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
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { liveYouTubeAdapter } from "./ingest";
import {
	DEFAULT_SCOUT_CONFIG,
	rankCandidateChannels,
	type ScoutConfig,
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

/**
 * Open a run: pick this run's Niche Queries least-recently-run first, stamp their
 * `lastRunAt` so the next run rotates to different phrases, and insert the
 * `scoutRuns` heartbeat row. Picking + stamping share one transaction so
 * concurrent runs can't select the same phrases. `lastRunAt` is stamped at pick
 * time (a picked query is a run query), so even a run that later aborts still
 * advances the rotation. Returns the run id and the chosen phrases.
 */
export const beginScoutRun = internalMutation({
	args: { queriesPerRun: v.number() },
	handler: async (
		ctx,
		{ queriesPerRun },
	): Promise<{ runId: Id<"scoutRuns">; queries: string[] }> => {
		const now = Date.now();
		const picked = await ctx.db
			.query("searchQueries")
			.withIndex("by_lastRunAt")
			.order("asc")
			.take(queriesPerRun);
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
		return { runId, queries: picked.map((query) => query.phrase) };
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
	const { runId, queries }: { runId: Id<"scoutRuns">; queries: string[] } =
		await ctx.runMutation(internal.scout.beginScoutRun, {
			queriesPerRun: config.queriesPerRun,
		});

	const publishedAfter = Date.now() - config.recentWindowDays * DAY_MS;
	let candidatesSeen = 0;
	let channelsSubmitted = 0;
	let quotaUnits = 0;
	let abortError: string | undefined;

	try {
		// 1. Search each query. A transient search.list failure skips just that
		//    query; quota exhaustion aborts the whole run (rethrown below).
		const refs: CandidateRef[] = [];
		for (const query of queries) {
			quotaUnits += SEARCH_QUOTA_UNITS;
			try {
				const hits = await adapter.searchRecentShorts(query, {
					publishedAfter,
					maxResults: config.searchResultsPerQuery,
				});
				refs.push(...hits);
			} catch (error) {
				if (error instanceof QuotaExceededError) {
					throw error;
				}
				// Any other search failure is a transient hiccup for this one query.
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
