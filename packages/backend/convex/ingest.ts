/**
 * Live ingestion (ADR-0001): two crons feed the discovery pipeline from real
 * YouTube data, replacing the manual seed.
 *
 *   discovery cron → fetch trending → upsert channels + videos → derive Listings
 *   snapshot cron  → re-sample tracked videos → write Snapshots → derive Listings
 *
 * The YouTube boundary is a humble adapter (`model/youtube.ts`). The cron
 * `internalAction`s wire the real adapter from env; the `runDiscovery` /
 * `runSnapshot` orchestration and the mutations they call are the tested seam,
 * driven in tests with a stub adapter so no network is hit.
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
import { classifyForm } from "./model/deriveListings";
import { recomputeListingsForChannel } from "./model/listings";
import {
	createYouTubeAdapter,
	type FetchTrendingOptions,
	type YouTubeAdapter,
} from "./model/youtube";

/** Ceiling on videos re-sampled per snapshot run — bounds the query and keeps
 * the batched stats requests within a sane quota per cron tick. Tunable. */
const SNAPSHOT_VIDEO_LIMIT = 500;

/** Result of an ingestion run, surfaced from the cron/orchestration for logs. */
export type DiscoveryResult = {
	channels: number;
	videos: number;
	channelsRecomputed: number;
};
export type SnapshotResult = { snapshots: number; channelsRecomputed: number };

// --- Argument validators (shared shape between mutation and orchestration) -----

const discoveredChannelValidator = v.object({
	ytChannelId: v.string(),
	title: v.string(),
	handle: v.optional(v.string()),
	avatarUrl: v.optional(v.string()),
	description: v.optional(v.string()),
});

const discoveredVideoValidator = v.object({
	ytVideoId: v.string(),
	ytChannelId: v.string(),
	title: v.string(),
	thumbnailUrl: v.optional(v.string()),
	durationSec: v.number(),
	publishedAt: v.number(),
	viewCount: v.number(),
	isStandard: v.boolean(),
});

// --- Mutations & queries (the DB seam) -----------------------------------------

/**
 * Upsert a batch of discovered channels and videos, record a snapshot per video
 * from the view count the fetch already carried, then recompute Listings for
 * every touched channel so the Feed reflects the latest Proven verdict.
 * Idempotent: re-seeing a channel/video patches in place rather than duplicating.
 */
export const upsertDiscovered = internalMutation({
	args: {
		channels: v.array(discoveredChannelValidator),
		videos: v.array(discoveredVideoValidator),
	},
	handler: async (ctx, { channels, videos }): Promise<DiscoveryResult> => {
		const now = Date.now();

		const channelIdByYt = new Map<string, Id<"channels">>();
		for (const channel of channels) {
			const existing = await ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", channel.ytChannelId))
				.unique();
			const fields = {
				title: channel.title,
				handle: channel.handle,
				avatarUrl: channel.avatarUrl,
				description: channel.description,
			};
			if (existing !== null) {
				await ctx.db.patch("channels", existing._id, fields);
				channelIdByYt.set(channel.ytChannelId, existing._id);
			} else {
				const id = await ctx.db.insert("channels", {
					ytId: channel.ytChannelId,
					discoveredAt: now,
					source: "trending",
					...fields,
				});
				channelIdByYt.set(channel.ytChannelId, id);
			}
		}

		const touched = new Set<Id<"channels">>();
		for (const video of videos) {
			const channelId = channelIdByYt.get(video.ytChannelId);
			if (channelId === undefined) {
				continue; // video's channel wasn't in the batch — skip defensively
			}
			const fields = {
				channelId,
				title: video.title,
				thumbnailUrl: video.thumbnailUrl,
				durationSec: video.durationSec,
				form: classifyForm(video.durationSec),
				isStandard: video.isStandard,
			};
			const existing = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", video.ytVideoId))
				.unique();
			let videoId: Id<"videos">;
			if (existing !== null) {
				await ctx.db.patch("videos", existing._id, fields);
				videoId = existing._id;
			} else {
				videoId = await ctx.db.insert("videos", {
					ytId: video.ytVideoId,
					publishedAt: video.publishedAt,
					...fields,
				});
			}
			// Trending carried a fresh view count for free, so record it as a
			// snapshot — denser time-series at zero extra quota.
			await ctx.db.insert("videoSnapshots", {
				videoId,
				viewCount: video.viewCount,
				at: now,
			});
			touched.add(channelId);
		}

		for (const channelId of touched) {
			await recomputeListingsForChannel(ctx, channelId);
		}

		return {
			channels: channels.length,
			videos: videos.length,
			channelsRecomputed: touched.size,
		};
	},
});

/** The tracked videos the snapshot cron should re-sample, bounded and returned
 * as YouTube ids ready to batch through the adapter. Newest-first so that once
 * the table outgrows the cap it's the recently discovered videos — the ones
 * still inside the Proven window — that keep refreshing, not the oldest. */
