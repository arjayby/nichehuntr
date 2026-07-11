import { describe, expect, it } from "vitest";

import { setup } from "../test/harness";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { runEnrichChannel } from "./enrich";
import type {
	EnrichmentAdapter,
	EnrichmentInput,
	EnrichmentNicheQuery,
	EnrichmentResult,
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

function stubEnrichment(
	resultFor: (input: EnrichmentInput) => EnrichmentResult,
) {
	const calls: EnrichmentInput[] = [];
	const adapter: EnrichmentAdapter = {
		enrich: async (input) => {
			calls.push(input);
			return resultFor(input);
		},
	};
	return { adapter, calls };
}

/** Wrap signals (and optional minted Niche Queries) as an adapter result. */
const enrichResult = (
	signals: Signals,
	nicheQueries: EnrichmentNicheQuery[] = [],
): EnrichmentResult => ({ signals, nicheQueries });

/** An adapter whose `enrich` always throws — proves a skipped Channel never
 * reaches it, and that a failing call writes nothing. */
function throwingEnrichment() {
	const calls: EnrichmentInput[] = [];
	const adapter: EnrichmentAdapter = {
		enrich: async (input) => {
			calls.push(input);
			throw new Error("Anthropic API error");
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

describe("runEnrichChannel — single-channel short-form scoring", () => {
	it("scores a visible channel and exposes clonability on the Feed", async () => {
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

		const { adapter } = stubEnrichment(() =>
			enrichResult(shortSignals(90, 50, 50)),
		);
		const result = await t.action((ctx) =>
			runEnrichChannel(ctx, adapter, channelId),
		);
		expect(result).toEqual({ status: "enriched" });

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
		const channelId = await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "mixed",
				title: "Mixed Channel",
				longViews: [1_000_000, 900_000],
			}),
		);

		const { adapter, calls } = stubEnrichment(() =>
			enrichResult(shortSignals(50, 50, 50)),
		);
		await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId));

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

	it("skips a hidden channel without touching the adapter or writing signals", async () => {
		const { t } = await setup();
		// Weak short-form reach ⇒ tracked/hidden, so it must never be enriched.
		const channelId = await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "hidden",
				title: "Hidden Tracked",
				shortViews: [10_000, 12_000, 9_000],
			}),
		);

		const { adapter, calls } = throwingEnrichment();
		const result = await t.action((ctx) =>
			runEnrichChannel(ctx, adapter, channelId),
		);

		expect(result).toEqual({ status: "skipped" });
		expect(calls).toHaveLength(0);
		expect(await enrichmentForChannel(t, channelId)).toBeNull();
	});

	it("skips a channel that vanished before the follow-up ran", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "ghost", title: "Ghost" }),
		);
		await t.run(async (ctx) => {
			await ctx.db.delete("channels", channelId);
		});

		const { adapter, calls } = throwingEnrichment();
		const result = await t.action((ctx) =>
			runEnrichChannel(ctx, adapter, channelId),
		);
		expect(result).toEqual({ status: "skipped" });
		expect(calls).toHaveLength(0);
	});

	it("re-runs only when short-form inputs materially change", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "cache",
				title: "Cache Me",
				longViews: [1_000_000],
			}),
		);
		const { adapter, calls } = stubEnrichment(() =>
			enrichResult(shortSignals(70, 50, 50)),
		);

		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });
		expect(calls).toHaveLength(1);

		// Unchanged inputs ⇒ fingerprint matches ⇒ no adapter call.
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "skipped" });
		expect(calls).toHaveLength(1);

		// Retitling a long-form upload doesn't change the short-form fingerprint.
		await t.run(async (ctx) => {
			const long = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", "cache_long_0"))
				.unique();
			if (long !== null) {
				await ctx.db.patch(long._id, { title: "Long retitle ignored" });
			}
		});
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "skipped" });
		expect(calls).toHaveLength(1);

		// Retitling a Short does — the fingerprint changes and it re-runs.
		await t.run(async (ctx) => {
			const short = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", "cache_short_0"))
				.unique();
			if (short !== null) {
				await ctx.db.patch(short._id, { title: "Cache Me retitled" });
			}
		});
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });
		expect(calls).toHaveLength(2);
	});

	it("isolates an adapter failure — reports failed and writes nothing", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "boom", title: "Boom" }),
		);

		const { adapter, calls } = throwingEnrichment();
		const result = await t.action((ctx) =>
			runEnrichChannel(ctx, adapter, channelId),
		);

		expect(result).toEqual({ status: "failed" });
		expect(calls).toHaveLength(1); // the visible channel was attempted
		expect(await enrichmentForChannel(t, channelId)).toBeNull();

		// The fingerprint stayed unwritten, so a healthy retry still enriches it.
		const { adapter: healthy } = stubEnrichment(() =>
			enrichResult(shortSignals(80, 60, 40)),
		);
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, healthy, channelId)),
		).toEqual({ status: "enriched" });
		expect(await enrichmentForChannel(t, channelId)).not.toBeNull();
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

		const { adapter } = stubEnrichment(() =>
			enrichResult(shortSignals(80, 60, 40)),
		);
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });

		const rows = await t.run((ctx) =>
			ctx.db
				.query("enrichments")
				.withIndex("by_channel", (q) => q.eq("channelId", channelId))
				.collect(),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.signals.automatable?.score).toBe(80);
	});
});

