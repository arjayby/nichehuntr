import { describe, expect, it } from "vitest";

import { setup } from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { runEnrich } from "./enrich";
import type {
	EnrichmentAdapter,
	EnrichmentInput,
	Signals,
} from "./model/clonability";

const DAY = 24 * 60 * 60 * 1000;
const SHORT_SEC = 45;
const LONG_SEC = 600;

async function addChannel(
	ctx: MutationCtx,
	opts: {
		ytId: string;
		title: string;
		description?: string;
		shortViews?: number[];
		longViews?: number[];
	},
): Promise<Id<"channels">> {
	const now = Date.now();
	const channelId = await ctx.db.insert("channels", {
		ytId: opts.ytId,
		title: opts.title,
		description: opts.description,
		subscriberCount: 1_000,
		discoveredAt: now,
		source: "admin",
	});

	for (const [index, viewCount] of (
		opts.shortViews ?? [120_000, 130_000, 10_000]
	).entries()) {
		await addVideo(ctx, {
			channelId,
			ytId: `${opts.ytId}_short_${index}`,
			title: `${opts.title} short ${index}`,
			durationSec: SHORT_SEC,
			viewCount,
			publishedAt: now - (index + 1) * DAY,
		});
	}
	for (const [index, viewCount] of (opts.longViews ?? []).entries()) {
		await addVideo(ctx, {
			channelId,
			ytId: `${opts.ytId}_long_${index}`,
			title: `${opts.title} long ${index}`,
			durationSec: LONG_SEC,
			viewCount,
			publishedAt: now - index * DAY,
		});
	}

	return channelId;
}

async function addVideo(
	ctx: MutationCtx,
	opts: {
		channelId: Id<"channels">;
		ytId: string;
		title: string;
		durationSec: number;
		viewCount: number;
		publishedAt: number;
	},
) {
	await ctx.db.insert("videos", {
		ytId: opts.ytId,
		channelId: opts.channelId,
		title: opts.title,
		thumbnailUrl: `https://img.example/${opts.ytId}.jpg`,
		durationSec: opts.durationSec,
		publishedAt: opts.publishedAt,
		currentViewCount: opts.viewCount,
		isStandard: true,
	});
}

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

const shortSignals = (
	automatable: number,
	transformative: number,
	improvable: number,
): Signals => ({
	automatable: { score: automatable, rationale: "repeatable template" },
	transformative: { score: transformative, rationale: "repackages clips" },
	improvable: { score: improvable, rationale: "weak execution" },
});

async function enrichmentForChannel(
	t: Awaited<ReturnType<typeof setup>>["t"],
	channelId: Id<"channels">,
) {
	return t.run(async (ctx) => {
		const rows = await ctx.db
			.query("enrichments")
			.withIndex("by_channel", (q) => q.eq("channelId", channelId))
			.collect();
		return rows[0] ?? null;
	});
}

