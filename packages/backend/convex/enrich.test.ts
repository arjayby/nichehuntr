import { describe, expect, it } from "vitest";
import { setup } from "../test/harness";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { runEnrich } from "./enrich";
import type {
	EnrichmentAdapter,
	EnrichmentInput,
	Signals,
} from "./model/clonability";
import type { Form } from "./model/deriveListings";
import { recomputeListingsForChannel } from "./model/listings";

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

async function listingByTitle(
	t: Awaited<ReturnType<typeof setup>>["t"],
	title: string,
	form: Form = "long",
) {
	return t.run(async (ctx) => {
		const channels = await ctx.db.query("channels").collect();
		const channel = channels.find((row) => row.title === title);
		if (channel === undefined) {
			return null;
		}
		const listings = await ctx.db
			.query("listings")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.collect();
		return listings.find((row) => row.form === form) ?? null;
	});
}

describe("runEnrich — Clonability scoring", () => {
	it("rides a Clonability score and rationales onto the Listing", async () => {
		const { t } = await setup();
		await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "fin", title: "Deep Finance" }),
		);

		// Proven and Breaking Out, but no Clonability yet (graceful degradation).
		const before = await listingByTitle(t, "Deep Finance");
		expect(before?.clonability).toBeNull();
		expect(before?.signals).toBeNull();
		expect(before?.stage).toBe("breaking_out");

		const { adapter } = stubEnrichment(() => longSignals(80, 40));
		const result = await t.action((ctx) => runEnrich(ctx, adapter));
		expect(result).toEqual({ enriched: 1, failed: 0 });

		const after = await listingByTitle(t, "Deep Finance");
		expect(after?.clonability).toBe(60); // (80 + 40) / 2
		expect(after?.signals?.enterprise_value?.rationale).toBe("high-CPM niche");
		// Enrichment never gates and never moves Stage (ADR-0003).
		expect(after?.stage).toBe("breaking_out");
	});

	it("keeps a proven Listing visible to downstream reads before enrichment", async () => {
		const { t } = await setup();
		await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "raw", title: "Unenriched" }),
		);

		const listing = await listingByTitle(t, "Unenriched");
		expect(listing?.proven).toBe(true);
		expect(listing?.clonability).toBeNull();
		expect(listing?.signals).toBeNull();
	});

	it("passes the channel's thumbnails to the adapter", async () => {
		const { t } = await setup();
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
		const { t } = await setup();
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
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addStrongChannel(ctx, { ytId: "keep", title: "Keep Me" }),
		);

		const { adapter } = stubEnrichment(() => longSignals(90, 30));
		await t.action((ctx) => runEnrich(ctx, adapter));
		expect((await listingByTitle(t, "Keep Me"))?.clonability).toBe(60);

		// A later pipeline tick deletes and re-inserts this channel's Listings.
		await t.run((ctx) => recomputeListingsForChannel(ctx, channelId));

		const listing = await listingByTitle(t, "Keep Me");
		expect(listing?.clonability).toBe(60); // re-applied from the cache, not lost
		expect(listing?.signals?.enterprise_value?.score).toBe(90);
	});
});

describe("runEnrich — within-column ranking", () => {
	it("sorts a Stage column by Clonability so the strongest clone target leads", async () => {
		const { t } = await setup();
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

		const listings = await t.run(async (ctx) => {
			const channels = await ctx.db.query("channels").collect();
			const names = new Map(channels.map((c) => [c._id, c.title]));
			return (await ctx.db.query("listings").collect())
				.filter((listing) => listing.stage === "breaking_out")
				.sort((a, b) => (b.clonability ?? -1) - (a.clonability ?? -1))
				.map((listing) => names.get(listing.channelId));
		});
		const titles = listings.filter(
			(title): title is string => title !== undefined,
		);
		expect(titles.indexOf("High Clone")).toBeLessThan(
			titles.indexOf("Low Clone"),
		);
	});
});