export const listVideosToSnapshot = internalQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, { limit }): Promise<{ ytVideoId: string }[]> => {
		const videos = await ctx.db
			.query("videos")
			.order("desc")
			.take(limit ?? SNAPSHOT_VIDEO_LIMIT);
		return videos.map((video) => ({ ytVideoId: video.ytId }));
	},
});

/**
 * Append a fresh Snapshot for each re-sampled video and recompute the Listings
 * of every channel whose videos moved — this is where a channel whose median
 * has drifted below the Proven threshold drops out of the Feed.
 */
export const recordSnapshots = internalMutation({
	args: {
		readings: v.array(
			v.object({ ytVideoId: v.string(), viewCount: v.number() }),
		),
	},
	handler: async (ctx, { readings }): Promise<SnapshotResult> => {
		const now = Date.now();
		const touched = new Set<Id<"channels">>();
		for (const reading of readings) {
			const video = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", reading.ytVideoId))
				.unique();
			if (video === null) {
				continue; // untracked video — nothing to snapshot
			}
			await ctx.db.insert("videoSnapshots", {
				videoId: video._id,
				viewCount: reading.viewCount,
				at: now,
			});
			touched.add(video.channelId);
		}

		for (const channelId of touched) {
			await recomputeListingsForChannel(ctx, channelId);
		}

		return { snapshots: readings.length, channelsRecomputed: touched.size };
	},
});

// --- Orchestration (plain helpers, tested with a stub adapter) -----------------

/**
 * Fetch the trending firehose, enrich with channel metadata, and upsert it.
 * `search.list` is never called (ADR-0001) and stats ride along with trending,
 * so a run costs ~1 unit for trending plus 1 unit per 50 channels enriched.
 */
export async function runDiscovery(
	ctx: ActionCtx,
	adapter: YouTubeAdapter,
	opts?: FetchTrendingOptions,
): Promise<DiscoveryResult> {
	const trending = await adapter.fetchTrending(opts);
	if (trending.length === 0) {
		return { channels: 0, videos: 0, channelsRecomputed: 0 };
	}

	const channelIds = [...new Set(trending.map((t) => t.ytChannelId))];
	const infos = await adapter.fetchChannels(channelIds);
	const infoByYt = new Map(infos.map((info) => [info.ytChannelId, info]));

	const channels = channelIds.map((ytChannelId) => {
		const info = infoByYt.get(ytChannelId);
		const fromTrending = trending.find((t) => t.ytChannelId === ytChannelId);
		return {
			ytChannelId,
			// Fall back to the channel title trending carried if enrichment dropped
			// the channel (e.g. it was since deleted), so the video still lands.
			title: info?.title || fromTrending?.channelTitle || ytChannelId,
			handle: info?.handle,
			avatarUrl: info?.avatarUrl,
			description: info?.description,
		};
	});

	const videos = trending.map((t) => ({
		ytVideoId: t.ytVideoId,
		ytChannelId: t.ytChannelId,
		title: t.title,
		thumbnailUrl: t.thumbnailUrl,
		durationSec: t.durationSec,
		publishedAt: t.publishedAt,
		viewCount: t.viewCount,
		isStandard: t.isStandard,
	}));

	return await ctx.runMutation(internal.ingest.upsertDiscovered, {
		channels,
		videos,
	});
}

/** Re-sample tracked videos and write their Snapshots, refreshing the Feed. */
export async function runSnapshot(
	ctx: ActionCtx,
	adapter: YouTubeAdapter,
	opts?: { limit?: number },
): Promise<SnapshotResult> {
	const targets = await ctx.runQuery(internal.ingest.listVideosToSnapshot, {
		limit: opts?.limit,
	});
	if (targets.length === 0) {
		return { snapshots: 0, channelsRecomputed: 0 };
	}

	const stats = await adapter.fetchVideoStats(targets.map((t) => t.ytVideoId));
	return await ctx.runMutation(internal.ingest.recordSnapshots, {
		readings: stats.map((s) => ({
			ytVideoId: s.ytVideoId,
			viewCount: s.viewCount,
		})),
	});
}

// --- Cron entrypoints ----------------------------------------------------------

/** Build the live adapter, failing loudly if the API key isn't configured. */
function liveAdapter(): YouTubeAdapter {
	const apiKey = process.env.YOUTUBE_API_KEY;
	if (!apiKey) {
		throw new Error(
			"YOUTUBE_API_KEY is not set — configure it in the Convex dashboard.",
		);
	}
	return createYouTubeAdapter(apiKey);
}

export const discoveryCron = internalAction({
	args: {},
	handler: async (ctx): Promise<DiscoveryResult> =>
		runDiscovery(ctx, liveAdapter()),
});

export const snapshotCron = internalAction({
	args: {},
	handler: async (ctx): Promise<SnapshotResult> =>
		runSnapshot(ctx, liveAdapter()),
});
