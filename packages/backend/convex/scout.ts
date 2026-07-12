/**
 * The Scout run (CONTEXT.md: Scout, ADR-0008) — automated seeded-search Channel
 * discovery. A run picks the least-recently-run Niche Queries, searches each for
 * recent popular Shorts, drops candidates from already-tracked channels *before*
 * spending hydration quota, ranks the unseen channels globally by their best
 * found-video's views, drops those under a floor, and creates up to a capped
 * number of `scout`-sourced Submissions. Those flow through the unchanged
 * Discovery pipeline (`submissionWorker`) exactly as an admin paste would — the
 * Scout is just a new caller of existing machinery.
 *
 * The boundary mirrors submissions.ts: the humble YouTube adapter
 * (`model/youtube.ts`) is the network seam, `runScoutRun` is the tested
 * orchestration (driven with a stub adapter, no network), and the internal
 * mutations/queries it calls are the DB seam. Selection/ranking are pure model
 * functions (`model/scout.ts`). `scoutRunAction` wires the live adapter from env
 * and is triggered manually via `convex run` — no cron in this slice.
 *
 * Each run writes one `scoutRuns` heartbeat row: when it started/finished, how
 * many queries it used, candidates it saw, channels it submitted, quota it
 * roughly spent, and — only if an aborting failure (e.g. quota exhaustion) cut it
 * short — the error, after its partial counters were tallied.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { liveYouTubeAdapter } from "./ingest";
import {
	DEFAULT_SCOUT_CONFIG,
	isRetired,
	nextZeroYield,
	rankCandidateChannels,
	type ScoutConfig,
	selectRunQueries,
} from "./model/scout";
import {
	type CandidateRef,
	MAX_IDS_PER_REQUEST,
	QuotaExceededError,
	type YouTubeAdapter,
} from "./model/youtube";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rough YouTube quota units per operation, for the heartbeat's estimate only
 * (PRD quota math): a `search.list` is 100 units; a `videos.list` hydration batch
 * is 1 unit per 50 ids; one new-channel ingest downstream is ~4 units (metadata +
 * uploads backfill). The estimate is deliberately approximate — it exists to spot
 * a run burning far more than expected, not to bill exactly. */
const SEARCH_QUOTA_UNITS = 100;
const HYDRATION_QUOTA_UNITS_PER_BATCH = 1;
const INGEST_QUOTA_UNITS = 4;

// --- DB seam (internal mutations & query the orchestration drives) --------------

/** One Niche Query the run will search: its id (to stamp yield afterward) and the
 * phrase to search for. */
type PickedQuery = { queryId: Id<"searchQueries">; phrase: string };

/**
 * Open a run: pick this run's Niche Queries — the least-recently-run slice split
 * between `seeded` and exploration (`adjacent`/`wildcat`) phrases, retired
 * queries excluded — stamp their `lastRunAt` so the next run rotates to different
 * phrases, and insert the `scoutRuns` heartbeat row. Picking + stamping share one
 * transaction so concurrent runs can't select the same phrases. `lastRunAt` is
 * stamped at pick time (a picked query is a run query), so even a run that later
 * aborts still advances the rotation. Returns the run id and the chosen queries.
 *
 * Retired queries drift to the front of the LRU index (their `lastRunAt` freezes
 * once they stop being picked), so the scan skips them explicitly rather than
 * letting them crowd out live phrases. It streams `by_lastRunAt` and stops as
 * soon as both slices could be filled to target, so a healthy pool reads only a
 * little past the front; it falls back to scanning the rest only when a slice is
 * chronically short (then borrowing needs to see every live candidate anyway).
 * The live candidates go to the pure `selectRunQueries` for the split/borrow
 * decision.
 */
export const beginScoutRun = internalMutation({
	args: {
		seededPerRun: v.number(),
		explorationPerRun: v.number(),
		retirementThreshold: v.number(),
	},
	handler: async (
		ctx,
		{ seededPerRun, explorationPerRun, retirementThreshold },
	): Promise<{ runId: Id<"scoutRuns">; queries: PickedQuery[] }> => {
		const now = Date.now();

		// Stream LRU-first, skipping retired, until both slices could be filled to
		// target (or the pool is exhausted — then borrowing fills the shortfall).
		const candidates: Doc<"searchQueries">[] = [];
		let liveSeeded = 0;
		let liveExploration = 0;
		for await (const query of ctx.db
			.query("searchQueries")
			.withIndex("by_lastRunAt")
			.order("asc")) {
			if (isRetired(query.consecutiveZeroYield, retirementThreshold)) {
				continue;
			}
			candidates.push(query);
			if (query.origin === "seeded") {
				liveSeeded++;
			} else {
				liveExploration++;
			}
			if (liveSeeded >= seededPerRun && liveExploration >= explorationPerRun) {
				break;
			}
		}

		const picked = selectRunQueries(candidates, {
			seededPerRun,
			explorationPerRun,
			retirementThreshold,
		});
		for (const query of picked) {
			await ctx.db.patch("searchQueries", query._id, { lastRunAt: now });
		}
		const runId = await ctx.db.insert("scoutRuns", {
			startedAt: now,
			queriesUsed: picked.length,
			candidatesSeen: 0,
			channelsSubmitted: 0,
			estimatedQuotaUnits: 0,
		});
		return {
			runId,
			queries: picked.map((query) => ({
				queryId: query._id,
				phrase: query.phrase,
			})),
		};
	},
});

