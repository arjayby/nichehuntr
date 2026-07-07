/**
 * Live ingestion upkeep (ADR-0001, ADR-0003, ADR-0005). Automated discovery is
 * gone (ADR-0005): channels enter only by admin Submission, so this file keeps
 * the judgment engine fed rather than sourcing new channels.
 *
 *   snapshot cron  → re-sample tracked videos → write Snapshots → derive Listings
 *   embed cron     → embed channels → vector-search cluster size → write Saturation
 *
 * `upsertDiscovered` remains the shared channel/video/snapshot write path — a
 * later slice's Submission worker calls it to intake a submitted channel.
 *
 * The YouTube and embeddings boundaries are humble adapters (`model/youtube.ts`,
 * `model/embeddings.ts`). The cron `internalAction`s wire the real adapters from
 * env; the `run*` orchestration and the mutations they call are the tested seam,
 * driven in tests with stub adapters so no network is hit. Vector search is
 * action-only, so Saturation is measured in `runEmbed`, not the recompute mutation.
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
import {
	buildChannelEmbeddingText,
	createVoyageEmbeddingsAdapter,
	EMBEDDING_DIMENSIONS,
	type EmbeddingsAdapter,
} from "./model/embeddings";
import { recomputeListingsForChannel } from "./model/listings";
import { sourceValidator } from "./model/validators";
import { createYouTubeAdapter, type YouTubeAdapter } from "./model/youtube";

/** Ceiling on videos re-sampled per snapshot run — bounds the query and keeps
 * the batched stats requests within a sane quota per cron tick. Tunable. */
const SNAPSHOT_VIDEO_LIMIT = 500;

/** Bound on the tracked set a single embed/saturation tick scans. At this scale
 * it covers the whole catalog; a later slice paginates past it. Tunable. */
const CHANNEL_SCAN_LIMIT = 1000;

/** How many missing embeddings one embed tick backfills — one Voyage batch. */
const EMBED_BATCH = 128;

/** Recent upload titles folded into a channel's embedding text (sharpest niche
 * signal). Matches the embeddings adapter's own cap. */
const EMBED_TITLE_COUNT = 8;

/** Neighbors pulled per channel when sizing its niche cluster. Saturation caps
 * out at "crowded", so a count past this reads as crowded either way. 1–256. */
const SATURATION_NEIGHBOR_LIMIT = 64;

/** Channels whose Saturation is written per mutation. Bounds the work of one
 * transaction: each changed channel re-derives its Listings (a bounded video
 * read), so the whole pass is spread across several small mutations. Tunable. */
const SATURATION_WRITE_BATCH = 25;

/**
 * Minimum cosine similarity for two channels to count as the same niche. Vector
 * scores run −1…1; same-niche content clusters high, so this sits well above 0.
 * Tunable — the single knob that widens or tightens what "similar" means.
 */
const SIMILARITY_THRESHOLD = 0.75;

/** Result of an ingestion run, surfaced from the cron/orchestration for logs. */
export type DiscoveryResult = {
	channels: number;
	videos: number;
	channelsRecomputed: number;
};
export type SnapshotResult = { snapshots: number; channelsRecomputed: number };
export type EmbedResult = { embedded: number; saturated: number };

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
		// Provenance stamped on newly-inserted channels. The Submission worker
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

/**
 * Channels still missing an embedding, with the text to embed prebuilt from their
 * metadata and recent upload titles. Filtered in JS rather than the query because
 * an unset optional field isn't indexable; the scan is newest-first and bounded to
 * the catalog, so freshly discovered channels are always embedded first (a later
 * slice paginates past the cap).
 */
export const listChannelsToEmbed = internalQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (
		ctx,
		{ limit },
	): Promise<{ channelId: Id<"channels">; text: string }[]> => {
		const channels = await ctx.db
			.query("channels")
			.order("desc")
			.take(CHANNEL_SCAN_LIMIT);
		const missing = channels
			.filter((c) => c.embedding === undefined)
			.slice(0, limit ?? EMBED_BATCH);

		const out: { channelId: Id<"channels">; text: string }[] = [];
		for (const channel of missing) {
			const videos = await ctx.db
				.query("videos")
				.withIndex("by_channel_and_publishedAt", (q) =>
					q.eq("channelId", channel._id),
				)
				.order("desc")
				.take(EMBED_TITLE_COUNT);
			out.push({
				channelId: channel._id,
				text: buildChannelEmbeddingText(
					{ title: channel.title, description: channel.description },
					videos.map((video) => video.title),
				),
			});
		}
		return out;
	},
});

/** Persist backfilled embeddings. A wrong-width vector (malformed provider
 * response) is skipped rather than stored, since the index would reject it. */
export const saveEmbeddings = internalMutation({
	args: {
		items: v.array(
			v.object({
				channelId: v.id("channels"),
				embedding: v.array(v.number()),
			}),
		),
	},
	handler: async (ctx, { items }): Promise<{ embedded: number }> => {
		let embedded = 0;
		for (const item of items) {
			if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
				continue;
			}
			await ctx.db.patch("channels", item.channelId, {
				embedding: item.embedding,
			});
			embedded++;
		}
		return { embedded };
	},
});

