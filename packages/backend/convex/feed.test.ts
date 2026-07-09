import { describe, expect, it } from "vitest";

import { createGatedTest, setup } from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { FeedCard, FeedGroup } from "./feed";
import type { ChannelLifecycleStage } from "./model/channelLifecycle";

const DAY = 24 * 60 * 60 * 1000;

async function addChannel(
	ctx: MutationCtx,
	title: string,
	opts: { subscriberCount?: number } = {},
): Promise<Id<"channels">> {
	return ctx.db.insert("channels", {
		ytId: `yt_${title.replace(/\s+/g, "_")}`,
		title,
		handle: title.toLowerCase().replace(/\s+/g, ""),
		subscriberCount: opts.subscriberCount ?? 1_000,
		discoveredAt: Date.now(),
		source: "seed",
	});
}

async function addVideo(
	ctx: MutationCtx,
	opts: {
		channelId: Id<"channels">;
		title: string;
		viewCount: number;
		publishedAt: number;
		durationSec?: number;
	},
) {
	return ctx.db.insert("videos", {
		ytId: `yt_${opts.title.replace(/\s+/g, "_")}`,
		channelId: opts.channelId,
		title: opts.title,
		durationSec: opts.durationSec ?? 45,
		publishedAt: opts.publishedAt,
		currentViewCount: opts.viewCount,
		isStandard: true,
	});
}

async function addShorts(
	ctx: MutationCtx,
	channelId: Id<"channels">,
	viewCounts: number[],
	opts: { startAgeDays?: number } = {},
) {
	const startAgeDays = opts.startAgeDays ?? 1;
	await Promise.all(
		viewCounts.map((viewCount, index) =>
			addVideo(ctx, {
				channelId,
				title: `${channelId} short ${index}`,
				viewCount,
				publishedAt: Date.now() - (startAgeDays + index) * DAY,
			}),
		),
	);
}

async function addEnrichment(
	ctx: MutationCtx,
	channelId: Id<"channels">,
	scores: { automatable: number; transformative: number; improvable: number },
) {
	await ctx.db.insert("enrichments", {
		channelId,
		fingerprint: `fp_${channelId}`,
		enrichedAt: Date.now(),
		signals: {
			automatable: { score: scores.automatable, rationale: "templated" },
			transformative: {
				score: scores.transformative,
				rationale: "repackages source material",
			},
			improvable: { score: scores.improvable, rationale: "weak execution" },
		},
	});
}

/** Titles of every card the feed returned, across all columns. */
function allTitles(groups: FeedGroup[]): string[] {
	return groups.flatMap((g) => g.cards).map((c) => c.channel.title);
}

function cardsForStage(
	groups: FeedGroup[],
	stage: Exclude<ChannelLifecycleStage, "tracked">,
): FeedCard[] {
	return groups.find((g) => g.stage === stage)?.cards ?? [];
}

