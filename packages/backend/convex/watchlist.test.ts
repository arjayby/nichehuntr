import { describe, expect, it } from "vitest";

import { asSubscribedOperator, createGatedTest, setup } from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const DAY = 24 * 60 * 60 * 1000;

async function addChannel(
	ctx: MutationCtx,
	title: string,
	description?: string,
	opts: { subscriberCount?: number } = {},
): Promise<Id<"channels">> {
	return ctx.db.insert("channels", {
		ytId: `yt_${title.replace(/\s+/g, "_")}`,
		title,
		handle: title.toLowerCase().replace(/\s+/g, ""),
		avatarUrl: `https://img/${title}.jpg`,
		description,
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
		viewCount?: number;
		publishedAt: number;
		durationSec?: number;
		isStandard?: boolean;
		writeCurrentCount?: boolean;
	},
) {
	const viewCount = opts.viewCount ?? 0;
	const videoId = await ctx.db.insert("videos", {
		ytId: opts.title.toLowerCase().replace(/\s+/g, "_"),
		channelId: opts.channelId,
		title: opts.title,
		thumbnailUrl: `https://img/${opts.title}.jpg`,
		durationSec: opts.durationSec ?? 45,
		form: (opts.durationSec ?? 45) <= 300 ? "short" : "long",
		publishedAt: opts.publishedAt,
		currentViewCount: opts.writeCurrentCount === false ? undefined : viewCount,
		isStandard: opts.isStandard ?? true,
	});
	if (opts.writeCurrentCount === false && opts.viewCount !== undefined) {
		await ctx.db.insert("videoSnapshots", {
			videoId,
			viewCount,
			at: Date.now(),
		});
	}
	return videoId;
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

async function addEnrichment(ctx: MutationCtx, channelId: Id<"channels">) {
	await ctx.db.insert("enrichments", {
		channelId,
		form: "short",
		fingerprint: `fp_${channelId}`,
		enrichedAt: Date.now(),
		signals: {
			automatable: { score: 90, rationale: "Templated AI voiceover." },
			transformative: { score: 70, rationale: "Repackages story prompts." },
			improvable: { score: 55, rationale: "Thumbnails are lazy." },
		},
	});
}

describe("watchlist", () => {
	it("saves a Channel on toggle and lists it at the root with channel identity", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "AI Horror"));

		const result = await operator.mutation(api.watchlist.toggle, {
			channelId,
		});
		expect(result).toEqual({ saved: true });

		const { folders, root } = await operator.query(api.watchlist.list, {});
		expect(folders).toEqual([]);
		expect(root).toHaveLength(1);
		expect(root[0]).toMatchObject({
			channelId,
			folderId: null,
			channel: {
				ytId: "yt_AI_Horror",
				title: "AI Horror",
				handle: "aihorror",
				avatarUrl: "https://img/AI Horror.jpg",
			},
		});
	});

	it("unsaves on the second toggle — saving the same Channel twice is impossible", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "AI Horror"));

		await operator.mutation(api.watchlist.toggle, { channelId });
		const second = await operator.mutation(api.watchlist.toggle, {
			channelId,
		});
		expect(second).toEqual({ saved: false });

		const { root } = await operator.query(api.watchlist.list, {});
		expect(root).toEqual([]);
	});

	it("dedupes on Channel only", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "Straddler"));

		await operator.mutation(api.watchlist.toggle, { channelId });
		const second = await operator.mutation(api.watchlist.toggle, { channelId });

		const { root } = await operator.query(api.watchlist.list, {});
		expect(second).toEqual({ saved: false });
		expect(root).toEqual([]);
	});

	it("collapses duplicate stored rows and unsaves all duplicates for a Channel", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run((ctx) => addChannel(ctx, "Duplicate"));
		await operator.mutation(api.watchlist.toggle, { channelId });

		await t.run(async (ctx) => {
			const existing = await ctx.db.query("watchlistEntries").first();
			if (existing === null) throw new Error("missing saved row");
			await ctx.db.insert("watchlistEntries", {
				operatorId: existing.operatorId,
				channelId,
			});
		});

		expect((await operator.query(api.watchlist.list, {})).root).toHaveLength(1);

		const result = await operator.mutation(api.watchlist.toggle, { channelId });
		expect(result).toEqual({ saved: false });
		expect((await operator.query(api.watchlist.list, {})).root).toEqual([]);
		const rows = await t.run((ctx) =>
			ctx.db.query("watchlistEntries").take(10),
		);
		expect(rows).toEqual([]);
	});

	it("scopes entries to the calling Operator", async () => {
		const { t, operator } = await setup();
		const rival = await asSubscribedOperator(t, "rival");
		const channelId = await t.run((ctx) => addChannel(ctx, "Contested"));

		await operator.mutation(api.watchlist.toggle, { channelId });

		expect((await rival.query(api.watchlist.list, {})).root).toEqual([]);

		// The rival saving the same Channel is their own entry, not a dedupe hit.
		await rival.mutation(api.watchlist.toggle, { channelId });
		expect((await rival.query(api.watchlist.list, {})).root).toHaveLength(1);
		expect((await operator.query(api.watchlist.list, {})).root).toHaveLength(1);
	});

	it("lists root entries newest-first", async () => {
		const { t, operator } = await setup();
		const first = await t.run((ctx) => addChannel(ctx, "Saved First"));
		const second = await t.run((ctx) => addChannel(ctx, "Saved Second"));

		await operator.mutation(api.watchlist.toggle, {
			channelId: first,
		});
		await operator.mutation(api.watchlist.toggle, {
			channelId: second,
		});

		const { root } = await operator.query(api.watchlist.list, {});
		expect(root.map((e) => e.channel.title)).toEqual([
			"Saved Second",
			"Saved First",
		]);
	});

	it("detail re-derives live Feed state when the Channel is on the Feed", async () => {
		const { t, operator } = await setup();
		const channelId = await t.run(async (ctx) => {
			const id = await addChannel(
				ctx,
				"AI Horror",
				"Nightly AI horror shorts.",
			);
			await addShorts(ctx, id, [120_000, 130_000, 10_000]);
			await addEnrichment(ctx, id);
			return id;
		});

		const detail = await operator.query(api.watchlist.detail, {
			channelId,
		});

		expect(detail).toMatchObject({
			channelId,
			channel: {
				ytId: "yt_AI_Horror",
				title: "AI Horror",
				handle: "aihorror",
				avatarUrl: "https://img/AI Horror.jpg",
				description: "Nightly AI horror shorts.",
			},
			feed: {
				stage: "breaking_out",
				evidence: {
					fetchedShorts: 3,
					recentShortsChecked: 3,
					shortsAtOrAbove50k: 2,
					shortsAtOrAbove100k: 2,
				},
				clonability: 76,
				signals: {
					automatable: { score: 90, rationale: "Templated AI voiceover." },
					transformative: { score: 70, rationale: "Repackages story prompts." },
					improvable: { score: 55, rationale: "Thumbnails are lazy." },
				},
			},
		});
	});

	it("detail degrades to identity + null Feed state when the Channel is off the Feed", async () => {
		const { t, operator } = await setup();
		const { goneId, unprovenId } = await t.run(async (ctx) => {
			const goneId = await addChannel(ctx, "Vanished", "Used to be hot.");
			// No videos at all — lifecycle keeps the Channel Tracked/hidden.
			const unprovenId = await addChannel(ctx, "Faded");
			await addShorts(ctx, unprovenId, [40_000, 30_000, 20_000]);
			return { goneId, unprovenId };
		});

		const gone = await operator.query(api.watchlist.detail, {
			channelId: goneId,
		});
		expect(gone).toMatchObject({
			channel: { title: "Vanished", description: "Used to be hot." },
			feed: null,
		});

		const unproven = await operator.query(api.watchlist.detail, {
			channelId: unprovenId,
		});
		expect(unproven).toMatchObject({
			channel: { title: "Faded" },
			feed: null,
		});
	});

	it("detail's uploads strip is the last 12 standard Shorts, newest-first, with latest snapshot counts", async () => {
		const { t, operator } = await setup();
		const base = Date.UTC(2026, 0, 1);
		const day = 24 * 60 * 60 * 1000;
		const channelId = await t.run(async (ctx) => {
			const channelId = await addChannel(ctx, "Prolific");
			// 14 standard shorts — only the newest 12 belong on the strip.
			for (let i = 0; i < 14; i++) {
				const videoId = await addVideo(ctx, {
					channelId,
					title: `Short ${i}`,
					publishedAt: base + i * day,
					writeCurrentCount: false,
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
			await addVideo(ctx, {
				channelId,
				title: "Long video",
				durationSec: 900,
				publishedAt: base + 20 * day,
			});
			await addVideo(ctx, {
				channelId,
				title: "Live stream",
				publishedAt: base + 21 * day,
				isStandard: false,
			});
			return channelId;
		});

		const detail = await operator.query(api.watchlist.detail, {
			channelId,
		});

		expect(detail?.uploads).toHaveLength(12);
		expect(detail?.uploads.map((u) => u.ytId)).toEqual(
			Array.from({ length: 12 }, (_, i) => `short_${13 - i}`),
		);
		expect(detail?.uploads[0]).toMatchObject({
			ytId: "short_13",
			title: "Short 13",
			thumbnailUrl: "https://img/Short 13.jpg",
			publishedAt: base + 13 * day,
			viewCount: 250_000, // the latest snapshot, not the first
		});
		// No snapshot yet — the count is explicitly unmeasured, never zero.
		expect(detail?.uploads[1]?.viewCount).toBeNull();
	});

	it("entries flag whether each Channel is still on the Feed", async () => {
		const { t, operator } = await setup();
		const { liveId, fadedId } = await t.run(async (ctx) => {
			const liveId = await addChannel(ctx, "Still Live");
			await addShorts(ctx, liveId, [80_000, 60_000, 10_000]);
			const fadedId = await addChannel(ctx, "Faded Away");
			await addShorts(ctx, fadedId, [40_000, 30_000, 20_000]);
			return { liveId, fadedId };
		});

		await operator.mutation(api.watchlist.toggle, {
			channelId: liveId,
		});
		await operator.mutation(api.watchlist.toggle, {
			channelId: fadedId,
		});

		const { root } = await operator.query(api.watchlist.list, {});
		const byTitle = new Map(root.map((e) => [e.channel.title, e.onFeed]));
		expect(byTitle.get("Still Live")).toBe(true);
		expect(byTitle.get("Faded Away")).toBe(false);
	});

	it("requires authentication", async () => {
		const t = createGatedTest();
		const channelId = await t.run((ctx) => addChannel(ctx, "Locked"));

		await expect(
			t.mutation(api.watchlist.toggle, { channelId }),
		).rejects.toThrow(/authenticated/i);
		await expect(t.query(api.watchlist.list, {})).rejects.toThrow(
			/authenticated/i,
		);
		await expect(t.query(api.watchlist.detail, { channelId })).rejects.toThrow(
			/authenticated/i,
		);
	});
});

describe("watchlist folders", () => {
	/** Save a channel and return the freshly created entry's id. */
	async function saveEntry(
		operator: Awaited<ReturnType<typeof asSubscribedOperator>>,
		channelId: Id<"channels">,
	): Promise<Id<"watchlistEntries">> {
		await operator.mutation(api.watchlist.toggle, { channelId });
		const { root, folders } = await operator.query(api.watchlist.list, {});
		const all = [...root, ...folders.flatMap((f) => f.entries)];
		const entry = all.find((e) => e.channelId === channelId);
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
