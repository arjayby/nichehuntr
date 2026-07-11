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
import type { Doc, Id } from "./_generated/dataModel";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import {
	channelEnrichmentFor,
	upsertChannelEnrichment,
} from "./model/channelEnrichment";
import {
	type DerivedChannelLifecycle,
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
import { mintNicheQuery } from "./model/nicheQueries";
import {
	mintedNicheQueryValidator,
	signalsValidator,
} from "./model/validators";

/** Recent uploads scanned for a channel before filtering to Shorts. */
const ENRICH_VIDEO_SCAN = 200;

/** Recent Shorts folded into the enrichment input (titles + thumbnails). */
const ENRICH_VIDEO_WINDOW = 6;

/**
 * Load a Channel's recent uploads and derive its current lifecycle — the shared
 * spine of both the per-Channel enrich target and the launch sweep, so the two
 * decide "visible" from one code path rather than two drifting copies. Returns
 * the scanned videos too, since the enrich target still needs them to build the
 * short-form input window.
 */
async function loadChannelLifecycle(
	ctx: QueryCtx,
	channel: Doc<"channels">,
): Promise<{ recent: Doc<"videos">[]; lifecycle: DerivedChannelLifecycle }> {
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
	return { recent, lifecycle };
}

/** Whether a derived lifecycle puts the Channel on the Feed — the single visible
 * predicate the enrich target and the launch sweep share (mirrors feed.ts). */
function isFeedVisible(lifecycle: DerivedChannelLifecycle): boolean {
	return (
		lifecycle.feedVisibility === "visible" && lifecycle.stage !== "tracked"
	);
}

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

		const { recent, lifecycle } = await loadChannelLifecycle(ctx, channel);
		if (!isFeedVisible(lifecycle)) {
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
 * Persist one Channel's freshly scored signals and mint its Niche Queries into
 * the Scout's pool, in one transaction (ADR-0008). Feed and detail reads use the
 * signals cache directly; enrichment never rewrites lifecycle data. The minted
 * phrases are internal Scout fuel — deduped case-insensitively by
 * `mintNicheQuery`, so re-enriching a Channel that mints the same phrase revives
 * it rather than duplicating it.
 */
export const applyChannelEnrichment = internalMutation({
	args: {
		channelId: v.id("channels"),
		signals: signalsValidator,
		fingerprint: v.string(),
		nicheQueries: v.array(mintedNicheQueryValidator),
	},
	handler: async (
		ctx,
		{ channelId, signals, fingerprint, nicheQueries },
	): Promise<null> => {
		await upsertChannelEnrichment(ctx, {
			channelId,
			signals,
			fingerprint,
			enrichedAt: Date.now(),
		});
		for (const query of nicheQueries) {
			await mintNicheQuery(ctx, query);
		}
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

	let result: Awaited<ReturnType<EnrichmentAdapter["enrich"]>>;
	try {
		result = await adapter.enrich(target.input);
	} catch (error) {
		console.error(`enrich failed for channel ${channelId}:`, error);
		return { status: "failed" };
	}

	await ctx.runMutation(internal.enrich.applyChannelEnrichment, {
		channelId,
		signals: result.signals,
		fingerprint: target.fingerprint,
		nicheQueries: result.nicheQueries,
	});
	return { status: "enriched" };
}

// --- One-time launch sweep (seeds the Niche Query pool) ------------------------

/** Safety cap on channels scanned by the one-time launch sweep. Independent of
 * the Feed's own read cap — the visibility *decision* is shared through
 * `loadChannelLifecycle`/`isFeedVisible`; this only bounds how many channels the
 * sweep walks in a single pass. */
const SWEEP_CHANNEL_SCAN = 500;

/**
 * The ids of every currently Feed-visible Channel, recomputing visibility from
 * live DB state exactly as the Feed does. Backs the one-time launch sweep so it
 * spends Anthropic budget only on visible Channels; hidden Tracked Channels are
 * excluded and never scheduled.
 */
export const listVisibleChannelIds = internalQuery({
	args: {},
	handler: async (ctx): Promise<Id<"channels">[]> => {
		const channels = await ctx.db
			.query("channels")
			.order("desc")
			.take(SWEEP_CHANNEL_SCAN);

		const visible: Id<"channels">[] = [];
		for (const channel of channels) {
			const { lifecycle } = await loadChannelLifecycle(ctx, channel);
			if (isFeedVisible(lifecycle)) {
				visible.push(channel._id);
			}
		}
		return visible;
	},
});

/**
 * One-time launch sweep — run out-of-band via
 * `convex run enrich:seedNicheQueryPool`, the same escape hatch as the admin
 * bootstrap. Schedules the standard single-Channel Enrichment worker for every
 * currently Feed-visible Channel, seeding the Niche Query pool from the existing
 * Feed. Only visible Channels are scheduled, so hidden Tracked Channels spend no
 * Anthropic budget. Because the fingerprint version was bumped, already-enriched
 * Channels re-run rather than skip. Safe to re-run: each worker re-checks
 * visibility and fingerprint, so a second sweep is a no-op once the pool is
 * seeded. Returns the number of Channels scheduled.
 */
export const seedNicheQueryPool = internalAction({
	args: {},
	handler: async (ctx): Promise<{ scheduled: number }> => {
		// Same-file runQuery — annotate the result per Convex guidelines so the
		// action's type doesn't depend on inference across the function boundary.
		const channelIds: Id<"channels">[] = await ctx.runQuery(
			internal.enrich.listVisibleChannelIds,
			{},
		);
		for (const channelId of channelIds) {
			await ctx.scheduler.runAfter(
				0,
				internal.enrichChannel.enrichChannelWorker,
				{ channelId },
			);
		}
		return { scheduled: channelIds.length };
	},
});
