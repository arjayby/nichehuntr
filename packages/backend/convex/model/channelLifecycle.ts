/** Pure channel lifecycle derivation for the short-form threshold model. */

export type ChannelLifecycleStage =
	| "emerging"
	| "breaking_out"
	| "established"
	| "tracked";

export type FeedVisibility = "visible" | "hidden";

export type ChannelLifecycleVideo = {
	durationSec: number;
	publishedAt: number;
	/** Raw current view count from the fetched video data. */
	viewCount: number;
};

export type StoredLifecycleVideo = {
	durationSec: number;
	publishedAt: number;
	currentViewCount?: number;
};

export type DeriveChannelLifecycleInput = {
	subscriberCount: number;
	videos: ChannelLifecycleVideo[];
	/** Reference "now", ms since epoch, injected for deterministic recency checks. */
	now: number;
};

export type LifecycleEvidence = {
	subscriberCount: number;
	fetchedShorts: number;
	latestShortPublishedAt: number | null;
	recentShortsChecked: number;
	shortsAtOrAbove50k: number;
	shortsAtOrAbove100k: number;
};

export type DerivedChannelLifecycle = {
	stage: ChannelLifecycleStage;
	feedVisibility: FeedVisibility;
	evidence: LifecycleEvidence;
};

export const SHORT_MAX_SEC = 300;
export const RECENT_SHORT_WINDOW = 10;
export const MIN_CLASSIFIABLE_SHORTS = 3;
export const RECENT_UPLOAD_DAYS = 14;
export const EMERGING_VIEW_THRESHOLD = 50_000;
export const BREAKING_OUT_VIEW_THRESHOLD = 100_000;
export const ESTABLISHED_MIN_SUBSCRIBERS = 50_000;
export const ESTABLISHED_MIN_SHORTS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Project a stored video row into the pure lifecycle input shape. Missing
 * current counts are treated as zero reach for Feed visibility decisions. */
export function lifecycleVideoFromStoredVideo(
	video: StoredLifecycleVideo,
): ChannelLifecycleVideo {
	return {
		durationSec: video.durationSec,
		publishedAt: video.publishedAt,
		viewCount: video.currentViewCount ?? 0,
	};
}

function thresholdPasses(checkedCount: number, passingCount: number): boolean {
	return (
		checkedCount >= MIN_CLASSIFIABLE_SHORTS &&
		passingCount >= Math.ceil(checkedCount / 2)
	);
}

function visible(stage: Exclude<ChannelLifecycleStage, "tracked">) {
	return { stage, feedVisibility: "visible" as const };
}

/**
 * Derive a Channel's lifecycle stage, Feed visibility, and evidence counters
 * from plain channel/video data. It does not read the database, call YouTube, or
 * depend on UI shape.
 */
export function deriveChannelLifecycle(
	input: DeriveChannelLifecycleInput,
): DerivedChannelLifecycle {
	const shorts = input.videos
		.filter((video) => video.durationSec <= SHORT_MAX_SEC)
		.sort((a, b) => b.publishedAt - a.publishedAt);

	const recentShorts = shorts.slice(0, RECENT_SHORT_WINDOW);
	const latestShortPublishedAt = shorts[0]?.publishedAt ?? null;
	const shortsAtOrAbove50k = recentShorts.filter(
		(video) => video.viewCount >= EMERGING_VIEW_THRESHOLD,
	).length;
	const shortsAtOrAbove100k = recentShorts.filter(
		(video) => video.viewCount >= BREAKING_OUT_VIEW_THRESHOLD,
	).length;

	const evidence: LifecycleEvidence = {
		subscriberCount: input.subscriberCount,
		fetchedShorts: shorts.length,
		latestShortPublishedAt,
		recentShortsChecked: recentShorts.length,
		shortsAtOrAbove50k,
		shortsAtOrAbove100k,
	};

	const recent50kPasses = thresholdPasses(
		recentShorts.length,
		shortsAtOrAbove50k,
	);
	const recent100kPasses = thresholdPasses(
		recentShorts.length,
		shortsAtOrAbove100k,
	);
	const isMature =
		input.subscriberCount >= ESTABLISHED_MIN_SUBSCRIBERS &&
		shorts.length >= ESTABLISHED_MIN_SHORTS;
	const latestShortIsRecent =
		latestShortPublishedAt !== null &&
		latestShortPublishedAt >= input.now - RECENT_UPLOAD_DAYS * DAY_MS;

	const lifecycle = (() => {
		if (recent100kPasses && isMature) {
			return visible("established");
		}
		if (latestShortIsRecent && recent100kPasses && !isMature) {
			return visible("breaking_out");
		}
		if (
			latestShortIsRecent &&
			recent50kPasses &&
			!recent100kPasses &&
			!isMature
		) {
			return visible("emerging");
		}
		return { stage: "tracked" as const, feedVisibility: "hidden" as const };
	})();

	return {
		...lifecycle,
		evidence,
	};
}
