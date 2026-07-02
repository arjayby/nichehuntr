/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { FeedCard, FeedGroup } from "./feed";
import { runEmbed, runSnowball } from "./ingest";
import { SATURATION_CROWDED } from "./model/deriveListings";
import {
	EMBEDDING_DIMENSIONS,
	type EmbeddingsAdapter,
} from "./model/embeddings";
import { recomputeListingsForChannel } from "./model/listings";
import type { RelatedChannels, YouTubeAdapter } from "./model/youtube";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const LONG_SEC = 600; // > 180s ⇒ long-form; long Proven threshold is 100k.

/**
 * Insert a proven, strongly-accelerating long-form channel and derive its
 * Listing. Momentum lands well above the strong threshold (+50k over 2 days on a
 * 150k baseline), so on the momentum axis alone the Listing is Breaking Out — the
 * clean baseline for proving that Saturation can override it.
 */
async function addStrongChannel(
	ctx: MutationCtx,
	opts: {
		ytId: string;
		title: string;
		description?: string;
		source?: "trending" | "seed";
	},
): Promise<Id<"channels">> {
	const now = Date.now();
	const channelId = await ctx.db.insert("channels", {
		ytId: opts.ytId,
		title: opts.title,
		description: opts.description,
		discoveredAt: now,
		source: opts.source ?? "trending",
	});
	for (let i = 0; i < 3; i++) {
		const videoId = await ctx.db.insert("videos", {
			ytId: `${opts.ytId}_v${i}`,
			channelId,
			title: `${opts.title} upload ${i}`,
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

/** A one-hot embedding: identical within a niche (cosine 1), orthogonal across
 * niches (cosine 0), so the similarity threshold cleanly includes/excludes. */
function nicheVector(niche: number): number[] {
	const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
	vector[niche] = 1;
	return vector;
}

/** A stub embeddings adapter that assigns a niche vector from the channel text. */
function stubEmbeddings(nicheOf: (text: string) => number): EmbeddingsAdapter {
	return { embed: async (texts) => texts.map((t) => nicheVector(nicheOf(t))) };
}

/** Route each embed input to a niche by a keyword in its (title-derived) text. */
function nicheOf(text: string): number {
	if (text.includes("Horror")) return 0;
	if (text.includes("Finance")) return 1;
	return 2;
}

/** A YouTube stub for snowball: only the related/metadata calls matter here. */
function snowballAdapter(related: RelatedChannels[]): YouTubeAdapter {
	return {
		fetchTrending: async () => [],
		fetchChannels: async (ids) =>
			ids.map((id) => ({ ytChannelId: id, title: `${id} title`, handle: id })),
		fetchVideoStats: async () => [],
		fetchRelatedChannels: async () => related,
	};
}

function cardByTitle(groups: FeedGroup[], title: string): FeedCard | undefined {
	return groups.flatMap((g) => g.cards).find((c) => c.channel.title === title);
}

const longFeed = (t: ReturnType<typeof convexTest>) =>
	t.withIdentity({ subject: "u" }).query(api.feed.feed, { form: "long" });

describe("runSnowball", () => {
	it("tracks related channels and records graph edges", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) =>
			addStrongChannel(ctx, { ytId: "seed_a", title: "Seed A" }),
		);

		const related: RelatedChannels[] = [
			{
				fromChannelId: "seed_a",
				relatedChannelIds: ["rel_1", "rel_2", "rel_3"],
			},
		];
		const result = await t.action(async (ctx) =>
			runSnowball(ctx, snowballAdapter(related)),
		);
		expect(result).toMatchObject({ seeds: 1, discovered: 3, edges: 3 });

		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			snowball: (
				await ctx.db
					.query("channels")
					.withIndex("by_source", (q) => q.eq("source", "snowball"))
					.collect()
			).length,
			edges: (await ctx.db.query("channelEdges").collect()).length,
		}));
		expect(counts).toEqual({ channels: 4, snowball: 3, edges: 3 });
	});

	it("is idempotent — re-snowballing the same graph adds nothing", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) =>
			addStrongChannel(ctx, { ytId: "seed_b", title: "Seed B" }),
		);
		const related: RelatedChannels[] = [
			{ fromChannelId: "seed_b", relatedChannelIds: ["rel_1", "rel_2"] },
		];

		await t.action(async (ctx) => runSnowball(ctx, snowballAdapter(related)));
		const second = await t.action(async (ctx) =>
			runSnowball(ctx, snowballAdapter(related)),
		);
		expect(second).toMatchObject({ discovered: 0, edges: 0 });

		const edges = await t.run(
			async (ctx) => (await ctx.db.query("channelEdges").collect()).length,
		);
		expect(edges).toBe(2);
	});

	it("feeds the snowball-density fallback before embeddings exist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) =>
			addStrongChannel(ctx, { ytId: "seed_dense", title: "Seed Dense" }),
		);
		// On momentum alone it is Breaking Out.
		expect(cardByTitle(await longFeed(t), "Seed Dense")?.stage).toBe(
			"breaking_out",
		);

		// Snowball a crowded neighborhood off it — enough edges to cross the crowded
		// band, so the density fallback alone forces Established.
		const related: RelatedChannels[] = [
			{
				fromChannelId: "seed_dense",
				relatedChannelIds: Array.from(
					{ length: SATURATION_CROWDED },
					(_, i) => `dense_${i}`,
				),
			},
		];
		await t.action(async (ctx) => runSnowball(ctx, snowballAdapter(related)));

		const card = cardByTitle(await longFeed(t), "Seed Dense");
		expect(card?.saturation).toBe(SATURATION_CROWDED);
		expect(card?.stage).toBe("established");
	});
});

