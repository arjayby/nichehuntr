import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, query } from "./_generated/server";
import { channelEnrichmentFor } from "./model/channelEnrichment";
import {
	type ChannelLifecycleStage,
	deriveChannelLifecycle,
	type LifecycleEvidence,
} from "./model/channelLifecycle";
import { computeClonability, type Signals } from "./model/clonability";
import { stageValidator } from "./model/validators";
import { requireActiveSubscription } from "./polar";

type FeedStage = Exclude<ChannelLifecycleStage, "tracked">;

/** Canonical left-to-right column order — the channel lifecycle (CONTEXT.md). */
const STAGE_ORDER = [
	"emerging",
	"breaking_out",
	"established",
] as const satisfies readonly FeedStage[];

/** Safety cap on cards read per request; pagination is deferred (out of scope). */
const MAX_FEED_CARDS = 500;

/** Safety cap on channel videos scanned while deriving lifecycle evidence. */
const MAX_CHANNEL_VIDEOS = 200;

/** A single Feed card: a visible Channel plus lifecycle evidence. */
export type FeedCard = {
	channelId: Id<"channels">;
	stage: FeedStage;
	evidence: LifecycleEvidence;
	clonability: number | null;
	/** Short-form Enrichment scores + rationales behind Clonability. Null until
	 * the enrich cron scores this Channel's Shorts; it never gates visibility. */
	signals: Signals | null;
	channel: {
		ytId: string;
		title: string;
		handle: string | null;
		avatarUrl: string | null;
	};
};

/** One column of the Feed: a Stage and its cards, sorted by Clonability desc. */
export type FeedGroup = { stage: FeedStage; cards: FeedCard[] };

/** Sort by Clonability descending, keeping channels with no score yet last. */
function byClonabilityDesc(a: FeedCard, b: FeedCard): number {
	if (a.clonability === b.clonability) return 0;
	if (a.clonability === null) return 1;
	if (b.clonability === null) return -1;
	return b.clonability - a.clonability;
}

async function videosForLifecycle(ctx: QueryCtx, channelId: Id<"channels">) {
	const videos = await ctx.db
		.query("videos")
		.withIndex("by_channel_and_publishedAt", (q) =>
			q.eq("channelId", channelId),
		)
		.order("desc")
		.take(MAX_CHANNEL_VIDEOS);

	return Promise.all(
		videos.map(async (video: Doc<"videos">) => {
			if (video.currentViewCount !== undefined) {
				return {
					durationSec: video.durationSec,
					publishedAt: video.publishedAt,
					viewCount: video.currentViewCount,
				};
			}
			const latestSnapshot = await ctx.db
				.query("videoSnapshots")
				.withIndex("by_video_and_at", (q) => q.eq("videoId", video._id))
				.order("desc")
				.first();
			return {
				durationSec: video.durationSec,
				publishedAt: video.publishedAt,
				viewCount: latestSnapshot?.viewCount ?? 0,
			};
		}),
	);
}

/**
 * The Feed: visible Channels grouped into lifecycle columns and sorted by
 * Clonability. It is a shared, global surface and requires an active subscription.
 */
export const feed = query({
	args: {
		stages: v.optional(v.array(stageValidator)),
	},
	handler: async (ctx, args): Promise<FeedGroup[]> => {
		await requireActiveSubscription(ctx);

		const stageSet = new Set<FeedStage>(
			args.stages && args.stages.length > 0 ? args.stages : STAGE_ORDER,
		);

		const channels = await ctx.db
			.query("channels")
			.order("desc")
			.take(MAX_FEED_CARDS);

		const cards: FeedCard[] = [];
		for (const channel of channels) {
			const [videos, enrichment] = await Promise.all([
				videosForLifecycle(ctx, channel._id),
				channelEnrichmentFor(ctx, channel._id),
			]);
			const lifecycle = deriveChannelLifecycle({
				subscriberCount: channel.subscriberCount ?? 0,
				videos,
				now: Date.now(),
			});
			if (
				lifecycle.feedVisibility === "hidden" ||
				lifecycle.stage === "tracked" ||
				!stageSet.has(lifecycle.stage)
			) {
				continue;
			}
			cards.push({
				channelId: channel._id,
				stage: lifecycle.stage,
				evidence: lifecycle.evidence,
				clonability: computeClonability(enrichment?.signals ?? null),
				signals: enrichment?.signals ?? null,
				channel: {
					ytId: channel.ytId,
					title: channel.title,
					handle: channel.handle ?? null,
					avatarUrl: channel.avatarUrl ?? null,
				},
			});
		}

		cards.sort(byClonabilityDesc);

		return STAGE_ORDER.filter((stage) => stageSet.has(stage)).map((stage) => ({
			stage,
			cards: cards.filter((card) => card.stage === stage),
		}));
	},
});
