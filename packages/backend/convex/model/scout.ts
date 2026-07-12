/**
 * The Scout's pure run-planning model (CONTEXT.md: Scout, ADR-0008).
 *
 * A Scout run searches its Niche Query pool, harvests candidate videos, and turns
 * the best unseen Channels into Submissions that flow through the unchanged
 * Discovery pipeline. The decision that picks *which* Channels get submitted —
 * grouping a run's candidate videos by channel, ranking those channels globally
 * by their best found-video's view count, dropping the ones under a minimum-views
 * floor, and capping how many are submitted — is a pure function here, with no
 * ctx and no network, mirroring the pure Channel lifecycle model. The
 * orchestration (scout.ts) drives the adapter and DB around it.
 */

/**
 * Tunable Scout budget knobs (PRD user story #16 — every budget number is a
 * config knob, tunable without code changes). `DEFAULT_SCOUT_CONFIG` encodes the
 * v1 numbers from the Scout PRD.
 */
export type ScoutConfig = {
	/** How many Niche Queries a single run searches, least-recently-run first. */
	queriesPerRun: number;
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
};

export const DEFAULT_SCOUT_CONFIG: ScoutConfig = {
	queriesPerRun: 10,
	searchResultsPerQuery: 50,
	recentWindowDays: 14,
	viewFloor: 10_000,
	submissionCap: 30,
};

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
