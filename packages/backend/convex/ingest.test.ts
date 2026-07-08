import { afterEach, describe, expect, it, vi } from "vitest";

import { setup as harnessSetup } from "../test/harness";
import { internal } from "./_generated/api";
import { runSnapshot } from "./ingest";
import type { Stage } from "./model/deriveListings";
import type { YouTubeAdapter } from "./model/youtube";

const DAY = 24 * 60 * 60 * 1000;
const LONG_SEC = 600; // > 180s ⇒ long-form; long Proven threshold is 100k.

/** A discovered video in the shape `upsertDiscovered` ingests. */
type DiscoveredVideo = {
	ytVideoId: string;
	ytChannelId: string;
	title: string;
	durationSec: number;
	publishedAt: number;
	viewCount: number;
	isStandard: boolean;
};

/** Build a run of standard, settled long-form uploads for one channel. */
function longVideos(
	channelId: string,
	opts: { count: number; viewCount: number; ageDays: number; tag?: string },
): DiscoveredVideo[] {
	const { count, viewCount, ageDays, tag = "v" } = opts;
	return Array.from({ length: count }, (_, i) => ({
		ytVideoId: `${channelId}_${tag}${i}`,
		ytChannelId: channelId,
		title: `${channelId} ${tag} ${i}`,
		durationSec: LONG_SEC,
		publishedAt: Date.now() - ageDays * DAY,
		viewCount,
		isStandard: true,
	}));
}

/** A stub standing in for the humble YouTube adapter — no network. Discovery is
 * gone (ADR-0005), so the snapshot cron only needs the stats refresh. */
function stubAdapter(cfg: { statViews?: number }): YouTubeAdapter {
	return {
		fetchChannels: async (ids) =>
			ids.map((id) => ({
				ytChannelId: id,
				title: `${id} title`,
				handle: `@${id}`,
			})),
		fetchVideoStats: async (ids) =>
			ids.map((id) => ({ ytVideoId: id, viewCount: cfg.statViews ?? 0 })),
		// Discovery is gone; the snapshot path never backfills uploads, so this
		// stub only needs to satisfy the adapter shape.
		fetchChannelUploads: async () => [],
	};
}

/** A convex-test instance with a subscribed Operator for gated paths. */
async function setup() {
	const { t, operator: asUser } = await harnessSetup();
	return { t, asUser };
}

async function listingByTitle(
	t: Awaited<ReturnType<typeof setup>>["t"],
	title: string,
) {
	return t.run(async (ctx) => {
		const channels = await ctx.db.query("channels").collect();
		const channel = channels.find((row) => row.title === title);
		if (channel === undefined) {
			return null;
		}
		const listings = await ctx.db
			.query("listings")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.collect();
		return listings.find((row) => row.form === "long") ?? null;
	});
}

/** Intake a channel's uploads through the shared write path (the Submission
 * worker's future entrypoint), deriving one snapshot per video as it lands. */
async function ingest(
	t: Awaited<ReturnType<typeof setup>>["t"],
	videos: DiscoveredVideo[],
) {
	const ytChannelId = videos[0]?.ytChannelId;
	return t.mutation(internal.ingest.upsertDiscovered, {
		channels:
			ytChannelId === undefined
				? []
				: [{ ytChannelId, title: `${ytChannelId} title` }],
		videos,
	});
}

describe("upsertDiscovered — channel/video/snapshot write path", () => {
	it("turns ingested uploads into a Proven Listing", async () => {
		const { t } = await setup();
		const result = await ingest(
			t,
			longVideos("chan_proven", {
				count: 5,
				viewCount: 150_000,
				ageDays: 60,
			}),
		);
		expect(result).toMatchObject({
			channels: 1,
			videos: 5,
			channelsRecomputed: 1,
		});

		expect(await listingByTitle(t, "chan_proven title")).toMatchObject({
			proven: true,
		});
	});

	it("keeps a channel unproven when its median misses the threshold", async () => {
		const { t } = await setup();
		await ingest(
			t,
			longVideos("chan_weak", {
				count: 5,
				viewCount: 40_000, // below the 100k long threshold
				ageDays: 60,
			}),
		);

		expect(await listingByTitle(t, "chan_weak title")).toMatchObject({
			proven: false,
		});
	});

	it("is idempotent — re-ingesting patches rather than duplicating", async () => {
		const { t } = await setup();
		const videos = longVideos("chan_dup", {
			count: 5,
			viewCount: 150_000,
			ageDays: 60,
		});

		await ingest(t, videos);
		await ingest(t, videos);

		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			listings: (await ctx.db.query("listings").collect()).length,
		}));
		expect(counts).toEqual({ channels: 1, videos: 5, listings: 1 });
	});

	it("drops a channel's Proven verdict once newer weak uploads sink its median", async () => {
		const { t } = await setup();

		// First pass: five strong, older uploads ⇒ Proven.
		await ingest(
			t,
			longVideos("chan_fade", {
				count: 5,
				viewCount: 150_000,
				ageDays: 90,
				tag: "strong",
			}),
		);
		expect(await listingByTitle(t, "chan_fade title")).toMatchObject({
			proven: true,
		});

		// Refresh: a dozen newer but weak uploads fill the Proven window and drag
		// the median below the threshold.
		await ingest(
			t,
			longVideos("chan_fade", {
				count: 12,
				viewCount: 8_000,
				ageDays: 10,
				tag: "weak",
			}),
		);
		expect(await listingByTitle(t, "chan_fade title")).toMatchObject({
			proven: false,
		});
	});
});

describe("runSnapshot", () => {
	it("re-samples tracked videos and refreshes the derived median", async () => {
		const { t } = await setup();

		await ingest(
			t,
			longVideos("chan_snap", {
				count: 5,
				viewCount: 150_000,
				ageDays: 60,
			}),
		);

		const medianBefore = (await listingByTitle(t, "chan_snap title"))
			?.medianViews;
		expect(medianBefore).toBe(150_000);

		// Views only climb; a fresh snapshot at 220k should lift the median.
		const result = await t.action(async (ctx) =>
			runSnapshot(ctx, stubAdapter({ statViews: 220_000 })),
		);
		expect(result).toMatchObject({ snapshots: 5, channelsRecomputed: 1 });

		const medianAfter = (await listingByTitle(t, "chan_snap title"))
			?.medianViews;
		expect(medianAfter).toBe(220_000);

		// A second snapshot was appended per video (2 each ⇒ 10 total).
		const snapshotCount = await t.run(
			async (ctx) => (await ctx.db.query("videoSnapshots").collect()).length,
		);
		expect(snapshotCount).toBe(10);
	});

	it("no-ops cleanly when nothing is tracked yet", async () => {
		const { t } = await setup();
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

		const { t } = await setup();

		/** Which Listing stage the channel currently sits in. */
		const columnOf = async (): Promise<Stage | undefined> => {
			return (await listingByTitle(t, "chan_slide title"))?.stage;
		};

		// Intake: a proven but old, slow-moving channel. With a single snapshot,
		// momentum is the views/age proxy — 150k over 90 days barely moves ⇒ cooled
		// ⇒ Established.
		await ingest(
			t,
			longVideos("chan_slide", {
				count: 3,
				viewCount: 150_000,
				ageDays: 90,
			}),
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
