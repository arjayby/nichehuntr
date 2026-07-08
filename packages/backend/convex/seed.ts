import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import { classifyForm } from "./model/deriveListings";
import { recomputeListingsForChannel } from "./model/listings";

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
		description: "Faceless AI-narrated horror shorts. Proven short-form.",
		videos: uploads(42, views(720_000, 8)),
	},
	{
		ytId: "seed_deep_finance",
		title: "Deep Finance Breakdowns",
		handle: "deepfinancebreakdowns",
		description: "Long-form finance explainers. Proven long-form.",
		videos: uploads(840, views(185_000, 8)),
	},
	{
		// Straddles both forms → two Listings (ADR-0002).
		ytId: "seed_faceless_empire",
		title: "Faceless Empire",
		handle: "facelessempire",
		description:
			"Compilation shorts and long-form deep dives. Proven in both forms.",
		videos: [
			...uploads(48, views(660_000, 5)),
			...uploads(900, views(155_000, 5)),
		],
	},
	{
		// Median below the long threshold — one viral fluke can't carry it. Kept in
		// the read model as a non-proven Listing, so it never reaches the Feed.
		ytId: "seed_one_hit_wonder",
		title: "One-Hit Wonder",
		handle: "onehitwonder",
		description: "One viral video, otherwise quiet. Fails the Proven gate.",
		videos: uploads(
			900,
			[42_000, 38_000, 45_000, 40_000, 3_200_000, 44_000, 39_000, 41_000],
		),
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
		const listings = await ctx.db
			.query("listings")
			.withIndex("by_channel", (q) => q.eq("channelId", channel._id))
			.collect();
		for (const listing of listings) {
			await ctx.db.delete("listings", listing._id);
		}
		await ctx.db.delete("channels", channel._id);
	}
}

/**
 * Dev-only seed: wipes previously seeded data and inserts a handful of channels
 * with videos + snapshots, then derives their Listings — so the whole path
 * (schema → deriveListings → feed → UI) is demoable without hitting YouTube.
 * Run manually with `npx convex run seed:seed`.
 */
export const seed = internalMutation({
	args: {},
	handler: async (ctx) => {
		await clearSeedData(ctx);

		const now = Date.now();
		for (const spec of SEED_CHANNELS) {
			const channelId = await ctx.db.insert("channels", {
				ytId: spec.ytId,
				title: spec.title,
				handle: spec.handle,
				description: spec.description,
				discoveredAt: now,
				source: "seed",
			});

			for (const [i, video] of spec.videos.entries()) {
				const videoId = await ctx.db.insert("videos", {
					ytId: `${spec.ytId}_v${i}`,
					channelId,
					title: `${spec.title} — upload ${i + 1}`,
					durationSec: video.durationSec,
					form: classifyForm(video.durationSec),
					publishedAt: now - video.ageDays * DAY_MS,
					currentViewCount: video.viewCount,
					isStandard: video.isStandard ?? true,
				});
				await ctx.db.insert("videoSnapshots", {
					videoId,
					viewCount: video.viewCount,
					at: now,
				});
			}

			await recomputeListingsForChannel(ctx, channelId);
		}

		const allListings = await ctx.db.query("listings").collect();
		return {
			channels: SEED_CHANNELS.length,
			listings: allListings.length,
			provenListings: allListings.filter((l) => l.proven).length,
		};
	},
});
