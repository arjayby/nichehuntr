/**
 * Shared Channel ingestion write path (ADR-0005/0006). Automated discovery,
 * snapshot momentum, and saturation upkeep are retired; channels now enter only
 * through admin Submissions, which store current short-form stats for the
 * threshold lifecycle.
 */

import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { sourceValidator } from "./model/validators";
import { createYouTubeAdapter, type YouTubeAdapter } from "./model/youtube";

/** Result of an ingestion run, surfaced from the cron/orchestration for logs. */
export type DiscoveryResult = {
	channels: number;
	videos: number;
	channelsTouched: number;
};

// --- Argument validators (shared shape between mutation and orchestration) -----

const discoveredChannelValidator = v.object({
	ytChannelId: v.string(),
	title: v.string(),
	handle: v.optional(v.string()),
	avatarUrl: v.optional(v.string()),
	description: v.optional(v.string()),
	subscriberCount: v.optional(v.number()),
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
 * Upsert a batch of discovered channels and videos. The upload's fetched
 * `viewCount` is stored as the current count the short-form lifecycle reads.
 * Idempotent: re-seeing a channel/video patches in place rather than duplicating.
 */
export const upsertDiscovered = internalMutation({
	args: {
		channels: v.array(discoveredChannelValidator),
		videos: v.array(discoveredVideoValidator),
		// Source stamped on newly-inserted channels. The Submission worker
		// passes `admin` — the sole live intake now (ADR-0005) and this path's
		// default; only patched onto brand-new rows, never overwriting an existing
		// channel's original source on an idempotent refresh.
		source: v.optional(sourceValidator),
	},
	handler: async (
		ctx,
		{ channels, videos, source },
	): Promise<DiscoveryResult> => {
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
				subscriberCount: channel.subscriberCount,
			};
			if (existing !== null) {
				await ctx.db.patch("channels", existing._id, fields);
				channelIdByYt.set(channel.ytChannelId, existing._id);
			} else {
				const id = await ctx.db.insert("channels", {
					ytId: channel.ytChannelId,
					discoveredAt: now,
					source: source ?? "admin",
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
				isStandard: video.isStandard,
				currentViewCount: video.viewCount,
			};
			const existing = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", video.ytVideoId))
				.unique();
			if (existing !== null) {
				await ctx.db.patch("videos", existing._id, fields);
			} else {
				await ctx.db.insert("videos", {
					ytId: video.ytVideoId,
					publishedAt: video.publishedAt,
					...fields,
				});
			}
			touched.add(channelId);
		}

		return {
			channels: channels.length,
			videos: videos.length,
			channelsTouched: touched.size,
		};
	},
});

/** Build the live adapter, failing loudly if the API key isn't configured.
 * Shared with the Submission worker (submissions.ts). */
export function liveYouTubeAdapter(): YouTubeAdapter {
	const apiKey = process.env.YOUTUBE_API_KEY;
	if (!apiKey) {
		throw new Error(
			"YOUTUBE_API_KEY is not set — configure it in the Convex dashboard.",
		);
	}
	return createYouTubeAdapter(apiKey);
}
