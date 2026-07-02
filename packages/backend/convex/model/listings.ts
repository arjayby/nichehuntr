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

/** Safety cap on snowball edges read per channel when counting niche density.
 * Related-channel fan-out is small, so this only guards a pathological graph. */
const EDGE_SCAN_LIMIT = 256;

/**
 * A channel's snowball-graph density: how many distinct other channels it shares
 * a related/featured edge with, in either direction. This is the cold-start
 * Saturation fallback (CONTEXT.md) — a rough niche-crowdedness read before the
 * embed cron has produced a vector-search cluster size.
 */
async function snowballDensity(
	ctx: MutationCtx,
	channelId: Id<"channels">,
): Promise<number> {
	const outgoing = await ctx.db
		.query("channelEdges")
		.withIndex("by_from", (q) => q.eq("fromChannelId", channelId))
		.take(EDGE_SCAN_LIMIT);
	const incoming = await ctx.db
		.query("channelEdges")
		.withIndex("by_to", (q) => q.eq("toChannelId", channelId))
		.take(EDGE_SCAN_LIMIT);
	const neighbors = new Set<string>();
	for (const edge of outgoing) {
		neighbors.add(edge.toChannelId);
	}
	for (const edge of incoming) {
		neighbors.add(edge.fromChannelId);
	}
	neighbors.delete(channelId); // ignore any self-edge
	return neighbors.size;
}

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
	// present (authoritative), else the snowball-graph density fallback, else null
	// (unknown — Stage stays on the momentum axis). deriveListings rides it onto
	// each of the channel's Listings and lets a crowded niche dominate Stage.
	const channel = await ctx.db.get("channels", channelId);
	let saturation: number | null;
	if (channel?.saturation !== undefined) {
		saturation = channel.saturation;
	} else {
		const density = await snowballDensity(ctx, channelId);
		saturation = density > 0 ? density : null;
	}

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