/**
 * Of the given candidate channel ids, return those *not* already tracked — the
 * free DB check the Scout runs before hydrating, so hydration quota is spent only
 * on genuinely new candidates. Bounded by the candidate set (a run's queries ×
 * results), which is small.
 */
export const filterUntrackedChannelIds = internalQuery({
	args: { ytChannelIds: v.array(v.string()) },
	handler: async (ctx, { ytChannelIds }): Promise<string[]> => {
		const untracked: string[] = [];
		for (const ytChannelId of ytChannelIds) {
			const existing = await ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", ytChannelId))
				.unique();
			if (existing === null) {
				untracked.push(ytChannelId);
			}
		}
		return untracked;
	},
});

/**
 * Create a `scout`-sourced Submission per ranked channel and schedule the
 * standard Submission worker over each — the same background ingest an admin
 * paste triggers, so Scout candidates flow through the unchanged pipeline and the
 * lifecycle gates still decide Feed visibility. Scout Submissions carry no
 * `submittedBy` (there's no admin user). Returns how many were created.
 */
export const createScoutSubmissions = internalMutation({
	args: { ytChannelIds: v.array(v.string()) },
	handler: async (ctx, { ytChannelIds }): Promise<number> => {
		for (const ytChannelId of ytChannelIds) {
			const submissionId = await ctx.db.insert("submissions", {
				rawInput: ytChannelId,
				source: "scout",
				status: "pending",
			});
			await ctx.scheduler.runAfter(0, internal.submissions.submissionWorker, {
				submissionId,
			});
		}
		return ytChannelIds.length;
	},
});

/**
 * Fold each searched query's yield back into the pool (CONTEXT.md: Niche Query).
 * A query that surfaced at least one *unseen* Channel this run has its
 * consecutive-zero-yield counter reset; one that surfaced none advances toward
 * retirement. "Unseen" is the free already-tracked DB check the run already ran —
 * so yield is decided before any hydration/floor, and a query is credited for
 * finding a new channel even if that channel was later ranked out. Only queries
 * whose `search.list` actually succeeded are passed here: a transient search
 * failure is left out upstream, so a hiccup never counts toward retirement. The
 * counter is recomputed from each row's *current* value, so a row deleted mid-run
 * is skipped (the get returns null); a barren run's increment is idempotent under
 * the `next !== current` guard only against a re-run, not against a concurrent
 * re-mint (a revival racing this write can be clobbered — an acceptable rarity,
 * since the next enrichment re-mints again).
 */
export const applyQueryYields = internalMutation({
	args: {
		updates: v.array(
			v.object({ queryId: v.id("searchQueries"), yielded: v.boolean() }),
		),
	},
	handler: async (ctx, { updates }): Promise<null> => {
		for (const { queryId, yielded } of updates) {
			const query = await ctx.db.get("searchQueries", queryId);
			if (query === null) {
				continue;
			}
			const next = nextZeroYield(query.consecutiveZeroYield, yielded);
			if (next !== query.consecutiveZeroYield) {
				await ctx.db.patch("searchQueries", queryId, {
					consecutiveZeroYield: next,
				});
			}
		}
		return null;
	},
});

/**
 * Settle the run's heartbeat: stamp `finishedAt` and the final counters. `error`
 * is passed only when an aborting failure cut the run short — the partial counters
 * tallied up to that point are still recorded, so a dead run is distinguishable
 * from a quiet one.
 */
export const finishScoutRun = internalMutation({
	args: {
		runId: v.id("scoutRuns"),
		candidatesSeen: v.number(),
		channelsSubmitted: v.number(),
		estimatedQuotaUnits: v.number(),
		error: v.optional(v.string()),
	},
	handler: async (
		ctx,
		{ runId, candidatesSeen, channelsSubmitted, estimatedQuotaUnits, error },
	): Promise<null> => {
		await ctx.db.patch("scoutRuns", runId, {
			finishedAt: Date.now(),
			candidatesSeen,
			channelsSubmitted,
			estimatedQuotaUnits,
			error,
		});
		return null;
	},
});

// --- Orchestration (plain helper, tested with a stub adapter) -------------------

/**
 * Run the Scout end-to-end and return the heartbeat row id. Picks queries →
 * searches each for recent Shorts → drops already-tracked channels → hydrates the
 * survivors → ranks globally with the floor and cap → submits the top channels as
 * `scout` Submissions. A single query's `search.list` failure just skips that
 * query; a quota exhaustion (or any other unexpected throw) aborts the run
 * cleanly, recording the error and the partial counters on the heartbeat.
 */