describe("runEmbed — embeddings + Saturation", () => {
	it("backfills an embedding of the index's width per channel", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) =>
			addStrongChannel(ctx, { ytId: "h_solo", title: "Horror Solo" }),
		);

		const result = await t.action(async (ctx) =>
			runEmbed(ctx, stubEmbeddings(nicheOf)),
		);
		expect(result.embedded).toBe(1);

		const width = await t.run(async (ctx) => {
			const channel = await ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", "h_solo"))
				.unique();
			return channel?.embedding?.length;
		});
		expect(width).toBe(EMBEDDING_DIMENSIONS);
	});

	it("sizes each niche by vector search and lets a crowded one dominate Stage", async () => {
		const t = convexTest(schema, modules);
		// A crowded niche (9 channels ⇒ 8 neighbors each = the crowded band) beside a
		// sparse one (2 Finance channels ⇒ 1 neighbor each). All are proven with
		// strong momentum, so only Saturation can move them out of Breaking Out.
		await t.run(async (ctx) => {
			for (let i = 0; i <= SATURATION_CROWDED; i++) {
				await addStrongChannel(ctx, {
					ytId: `h_${i}`,
					title: `Horror ${i}`,
					description: "AI narrated horror",
				});
			}
			for (let i = 0; i < 2; i++) {
				await addStrongChannel(ctx, {
					ytId: `f_${i}`,
					title: `Finance ${i}`,
					description: "Long-form finance",
				});
			}
		});

		// Momentum alone would keep every one of them in Breaking Out.
		expect(cardByTitle(await longFeed(t), "Horror 0")?.stage).toBe(
			"breaking_out",
		);

		await t.action(async (ctx) => runEmbed(ctx, stubEmbeddings(nicheOf)));

		const groups = await longFeed(t);
		const horror = cardByTitle(groups, "Horror 0");
		expect(horror?.saturation).toBe(SATURATION_CROWDED); // 8 similar channels
		expect(horror?.stage).toBe("established"); // saturation dominates momentum

		const finance = cardByTitle(groups, "Finance 0");
		expect(finance?.saturation).toBe(1); // one peer — a sparse niche
		expect(finance?.stage).toBe("breaking_out"); // momentum still wins
	});

	it("re-measures a channel as its niche fills in across ticks", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) =>
			addStrongChannel(ctx, { ytId: "h_first", title: "Horror First" }),
		);

		// First tick: it is alone in its niche ⇒ Saturation 0, still Breaking Out.
		await t.action(async (ctx) => runEmbed(ctx, stubEmbeddings(nicheOf)));
		let card = cardByTitle(await longFeed(t), "Horror First");
		expect(card?.saturation).toBe(0);
		expect(card?.stage).toBe("breaking_out");

		// The niche crowds in, then a later tick re-measures the original channel.
		await t.run(async (ctx) => {
			for (let i = 0; i < SATURATION_CROWDED; i++) {
				await addStrongChannel(ctx, {
					ytId: `h_late_${i}`,
					title: `Horror Late ${i}`,
				});
			}
		});
		await t.action(async (ctx) => runEmbed(ctx, stubEmbeddings(nicheOf)));

		card = cardByTitle(await longFeed(t), "Horror First");
		expect(card?.saturation).toBe(SATURATION_CROWDED);
		expect(card?.stage).toBe("established");
	});
});