describe("runEnrich — channel-level short-form scoring", () => {
	it("writes one channel-level enrichment row and exposes clonability on the Feed", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "shorts",
				title: "AI Shorts",
				description: "Daily AI shorts.",
			}),
		);

		const before = await operator.query(api.feed.feed, {});
		expect(before.flatMap((g) => g.cards)[0]).toMatchObject({
			channelId,
			clonability: null,
			signals: null,
		});

		const { adapter } = stubEnrichment(() => shortSignals(90, 50, 50));
		const result = await t.action((ctx) => runEnrich(ctx, adapter));
		expect(result).toEqual({ enriched: 1, failed: 0 });

		const row = await enrichmentForChannel(t, channelId);
		expect(row).toMatchObject({
			channelId,
			signals: {
				automatable: { score: 90, rationale: "repeatable template" },
				transformative: { score: 50, rationale: "repackages clips" },
				improvable: { score: 50, rationale: "weak execution" },
			},
		});
		expect(row).not.toHaveProperty("form");

		const after = await operator.query(api.feed.feed, {});
		expect(after.flatMap((g) => g.cards)[0]).toMatchObject({
			channelId,
			stage: "breaking_out",
			clonability: 70,
			signals: row?.signals,
		});
	});

	it("builds enrichment input from short-form videos and ignores long-form uploads", async () => {
		const { t } = await setup();
		await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "mixed",
				title: "Mixed Channel",
				longViews: [1_000_000, 900_000],
			}),
		);

		const { adapter, calls } = stubEnrichment(() => shortSignals(50, 50, 50));
		await t.action((ctx) => runEnrich(ctx, adapter));

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			channelTitle: "Mixed Channel",
			videos: [
				{ ytId: "mixed_short_0", title: "Mixed Channel short 0" },
				{ ytId: "mixed_short_1", title: "Mixed Channel short 1" },
				{ ytId: "mixed_short_2", title: "Mixed Channel short 2" },
			],
		});
		expect(calls[0]?.videos.map((video) => video.ytId)).not.toContain(
			"mixed_long_0",
		);
		expect(calls[0]).not.toHaveProperty("form");
		expect(calls[0]?.videos.every((v) => Boolean(v.thumbnailUrl))).toBe(true);
	});

	it("caches by channel and re-runs only when short-form inputs materially change", async () => {
		const { t } = await setup();
		await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "cache",
				title: "Cache Me",
				longViews: [1_000_000],
			}),
		);
		const { adapter, calls } = stubEnrichment(() => shortSignals(70, 50, 50));

		expect((await t.action((ctx) => runEnrich(ctx, adapter))).enriched).toBe(1);
		expect(calls).toHaveLength(1);

		expect((await t.action((ctx) => runEnrich(ctx, adapter))).enriched).toBe(0);
		expect(calls).toHaveLength(1);

		await t.run(async (ctx) => {
			const long = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", "cache_long_0"))
				.unique();
			if (long !== null) {
				await ctx.db.patch(long._id, { title: "Long retitle ignored" });
			}
		});
		expect((await t.action((ctx) => runEnrich(ctx, adapter))).enriched).toBe(0);
		expect(calls).toHaveLength(1);

		await t.run(async (ctx) => {
			const short = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", "cache_short_0"))
				.unique();
			if (short !== null) {
				await ctx.db.patch(short._id, { title: "Cache Me retitled" });
			}
		});
		expect((await t.action((ctx) => runEnrich(ctx, adapter))).enriched).toBe(1);
		expect(calls).toHaveLength(2);
	});

	it("collapses duplicate channel enrichment rows when refreshing stale signals", async () => {
		const { t } = await setup();
		const channelId = await t.run(async (ctx) => {
			const id = await addChannel(ctx, { ytId: "dupe", title: "Deduped" });
			await ctx.db.insert("enrichments", {
				channelId: id,
				fingerprint: "stale-1",
				enrichedAt: Date.now() - 10,
				signals: {
					improvable: { score: 10, rationale: "legacy partial row" },
				},
			});
			await ctx.db.insert("enrichments", {
				channelId: id,
				fingerprint: "stale-2",
				enrichedAt: Date.now() - 5,
				signals: {
					automatable: { score: 20, rationale: "legacy duplicate row" },
					transformative: { score: 20, rationale: "legacy duplicate row" },
					improvable: { score: 20, rationale: "legacy duplicate row" },
				},
			});
			return id;
		});

		const { adapter } = stubEnrichment(() => shortSignals(80, 60, 40));
		expect((await t.action((ctx) => runEnrich(ctx, adapter))).enriched).toBe(1);

		const rows = await t.run((ctx) =>
			ctx.db
				.query("enrichments")
				.withIndex("by_channel", (q) => q.eq("channelId", channelId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.signals.automatable?.score).toBe(80);
	});

	it("reuses channel enrichment across lifecycle reads", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "keep", title: "Keep Me" }),
		);

		const { adapter } = stubEnrichment(() => shortSignals(90, 30, 30));
		await t.action((ctx) => runEnrich(ctx, adapter));
		expect(
			(await operator.query(api.feed.feed, {})).flatMap((g) => g.cards)[0]
				?.clonability,
		).toBe(60);

		const card = (await operator.query(api.feed.feed, {}))
			.flatMap((g) => g.cards)
			.find((item) => item.channelId === channelId);
		expect(card?.clonability).toBe(60);
		expect(card?.signals?.automatable.score).toBe(90);
	});
});
