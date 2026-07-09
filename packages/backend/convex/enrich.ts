/**
 * The Enrichment pass (ADR-0003, ADR-0006): a cron scores each visible short-form
 * Channel's subjective Clonability signals with a multimodal Claude call and
 * caches the result, so the Feed's within-column ranking sharpens.
 *
 *   enrich cron → find visible Channels needing enrichment → Claude call per Channel
 *               → cache signals in `enrichments`
 *
 * The Claude boundary is a humble adapter (`model/enrichment.ts`); `runEnrich` and
 * the mutations it calls are the tested seam, driven with a stub adapter so no
 * network is hit. The cron `internalAction`
 * that wires the real adapter lives in `enrichCron.ts`: the Anthropic SDK needs the
 * Node.js runtime (`"use node"`), which can't share a file with queries/mutations.
 * Enrichment never gates (ADR-0003): a Channel with no signals yet still renders,
 * just without a Clonability score.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import {
	channelEnrichmentFor,
	upsertChannelEnrichment,
} from "./model/channelEnrichment";
import {
	deriveChannelLifecycle,
	lifecycleVideoFromStoredVideo,
	SHORT_MAX_SEC,
} from "./model/channelLifecycle";
import {
	buildEnrichmentFingerprint,
	type EnrichmentAdapter,
	type EnrichmentInput,
	type EnrichmentVideo,
	type Signals,
} from "./model/clonability";
import { signalsValidator } from "./model/validators";

/** How many Channels one enrich tick scores. Claude calls are the slow/costly
 * step, so keep the batch modest; the fingerprint check skips unchanged ones. */
const ENRICH_BATCH = 20;

/** Channels scanned per tick to find staleness. Bounds the read
 * even when nearly everything is already enriched. Tunable. */
const CHANNEL_SCAN_LIMIT = 500;

/** Recent uploads scanned per channel before filtering to Shorts. */
const ENRICH_VIDEO_SCAN = 200;

/** Recent Shorts folded into the enrichment input (titles + thumbnails). */
const ENRICH_VIDEO_WINDOW = 6;

/** Enrichments written per mutation. */
const ENRICH_WRITE_BATCH = 10;

/** Result of an enrich run, surfaced from the cron/orchestration for logs. */
export type EnrichResult = { enriched: number; failed: number };

// --- Queries & mutations (the DB seam) -----------------------------------------

/**
 * Visible Channels that need enrichment — never scored, or whose inputs changed
 * since they were (fingerprint mismatch) — each with the prebuilt Enrichment input
 * and its current fingerprint. Only visible Channels are enriched: they're the
 * ones the Feed shows, so scoring hidden Tracked Channels would be wasted spend.
 * Newest Channels first, bounded to a batch.
 */
export const listChannelsToEnrich = internalQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, { limit }) => {
		const batch = limit ?? ENRICH_BATCH;
		const targets: {
			channelId: Id<"channels">;
			input: EnrichmentInput;
			fingerprint: string;
		}[] = [];
		const channels = await ctx.db
			.query("channels")
			.order("desc")
			.take(CHANNEL_SCAN_LIMIT);

		for (const channel of channels) {
			if (targets.length >= batch) {
				break;
			}
			const recent = await ctx.db
				.query("videos")
				.withIndex("by_channel_and_publishedAt", (q) =>
					q.eq("channelId", channel._id),
				)
				.order("desc")
				.take(ENRICH_VIDEO_SCAN);

			const lifecycleVideos = recent.map(lifecycleVideoFromStoredVideo);
			const lifecycle = deriveChannelLifecycle({
				subscriberCount: channel.subscriberCount ?? 0,
				videos: lifecycleVideos,
				now: Date.now(),
			});
			if (
				lifecycle.feedVisibility === "hidden" ||
				lifecycle.stage === "tracked"
			) {
				continue;
			}

			const shortVideos = recent
				.filter(
					(video) => video.durationSec <= SHORT_MAX_SEC && video.isStandard,
				)
				.slice(0, ENRICH_VIDEO_WINDOW);

			// Build clean objects — omit optional fields when absent rather than
			// setting them to `undefined`, which isn't a valid Convex return value.
			const input: EnrichmentInput = {
				channelTitle: channel.title,
				videos: shortVideos.map((video) => {
					const entry: EnrichmentVideo = {
						ytId: video.ytId,
						title: video.title,
					};
					if (video.thumbnailUrl !== undefined) {
						entry.thumbnailUrl = video.thumbnailUrl;
					}
					return entry;
				}),
			};
			if (channel.description !== undefined) {
				input.channelDescription = channel.description;
			}
			const fingerprint = buildEnrichmentFingerprint(input);

			const existing = await channelEnrichmentFor(ctx, channel._id);
			if (existing !== null && existing.fingerprint === fingerprint) {
				continue; // cached and unchanged — nothing to re-run
			}
			targets.push({ channelId: channel._id, input, fingerprint });
		}
		return targets;
	},
});

/**
 * Persist a batch of freshly scored signals, upserted per Channel. Feed and
 * detail reads use this cache directly; enrichment never rewrites lifecycle data.
 */
export const applyEnrichment = internalMutation({
	args: {
		items: v.array(
			v.object({
				channelId: v.id("channels"),
				signals: signalsValidator,
				fingerprint: v.string(),
			}),
		),
	},
	handler: async (ctx, { items }): Promise<{ enriched: number }> => {
		const now = Date.now();
		for (const item of items) {
			await upsertChannelEnrichment(ctx, {
				channelId: item.channelId,
				signals: item.signals,
				fingerprint: item.fingerprint,
				enrichedAt: now,
			});
		}
		return { enriched: items.length };
	},
});

// --- Orchestration (plain helper, tested with a stub adapter) ------------------

/**
 * Score the Channels that need enrichment and cache the results. One failed
 * Channel (a bad API response, an image that won't load) doesn't sink the tick —
 * it's counted and retried next run, since its fingerprint stays unwritten.
 */
export async function runEnrich(
	ctx: ActionCtx,
	adapter: EnrichmentAdapter,
	opts?: { limit?: number },
): Promise<EnrichResult> {
	const targets: {
		channelId: Id<"channels">;
		input: EnrichmentInput;
		fingerprint: string;
	}[] = await ctx.runQuery(internal.enrich.listChannelsToEnrich, {
		limit: opts?.limit,
	});
	if (targets.length === 0) {
		return { enriched: 0, failed: 0 };
	}

	const items: {
		channelId: Id<"channels">;
		signals: Signals;
		fingerprint: string;
	}[] = [];
	let failed = 0;
	for (const target of targets) {
		try {
			const signals = await adapter.enrich(target.input);
			items.push({
				channelId: target.channelId,
				signals,
				fingerprint: target.fingerprint,
			});
		} catch (error) {
			failed++;
			console.error(`enrich failed for channel ${target.channelId}:`, error);
		}
	}

	for (let i = 0; i < items.length; i += ENRICH_WRITE_BATCH) {
		await ctx.runMutation(internal.enrich.applyEnrichment, {
			items: items.slice(i, i + ENRICH_WRITE_BATCH),
		});
	}
	return { enriched: items.length, failed };
}
