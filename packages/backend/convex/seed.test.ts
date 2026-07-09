import { describe, expect, it } from "vitest";

import { asSubscribedOperator, createGatedTest } from "../test/harness";
import { api, internal } from "./_generated/api";

/** Titles of every card the feed returned, across all columns. */
function titles(
	groups: { cards: { channel: { title: string } }[] }[],
): string[] {
	return groups.flatMap((g) => g.cards).map((c) => c.channel.title);
}

describe("seed", () => {
	it("drives the full path so the Feed renders visible lifecycle Channels", async () => {
		const t = createGatedTest();
		const summary = await t.mutation(internal.seed.seed, {});

		expect(summary).toEqual({ channels: 5, visibleSeedChannels: 3 });

		const asUser = await asSubscribedOperator(t);
		const feedTitles = titles(await asUser.query(api.feed.feed, {}));

		expect(feedTitles).toEqual(
			expect.arrayContaining([
				"AI Horror Shorts",
				"Faceless Empire",
				"Mature Shorts Reference",
			]),
		);
		expect(feedTitles).not.toContain("Deep Finance Breakdowns");
		expect(feedTitles).not.toContain("One-Hit Wonder");
	});

	it("is idempotent — re-running replaces rather than duplicates", async () => {
		const t = createGatedTest();
		await t.mutation(internal.seed.seed, {});
		const second = await t.mutation(internal.seed.seed, {});

		expect(second).toEqual({ channels: 5, visibleSeedChannels: 3 });
	});
});
