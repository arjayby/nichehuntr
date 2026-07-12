/**
 * The Scout's pure run-planning model (CONTEXT.md: Scout, ADR-0008).
 *
 * A Scout run searches its Niche Query pool, harvests candidate videos, and turns
 * the best unseen Channels into Submissions that flow through the unchanged
 * Discovery pipeline. Two decisions live here as pure functions — no ctx, no
 * network — mirroring the pure Channel lifecycle model, with the orchestration
 * (scout.ts) driving the adapter and DB around them:
 *
 *  - *Which queries a run picks* (`selectRunQueries`): the least-recently-run
 *    slice split between `seeded` and exploration (`adjacent`/`wildcat`) phrases,
 *    borrowing across the split when one slice is short, and never picking a
 *    retired phrase.
 *  - *Which channels a run submits* (`rankCandidateChannels`): grouping the run's
 *    candidate videos by channel, ranking globally by best found-video views,
 *    dropping under-floor channels, and capping how many are submitted.
 *
 * The pool self-prunes: a run that surfaces no unseen Channel for a query counts
 * against it (`nextZeroYield`), and once that counter reaches the threshold the
 * query is retired — skipped, never deleted (`isRetired`). Re-minting the phrase
 * (model/nicheQueries.ts) revives it.
 */

import type { NicheQueryOrigin } from "./validators";

/**
 * Tunable Scout knobs (PRD user story #16 — every budget/lifecycle number is a
 * config knob, tunable without code changes). `DEFAULT_SCOUT_CONFIG` encodes the
 * v1 numbers from the Scout PRD.
 */
export type ScoutConfig = {
	/** How many `seeded` Niche Queries a run targets, least-recently-run first. */
	seededPerRun: number;
	/** How many exploration (`adjacent`/`wildcat`) queries a run targets, LRU
	 * first. When one slice is short the run borrows from the other to still fill
	 * `seededPerRun + explorationPerRun` total. */
	explorationPerRun: number;
	/** `maxResults` asked of each `search.list` (YouTube caps this at 50). */
	searchResultsPerQuery: number;
	/** How recent a Short must be to count — `publishedAfter` is now minus this. */
	recentWindowDays: number;
	/** A candidate channel whose best found video is under this many views is
	 * dropped before submission, so intake quota goes to channels likely to clear
	 * the lifecycle gates. */
	viewFloor: number;
	/** The most Submissions a single run creates, after ranking. */
	submissionCap: number;
	/** Consecutive zero-unseen-channel runs that retire a query. At this count the
	 * query is skipped by `selectRunQueries` until a re-mint revives it. */
	retirementThreshold: number;
};

export const DEFAULT_SCOUT_CONFIG: ScoutConfig = {
	seededPerRun: 8,
	explorationPerRun: 2,
	searchResultsPerQuery: 50,
	recentWindowDays: 14,
	viewFloor: 10_000,
	submissionCap: 30,
	retirementThreshold: 3,
};

/** Whether a Niche Query has retired: it has gone `threshold` consecutive runs
 * without surfacing an unseen Channel, so quota should no longer be spent on it.
 * Retired means skipped, not deleted — a re-mint resets the counter and revives
 * it (CONTEXT.md: Niche Query, ADR-0008). */
export function isRetired(
	consecutiveZeroYield: number,
	threshold: number,
): boolean {
	return consecutiveZeroYield >= threshold;
}

/** The consecutive-zero-yield counter after a run that either surfaced an unseen
 * Channel for this query (`yielded` — resets to 0) or did not (`!yielded` —
 * advances by one, marching the query toward retirement). Pure, so the increment/
 * reset rule is single-sourced between the tests and the run's write path. */
export function nextZeroYield(current: number, yielded: boolean): number {
	return yielded ? 0 : current + 1;
}

/** The shape `selectRunQueries` needs off a pooled Niche Query: its origin slice
 * and its retirement counter. Callers pass the full DB row (which structurally
 * satisfies this) and get the same rows back, so they keep the ids to stamp. */
