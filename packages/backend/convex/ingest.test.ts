/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import { runDiscovery, runSnapshot } from "./ingest";
import type { Stage } from "./model/deriveListings";
import type {
	ChannelInfo,
	TrendingVideo,
	YouTubeAdapter,
} from "./model/youtube";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const DAY = 24 * 60 * 60 * 1000;
const LONG_SEC = 600; // > 180s ⇒ long-form; long Proven threshold is 100k.

/** Build a run of standard, settled long-form trending videos for one channel. */
function longVideos(
	channelId: string,
	opts: { count: number; viewCount: number; ageDays: number; tag?: string },
): TrendingVideo[] {
	const { count, viewCount, ageDays, tag = "v" } = opts;
	return Array.from({ length: count }, (_, i) => ({
		ytVideoId: `${channelId}_${tag}${i}`,
		ytChannelId: channelId,
		channelTitle: `${channelId} title`,
		title: `${channelId} ${tag} ${i}`,
		durationSec: LONG_SEC,
		publishedAt: Date.now() - ageDays * DAY,
		viewCount,
		isStandard: true,
	}));
}

/** A stub standing in for the humble YouTube adapter — no network. */
function stubAdapter(cfg: {
	trending?: TrendingVideo[];
	channels?: ChannelInfo[];
	statViews?: number;
}): YouTubeAdapter {
	return {
		fetchTrending: async () => cfg.trending ?? [],
		fetchChannels: async (ids) =>
			cfg.channels ??
			ids.map((id) => ({
				ytChannelId: id,
				title: `${id} title`,
				handle: `@${id}`,
			})),
		fetchVideoStats: async (ids) =>
			ids.map((id) => ({ ytVideoId: id, viewCount: cfg.statViews ?? 0 })),
	};
}

/** Titles of every card the feed returned, across all columns. */
function titles(
	groups: { cards: { channel: { title: string } }[] }[],
): string[] {
	return groups.flatMap((g) => g.cards).map((c) => c.channel.title);
}

describe("runDiscovery", () => {
	it("turns a fetched channel into a Proven Listing visible in the Feed", async () => {
		const t = convexTest(schema, modules);
		const adapter = stubAdapter({
			trending: longVideos("chan_proven", {
				count: 5,
				viewCount: 150_000,
				ageDays: 60,
			}),
			channels: [
				{
					ytChannelId: "chan_proven",
					title: "Proven Channel",
					handle: "@proven",
					avatarUrl: "https://img/avatar.jpg",
				},
			],
		});

		const result = await t.action(async (ctx) => runDiscovery(ctx, adapter));
		expect(result).toMatchObject({
			channels: 1,
			videos: 5,
			channelsRecomputed: 1,
		});

		const asUser = t.withIdentity({ subject: "u" });
		const longTitles = titles(
			await asUser.query(api.feed.feed, { form: "long" }),
		);
		expect(longTitles).toContain("Proven Channel");

		// The channel was recorded as trending-sourced, not seeded.
		const source = await t.run(async (ctx) => {
			const channel = await ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", "chan_proven"))
				.unique();
			return channel?.source;
		});
		expect(source).toBe("trending");
	});

	it("does not surface a channel whose median misses the Proven threshold", async () => {
		const t = convexTest(schema, modules);
		const adapter = stubAdapter({
			trending: longVideos("chan_weak", {
				count: 5,
				viewCount: 40_000, // below the 100k long threshold
				ageDays: 60,
			}),
		});

		await t.action(async (ctx) => runDiscovery(ctx, adapter));

		const asUser = t.withIdentity({ subject: "u" });
		const longTitles = titles(
			await asUser.query(api.feed.feed, { form: "long" }),
		);
		expect(longTitles).not.toContain("chan_weak title");
	});

	it("is idempotent — re-discovering patches rather than duplicating", async () => {
		const t = convexTest(schema, modules);
		const adapter = stubAdapter({
			trending: longVideos("chan_dup", {
				count: 5,
				viewCount: 150_000,
				ageDays: 60,
			}),
		});

		await t.action(async (ctx) => runDiscovery(ctx, adapter));
		await t.action(async (ctx) => runDiscovery(ctx, adapter));

		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			listings: (await ctx.db.query("listings").collect()).length,
		}));
		expect(counts).toEqual({ channels: 1, videos: 5, listings: 1 });
	});

	it("drops a channel from the Feed once newer weak uploads sink its median", async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity({ subject: "u" });

		// First pass: five strong, older uploads ⇒ Proven, in the Feed.
		await t.action(async (ctx) =>
			runDiscovery(
				ctx,
				stubAdapter({
					trending: longVideos("chan_fade", {
						count: 5,
						viewCount: 150_000,
						ageDays: 90,
						tag: "strong",
					}),
				}),
			),
		);
		expect(
			titles(await asUser.query(api.feed.feed, { form: "long" })),
		).toContain("chan_fade title");

		// Refresh: a dozen newer but weak uploads fill the Proven window and drag
		// the median below the threshold.
		await t.action(async (ctx) =>
			runDiscovery(
				ctx,
				stubAdapter({
					trending: longVideos("chan_fade", {
						count: 12,
						viewCount: 8_000,
						ageDays: 10,
						tag: "weak",
					}),
				}),
			),
		);
		expect(
			titles(await asUser.query(api.feed.feed, { form: "long" })),
		).not.toContain("chan_fade title");
	});
});

