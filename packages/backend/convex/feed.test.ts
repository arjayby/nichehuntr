import { describe, expect, it } from "vitest";

import { createGatedTest, setup } from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { FeedCard, FeedGroup } from "./feed";
import type { Form, Stage } from "./model/deriveListings";

async function addChannel(
	ctx: MutationCtx,
	title: string,
): Promise<Id<"channels">> {
	return ctx.db.insert("channels", {
		ytId: `yt_${title.replace(/\s+/g, "_")}`,
		title,
		handle: title.toLowerCase().replace(/\s+/g, ""),
		discoveredAt: Date.now(),
		source: "seed",
	});
}

async function addListing(
	ctx: MutationCtx,
	opts: {
		channelId: Id<"channels">;
		form: Form;
		proven: boolean;
		stage: Stage;
		clonability?: number | null;
	},
): Promise<Id<"listings">> {
	return ctx.db.insert("listings", {
		channelId: opts.channelId,
		form: opts.form,
		proven: opts.proven,
		medianViews: 150_000,
		baseline: null,
		momentum: null,
		saturation: null,
		stage: opts.stage,
		clonability: opts.clonability ?? null,
		signals: null,
	});
}

/** Titles of every card the feed returned, across all columns. */
function allTitles(groups: FeedGroup[]): string[] {
	return groups.flatMap((g) => g.cards).map((c) => c.channel.title);
}

function cardsForStage(groups: FeedGroup[], stage: Stage): FeedCard[] {
	return groups.find((g) => g.stage === stage)?.cards ?? [];
}

describe("feed query", () => {
	it("returns only proven listings, grouped into lifecycle columns", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const c1 = await addChannel(ctx, "Proven Emerging");
			await addListing(ctx, {
				channelId: c1,
				form: "short",
				proven: true,
				stage: "emerging",
			});
			const c2 = await addChannel(ctx, "Proven Breaking Out");
			await addListing(ctx, {
				channelId: c2,
				form: "short",
				proven: true,
				stage: "breaking_out",
			});
			const c3 = await addChannel(ctx, "Unproven Fluke");
			// Highest imaginable score, but not proven — must never surface.
			await addListing(ctx, {
				channelId: c3,
				form: "short",
				proven: false,
				stage: "emerging",
				clonability: 100,
			});
		});

		const groups = await operator.query(api.feed.feed, { form: "short" });

		expect(
			cardsForStage(groups, "emerging").map((c) => c.channel.title),
		).toEqual(["Proven Emerging"]);
		expect(
			cardsForStage(groups, "breaking_out").map((c) => c.channel.title),
		).toEqual(["Proven Breaking Out"]);
		expect(cardsForStage(groups, "established")).toEqual([]);
		expect(allTitles(groups)).not.toContain("Unproven Fluke");
	});

	it("sorts a column by clonability descending, keeping unscored listings last", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const scores: [string, number | null][] = [
				["Mid", 50],
				["Top", 90],
				["Unscored", null],
				["Low", 20],
			];
			for (const [title, clonability] of scores) {
				const c = await addChannel(ctx, title);
				await addListing(ctx, {
					channelId: c,
					form: "long",
					proven: true,
					stage: "emerging",
					clonability,
				});
			}
		});

		const groups = await operator.query(api.feed.feed, { form: "long" });

		expect(cardsForStage(groups, "emerging").map((c) => c.clonability)).toEqual(
			[90, 50, 20, null],
		);
	});

	it("surfaces a straddling channel under both form filters", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Straddler");
			await addListing(ctx, {
				channelId,
				form: "short",
				proven: true,
				stage: "emerging",
			});
			await addListing(ctx, {
				channelId,
				form: "long",
				proven: true,
				stage: "emerging",
			});
		});

		const shortFeed = await operator.query(api.feed.feed, { form: "short" });
		const longFeed = await operator.query(api.feed.feed, { form: "long" });

		expect(allTitles(shortFeed)).toContain("Straddler");
		expect(allTitles(longFeed)).toContain("Straddler");
	});

	it("narrows to only the requested stages", async () => {
		const { t, operator } = await setup();
		await t.run(async (ctx) => {
			const a = await addChannel(ctx, "Em");
			await addListing(ctx, {
				channelId: a,
				form: "short",
				proven: true,
				stage: "emerging",
			});
			const b = await addChannel(ctx, "Br");
			await addListing(ctx, {
				channelId: b,
				form: "short",
				proven: true,
				stage: "breaking_out",
			});
		});

		const groups = await operator.query(api.feed.feed, {
			form: "short",
			stages: ["breaking_out"],
		});

		expect(groups.map((g) => g.stage)).toEqual(["breaking_out"]);
		expect(
			cardsForStage(groups, "breaking_out").map((c) => c.channel.title),
		).toEqual(["Br"]);
	});

	it("requires authentication", async () => {
		const t = createGatedTest();
		await expect(t.query(api.feed.feed, { form: "short" })).rejects.toThrow(
			/authenticated/i,
		);
	});
});
