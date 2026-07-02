import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { EMBEDDING_DIMENSIONS } from "./model/embeddings";
import {
	formValidator,
	signalsValidator,
	sourceValidator,
	stageValidator,
} from "./model/validators";

export default defineSchema({
	// The underlying YouTube entities we discover and track. Not the scored unit
	// — see `listings` (ADR-0002).
	channels: defineTable({
		ytId: v.string(),
		title: v.string(),
		handle: v.optional(v.string()),
		avatarUrl: v.optional(v.string()),
		description: v.optional(v.string()),
		// Content embedding powering Saturation via the vector index below
		// (ADR-0003). Null until the embed cron backfills it.
		embedding: v.optional(v.array(v.float64())),
		// The channel's Saturation: the nearest-neighbor cluster size the embed cron
		// derives from vector search. Read back by `recomputeListingsForChannel`
		// (which falls back to snowball-graph density when this is unset) and ridden
		// onto each of the channel's Listings. Per-channel because the embedding is.
		saturation: v.optional(v.number()),
		discoveredAt: v.number(),
		source: sourceValidator,
	})
		.index("by_ytId", ["ytId"])
		.index("by_source", ["source"])
		// Nearest-neighbor search over channel embeddings drives Saturation. Only
		// callable from an action, so the embed cron owns it (ADR-0003).
		.vectorIndex("by_embedding", {
			vectorField: "embedding",
			dimensions: EMBEDDING_DIMENSIONS,
		}),

	// Individual uploads. `form` is denormalized per video from its duration so
	// the read path never has to reclassify. `isStandard` is false for
	// non-standard items (live streams, premieres) that the Proven gate excludes.
	videos: defineTable({
		ytId: v.string(),
		channelId: v.id("channels"),
		title: v.string(),
		thumbnailUrl: v.optional(v.string()),
		durationSec: v.number(),
		form: formValidator,
		publishedAt: v.number(),
		isStandard: v.boolean(),
	})
		.index("by_channel_and_publishedAt", ["channelId", "publishedAt"])
		// Ingestion upserts videos by their YouTube id and the snapshot cron looks
		// them up the same way, so both paths need a direct lookup on `ytId`.
		.index("by_ytId", ["ytId"]),

	// The Momentum time-series: point-in-time view counts (ADR-0001). The latest
	// snapshot per video is its current view count for the Proven gate.
	videoSnapshots: defineTable({
		videoId: v.id("videos"),
		viewCount: v.number(),
		at: v.number(),
	}).index("by_video_and_at", ["videoId", "at"]),

	// The reactive read model: one row per (channel, form) (ADR-0002). Only
	// `proven` gates visibility; every other signal is nullable and scores only.
	listings: defineTable({
		channelId: v.id("channels"),
		form: formValidator,
		proven: v.boolean(),
		medianViews: v.number(),
		baseline: v.union(v.number(), v.null()),
		momentum: v.union(v.number(), v.null()),
		saturation: v.union(v.number(), v.null()),
		stage: stageValidator,
		clonability: v.union(v.number(), v.null()),
		signals: v.union(signalsValidator, v.null()),
	})
		.index("by_channel", ["channelId"])
		.index("by_form_and_proven", ["form", "proven"]),

	// The snowball graph (CONTEXT.md): a directed edge means `toChannelId` surfaced
	// as related/featured off `fromChannelId` during snowball discovery. Its purpose
	// is to populate same-niche clusters so vector search has neighbors to find; its
	// density around a channel is also the cold-start Saturation fallback before
	// embeddings exist. Edges are deduped on insert, so a neighbor count is honest.
	channelEdges: defineTable({
		fromChannelId: v.id("channels"),
		toChannelId: v.id("channels"),
	})
		.index("by_from", ["fromChannelId"])
		.index("by_to", ["toChannelId"]),
});
