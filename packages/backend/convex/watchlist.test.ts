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
	it("saves a (channel, form) on toggle and lists it at the root with channel identity", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "AI Horror"));

		const result = await operator.mutation(api.watchlist.toggle, {
			channelId,
			form: "short",
		});
		expect(result).toEqual({ saved: true });

		const { folders, root } = await operator.query(api.watchlist.list, {});
		expect(folders).toEqual([]);
		expect(root).toHaveLength(1);
		expect(root[0]).toMatchObject({
			channelId,
			form: "short",
			folderId: null,
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

		const { root } = await operator.query(api.watchlist.list, {});
		expect(root).toEqual([]);
	});

	it("keeps a straddling channel's two form faces as two distinct entries", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "Straddler"));

		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });
		await operator.mutation(api.watchlist.toggle, { channelId, form: "long" });

		const { root } = await operator.query(api.watchlist.list, {});
		expect(root).toHaveLength(2);
		expect(root.map((e) => e.form).sort()).toEqual(["long", "short"]);

		// Unsaving one face leaves the other untouched.
		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });
		const remaining = await operator.query(api.watchlist.list, {});
		expect(remaining.root.map((e) => e.form)).toEqual(["long"]);
	});

	it("scopes entries to the calling Operator", async () => {
		const { t, operator } = await setup();
		const rival = await asSubscribedOperator(t, "rival");
		const channelId = await t.run((ctx) => addChannel(ctx, "Contested"));

		await operator.mutation(api.watchlist.toggle, { channelId, form: "short" });

		expect((await rival.query(api.watchlist.list, {})).root).toEqual([]);

		// The rival saving the same card is their own entry, not a dedupe hit.
		await rival.mutation(api.watchlist.toggle, { channelId, form: "short" });
		expect((await rival.query(api.watchlist.list, {})).root).toHaveLength(1);
		expect((await operator.query(api.watchlist.list, {})).root).toHaveLength(1);
	});

	it("lists root entries newest-first", async () => {
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

		const { root } = await operator.query(api.watchlist.list, {});
		expect(root.map((e) => e.channel.title)).toEqual([
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

		const { root } = await operator.query(api.watchlist.list, {});
		const byKey = new Map(
			root.map((e) => [`${e.channel.title}:${e.form}`, e.onFeed]),
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
		await expect(t.query(api.watchlist.list, {})).rejects.toThrow(
			/authenticated/i,
		);
		await expect(
			t.query(api.watchlist.detail, { channelId, form: "short" }),
		).rejects.toThrow(/authenticated/i);
	});
});

describe("watchlist folders", () => {
	/** Save a channel and return the freshly created entry's id. */
	async function saveEntry(
		operator: Awaited<ReturnType<typeof asSubscribedOperator>>,
		channelId: Id<"channels">,
		form: "short" | "long" = "short",
	): Promise<Id<"watchlistEntries">> {
		await operator.mutation(api.watchlist.toggle, { channelId, form });
		const { root, folders } = await operator.query(api.watchlist.list, {});
		const all = [...root, ...folders.flatMap((f) => f.entries)];
		const entry = all.find((e) => e.channelId === channelId && e.form === form);
		if (entry === undefined) throw new Error("entry not found after save");
		return entry.entryId;
	}

	it("creates a folder from the section header — an empty bucket in the list", async () => {
		const { operator } = await setup();

		const { folderId } = await operator.mutation(api.watchlist.createFolder, {
			name: "faceless",
		});

		const { folders, root } = await operator.query(api.watchlist.list, {});
		expect(root).toEqual([]);
		expect(folders).toEqual([{ folderId, name: "faceless", entries: [] }]);
	});

	it("trims folder names and rejects empty ones", async () => {
		const { operator } = await setup();

		const { folderId } = await operator.mutation(api.watchlist.createFolder, {
			name: "  next month  ",
		});
		const { folders } = await operator.query(api.watchlist.list, {});
		expect(folders[0]).toMatchObject({ folderId, name: "next month" });

		await expect(
			operator.mutation(api.watchlist.createFolder, { name: "   " }),
		).rejects.toThrow(/empty/i);
	});

	it("files an entry into a folder and un-files it back to root", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "AI Horror"));
		const entryId = await saveEntry(operator, channelId);
		const { folderId } = await operator.mutation(api.watchlist.createFolder, {
			name: "faceless",
		});

		// File it.
		await operator.mutation(api.watchlist.setEntryFolder, {
			entryId,
			folderId,
		});
		let view = await operator.query(api.watchlist.list, {});
		expect(view.root).toEqual([]);
		expect(view.folders[0]?.entries.map((e) => e.entryId)).toEqual([entryId]);
		expect(view.folders[0]?.entries[0]?.folderId).toEqual(folderId);

		// Un-file it (folderId: null) — back to the root.
		await operator.mutation(api.watchlist.setEntryFolder, {
			entryId,
			folderId: null,
		});
		view = await operator.query(api.watchlist.list, {});
		expect(view.folders[0]?.entries).toEqual([]);
		expect(view.root.map((e) => e.entryId)).toEqual([entryId]);
		expect(view.root[0]?.folderId).toBeNull();
	});

	it("renames a folder", async () => {
		const { operator } = await setup();
		const { folderId } = await operator.mutation(api.watchlist.createFolder, {
			name: "faceless",
		});

		await operator.mutation(api.watchlist.renameFolder, {
			folderId,
			name: "faceless AI",
		});

		const { folders } = await operator.query(api.watchlist.list, {});
		expect(folders[0]).toMatchObject({ folderId, name: "faceless AI" });
	});

	it("deleting a folder reparents its entries to root — never deletes them", async () => {
		const { t, operator } = await setup();
		const a = await t.run((ctx) => addChannel(ctx, "Alpha"));
		const b = await t.run((ctx) => addChannel(ctx, "Bravo"));
		const entryA = await saveEntry(operator, a);
		const entryB = await saveEntry(operator, b);
		const { folderId } = await operator.mutation(api.watchlist.createFolder, {
			name: "faceless",
		});
		await operator.mutation(api.watchlist.setEntryFolder, {
			entryId: entryA,
			folderId,
		});
		await operator.mutation(api.watchlist.setEntryFolder, {
			entryId: entryB,
			folderId,
		});

		await operator.mutation(api.watchlist.deleteFolder, { folderId });

		const { folders, root } = await operator.query(api.watchlist.list, {});
		expect(folders).toEqual([]);
		// Both entries survive at the root, cleared of the deleted folder.
		expect(new Set(root.map((e) => e.entryId))).toEqual(
			new Set([entryA, entryB]),
		);
		expect(root.every((e) => e.folderId === null)).toBe(true);
	});

	it("orders folders alphabetically and entries newest-first within each folder and root", async () => {
		const { t, operator } = await setup();
		const zebra = await t.run((ctx) => addChannel(ctx, "Zebra"));
		const apex = await t.run((ctx) => addChannel(ctx, "Apex"));
		const rootOld = await t.run((ctx) => addChannel(ctx, "Root Old"));
		const rootNew = await t.run((ctx) => addChannel(ctx, "Root New"));

		// Two folders created out of alphabetical order.
		const { folderId: workId } = await operator.mutation(
			api.watchlist.createFolder,
			{ name: "work" },
		);
		const { folderId: brandId } = await operator.mutation(
			api.watchlist.createFolder,
			{ name: "brand" },
		);

		// Save order fixes newest-first: later saves sort first.
		const zebraEntry = await saveEntry(operator, zebra);
		const apexEntry = await saveEntry(operator, apex);
		await saveEntry(operator, rootOld);
		await saveEntry(operator, rootNew);

		// File both channels into the same "brand" folder; apex was saved last.
		await operator.mutation(api.watchlist.setEntryFolder, {
			entryId: zebraEntry,
			folderId: brandId,
		});
		await operator.mutation(api.watchlist.setEntryFolder, {
			entryId: apexEntry,
			folderId: brandId,
		});

		const { folders, root } = await operator.query(api.watchlist.list, {});
		// Folders alphabetical: "brand" before "work".
		expect(folders.map((f) => f.name)).toEqual(["brand", "work"]);
		expect(folders[0]?.folderId).toEqual(brandId);
		expect(folders[1]?.folderId).toEqual(workId);
		// Within "brand": apex (saved later) is newest-first.
		expect(folders[0]?.entries.map((e) => e.channel.title)).toEqual([
			"Apex",
			"Zebra",
		]);
		// Root keeps its own newest-first order, folder members excluded.
		expect(root.map((e) => e.channel.title)).toEqual(["Root New", "Root Old"]);
	});

	it("keeps folders and filing private per Operator", async () => {
		const { t, operator } = await setup();
		const rival = await asSubscribedOperator(t, "rival");
		const channelId = await t.run((ctx) => addChannel(ctx, "Contested"));
		const rivalEntry = await saveEntry(rival, channelId);

		const { folderId } = await operator.mutation(api.watchlist.createFolder, {
			name: "mine",
		});

		// The rival never sees the Operator's folder.
		expect((await rival.query(api.watchlist.list, {})).folders).toEqual([]);

		// Cross-Operator mutations are rejected: the rival can't touch the folder…
		await expect(
			rival.mutation(api.watchlist.renameFolder, { folderId, name: "hijack" }),
		).rejects.toThrow(/folder/i);
		await expect(
			rival.mutation(api.watchlist.deleteFolder, { folderId }),
		).rejects.toThrow(/folder/i);
		// …and the Operator can't file the rival's entry into their folder.
		await expect(
			operator.mutation(api.watchlist.setEntryFolder, {
				entryId: rivalEntry,
				folderId,
			}),
		).rejects.toThrow(/entry/i);
		// …nor file their own entry into a folder they don't own.
		const own = await t.run((ctx) => addChannel(ctx, "Own"));
		const ownEntry = await saveEntry(operator, own);
		const rivalFolder = await rival.mutation(api.watchlist.createFolder, {
			name: "rival",
		});
		await expect(
			operator.mutation(api.watchlist.setEntryFolder, {
				entryId: ownEntry,
				folderId: rivalFolder.folderId,
			}),
		).rejects.toThrow(/folder/i);
	});

	it("requires authentication for every folder function", async () => {
		const t = createGatedTest();
		const { entryId, folderId } = await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Locked");
			const entryId = await ctx.db.insert("watchlistEntries", {
				operatorId: "someone",
				channelId,
				form: "short",
			});
			const folderId = await ctx.db.insert("watchlistFolders", {
				operatorId: "someone",
				name: "locked",
			});
			return { entryId, folderId };
		});

		await expect(
			t.mutation(api.watchlist.createFolder, { name: "x" }),
		).rejects.toThrow(/authenticated/i);
		await expect(
			t.mutation(api.watchlist.renameFolder, { folderId, name: "x" }),
		).rejects.toThrow(/authenticated/i);
		await expect(
			t.mutation(api.watchlist.deleteFolder, { folderId }),
		).rejects.toThrow(/authenticated/i);
		await expect(
			t.mutation(api.watchlist.setEntryFolder, { entryId, folderId }),
		).rejects.toThrow(/authenticated/i);
	});
});
