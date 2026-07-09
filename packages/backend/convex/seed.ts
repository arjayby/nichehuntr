import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { deriveChannelLifecycle } from "./model/channelLifecycle";

const DAY_MS = 24 * 60 * 60 * 1000;

type SeedVideo = {
	durationSec: number;
	viewCount: number;
	ageDays: number;
	isStandard?: boolean;
};

type SeedChannel = {
	ytId: string;
	title: string;
	handle: string;
	description: string;
	subscriberCount?: number;
	videos: SeedVideo[];
};

/** Spread N view counts around a base with a fixed, deterministic wobble. */
function views(base: number, count: number): number[] {
	const wobble = [0, 0.12, -0.1, 0.06, -0.05, 0.15, -0.08, 0.03, 0.09, -0.12];
	return Array.from({ length: count }, (_, i) =>
		Math.round(base * (1 + (wobble[i % wobble.length] as number))),
	);
}

function uploads(durationSec: number, viewCounts: number[]): SeedVideo[] {
	// Space uploads a week apart, all settled (oldest first is irrelevant here).
	return viewCounts.map((viewCount, i) => ({
		durationSec,
		viewCount,
		ageDays: 10 + i * 7,
	}));
}

const SEED_CHANNELS: SeedChannel[] = [
	{
		ytId: "seed_ai_horror",
		title: "AI Horror Shorts",
		handle: "aihorrorshorts",
		description: "Faceless AI-narrated horror shorts with strong recent reach.",
		videos: uploads(42, views(720_000, 8)),
	},
	{
		ytId: "seed_deep_finance",
		title: "Deep Finance Breakdowns",
		handle: "deepfinancebreakdowns",
		description:
			"Long-form finance explainers. Ignored by the short-form Feed.",
		videos: uploads(840, views(185_000, 8)),
	},
	{
		ytId: "seed_faceless_empire",
		title: "Faceless Empire",
		handle: "facelessempire",
		description: "Compilation Shorts with enough reach to sit on the Feed.",
		videos: [
			...uploads(48, views(660_000, 5)),
			...uploads(900, views(155_000, 5)),
		],
	},
	{
		ytId: "seed_one_hit_wonder",
		title: "One-Hit Wonder",
		handle: "onehitwonder",
		description: "One viral long-form video, otherwise quiet.",
		videos: uploads(
			900,
			[42_000, 38_000, 45_000, 40_000, 3_200_000, 44_000, 39_000, 41_000],
		),
	},
	{
		ytId: "seed_mature_shorts",
		title: "Mature Shorts Reference",
		handle: "matureshorts",
		description: "Established Shorts channel with mature audience and catalog.",
		subscriberCount: 80_000,
		videos: uploads(36, views(180_000, 50)),
	},
];

async function clearSeedData(ctx: MutationCtx): Promise<void> {
	const seeded = await ctx.db
		.query("channels")
		.withIndex("by_source", (q) => q.eq("source", "seed"))
		.take(100);
	for (const channel of seeded) {
		const videos = await ctx.db
			.query("videos")
			.withIndex("by_channel_and_publishedAt", (q) =>
				q.eq("channelId", channel._id),
			)
			.collect();
		for (const video of videos) {
			const snapshots = await ctx.db
				.query("videoSnapshots")
				.withIndex("by_video_and_at", (q) => q.eq("videoId", video._id))
				.collect();
			for (const snapshot of snapshots) {
				await ctx.db.delete("videoSnapshots", snapshot._id);
			}
			await ctx.db.delete("videos", video._id);
		}
		await ctx.db.delete("channels", channel._id);
	}
}

/**
 * Dev-only seed: wipes previously seeded data and inserts a handful of channels
 * with current video counts, so the Channel lifecycle Feed is demoable without
 * hitting YouTube.
 * Run manually with `npx convex run seed:seed`.
 */
export const seed = internalMutation({
	args: {},
	handler: async (ctx) => {
		await clearSeedData(ctx);

		const now = Date.now();
		let visibleSeedChannels = 0;
		for (const spec of SEED_CHANNELS) {
			const channelId = await ctx.db.insert("channels", {
				ytId: spec.ytId,
				title: spec.title,
				handle: spec.handle,
				description: spec.description,
				subscriberCount: spec.subscriberCount ?? 1_000,
				discoveredAt: now,
				source: "seed",
			});

			for (const [i, video] of spec.videos.entries()) {
				await ctx.db.insert("videos", {
					ytId: `${spec.ytId}_v${i}`,
					channelId,
					title: `${spec.title} - upload ${i + 1}`,
					durationSec: video.durationSec,
					publishedAt: now - video.ageDays * DAY_MS,
					currentViewCount: video.viewCount,
					isStandard: video.isStandard ?? true,
				});
			}
			const lifecycle = deriveChannelLifecycle({
				subscriberCount: spec.subscriberCount ?? 1_000,
				videos: spec.videos.map((video) => ({
					durationSec: video.durationSec,
					publishedAt: now - video.ageDays * DAY_MS,
					viewCount: video.viewCount,
				})),
				now,
			});
			if (lifecycle.feedVisibility === "visible") {
				visibleSeedChannels += 1;
			}
		}

		return {
			channels: SEED_CHANNELS.length,
			visibleSeedChannels,
		};
	},
});
