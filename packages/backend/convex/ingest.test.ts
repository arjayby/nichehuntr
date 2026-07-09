import { describe, expect, it } from "vitest";

import { setup as harnessSetup } from "../test/harness";
import { internal } from "./_generated/api";

const DAY = 24 * 60 * 60 * 1000;
const SHORT_SEC = 45;

type DiscoveredVideo = {
	ytVideoId: string;
	ytChannelId: string;
	title: string;
	durationSec: number;
	publishedAt: number;
	viewCount: number;
	isStandard: boolean;
};

function shorts(
	channelId: string,
	viewCounts: number[],
	tag = "short",
): DiscoveredVideo[] {
	return viewCounts.map((viewCount, index) => ({
		ytVideoId: `${channelId}_${tag}_${index}`,
		ytChannelId: channelId,
		title: `${channelId} ${tag} ${index}`,
		durationSec: SHORT_SEC,
		publishedAt: Date.now() - (index + 1) * DAY,
		viewCount,
		isStandard: true,
	}));
}

async function setup() {
	const { t } = await harnessSetup();
	return { t };
}

async function ingest(
	t: Awaited<ReturnType<typeof setup>>["t"],
	videos: DiscoveredVideo[],
	opts: { title?: string; subscriberCount?: number } = {},
) {
	const ytChannelId = videos[0]?.ytChannelId;
	return t.mutation(internal.ingest.upsertDiscovered, {
		channels:
			ytChannelId === undefined
				? []
				: [
						{
							ytChannelId,
							title: opts.title ?? `${ytChannelId} title`,
							subscriberCount: opts.subscriberCount,
						},
					],
		videos,
	});
}

describe("upsertDiscovered — Channel current-stat write path", () => {
	it("stores submitted Channel metadata and current per-video view counts", async () => {
		const { t } = await setup();
		const result = await ingest(
			t,
			shorts("chan_visible", [120_000, 130_000, 10_000]),
			{ title: "Visible Shorts", subscriberCount: 12_000 },
		);

		expect(result).toEqual({ channels: 1, videos: 3, channelsTouched: 1 });

		const stored = await t.run(async (ctx) => {
			const channel = await ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", "chan_visible"))
				.unique();
			const videos =
				channel === null
					? []
					: await ctx.db
							.query("videos")
							.withIndex("by_channel_and_publishedAt", (q) =>
								q.eq("channelId", channel._id),
							)
							.collect();
			return {
				channel,
				currentViewCounts: videos
					.map((video) => video.currentViewCount)
					.sort((a, b) => (a ?? 0) - (b ?? 0)),
			};
		});

		expect(stored.channel).toMatchObject({
			title: "Visible Shorts",
			subscriberCount: 12_000,
			source: "admin",
		});
		expect(stored.currentViewCounts).toEqual([10_000, 120_000, 130_000]);
	});

	it("does not write legacy snapshots or Listings during ingest", async () => {
		const { t } = await setup();
		await ingest(t, shorts("chan_clean", [80_000, 60_000, 10_000]));

		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			snapshots: (await ctx.db.query("videoSnapshots").collect()).length,
			listings: (await ctx.db.query("listings").collect()).length,
		}));

		expect(counts).toEqual({
			channels: 1,
			videos: 3,
			snapshots: 0,
			listings: 0,
		});
	});

	it("is idempotent: re-ingesting patches current stats rather than duplicating", async () => {
		const { t } = await setup();
		const initial = shorts("chan_refresh", [120_000, 130_000, 140_000]);

		await ingest(t, initial, { title: "Refreshable" });
		await ingest(
			t,
			initial.map((video) => ({ ...video, viewCount: 1_000 })),
			{ title: "Refreshable Renamed" },
		);

		const stored = await t.run(async (ctx) => ({
			channels: await ctx.db.query("channels").collect(),
			videos: await ctx.db.query("videos").collect(),
		}));

		expect(stored.channels).toHaveLength(1);
		expect(stored.channels[0]).toMatchObject({ title: "Refreshable Renamed" });
		expect(stored.videos).toHaveLength(3);
		expect(stored.videos.map((video) => video.currentViewCount)).toEqual([
			1_000, 1_000, 1_000,
		]);
	});
});
