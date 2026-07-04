import { describe, expect, it } from "vitest";

import { asSubscribedOperator, createGatedTest, setup } from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

async function addChannel(
	ctx: MutationCtx,
	title: string,
): Promise<Id<"channels">> {
	return ctx.db.insert("channels", {
		ytId: `yt_${title.replace(/\s+/g, "_")}`,
		title,
		handle: title.toLowerCase().replace(/\s+/g, ""),
		avatarUrl: `https://img/${title}.jpg`,
		discoveredAt: Date.now(),
		source: "seed",
	});
}

describe("watchlist", () => {
	it("saves a (channel, form) on toggle and lists it with channel identity", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "AI Horror"));

		const result = await operator.mutation(api.watchlist.toggle, {
			channelId,
			form: "short",
		});
		expect(result).toEqual({ saved: true });

		const entries = await operator.query(api.watchlist.entries, {});
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			channelId,
			form: "short",
			channel: {
				ytId: "yt_AI_Horror",
				title: "AI Horror",
				handle: "aihorror",
				avatarUrl: "https://img/AI Horror.jpg",
			},
		});
	});

	it("unsaves on the second toggle — saving the same card twice is impossible", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "AI Horror"));

		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });
		const second = await operator.mutation(api.watchlist.toggle, {
			channelId,
			form: "short",
		});
		expect(second).toEqual({ saved: false });

		expect(await operator.query(api.watchlist.entries, {})).toEqual([]);
	});

	it("keeps a straddling channel's two form faces as two distinct entries", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "Straddler"));

		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });
		await operator.mutation(api.watchlist.toggle, { channelId, form: "long" });

		const entries = await operator.query(api.watchlist.entries, {});
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.form).sort()).toEqual(["long", "short"]);

		// Unsaving one face leaves the other untouched.
		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });
		const remaining = await operator.query(api.watchlist.entries, {});
		expect(remaining.map((e) => e.form)).toEqual(["long"]);
	});

	it("scopes entries to the calling Operator", async () => {
		const { t, operator } = await setup();
		const rival = await asSubscribedOperator(t, "rival");
		const channelId = await t.run((ctx) => addChannel(ctx, "Contested"));

		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });

		expect(await rival.query(api.watchlist.entries, {})).toEqual([]);

		// The rival saving the same card is their own entry, not a dedupe hit.
		await rival.mutation(api.watchlist.toggle, { channelId, form: "short" });
		expect(await rival.query(api.watchlist.entries, {})).toHaveLength(1);
		expect(await operator.query(api.watchlist.entries, {})).toHaveLength(1);
	});

	it("lists entries newest-first", async () => {
		const { t, operator } = await setup();
		const first = await t.run((ctx) => addChannel(ctx, "Saved First"));
		const second = await t.run((ctx) => addChannel(ctx, "Saved Second"));

		await operator.mutation(api.watchlist.toggle, {
			channelId: first,
			form: "short",
		});
		await operator.mutation(api.watchlist.toggle, {
			channelId: second,
			form: "long",
		});

		const entries = await operator.query(api.watchlist.entries, {});
		expect(entries.map((e) => e.channel.title)).toEqual([
			"Saved Second",
			"Saved First",
		]);
	});

	it("requires authentication", async () => {
		const t = createGatedTest();
		const channelId = await t.run((ctx) => addChannel(ctx, "Locked"));

		await expect(
			t.mutation(api.watchlist.toggle, { channelId, form: "short" }),
		).rejects.toThrow(/authenticated/i);
		await expect(t.query(api.watchlist.entries, {})).rejects.toThrow(
			/authenticated/i,
		);
	});
});