export async function runScoutRun(
	ctx: ActionCtx,
	adapter: YouTubeAdapter,
	config: ScoutConfig,
): Promise<Id<"scoutRuns">> {
	// Same-file runMutation: annotate the return to sidestep TS circularity
	// (guidelines.md §Function calling), matching the sibling calls below.
	const { runId, queries }: { runId: Id<"scoutRuns">; queries: PickedQuery[] } =
		await ctx.runMutation(internal.scout.beginScoutRun, {
			seededPerRun: config.seededPerRun,
			explorationPerRun: config.explorationPerRun,
			retirementThreshold: config.retirementThreshold,
		});

	const publishedAfter = Date.now() - config.recentWindowDays * DAY_MS;
	let candidatesSeen = 0;
	let channelsSubmitted = 0;
	let quotaUnits = 0;
	let abortError: string | undefined;

	try {
		// 1. Search each query. A transient search.list failure skips just that
		//    query; quota exhaustion aborts the whole run (rethrown below). Keep the
		//    channels each *successfully-searched* query surfaced, so retirement can
		//    credit or penalize it below — a skipped query is simply left out.
		const refs: CandidateRef[] = [];
		const searched: {
			queryId: Id<"searchQueries">;
			channelIds: string[];
		}[] = [];
		for (const { queryId, phrase } of queries) {
			quotaUnits += SEARCH_QUOTA_UNITS;
			try {
				const hits = await adapter.searchRecentShorts(phrase, {
					publishedAfter,
					maxResults: config.searchResultsPerQuery,
				});
				refs.push(...hits);
				searched.push({
					queryId,
					channelIds: hits.map((hit) => hit.ytChannelId),
				});
			} catch (error) {
				if (error instanceof QuotaExceededError) {
					throw error;
				}
				// Any other search failure is a transient hiccup for this one query:
				// it isn't recorded, so it never counts toward retirement.
			}
		}
		candidatesSeen = refs.length;

		// 2. Drop candidates from already-tracked channels before any hydration.
		const candidateChannelIds = [
			...new Set(refs.map((ref) => ref.ytChannelId)),
		];
		const untrackedIds: string[] = await ctx.runQuery(
			internal.scout.filterUntrackedChannelIds,
			{ ytChannelIds: candidateChannelIds },
		);
		const untracked = new Set(untrackedIds);
		const untrackedRefs = refs.filter((ref) => untracked.has(ref.ytChannelId));

		// 3. Hydrate the survivors for view counts, then rank globally.
		if (untrackedRefs.length > 0) {
			quotaUnits +=
				Math.ceil(untrackedRefs.length / MAX_IDS_PER_REQUEST) *
				HYDRATION_QUOTA_UNITS_PER_BATCH;
			const stats = await adapter.hydrateCandidateStats(
				untrackedRefs.map((ref) => ref.ytVideoId),
			);
			const submitIds = rankCandidateChannels(stats, {
				viewFloor: config.viewFloor,
				cap: config.submissionCap,
			}).map((channel) => channel.ytChannelId);

			// 4. Submit the top-ranked channels through the unchanged pipeline.
			if (submitIds.length > 0) {
				channelsSubmitted = await ctx.runMutation(
					internal.scout.createScoutSubmissions,
					{ ytChannelIds: submitIds },
				);
				quotaUnits += channelsSubmitted * INGEST_QUOTA_UNITS;
			}
		}

		// 5. Self-prune: a query that surfaced an unseen channel resets its
		//    zero-yield counter; one that surfaced none advances toward retirement.
		//    Only on the clean path — an aborted run records no retirement changes,
		//    so the next run starts fresh.
		await ctx.runMutation(internal.scout.applyQueryYields, {
			updates: searched.map(({ queryId, channelIds }) => ({
				queryId,
				yielded: channelIds.some((id) => untracked.has(id)),
			})),
		});
	} catch (error) {
		abortError =
			error instanceof QuotaExceededError
				? `${error.message} — run aborted.`
				: error instanceof Error
					? error.message
					: "Scout run failed.";
	}

	await ctx.runMutation(internal.scout.finishScoutRun, {
		runId,
		candidatesSeen,
		channelsSubmitted,
		estimatedQuotaUnits: quotaUnits,
		error: abortError,
	});
	return runId;
}

// --- Manual entrypoint ---------------------------------------------------------

/**
 * The tracer-bullet trigger — run out-of-band via `convex run scout:scoutRunAction`
 * (the same escape hatch as the admin bootstrap and the launch sweep). Wires the
 * live YouTube adapter from env and runs one Scout pass with the default config.
 * Kept thin: all logic lives in `runScoutRun`. No cron in this slice.
 */
export const scoutRunAction = internalAction({
	args: {},
	handler: async (ctx): Promise<Id<"scoutRuns">> => {
		return await runScoutRun(ctx, liveYouTubeAdapter(), DEFAULT_SCOUT_CONFIG);
	},
});
