import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deriveListings, type ProvenVideo } from "./deriveListings";

/** How many recent uploads to load per channel when gating. Comfortably covers
 * both forms' windows plus fresh/non-standard items the gate then drops. */
const RECOMPUTE_VIDEO_LIMIT = 100;

/** How many recent snapshots to load per video for Momentum. The newest is the
 * current view count for the gate; the span across them is the velocity slope.
 * Capped so momentum tracks *recent* cycles rather than a video's whole history,
 * and to bound the per-video read (ADR-0001: velocity sharpens over ~24–72h). */
const RECENT_SNAPSHOT_WINDOW = 12;

/**
 * Recompute a channel's Listings from its videos and replace the stored rows so
 * the reactive read model matches the latest Proven verdict. This is the seam
 * the snapshot cron will reuse; Slice 1 calls it only from the seed.
 */
export async function recomputeListingsForChannel(
	ctx: MutationCtx,
	channelId: Id<"channels">,
): Promise<void> {
	const videos = await ctx.db
		.query("videos")
		.withIndex("by_channel_and_publishedAt", (q) =>
			q.eq("channelId", channelId),
		)
		.order("desc")
		.take(RECOMPUTE_VIDEO_LIMIT);

	const provenVideos: ProvenVideo[] = [];
	for (const video of videos) {
		// Newest-first: [0] is the current view count for the gate, and the span
		// across the window is the velocity slope Momentum reads.
		const recentSnapshots = await ctx.db
			.query("videoSnapshots")
			.withIndex("by_video_and_at", (q) => q.eq("videoId", video._id))
			.order("desc")
			.take(RECENT_SNAPSHOT_WINDOW);
		const latest = recentSnapshots[0];
		if (latest === undefined) {
			continue; // no view data yet — can't gate this video
		}
		provenVideos.push({
			durationSec: video.durationSec,
			viewCount: latest.viewCount,
			publishedAt: video.publishedAt,
			isStandard: video.isStandard,
			snapshots: recentSnapshots.map((s) => ({
				viewCount: s.viewCount,
				at: s.at,
			})),
		});
	}

	// Saturation is per-channel: the embed cron's vector-search cluster size when
	// present, else null (unmeasured — Stage stays on the momentum axis until the
	// embed pass runs). deriveListings rides it onto each of the channel's Listings
	// and lets a crowded niche dominate Stage.
	const channel = await ctx.db.get("channels", channelId);
	const saturation = channel?.saturation ?? null;

	const derived = deriveListings({
		channelId,
		now: Date.now(),
		videos: provenVideos,
		saturation,
	});

	const existing = await ctx.db
		.query("listings")
		.withIndex("by_channel", (q) => q.eq("channelId", channelId))
		.collect();
	for (const listing of existing) {
		await ctx.db.delete("listings", listing._id);
	}
	for (const listing of derived) {
		await ctx.db.insert("listings", listing);
	}
}
