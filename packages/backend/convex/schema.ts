import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
	formValidator,
	nicheQueryOriginValidator,
	signalsValidator,
	sourceValidator,
	stageValidator,
	submissionOutcomeValidator,
	submissionSourceValidator,
	submissionStatusValidator,
} from "./model/validators";

export default defineSchema({
	// The short-form YouTube Channels we track and score directly (ADR-0006).
	channels: defineTable({
		ytId: v.string(),
		title: v.string(),
		handle: v.optional(v.string()),
		avatarUrl: v.optional(v.string()),
		description: v.optional(v.string()),
		// YouTube's public subscriber count. Optional for pre-cutover rows and
		// channels whose stats are hidden; lifecycle derivation treats missing as 0.
		subscriberCount: v.optional(v.number()),
		// Deprecated compatibility fields from the retired Saturation/vector-search
		// lifecycle. No active path writes or reads them.
		embedding: v.optional(v.array(v.float64())),
		saturation: v.optional(v.number()),
		discoveredAt: v.number(),
		source: sourceValidator,
	})
		.index("by_ytId", ["ytId"])
		.index("by_source", ["source"]),

	// Individual uploads. New ingestion stores fetched Shorts with current raw
	// view counts. `form` is a deprecated optional compatibility field for rows
	// written by the earlier per-form Listing model.
	videos: defineTable({
		ytId: v.string(),
		channelId: v.id("channels"),
		title: v.string(),
		thumbnailUrl: v.optional(v.string()),
		durationSec: v.number(),
		form: v.optional(formValidator),
		publishedAt: v.number(),
		currentViewCount: v.optional(v.number()),
		isStandard: v.boolean(),
	})
		.index("by_channel_and_publishedAt", ["channelId", "publishedAt"])
		// Ingestion upserts videos by their YouTube id and the snapshot cron looks
		// them up the same way, so both paths need a direct lookup on `ytId`.
		.index("by_ytId", ["ytId"]),

	// Deprecated compatibility table from the retired snapshot/momentum lifecycle.
	// Kept so old rows can be purged safely by migration; active lifecycle paths
	// do not write or read it.
	videoSnapshots: defineTable({
		videoId: v.id("videos"),
		viewCount: v.number(),
		at: v.number(),
	}).index("by_video_and_at", ["videoId", "at"]),

	// Deprecated compatibility table from the retired per-form Listing lifecycle.
	// Active Feed/Watchlist paths derive Channel lifecycle directly from videos.
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

	// The Enrichment cache: one row per Channel holding the multimodal Claude
	// pass's short-form signal scores (ADR-0003, ADR-0006). Kept off any derived
	// read model because enrichment is expensive and must persist independently of
	// lifecycle recomputes. `fingerprint` digests the inputs the scores came from,
	// so an enrich follow-up re-runs a Channel only when its short-form metadata
	// inputs materially change.
	enrichments: defineTable({
		channelId: v.id("channels"),
		signals: signalsValidator,
		fingerprint: v.string(),
		enrichedAt: v.number(),
	}).index("by_channel", ["channelId"]),

	// The Operator's private Watchlist: one row per (Operator, Channel) pair
	// (CONTEXT.md). Never a listing id and never copied channel data — entries
	// re-derive live Feed state at read time so they survive lifecycle recomputes.
	// `operatorId` is the better-auth user id. Newest-first uses `_creationTime`.
	// `folderId` files the entry into one of the Operator's Folders (CONTEXT.md);
	// absent means the entry sits at the Watchlist root.
	watchlistEntries: defineTable({
		operatorId: v.string(),
		channelId: v.id("channels"),
		folderId: v.optional(v.id("watchlistFolders")),
	})
		// Point lookup for toggle/dedupe on the exact pair; its `operatorId`
		// prefix also serves the per-operator list (ordered by the remaining
		// columns, so the list query uses `by_operator` below instead).
		.index("by_operator_and_channel", ["operatorId", "channelId"])
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

	// Submissions (ADR-0005, ADR-0008): a request to bring a Channel into the Feed,
	// together with its ingestion outcome — the sole way a Channel now enters the
	// system. `source` records which front door it came through: an `admin` paste
	// (the manual-boost path) or the automated `Scout`. `submittedBy` is the
	// better-auth user id of the submitting Admin — optional because Scout
	// submissions have no user. Both are widen-style optionals so pre-Scout rows
	// (which predate `source`) stay valid and read as `admin`; every live write
	// stamps `source`. `rawInput` is the pasted text (trimmed of surrounding
	// whitespace on submit). Status runs `pending → processing → tracked | failed`;
	// a channel that ingests but misses the Feed lifecycle is `tracked`, never
	// `failed`. `failed` is reserved for an unresolvable paste or an API error and
	// carries a human `failureReason`. `resolvedYtChannelId` is the
	// canonical `UC…` id the paste resolved to and `channelId` the row it created or
	// refreshed (idempotent per channel — a re-submit is a manual refresh). Listed
	// newest-first off `_creationTime` for the live table (no extra index needed).
	submissions: defineTable({
		rawInput: v.string(),
		source: v.optional(submissionSourceValidator),
		submittedBy: v.optional(v.string()),
		status: submissionStatusValidator,
		resolvedYtChannelId: v.optional(v.string()),
		channelId: v.optional(v.id("channels")),
		outcome: v.optional(submissionOutcomeValidator),
		failureReason: v.optional(v.string()),
	}),

	// The Scout's Niche Query pool (CONTEXT.md: Niche Query, ADR-0008): free-text
	// search phrases the Scout will run against the YouTube Data API to harvest
	// candidate Channels. Purely internal Scout fuel — never rendered, never
	// filterable, not a taxonomy. Minted as a side effect of Enrichment (a visible
	// Channel's own niche as `seeded`, neighboring niches as `adjacent`) and, in a
	// later slice, the Scout's `wildcat` call. `phrase` is the normalized form
	// (trimmed, lowercased, inner whitespace collapsed) so a case/whitespace-only
	// variant dedupes to a single row via `by_phrase`. `consecutiveZeroYield`
	// counts consecutive Scout runs that harvested no unseen Channel; re-minting an
	// existing phrase revives it by resetting that counter, giving a phrase the
	// Scout was retiring another chance. `lastRunAt` is unset until the Scout first
	// runs it; created-at is the built-in `_creationTime`.
	searchQueries: defineTable({
		phrase: v.string(),
		origin: nicheQueryOriginValidator,
		lastRunAt: v.optional(v.number()),
		consecutiveZeroYield: v.number(),
	}).index("by_phrase", ["phrase"]),
});
