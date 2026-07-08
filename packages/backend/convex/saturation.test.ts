import { describe, expect, it } from "vitest";
import { setup } from "../test/harness";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { runEmbed } from "./ingest";
import { SATURATION_CROWDED } from "./model/deriveListings";
import {
	EMBEDDING_DIMENSIONS,
	type EmbeddingsAdapter,
} from "./model/embeddings";
import { recomputeListingsForChannel } from "./model/listings";

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

async function listingByTitle(
	t: Awaited<ReturnType<typeof setup>>["t"],
	title: string,
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
		return listings.find((row) => row.form === "long") ?? null;
	});
}

describe("runEmbed — embeddings + Saturation", () => {
	it("backfills an embedding of the index's width per channel", async () => {
		const { t } = await setup();
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
		const { t } = await setup();
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
		expect((await listingByTitle(t, "Horror 0"))?.stage).toBe("breaking_out");

		await t.action(async (ctx) => runEmbed(ctx, stubEmbeddings(nicheOf)));

		const horror = await listingByTitle(t, "Horror 0");
		expect(horror?.saturation).toBe(SATURATION_CROWDED); // 8 similar channels
		expect(horror?.stage).toBe("established"); // saturation dominates momentum

		const finance = await listingByTitle(t, "Finance 0");
		expect(finance?.saturation).toBe(1); // one peer — a sparse niche
		expect(finance?.stage).toBe("breaking_out"); // momentum still wins
	});

	it("re-measures a channel as its niche fills in across ticks", async () => {
		const { t } = await setup();
		await t.run(async (ctx) =>
			addStrongChannel(ctx, { ytId: "h_first", title: "Horror First" }),
		);

		// First tick: it is alone in its niche ⇒ Saturation 0, still Breaking Out.
		await t.action(async (ctx) => runEmbed(ctx, stubEmbeddings(nicheOf)));
		let card = await listingByTitle(t, "Horror First");
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

		card = await listingByTitle(t, "Horror First");
		expect(card?.saturation).toBe(SATURATION_CROWDED);
		expect(card?.stage).toBe("established");
	});
});
