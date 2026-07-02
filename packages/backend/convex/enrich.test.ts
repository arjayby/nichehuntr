/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { runEnrich } from "./enrich";
import type { FeedCard, FeedGroup } from "./feed";
import type {
	EnrichmentAdapter,
	EnrichmentInput,
	Signals,
} from "./model/clonability";
import { recomputeListingsForChannel } from "./model/listings";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const LONG_SEC = 600; // > 180s ⇒ long-form; long Proven threshold is 100k.

/**
 * Insert a proven, strongly-accelerating long-form channel (three uploads rising
 * 100k→150k over 2 days on a 150k baseline) and derive its Listing. On momentum
 * alone it is Breaking Out — the clean baseline for showing enrichment adds a
 * Clonability score without touching the Proven gate or the Stage.
 */
async function addStrongChannel(
	ctx: MutationCtx,
	opts: { ytId: string; title: string; description?: string },
): Promise<Id<"channels">> {
	const now = Date.now();
	const channelId = await ctx.db.insert("channels", {
		ytId: opts.ytId,
		title: opts.title,
		description: opts.description,
		discoveredAt: now,
		source: "trending",
	});
	for (let i = 0; i < 3; i++) {
		const videoId = await ctx.db.insert("videos", {
			ytId: `${opts.ytId}_v${i}`,
			channelId,
			title: `${opts.title} upload ${i}`,
			thumbnailUrl: `https://img.example/${opts.ytId}_${i}.jpg`,
			durationSec: LONG_SEC,
			form: "long",
			publishedAt: now - 30 * DAY,
			isStandard: true,
		});
		await ctx.db.insert("videoSnapshots", {
			videoId,
			viewCount: 100_000,
			at: now - 2 * DAY,
		});
		await ctx.db.insert("videoSnapshots", {
			videoId,
			viewCount: 150_000,
			at: now,
		});
	}
	await recomputeListingsForChannel(ctx, channelId);
	return channelId;
}

/** A stub enrichment adapter that records its calls, so no network is hit and the
 * cron's caching (call-count) can be asserted — mirroring `stubEmbeddings`. */
function stubEnrichment(signalsFor: (input: EnrichmentInput) => Signals) {
	const calls: EnrichmentInput[] = [];
	const adapter: EnrichmentAdapter = {
		enrich: async (input) => {
			calls.push(input);
			return signalsFor(input);
		},
	};
	return { adapter, calls };
}

/** Long-form signals whose even weighting makes Clonability the plain mean. */
const longSignals = (enterprise: number, improvable: number): Signals => ({
	enterprise_value: { score: enterprise, rationale: "high-CPM niche" },
	improvable: { score: improvable, rationale: "thumbnails are weak" },
});

function cardByTitle(groups: FeedGroup[], title: string): FeedCard | undefined {
	return groups.flatMap((g) => g.cards).find((c) => c.channel.title === title);
}

const longFeed = (t: ReturnType<typeof convexTest>) =>
	t.withIdentity({ subject: "u" }).query(api.feed.feed, { form: "long" });

describe("runEnrich — Clonability scoring", () => {
	it("rides a Clonability score and rationales onto the feed card", async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "fin", title: "Deep Finance" }),
		);

		// Proven and Breaking Out, but no Clonability yet (graceful degradation).
		const before = cardByTitle(await longFeed(t), "Deep Finance");
		expect(before?.clonability).toBeNull();
		expect(before?.signals).toBeNull();
		expect(before?.stage).toBe("breaking_out");

		const { adapter } = stubEnrichment(() => longSignals(80, 40));
		const result = await t.action((ctx) => runEnrich(ctx, adapter));
		expect(result).toEqual({ enriched: 1, failed: 0 });

		const after = cardByTitle(await longFeed(t), "Deep Finance");
		expect(after?.clonability).toBe(60); // (80 + 40) / 2
		expect(after?.signals?.enterprise_value?.rationale).toBe("high-CPM niche");
		// Enrichment never gates and never moves Stage (ADR-0003).
		expect(after?.stage).toBe("breaking_out");
	});

	it("still renders a proven Listing that has never been enriched", async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "raw", title: "Unenriched" }),
		);

		const card = cardByTitle(await longFeed(t), "Unenriched");
		expect(card).toBeDefined();
		expect(card?.clonability).toBeNull();
		expect(card?.signals).toBeNull();
	});

	it("passes the channel's thumbnails to the adapter", async () => {
		const t = convexTest(schema, modules);
		await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "th", title: "Thumbs" }),
		);

		const { adapter, calls } = stubEnrichment(() => longSignals(50, 50));
		await t.action((ctx) => runEnrich(ctx, adapter));

		expect(calls).toHaveLength(1);
		expect(calls[0]?.videos.every((v) => Boolean(v.thumbnailUrl))).toBe(true);
	});
});

describe("runEnrich — caching & material change", () => {
	it("caches results and re-runs only when inputs materially change", async () => {
		const t = convexTest(schema, modules);
		const channelId = await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "cache", title: "Cache Me" }),
		);
		const { adapter, calls } = stubEnrichment(() => longSignals(70, 50));

		const first = await t.action((ctx) => runEnrich(ctx, adapter));
		expect(first.enriched).toBe(1);
		expect(calls).toHaveLength(1);

		// Nothing changed ⇒ the fingerprint matches ⇒ no re-run, no extra call.
		const second = await t.action((ctx) => runEnrich(ctx, adapter));
		expect(second.enriched).toBe(0);
		expect(calls).toHaveLength(1);

		// Edit an upload title ⇒ material change ⇒ re-enriched.
		await t.run(async (ctx) => {
			const video = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", "cache_v0"))
				.unique();
			if (video !== null) {
				await ctx.db.patch("videos", video._id, {
					title: "Cache Me — retitled",
				});
			}
			await recomputeListingsForChannel(ctx, channelId);
		});

		const third = await t.action((ctx) => runEnrich(ctx, adapter));
		expect(third.enriched).toBe(1);
		expect(calls).toHaveLength(2);
	});

	it("preserves Clonability across a later recompute (survives the clobber)", async () => {
		const t = convexTest(schema, modules);
		const channelId = await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "keep", title: "Keep Me" }),
		);

		const { adapter } = stubEnrichment(() => longSignals(90, 30));
		await t.action((ctx) => runEnrich(ctx, adapter));
		expect(cardByTitle(await longFeed(t), "Keep Me")?.clonability).toBe(60);

		// A later pipeline tick deletes and re-inserts this channel's Listings.
		await t.run((ctx) => recomputeListingsForChannel(ctx, channelId));

		const card = cardByTitle(await longFeed(t), "Keep Me");
		expect(card?.clonability).toBe(60); // re-applied from the cache, not lost
		expect(card?.signals?.enterprise_value?.score).toBe(90);
	});
});

describe("runEnrich — within-column ranking", () => {
	it("sorts a Stage column by Clonability so the strongest clone target leads", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await addStrongChannel(ctx, { ytId: "lo", title: "Low Clone" });
			await addStrongChannel(ctx, { ytId: "hi", title: "High Clone" });
		});

		const { adapter } = stubEnrichment((input) =>
			input.channelTitle.startsWith("High")
				? longSignals(90, 90)
				: longSignals(20, 20),
		);
		await t.action((ctx) => runEnrich(ctx, adapter));

		const column = (await longFeed(t)).find((g) => g.stage === "breaking_out");
		const titles = column?.cards.map((c) => c.channel.title) ?? [];
		expect(titles.indexOf("High Clone")).toBeLessThan(
			titles.indexOf("Low Clone"),
		);
	});
});