describe("feed query", () => {
	it("returns visible channels grouped into canonical lifecycle columns", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const emerging = await addChannel(ctx, "Emerging Channel");
			await addShorts(ctx, emerging, [80_000, 60_000, 10_000]);

			const breakingOut = await addChannel(ctx, "Breaking Out Channel");
			await addShorts(ctx, breakingOut, [120_000, 130_000, 10_000]);

			const established = await addChannel(ctx, "Established Channel", {
				subscriberCount: 60_000,
			});
			await addShorts(ctx, established, [
				120_000,
				130_000,
				140_000,
				150_000,
				160_000,
				1,
				1,
				1,
				1,
				1,
				...Array(40).fill(1_000),
			]);
		});

		const groups = await operator.query(api.feed.feed, {});

		expect(groups.map((g) => g.stage)).toEqual([
			"emerging",
			"breaking_out",
			"established",
		]);
		expect(
			cardsForStage(groups, "emerging").map((c) => c.channel.title),
		).toEqual(["Emerging Channel"]);
		expect(
			cardsForStage(groups, "breaking_out").map((c) => c.channel.title),
		).toEqual(["Breaking Out Channel"]);
		expect(
			cardsForStage(groups, "established").map((c) => c.channel.title),
		).toEqual(["Established Channel"]);
	});

	it("excludes hidden tracked channels while keeping them in the dataset", async () => {
		const { t, operator } = await setup();
		let trackedId: Id<"channels"> | null = null;
		await t.run(async (ctx) => {
			const visible = await addChannel(ctx, "Visible");
			await addShorts(ctx, visible, [80_000, 60_000, 10_000]);

			trackedId = await addChannel(ctx, "Tracked Hidden");
			await addShorts(ctx, trackedId, [1_000_000, 1_000_000]);
		});

		const groups = await operator.query(api.feed.feed, {});

		expect(allTitles(groups)).toEqual(["Visible"]);
		const trackedExists = await t.run(async (ctx) =>
			trackedId === null ? null : ctx.db.get(trackedId),
		);
		expect(trackedExists?.title).toBe("Tracked Hidden");
	});

	it("returns channel evidence without listing, form, or obsolete lifecycle fields", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Evidence Channel", {
				subscriberCount: 12_345,
			});
			await addShorts(ctx, channelId, [120_000, 130_000, 40_000]);
			await addVideo(ctx, {
				channelId,
				title: "long ignored",
				durationSec: 900,
				viewCount: 1_000_000,
				publishedAt: Date.now(),
			});
		});

		const [card] = cardsForStage(
			await operator.query(api.feed.feed, {}),
			"breaking_out",
		);

		expect(card).toMatchObject({
			channelId: expect.any(String),
			stage: "breaking_out",
			evidence: {
				subscriberCount: 12_345,
				fetchedShorts: 3,
				recentShortsChecked: 3,
				shortsAtOrAbove50k: 2,
				shortsAtOrAbove100k: 2,
			},
			channel: {
				ytId: "yt_Evidence_Channel",
				title: "Evidence Channel",
				handle: "evidencechannel",
			},
		});
		expect(card.evidence.latestShortPublishedAt).toEqual(expect.any(Number));
		expect(card).not.toHaveProperty("listingId");
		expect(card).not.toHaveProperty("form");
		expect(card).not.toHaveProperty("proven");
		expect(card).not.toHaveProperty("medianViews");
		expect(card).not.toHaveProperty("baseline");
		expect(card).not.toHaveProperty("momentum");
		expect(card).not.toHaveProperty("saturation");
	});

	it("derives recent reach from current video counts without requiring snapshots", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Current Count Channel");
			for (const [index, viewCount] of [120_000, 130_000, 40_000].entries()) {
				await addVideo(ctx, {
					channelId,
					title: `current count ${index}`,
					viewCount,
					publishedAt: Date.now() - (index + 1) * DAY,
				});
			}
		});

		const [card] = cardsForStage(
			await operator.query(api.feed.feed, {}),
			"breaking_out",
		);

		expect(card).toMatchObject({
			stage: "breaking_out",
			channel: { title: "Current Count Channel" },
			evidence: {
				shortsAtOrAbove100k: 2,
				recentShortsChecked: 3,
			},
		});
	});

	it("sorts within a stage by clonability and keeps unscored channels last", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			for (const [title, scores] of [
				["Mid", { automatable: 50, transformative: 50, improvable: 50 }],
				["Top", { automatable: 90, transformative: 90, improvable: 90 }],
				["Unscored", null],
				["Low", { automatable: 20, transformative: 20, improvable: 20 }],
			] as const) {
				const channelId = await addChannel(ctx, title);
				await addShorts(ctx, channelId, [80_000, 60_000, 10_000]);
				if (scores !== null) {
					await addEnrichment(ctx, channelId, scores);
				}
			}
		});

		const emerging = cardsForStage(
			await operator.query(api.feed.feed, {}),
			"emerging",
		);

		expect(emerging.map((c) => c.channel.title)).toEqual([
			"Top",
			"Mid",
			"Low",
			"Unscored",
		]);
		expect(emerging.map((c) => c.clonability)).toEqual([90, 50, 20, null]);
		expect(emerging[0]?.signals?.automatable.rationale).toBe("templated");
	});

	it("does not let missing or low clonability gate Feed visibility or stage", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const missing = await addChannel(ctx, "Missing Enrichment");
			await addShorts(ctx, missing, [120_000, 130_000, 10_000]);

			const low = await addChannel(ctx, "Low Clonability");
			await addShorts(ctx, low, [120_000, 130_000, 10_000]);
			await addEnrichment(ctx, low, {
				automatable: 0,
				transformative: 0,
				improvable: 0,
			});
		});

		const breakingOut = cardsForStage(
			await operator.query(api.feed.feed, {}),
			"breaking_out",
		);

		expect(breakingOut.map((card) => card.channel.title)).toEqual([
			"Low Clonability",
			"Missing Enrichment",
		]);
		expect(breakingOut.map((card) => card.clonability)).toEqual([0, null]);
		expect(breakingOut.every((card) => card.stage === "breaking_out")).toBe(
			true,
		);
	});

	it("reads the preferred channel enrichment row when duplicate cache rows exist", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Duplicate Cache");
			await addShorts(ctx, channelId, [80_000, 60_000, 10_000]);
			await ctx.db.insert("enrichments", {
				channelId,
				fingerprint: "partial",
				enrichedAt: Date.now() + 1_000,
				signals: {
					improvable: { score: 10, rationale: "partial duplicate" },
				},
			});
			await addEnrichment(ctx, channelId, {
				automatable: 90,
				transformative: 70,
				improvable: 50,
			});
		});

		const [card] = cardsForStage(
			await operator.query(api.feed.feed, {}),
			"emerging",
		);

		expect(card).toMatchObject({
			channel: { title: "Duplicate Cache" },
			clonability: 75,
			signals: {
				automatable: { score: 90, rationale: "templated" },
			},
		});
	});

	it("ignores legacy long-form enrichment rows when reading Channel clonability", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Legacy Long Row");
			await addShorts(ctx, channelId, [80_000, 60_000, 10_000]);
			await ctx.db.insert("enrichments", {
				channelId,
				fingerprint: "legacy-long",
				enrichedAt: Date.now(),
				signals: {
					enterprise_value: { score: 100, rationale: "old long-form signal" },
					improvable: { score: 100, rationale: "shared long-form signal" },
				},
			});
		});

		const [card] = cardsForStage(
			await operator.query(api.feed.feed, {}),
			"emerging",
		);

		expect(card).toMatchObject({
			channel: { title: "Legacy Long Row" },
			clonability: null,
			signals: null,
		});
	});

	it("narrows to only the requested lifecycle stages", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const emerging = await addChannel(ctx, "Emerging");
			await addShorts(ctx, emerging, [80_000, 60_000, 10_000]);
			const breakingOut = await addChannel(ctx, "Breaking Out");
			await addShorts(ctx, breakingOut, [120_000, 130_000, 10_000]);
		});

		const groups = await operator.query(api.feed.feed, {
			stages: ["breaking_out"],
		});

		expect(groups.map((g) => g.stage)).toEqual(["breaking_out"]);
		expect(
			cardsForStage(groups, "breaking_out").map((c) => c.channel.title),
		).toEqual(["Breaking Out"]);
	});

	it("requires authentication", async () => {
		const t = createGatedTest();
		await expect(t.query(api.feed.feed, {})).rejects.toThrow(/authenticated/i);
	});
});
