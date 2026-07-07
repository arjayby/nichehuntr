import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { EMBEDDING_DIMENSIONS } from "./model/embeddings";
import {
	formValidator,
	signalsValidator,
	sourceValidator,
	stageValidator,
	submissionOutcomeValidator,
	submissionStatusValidator,
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

	// The Enrichment cache: one row per (channel, form) holding the multimodal
	// Claude pass's per-signal scores (ADR-0003, Slice 5). Kept off the `listings`
	// table because a recompute deletes and reinserts Listings, whereas enrichment
	// is expensive and must persist and be reused across recomputes. `fingerprint`
	// is a digest of the inputs the scores were derived from, so the enrich cron
	// re-runs a Listing only when its metadata/thumbnails materially change.
	enrichments: defineTable({
		channelId: v.id("channels"),
		form: formValidator,
		signals: signalsValidator,
		fingerprint: v.string(),
		enrichedAt: v.number(),
	}).index("by_channel_and_form", ["channelId", "form"]),

	// The Operator's private Watchlist: one row per (Operator, Channel, Form)
	// triple (ADR-0004). Never a listing id — Listings are deleted/reinserted on
	// recompute (ADR-0002), so entries re-derive live Listing data at read time.
	// `operatorId` is the better-auth user id. Newest-first uses `_creationTime`.
	// `folderId` files the entry into one of the Operator's Folders (CONTEXT.md);
	// absent means the entry sits at the Watchlist root.
	watchlistEntries: defineTable({
		operatorId: v.string(),
		channelId: v.id("channels"),
		form: formValidator,
		folderId: v.optional(v.id("watchlistFolders")),
	})
		// Point lookup for toggle/dedupe on the exact triple; its `operatorId`
		// prefix also serves the per-operator list (ordered by the remaining
		// columns, so the list query uses `by_operator` below instead).
		.index("by_operator_and_channel_and_form", [
			"operatorId",
			"channelId",
			"form",
		])
		.index("by_operator", ["operatorId"])
		// Serves delete-a-Folder reparenting: find every entry filed under it.
		.index("by_folder", ["folderId"]),

	// The Operator's flat, private Folders inside the Watchlist (CONTEXT.md): a
	// named bucket entries are filed into via `watchlistEntries.folderId`. No
	// nesting; an entry sits in at most one Folder or at the root. Deleting a
	// Folder reparents its entries to root — it never deletes them. Folders group,
	// they don't rank: the drawer sorts them alphabetically by `name`.
	watchlistFolders: defineTable({
		operatorId: v.string(),
		name: v.string(),
	}).index("by_operator", ["operatorId"]),

	// Legacy snowball graph (ADR-0005): a directed edge once meant `toChannelId`
	// surfaced as related/featured off `fromChannelId` during snowball discovery.
	// Automated discovery is removed, so nothing writes or reads edges anymore; the
	// table is retained only so the cutover purge migration can empty it, and a
	// later slice drops it once the pre-cutover rows are gone.
	channelEdges: defineTable({
		fromChannelId: v.id("channels"),
		toChannelId: v.id("channels"),
	})
		.index("by_from", ["fromChannelId"])
		.index("by_to", ["toChannelId"]),

	// Admins: operators authorized to submit Channels into the Feed (ADR-0005).
	// Admin is a role on a separate authorization axis from the subscription
	// paywall — a row here grants admin regardless of subscription. Keyed by the
	// better-auth `userId` (same identity `watchlistEntries.operatorId` uses).
	// Granted by email, bootstrapped once via an internal mutation. `requireAdmin`
	// and `isAdmin` (convex/admin.ts) resolve membership through `by_userId`.
	adminUsers: defineTable({
		userId: v.string(),
	}).index("by_userId", ["userId"]),

	// Admin Submissions (ADR-0005): an Admin's request to bring a Channel into the
	// Feed, together with its ingestion outcome — the sole way a Channel now enters
	// the system. `rawInput` is the pasted text (trimmed of surrounding
	// whitespace on submit); `submittedBy` is the
	// better-auth user id. Status runs `pending → processing → tracked | failed`;
	// a channel that ingests but misses the Proven gate is `tracked` (with a 0-proven
	// `outcome`), never `failed`. `failed` is reserved for an unresolvable paste or an
	// API error and carries a human `failureReason`. `resolvedYtChannelId` is the
	// canonical `UC…` id the paste resolved to and `channelId` the row it created or
	// refreshed (idempotent per channel — a re-submit is a manual refresh). Listed
	// newest-first off `_creationTime` for the live table (no extra index needed).
	submissions: defineTable({
		rawInput: v.string(),
		submittedBy: v.string(),
		status: submissionStatusValidator,
		resolvedYtChannelId: v.optional(v.string()),
		channelId: v.optional(v.id("channels")),
		outcome: v.optional(submissionOutcomeValidator),
		failureReason: v.optional(v.string()),
	}),
});
