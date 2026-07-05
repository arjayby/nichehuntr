import { describe, expect, it } from "vitest";

import { asSubscribedOperator, createGatedTest, setup } from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

async function addChannel(
	ctx: MutationCtx,
	title: string,
	description?: string,
): Promise<Id<"channels">> {
	return ctx.db.insert("channels", {
		ytId: `yt_${title.replace(/\s+/g, "_")}`,
		title,
		handle: title.toLowerCase().replace(/\s+/g, ""),
		avatarUrl: `https://img/${title}.jpg`,
		description,
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

	it("detail re-derives the live Listing join when the Listing is on the Feed", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run(async (ctx) => {
			const id = await addChannel(
				ctx,
				"AI Horror",
				"Nightly AI horror shorts.",
			);
			await ctx.db.insert("listings", {
				channelId: id,
				form: "short",
				proven: true,
				medianViews: 800_000,
				baseline: 800_000,
				momentum: 0.12,
				saturation: 2,
				stage: "breaking_out",
				clonability: 78,
				signals: {
					automatable: { score: 90, rationale: "Templated AI voiceover." },
					improvable: { score: 55, rationale: "Thumbnails are lazy." },
				},
			});
			return id;
		});

		const detail = await operator.query(api.watchlist.detail, {
			channelId,
			form: "short",
		});

		expect(detail).toMatchObject({
			channelId,
			form: "short",
			channel: {
				ytId: "yt_AI_Horror",
				title: "AI Horror",
				handle: "aihorror",
				avatarUrl: "https://img/AI Horror.jpg",
				description: "Nightly AI horror shorts.",
			},
			listing: {
				stage: "breaking_out",
				medianViews: 800_000,
				momentum: 0.12,
				saturation: 2,
				clonability: 78,
				signals: {
					automatable: { score: 90, rationale: "Templated AI voiceover." },
					improvable: { score: 55, rationale: "Thumbnails are lazy." },
				},
			},
		});
	});

	it("detail degrades to identity + a null listing when the pair is off the Feed", async () => {
		const { t, operator } = await setup();
		const { goneId, unprovenId } = await t.run(async (ctx) => {
			const goneId = await addChannel(ctx, "Vanished", "Used to be hot.");
			// No listing row at all — recompute dropped the pair entirely.
			const unprovenId = await addChannel(ctx, "Faded");
			await ctx.db.insert("listings", {
				channelId: unprovenId,
				form: "short",
				proven: false,
				medianViews: 40_000,
				baseline: null,
				momentum: null,
				saturation: null,
				stage: "established",
				clonability: null,
				signals: null,
			});
			return { goneId, unprovenId };
		});

		const gone = await operator.query(api.watchlist.detail, {
			channelId: goneId,
			form: "short",
		});
		expect(gone).toMatchObject({
			channel: { title: "Vanished", description: "Used to be hot." },
			listing: null,
		});

		const unproven = await operator.query(api.watchlist.detail, {
			channelId: unprovenId,
			form: "short",
		});
		expect(unproven).toMatchObject({
			channel: { title: "Faded" },
			listing: null,
		});
	});

	it("detail's uploads strip is the last 12 standard videos of the entry's form, newest-first, with latest snapshot counts", async () => {
		const { t, operator } = await setup();
		const base = Date.UTC(2026, 0, 1);
		const day = 24 * 60 * 60 * 1000;
		const channelId = await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Prolific");
			// 14 standard shorts — only the newest 12 belong on the strip.
			for (let i = 0; i < 14; i++) {
				const videoId = await ctx.db.insert("videos", {
					ytId: `short_${i}`,
					channelId,
					title: `Short ${i}`,
					thumbnailUrl: `https://img/short_${i}.jpg`,
					durationSec: 60,
					form: "short",
					publishedAt: base + i * day,
					isStandard: true,
				});
				// Two snapshots for the newest video: the strip shows the latest count.
				if (i === 13) {
					await ctx.db.insert("videoSnapshots", {
						videoId,
						viewCount: 100_000,
						at: base + 14 * day,
					});
					await ctx.db.insert("videoSnapshots", {
						videoId,
						viewCount: 250_000,
						at: base + 15 * day,
					});
				}
			}
			// Wrong form and non-standard items never reach the strip.
			await ctx.db.insert("videos", {
				ytId: "long_video",
				channelId,
				title: "Long video",
				durationSec: 900,
				form: "long",
				publishedAt: base + 20 * day,
				isStandard: true,
			});
			await ctx.db.insert("videos", {
				ytId: "live_stream",
				channelId,
				title: "Live stream",
				durationSec: 60,
				form: "short",
				publishedAt: base + 21 * day,
				isStandard: false,
			});
			return channelId;
		});

		const detail = await operator.query(api.watchlist.detail, {
			channelId,
			form: "short",
		});

		expect(detail?.uploads).toHaveLength(12);
		expect(detail?.uploads.map((u) => u.ytId)).toEqual(
			Array.from({ length: 12 }, (_, i) => `short_${13 - i}`),
		);
		expect(detail?.uploads[0]).toMatchObject({
			ytId: "short_13",
			title: "Short 13",
			thumbnailUrl: "https://img/short_13.jpg",
			publishedAt: base + 13 * day,
			viewCount: 250_000, // the latest snapshot, not the first
		});
		// No snapshot yet — the count is explicitly unmeasured, never zero.
		expect(detail?.uploads[1]?.viewCount).toBeNull();
	});

	it("entries flag whether each pair is still on the Feed", async () => {
		const { t, operator } = await setup();
		const { liveId, fadedId } = await t.run(async (ctx) => {
			const liveId = await addChannel(ctx, "Still Live");
			await ctx.db.insert("listings", {
				channelId: liveId,
				form: "short",
				proven: true,
				medianViews: 900_000,
				baseline: null,
				momentum: null,
				saturation: null,
				stage: "emerging",
				clonability: null,
				signals: null,
			});
			// The same channel's *long* face is unproven — it must not vouch for
			// the short entry, and vice versa (a Listing is per (channel, form)).
			await ctx.db.insert("listings", {
				channelId: liveId,
				form: "long",
				proven: false,
				medianViews: 10_000,
				baseline: null,
				momentum: null,
				saturation: null,
				stage: "established",
				clonability: null,
				signals: null,
			});
			const fadedId = await addChannel(ctx, "Faded Away");
			return { liveId, fadedId };
		});

		await operator.mutation(api.watchlist.toggle, {
			channelId: liveId,
			form: "short",
		});
		await operator.mutation(api.watchlist.toggle, {
			channelId: liveId,
			form: "long",
		});
		await operator.mutation(api.watchlist.toggle, {
			channelId: fadedId,
			form: "short",
		});

		const entries = await operator.query(api.watchlist.entries, {});
		const byKey = new Map(
			entries.map((e) => [`${e.channel.title}:${e.form}`, e.onFeed]),
		);
		expect(byKey.get("Still Live:short")).toBe(true);
		expect(byKey.get("Still Live:long")).toBe(false);
		expect(byKey.get("Faded Away:short")).toBe(false);
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
		await expect(
			t.query(api.watchlist.detail, { channelId, form: "short" }),
		).rejects.toThrow(/authenticated/i);
	});
});