type SelectableQuery = {
	origin: NicheQueryOrigin;
	consecutiveZeroYield: number;
};

/**
 * Pick a run's Niche Queries from a least-recently-run-ordered pool: the caller
 * passes candidates already sorted LRU-first (never-run ahead of the stalest),
 * and this returns the subset to run, preserving that order.
 *
 * Retired queries are dropped up front. The survivors are split into a `seeded`
 * slice and an exploration slice (`adjacent`/`wildcat`), each filled LRU-first up
 * to its target. When a slice is short of its target the run doesn't crash or run
 * fewer than it could — it borrows the shortfall from whatever LRU-stalest
 * queries remain in the other slice, so a healthy run always fills
 * `seededPerRun + explorationPerRun` total when the pool can supply it. Pure: no
 * ctx, no dedupe of already-tracked channels — just the pick.
 */
export function selectRunQueries<T extends SelectableQuery>(
	lruOrdered: readonly T[],
	{
		seededPerRun,
		explorationPerRun,
		retirementThreshold,
	}: Pick<
		ScoutConfig,
		"seededPerRun" | "explorationPerRun" | "retirementThreshold"
	>,
): T[] {
	const total = seededPerRun + explorationPerRun;
	const live = lruOrdered.filter(
		(query) => !isRetired(query.consecutiveZeroYield, retirementThreshold),
	);

	const picked: T[] = [];
	const seen = new Set<T>();
	const takeSlice = (predicate: (query: T) => boolean, limit: number) => {
		let taken = 0;
		for (const query of live) {
			if (taken >= limit) {
				break;
			}
			if (predicate(query) && !seen.has(query)) {
				picked.push(query);
				seen.add(query);
				taken++;
			}
		}
	};

	takeSlice((query) => query.origin === "seeded", seededPerRun);
	takeSlice((query) => query.origin !== "seeded", explorationPerRun);

	// Borrow the shortfall from the stalest remaining queries of either slice.
	for (const query of live) {
		if (picked.length >= total) {
			break;
		}
		if (!seen.has(query)) {
			picked.push(query);
			seen.add(query);
		}
	}

	return picked;
}

/** A channel the Scout will submit, tagged with the view count of the best video
 * that surfaced it — the signal the ≤cap ranking is ordered by. */
export type RankedCandidateChannel = {
	ytChannelId: string;
	bestViewCount: number;
};

/**
 * Rank a whole run's candidate videos into the channels to submit. Groups the
 * videos by channel, scores each channel by its best (highest) found-video view
 * count, drops channels whose best is *under* `viewFloor`, orders the survivors
 * by that score descending, and returns at most `cap`. Ties on view count break
 * by channel id so the selection is deterministic. Pure: the caller has already
 * dropped videos from already-tracked channels, so every channel here is unseen,
 * and ranking globally across the run (not per query) is why this takes the run's
 * whole candidate set at once.
 */
export function rankCandidateChannels(
	videos: readonly { ytChannelId: string; viewCount: number }[],
	{ viewFloor, cap }: { viewFloor: number; cap: number },
): RankedCandidateChannel[] {
	const bestByChannel = new Map<string, number>();
	for (const { ytChannelId, viewCount } of videos) {
		const prev = bestByChannel.get(ytChannelId);
		if (prev === undefined || viewCount > prev) {
			bestByChannel.set(ytChannelId, viewCount);
		}
	}
	return [...bestByChannel.entries()]
		.map(([ytChannelId, bestViewCount]) => ({ ytChannelId, bestViewCount }))
		.filter((channel) => channel.bestViewCount >= viewFloor)
		.sort(
			(a, b) =>
				b.bestViewCount - a.bestViewCount ||
				a.ytChannelId.localeCompare(b.ytChannelId),
		)
		.slice(0, cap);
}