describe("runSnapshot", () => {
	it("re-samples tracked videos and refreshes the derived median", async () => {
		const t = convexTest(schema, modules);
		const asUser = t.withIdentity({ subject: "u" });

		await t.action(async (ctx) =>
			runDiscovery(
				ctx,
				stubAdapter({
					trending: longVideos("chan_snap", {
						count: 5,
						viewCount: 150_000,
						ageDays: 60,
					}),
				}),
			),
		);

		const medianBefore = (await asUser.query(api.feed.feed, { form: "long" }))
			.flatMap((g) => g.cards)
			.find((c) => c.channel.title === "chan_snap title")?.medianViews;
		expect(medianBefore).toBe(150_000);

		// Views only climb; a fresh snapshot at 220k should lift the median.
		const result = await t.action(async (ctx) =>
			runSnapshot(ctx, stubAdapter({ statViews: 220_000 })),
		);
		expect(result).toMatchObject({ snapshots: 5, channelsRecomputed: 1 });

		const medianAfter = (await asUser.query(api.feed.feed, { form: "long" }))
			.flatMap((g) => g.cards)
			.find((c) => c.channel.title === "chan_snap title")?.medianViews;
		expect(medianAfter).toBe(220_000);

		// A second snapshot was appended per video (2 each ⇒ 10 total).
		const snapshotCount = await t.run(
			async (ctx) => (await ctx.db.query("videoSnapshots").collect()).length,
		);
		expect(snapshotCount).toBe(10);
	});

	it("no-ops cleanly when nothing is tracked yet", async () => {
		const t = convexTest(schema, modules);
		const result = await t.action(async (ctx) =>
			runSnapshot(ctx, stubAdapter({ statViews: 1 })),
		);
		expect(result).toEqual({ snapshots: 0, channelsRecomputed: 0 });
	});
});

describe("momentum drives live column placement", () => {
	// Fake only Date so convex-test's async internals keep using real timers.
	afterEach(() => {
		vi.useRealTimers();
	});

	it("slides a Listing across columns as snapshot cycles reveal acceleration", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const t0 = Date.UTC(2026, 5, 1);
		vi.setSystemTime(t0);

		const t = convexTest(schema, modules);
		const asUser = t.withIdentity({ subject: "u" });

		/** Which lifecycle column the channel's card currently sits in. */
		const columnOf = async (): Promise<Stage | undefined> => {
			const groups = await asUser.query(api.feed.feed, { form: "long" });
			return groups.find((g) =>
				g.cards.some((c) => c.channel.title === "chan_slide title"),
			)?.stage;
		};

		// Discovery: a proven but old, slow-moving channel. With a single snapshot,
		// momentum is the views/age proxy — 150k over 90 days barely moves ⇒ cooled
		// ⇒ Established.
		await t.action(async (ctx) =>
			runDiscovery(
				ctx,
				stubAdapter({
					trending: longVideos("chan_slide", {
						count: 3,
						viewCount: 150_000,
						ageDays: 90,
					}),
				}),
			),
		);
		expect(await columnOf()).toBe("established");

		// Two days on, a snapshot cycle catches the videos surging to 240k: a steep
		// recent slope ⇒ strong momentum ⇒ the same card moves to Breaking Out.
		vi.setSystemTime(t0 + 2 * DAY);
		await t.action(async (ctx) =>
			runSnapshot(ctx, stubAdapter({ statViews: 240_000 })),
		);
		expect(await columnOf()).toBe("breaking_out");
	});
});
