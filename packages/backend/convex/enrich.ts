/**
 * The Enrichment pass (Slice 5, ADR-0003): a cron scores each proven Listing's
 * subjective Clonability signals with a multimodal Claude call and caches the
 * result, so the Feed's within-column ranking sharpens.
 *
 *   enrich cron → find proven Listings needing enrichment → Claude call per Listing
 *               → cache signals in `enrichments` → recompute Listings (rides them on)
 *
 * The Claude boundary is a humble adapter (`model/enrichment.ts`); `runEnrich` and
 * the mutations it calls are the tested seam, driven with a stub adapter so no
 * network is hit — mirroring the embed/Saturation pass. The cron `internalAction`
 * that wires the real adapter lives in `enrichCron.ts`: the Anthropic SDK needs the
 * Node.js runtime (`"use node"`), which can't share a file with queries/mutations.
 * Enrichment never gates (ADR-0003): a Listing with no signals yet still renders,
 * just without a Clonability score.
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internalMutation, internalQuery } from "./_generated/server";
import {
	buildEnrichmentFingerprint,
	type EnrichmentAdapter,
	type EnrichmentInput,
	type EnrichmentVideo,
	type Signals,
} from "./model/clonability";
import type { Form } from "./model/deriveListings";
import { recomputeListingsForChannel } from "./model/listings";
import { formValidator, signalsValidator } from "./model/validators";

/** How many Listings one enrich tick scores. Claude calls are the slow/costly
 * step, so keep the batch modest; the fingerprint check skips unchanged ones. */
const ENRICH_BATCH = 20;

/** Proven Listings scanned per form per tick to find staleness. Bounds the read
 * even when nearly everything is already enriched. Tunable. */
const PROVEN_SCAN_LIMIT = 200;

/** Recent uploads scanned per channel before filtering to the form. */
const ENRICH_VIDEO_SCAN = 40;

/** Recent form videos folded into the enrichment input (titles + thumbnails). */
const ENRICH_VIDEO_WINDOW = 6;

/** Enrichments written per mutation. Each touched channel re-derives its Listings
 * (a bounded video read), so the pass spreads across several small mutations. */
const ENRICH_WRITE_BATCH = 10;

const FORMS: readonly Form[] = ["short", "long"];

/** Result of an enrich run, surfaced from the cron/orchestration for logs. */
export type EnrichResult = { enriched: number; failed: number };

// --- Queries & mutations (the DB seam) -----------------------------------------

/**
 * Proven Listings that need enrichment — never scored, or whose inputs changed
 * since they were (fingerprint mismatch) — each with the prebuilt Enrichment input
 * and its current fingerprint. Only Proven Listings are enriched: they're the ones
 * the Feed shows, so scoring an unproven Listing would be wasted spend. Newest
 * Proven first, bounded to a batch.
 */
export const listListingsToEnrich = internalQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, { limit }) => {
		const batch = limit ?? ENRICH_BATCH;
		const out: {
			channelId: Id<"channels">;
			input: EnrichmentInput;
			fingerprint: string;
		}[] = [];

		for (const form of FORMS) {
			if (out.length >= batch) {
				break;
			}
			const proven = await ctx.db
				.query("listings")
				.withIndex("by_form_and_proven", (q) =>
					q.eq("form", form).eq("proven", true),
				)
				.take(PROVEN_SCAN_LIMIT);

			for (const listing of proven) {
				if (out.length >= batch) {
					break;
				}
				const channel = await ctx.db.get("channels", listing.channelId);
				if (channel === null) {
					continue; // orphaned listing — skip defensively
				}

				const recent = await ctx.db
					.query("videos")
					.withIndex("by_channel_and_publishedAt", (q) =>
						q.eq("channelId", listing.channelId),
					)
					.order("desc")
					.take(ENRICH_VIDEO_SCAN);
				const formVideos = recent
					.filter((video) => video.form === form && video.isStandard)
					.slice(0, ENRICH_VIDEO_WINDOW);

				// Build clean objects — omit optional fields when absent rather than
				// setting them to `undefined`, which isn't a valid Convex return value.
				const input: EnrichmentInput = {
					form,
					channelTitle: channel.title,
					videos: formVideos.map((video) => {
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

				const existing = await ctx.db
					.query("enrichments")
					.withIndex("by_channel_and_form", (q) =>
						q.eq("channelId", listing.channelId).eq("form", form),
					)
					.unique();
				if (existing !== null && existing.fingerprint === fingerprint) {
					continue; // cached and unchanged — nothing to re-run
				}
				out.push({ channelId: listing.channelId, input, fingerprint });
			}
		}
		return out;
	},
});

/**
 * Persist a batch of freshly scored signals (upsert per (channel, form)) and
 * recompute each touched channel's Listings so the new Clonability rides onto the
 * Feed. Skips no channel — a re-run always reflects the latest signals; the
 * fingerprint lives on the row so the next tick knows the inputs it scored.
 */
export const applyEnrichment = internalMutation({
	args: {
		items: v.array(
			v.object({
				channelId: v.id("channels"),
				form: formValidator,
				signals: signalsValidator,
				fingerprint: v.string(),
			}),
		),
	},
	handler: async (
		ctx,
		{ items },
	): Promise<{ enriched: number; channelsRecomputed: number }> => {
		const now = Date.now();
		const touched = new Set<Id<"channels">>();
		for (const item of items) {
			const existing = await ctx.db
				.query("enrichments")
				.withIndex("by_channel_and_form", (q) =>
					q.eq("channelId", item.channelId).eq("form", item.form),
				)
				.unique();
			const fields = {
				signals: item.signals,
				fingerprint: item.fingerprint,
				enrichedAt: now,
			};
			if (existing !== null) {
				await ctx.db.patch("enrichments", existing._id, fields);
			} else {
				await ctx.db.insert("enrichments", {
					channelId: item.channelId,
					form: item.form,
					...fields,
				});
			}
			touched.add(item.channelId);
		}
		for (const channelId of touched) {
			await recomputeListingsForChannel(ctx, channelId);
		}
		return { enriched: items.length, channelsRecomputed: touched.size };
	},
});

// --- Orchestration (plain helper, tested with a stub adapter) ------------------

/**
 * Score the Listings that need enrichment and cache the results. One failed
 * Listing (a bad API response, an image that won't load) doesn't sink the tick —
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
	}[] = await ctx.runQuery(internal.enrich.listListingsToEnrich, {
		limit: opts?.limit,
	});
	if (targets.length === 0) {
		return { enriched: 0, failed: 0 };
	}

	const items: {
		channelId: Id<"channels">;
		form: Form;
		signals: Signals;
		fingerprint: string;
	}[] = [];
	let failed = 0;
	for (const target of targets) {
		try {
			const signals = await adapter.enrich(target.input);
			items.push({
				channelId: target.channelId,
				form: target.input.form,
				signals,
				fingerprint: target.fingerprint,
			});
		} catch (error) {
			failed++;
			console.error(
				`enrich failed for channel ${target.channelId} (${target.input.form}):`,
				error,
			);
		}
	}

	for (let i = 0; i < items.length; i += ENRICH_WRITE_BATCH) {
		await ctx.runMutation(internal.enrich.applyEnrichment, {
			items: items.slice(i, i + ENRICH_WRITE_BATCH),
		});
	}
	return { enriched: items.length, failed };
}