/** Embedded channels and their vectors, the query side of the Saturation pass.
 * Newest-first and bounded, mirroring the embed backfill's scan. */
export const listEmbeddedChannels = internalQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (
		ctx,
		{ limit },
	): Promise<{ channelId: Id<"channels">; embedding: number[] }[]> => {
		const channels = await ctx.db
			.query("channels")
			.order("desc")
			.take(CHANNEL_SCAN_LIMIT);
		const cap = limit ?? CHANNEL_SCAN_LIMIT;
		const out: { channelId: Id<"channels">; embedding: number[] }[] = [];
		for (const channel of channels) {
			if (channel.embedding === undefined) {
				continue;
			}
			out.push({ channelId: channel._id, embedding: channel.embedding });
			if (out.length >= cap) {
				break;
			}
		}
		return out;
	},
});

/**
 * Write each channel's freshly measured Saturation and re-derive its Listings so
 * Stage reflects the niche's crowdedness (a crowded niche dominates → Established).
 * Skips a channel whose Saturation is unchanged — most channels hold steady tick
 * to tick, and recomputing rewrites Listings, so this avoids needless reactive
 * churn on the Feed. Called in small batches so one mutation never recomputes an
 * unbounded set (each recompute reads a channel's recent videos).
 */
export const applySaturation = internalMutation({
	args: {
		items: v.array(
			v.object({
				channelId: v.id("channels"),
				saturation: v.number(),
			}),
		),
	},
	handler: async (ctx, { items }): Promise<{ channelsRecomputed: number }> => {
		let recomputed = 0;
		for (const item of items) {
			const channel = await ctx.db.get("channels", item.channelId);
			if (channel === null || channel.saturation === item.saturation) {
				continue; // gone, or already at this value — nothing to rewrite
			}
			await ctx.db.patch("channels", item.channelId, {
				saturation: item.saturation,
			});
			await recomputeListingsForChannel(ctx, item.channelId);
			recomputed++;
		}
		return { channelsRecomputed: recomputed };
	},
});

// --- Orchestration (plain helpers, tested with a stub adapter) -----------------

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

/**
 * The embed + Saturation pass (ADR-0003). First backfills channel embeddings for a
 * bounded batch missing one; then, over every embedded channel, sizes its niche
 * cluster with vector search (neighbors within `SIMILARITY_THRESHOLD`) and writes
 * that Saturation back — which re-derives Stage, letting a crowded niche dominate.
 * Vector search is action-only, so the whole pass lives here rather than in the
 * recompute mutation.
 */
export async function runEmbed(
	ctx: ActionCtx,
	adapter: EmbeddingsAdapter,
	opts?: { embedLimit?: number; saturateLimit?: number },
): Promise<EmbedResult> {
	const toEmbed = await ctx.runQuery(internal.ingest.listChannelsToEmbed, {
		limit: opts?.embedLimit,
	});
	if (toEmbed.length > 0) {
		const vectors = await adapter.embed(toEmbed.map((c) => c.text));
		await ctx.runMutation(internal.ingest.saveEmbeddings, {
			items: toEmbed.map((c, i) => ({
				channelId: c.channelId,
				embedding: vectors[i] ?? [],
			})),
		});
	}

	const embedded = await ctx.runQuery(internal.ingest.listEmbeddedChannels, {
		limit: opts?.saturateLimit,
	});
	const items: { channelId: Id<"channels">; saturation: number }[] = [];
	for (const channel of embedded) {
		const neighbors = await ctx.vectorSearch("channels", "by_embedding", {
			vector: channel.embedding,
			limit: SATURATION_NEIGHBOR_LIMIT,
		});
		const saturation = neighbors.filter(
			(n) => n._id !== channel.channelId && n._score >= SIMILARITY_THRESHOLD,
		).length;
		items.push({ channelId: channel.channelId, saturation });
	}

	// Spread the writes across small mutations so no single transaction recomputes
	// an unbounded set of Listings.
	for (let i = 0; i < items.length; i += SATURATION_WRITE_BATCH) {
		await ctx.runMutation(internal.ingest.applySaturation, {
			items: items.slice(i, i + SATURATION_WRITE_BATCH),
		});
	}
	return { embedded: toEmbed.length, saturated: items.length };
}

// --- Cron entrypoints ----------------------------------------------------------

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

/** Build the live embeddings adapter, failing loudly if its key isn't set. */
function liveEmbeddingsAdapter(): EmbeddingsAdapter {
	const apiKey = process.env.VOYAGE_API_KEY;
	if (!apiKey) {
		throw new Error(
			"VOYAGE_API_KEY is not set — configure it in the Convex dashboard.",
		);
	}
	return createVoyageEmbeddingsAdapter(apiKey);
}

export const snapshotCron = internalAction({
	args: {},
	handler: async (ctx): Promise<SnapshotResult> =>
		runSnapshot(ctx, liveYouTubeAdapter()),
});

export const embedCron = internalAction({
	args: {},
	handler: async (ctx): Promise<EmbedResult> =>
		runEmbed(ctx, liveEmbeddingsAdapter()),
});
