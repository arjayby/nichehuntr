import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deriveListings, type ProvenVideo } from "./deriveListings";

/** How many recent uploads to load per channel when gating. Comfortably covers
 * both forms' windows plus fresh/non-standard items the gate then drops. */
const RECOMPUTE_VIDEO_LIMIT = 100;

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
		const latest = await ctx.db
			.query("videoSnapshots")
			.withIndex("by_video_and_at", (q) => q.eq("videoId", video._id))
			.order("desc")
			.first();
		if (latest === null) {
			continue; // no view data yet — can't gate this video
		}
		provenVideos.push({
			durationSec: video.durationSec,
			viewCount: latest.viewCount,
			publishedAt: video.publishedAt,
			isStandard: video.isStandard,
		});
	}

	const derived = deriveListings({
		channelId,
		now: Date.now(),
		videos: provenVideos,
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