async function searchQueriesFor(t: Awaited<ReturnType<typeof setup>>["t"]) {
	return t.run((ctx) => ctx.db.query("searchQueries").collect());
}

describe("runEnrichChannel — minting Niche Queries into the Scout pool", () => {
	it("lands own-niche and adjacent-niche phrases with correct origins", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "niche", title: "AI Horror" }),
		);

		const { adapter } = stubEnrichment(() =>
			enrichResult(shortSignals(80, 60, 40), [
				{ phrase: "ai horror shorts", origin: "seeded" },
				{ phrase: "faceless narration horror", origin: "seeded" },
				{ phrase: "reddit scary stories", origin: "adjacent" },
			]),
		);
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });

		const rows = await searchQueriesFor(t);
		expect(
			rows
				.map((row) => ({ phrase: row.phrase, origin: row.origin }))
				.sort((a, b) => a.phrase.localeCompare(b.phrase)),
		).toEqual([
			{ phrase: "ai horror shorts", origin: "seeded" },
			{ phrase: "faceless narration horror", origin: "seeded" },
			{ phrase: "reddit scary stories", origin: "adjacent" },
		]);
		expect(rows.every((row) => row.consecutiveZeroYield === 0)).toBe(true);
	});

	it("revives a minted phrase through a real re-enrichment, resetting its counter", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "revive", title: "Revive" }),
		);
		const { adapter } = stubEnrichment(() =>
			enrichResult(shortSignals(80, 60, 40), [
				{ phrase: "ai horror shorts", origin: "seeded" },
			]),
		);

		// First enrichment mints the phrase.
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });

		// Simulate the Scout having run it fruitlessly a few times.
		await t.run(async (ctx) => {
			const [row] = await ctx.db.query("searchQueries").collect();
			if (row) {
				await ctx.db.patch(row._id, { consecutiveZeroYield: 3 });
			}
		});

		// Retitle a Short so the fingerprint changes and the channel re-enriches,
		// re-minting the same phrase through the orchestration seam.
		await t.run(async (ctx) => {
			const short = await ctx.db
				.query("videos")
				.withIndex("by_ytId", (q) => q.eq("ytId", "revive_short_0"))
				.unique();
			if (short) {
				await ctx.db.patch(short._id, { title: "Revive retitled" });
			}
		});
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });

		const rows = await searchQueriesFor(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.consecutiveZeroYield).toBe(0);
	});

	it("normalizes case/whitespace so a phrase dedupes to one row", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "norm", title: "Norm" }),
		);

		const { adapter } = stubEnrichment(() =>
			enrichResult(shortSignals(80, 60, 40), [
				{ phrase: "  AI   Horror  Shorts ", origin: "seeded" },
			]),
		);
		await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId));

		const rows = await searchQueriesFor(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.phrase).toBe("ai horror shorts");
	});

	it("never fails a channel's enrichment when it mints no phrases", async () => {
		const { t } = await setup();
		const channelId = await t.run((ctx) =>
			addChannel(ctx, { ytId: "empty", title: "No Queries" }),
		);

		const { adapter } = stubEnrichment(() =>
			enrichResult(shortSignals(80, 60, 40)),
		);
		expect(
			await t.action((ctx) => runEnrichChannel(ctx, adapter, channelId)),
		).toEqual({ status: "enriched" });
		expect(await searchQueriesFor(t)).toHaveLength(0);
	});
});

describe("listVisibleChannelIds — the launch sweep's target set", () => {
	it("returns only Feed-visible channels, skipping hidden Tracked ones", async () => {
		const { t } = await setup();
		const visibleId = await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "sweep_visible",
				title: "Visible",
				shortViews: [120_000, 130_000, 140_000],
			}),
		);
		await t.run((ctx) =>
			addChannel(ctx, {
				ytId: "sweep_hidden",
				title: "Hidden",
				shortViews: [9_000, 8_000, 7_000],
			}),
		);

		const ids = await t.query(internal.enrich.listVisibleChannelIds, {});
		expect(ids).toEqual([visibleId]);
	});
});
