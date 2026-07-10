/**
 * The Enrichment pass (ADR-0003, ADR-0006, ADR-0007): scores one visible
 * short-form Channel's subjective Clonability signals with a multimodal Claude
 * call and caches the result, so the Feed's within-column ranking sharpens.
 *
 *   tracked+visible Submission → schedule enrichChannelWorker(channelId)
 *     → recompute visibility from the DB → skip hidden / unchanged fingerprint
 *     → Claude call for that one Channel → cache signals in `enrichments`
 *
 * Enrichment is Admin-triggered, not cron-driven (ADR-0007): a Submission that
 * lands `tracked` and Feed-visible schedules this follow-up for that Channel
 * only. Hidden Tracked Channels are never enriched until a later Submission
 * refresh makes them visible.
 *
 * The Claude boundary is a humble adapter (`model/enrichment.ts`);
 * `runEnrichChannel` and the mutations it calls are the tested seam, driven with
 * a stub adapter so no network is hit. The `internalAction` that wires the real
 * adapter lives in `enrichChannel.ts`: the Anthropic SDK needs the Node.js
 * runtime (`"use node"`), which can't share a file with queries/mutations.
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
} from "./model/clonability";
import { signalsValidator } from "./model/validators";

/** Recent uploads scanned for a channel before filtering to Shorts. */
const ENRICH_VIDEO_SCAN = 200;

/** Recent Shorts folded into the enrichment input (titles + thumbnails). */
const ENRICH_VIDEO_WINDOW = 6;

/**
 * The outcome of a single-Channel enrich run, surfaced for logs. `skipped`
 * means the Channel isn't visible or its inputs are unchanged, so the adapter
 * was never called; `enriched` persisted fresh signals; `failed` means the
 * adapter threw and nothing was written (the fingerprint stays unwritten so a
 * later refresh retries).
 */
export type EnrichChannelResult = {
	status: "enriched" | "skipped" | "failed";
};

// --- Queries & mutations (the DB seam) -----------------------------------------

/**
 * The Enrichment input + fingerprint for one Channel, or `null` when there's
 * nothing to do: the Channel is gone, isn't Feed-visible (hidden Tracked
 * Channels are never scored — wasted spend), or its inputs are unchanged since
 * the cached signals (fingerprint match). Recomputes visibility from current DB
 * state so a stale scheduled job is harmless.
 */
export const buildChannelEnrichmentTarget = internalQuery({
	args: { channelId: v.id("channels") },
	handler: async (
		ctx,
		{ channelId },
	): Promise<{ input: EnrichmentInput; fingerprint: string } | null> => {
		const channel = await ctx.db.get("channels", channelId);
		if (channel === null) {
			return null;
		}

		const recent = await ctx.db
			.query("videos")
			.withIndex("by_channel_and_publishedAt", (q) =>
				q.eq("channelId", channel._id),
			)
			.order("desc")
			.take(ENRICH_VIDEO_SCAN);

		const lifecycle = deriveChannelLifecycle({
			subscriberCount: channel.subscriberCount ?? 0,
			videos: recent.map(lifecycleVideoFromStoredVideo),
			now: Date.now(),
		});
		if (
			lifecycle.feedVisibility === "hidden" ||
			lifecycle.stage === "tracked"
		) {
			return null;
		}

		const shortVideos = recent
			.filter((video) => video.durationSec <= SHORT_MAX_SEC && video.isStandard)
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
			return null; // cached and unchanged — nothing to re-run
		}
		return { input, fingerprint };
	},
});

/**
 * Persist one Channel's freshly scored signals, upserted by Channel. Feed and
 * detail reads use this cache directly; enrichment never rewrites lifecycle data.
 */
export const applyChannelEnrichment = internalMutation({
	args: {
		channelId: v.id("channels"),
		signals: signalsValidator,
		fingerprint: v.string(),
	},
	handler: async (ctx, { channelId, signals, fingerprint }): Promise<null> => {
		await upsertChannelEnrichment(ctx, {
			channelId,
			signals,
			fingerprint,
			enrichedAt: Date.now(),
		});
		return null;
	},
});

// --- Orchestration (plain helper, tested with a stub adapter) ------------------

/**
 * Score one Channel and cache the result — the Admin-triggered follow-up to a
 * tracked, Feed-visible Submission (ADR-0007). Reloads current DB state, skips a
 * Channel that's no longer visible or whose inputs are unchanged, and calls the
 * adapter only when there's genuinely new work. An adapter throw is isolated:
 * it's logged and reported as `failed`, leaving the fingerprint unwritten so a
 * later refresh retries — and, crucially, never touching the Submission, whose
 * `tracked` status is independent of Enrichment success.
 */
export async function runEnrichChannel(
	ctx: ActionCtx,
	adapter: EnrichmentAdapter,
	channelId: Id<"channels">,
): Promise<EnrichChannelResult> {
	const target = await ctx.runQuery(
		internal.enrich.buildChannelEnrichmentTarget,
		{ channelId },
	);
	if (target === null) {
		return { status: "skipped" };
	}

	let signals: Awaited<ReturnType<EnrichmentAdapter["enrich"]>>;
	try {
		signals = await adapter.enrich(target.input);
	} catch (error) {
		console.error(`enrich failed for channel ${channelId}:`, error);
		return { status: "failed" };
	}

	await ctx.runMutation(internal.enrich.applyChannelEnrichment, {
		channelId,
		signals,
		fingerprint: target.fingerprint,
	});
	return { status: "enriched" };
}
