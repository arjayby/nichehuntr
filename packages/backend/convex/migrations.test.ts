import { describe, expect, it } from "vitest";

import { createGatedTest } from "../test/harness";
import { internal } from "./_generated/api";

/** The pipeline tables the cutover purge is responsible for emptying. */
const PIPELINE_TABLES = [
	"channels",
	"videos",
	"videoSnapshots",
	"listings",
	"channelEdges",
	"enrichments",
] as const;

describe("purgePipeline", () => {
	it("empties every pipeline table for the cutover clean slate", async () => {
		const t = createGatedTest();

		// Seed one row in each table, wired together the way the live pipeline does,
		// so the purge is proven against realistic data rather than empty tables.
		await t.run(async (ctx) => {
			const channelId = await ctx.db.insert("channels", {
				ytId: "chan_purge",
				title: "Purge Me",
				discoveredAt: Date.now(),
				source: "trending",
			});
			const otherId = await ctx.db.insert("channels", {
				ytId: "chan_purge_2",
				title: "Purge Me Too",
				discoveredAt: Date.now(),
				source: "snowball",
			});
			const videoId = await ctx.db.insert("videos", {
				ytId: "vid_purge",
				channelId,
				title: "Upload",
				durationSec: 600,
				form: "long",
				publishedAt: Date.now(),
				isStandard: true,
			});
			await ctx.db.insert("videoSnapshots", {
				videoId,
				viewCount: 1000,
				at: Date.now(),
			});
			await ctx.db.insert("listings", {
				channelId,
				form: "long",
				proven: true,
				medianViews: 1000,
				baseline: null,
				momentum: null,
				saturation: null,
				stage: "emerging",
				clonability: null,
				signals: null,
			});
			await ctx.db.insert("channelEdges", {
				fromChannelId: channelId,
				toChannelId: otherId,
			});
			await ctx.db.insert("enrichments", {
				channelId,
				form: "long",
				signals: {},
				fingerprint: "fp",
				enrichedAt: Date.now(),
			});
		});

		const result = await t.mutation(internal.migrations.purgePipeline, {});

		// Every table reports the rows it deleted, and every table is now empty.
		const remaining = await t.run(async (ctx) => {
			const counts: Record<string, number> = {};
			for (const table of PIPELINE_TABLES) {
				counts[table] = (await ctx.db.query(table).collect()).length;
			}
			return counts;
		});

		for (const table of PIPELINE_TABLES) {
			expect(remaining[table]).toBe(0);
		}
		expect(result.channels).toBe(2);
		expect(result.videos).toBe(1);
		expect(result.videoSnapshots).toBe(1);
		expect(result.listings).toBe(1);
		expect(result.channelEdges).toBe(1);
		expect(result.enrichments).toBe(1);
	});

	it("is a no-op on already-empty tables", async () => {
		const t = createGatedTest();
		const result = await t.mutation(internal.migrations.purgePipeline, {});
		expect(result).toEqual({
			channels: 0,
			videos: 0,
			videoSnapshots: 0,
			listings: 0,
			channelEdges: 0,
			enrichments: 0,
		});
	});
});
