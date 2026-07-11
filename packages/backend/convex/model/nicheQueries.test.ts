import { describe, expect, it } from "vitest";

import { setup } from "../../test/harness";
import { mintNicheQuery, normalizeNicheQuery } from "./nicheQueries";

describe("normalizeNicheQuery", () => {
	it("trims, lowercases, and collapses inner whitespace", () => {
		expect(normalizeNicheQuery("  AI   Horror\tShorts \n")).toBe(
			"ai horror shorts",
		);
	});

	it("maps case/whitespace-only variants to the same key", () => {
		expect(normalizeNicheQuery("Reddit Stories")).toBe(
			normalizeNicheQuery("  reddit   stories "),
		);
	});
});

describe("mintNicheQuery — case-insensitive insert-dedupe + revive", () => {
	it("inserts a new phrase with a zeroed zero-yield counter", async () => {
		const { t } = await setup();
		await t.run((ctx) =>
			mintNicheQuery(ctx, { phrase: "AI Horror Shorts", origin: "seeded" }),
		);

		const rows = await t.run((ctx) => ctx.db.query("searchQueries").collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			phrase: "ai horror shorts",
			origin: "seeded",
			consecutiveZeroYield: 0,
		});
	});

	it("dedupes a case/whitespace variant to a single row", async () => {
		const { t } = await setup();
		await t.run(async (ctx) => {
			await mintNicheQuery(ctx, { phrase: "reddit stories", origin: "seeded" });
			await mintNicheQuery(ctx, {
				phrase: "  Reddit   Stories ",
				origin: "adjacent",
			});
		});

		const rows = await t.run((ctx) => ctx.db.query("searchQueries").collect());
		expect(rows).toHaveLength(1);
		// The original origin is preserved — a re-mint revives, it doesn't re-tag.
		expect(rows[0]).toMatchObject({
			phrase: "reddit stories",
			origin: "seeded",
		});
	});

	it("revives an existing phrase by resetting its zero-yield counter", async () => {
		const { t } = await setup();
		const id = await t.run(async (ctx) => {
			const rowId = await ctx.db.insert("searchQueries", {
				phrase: "reddit stories",
				origin: "seeded",
				consecutiveZeroYield: 3,
				lastRunAt: 123,
			});
			return rowId;
		});

		await t.run((ctx) =>
			mintNicheQuery(ctx, { phrase: "Reddit Stories", origin: "seeded" }),
		);

		const row = await t.run((ctx) => ctx.db.get("searchQueries", id));
		expect(row).toMatchObject({
			consecutiveZeroYield: 0,
			// Revival preserves lastRunAt — it's a second chance, not a fresh phrase.
			lastRunAt: 123,
		});
	});

	it("skips a phrase that normalizes to empty", async () => {
		const { t } = await setup();
		await t.run((ctx) =>
			mintNicheQuery(ctx, { phrase: "   \t\n ", origin: "seeded" }),
		);
		expect(
			await t.run((ctx) => ctx.db.query("searchQueries").collect()),
		).toEqual([]);
	});
});
