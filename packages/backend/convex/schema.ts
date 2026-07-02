import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
		// Content embedding powering Saturation via vector search (ADR-0003). The
		// provider/dimension are chosen at build time, so the vector index is added
		// with the Saturation slice; here the field just reserves its place.
		embedding: v.optional(v.array(v.float64())),
		discoveredAt: v.number(),
		source: sourceValidator,
	})
		.index("by_ytId", ["ytId"])
		.index("by_source", ["source"]),

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
});
