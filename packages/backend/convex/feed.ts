import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import type { Form, Stage } from "./model/deriveListings";
import { formValidator, stageValidator } from "./model/validators";

/** Canonical left-to-right column order — the momentum lifecycle (CONTEXT.md). */
const STAGE_ORDER = [
	"emerging",
	"breaking_out",
	"established",
] as const satisfies readonly Stage[];

/** Safety cap on cards read per request; pagination is deferred (out of scope). */
const MAX_FEED_CARDS = 500;

/** A single Feed card: a Proven Listing plus the channel identity it renders. */
export type FeedCard = {
	listingId: Id<"listings">;
	channelId: Id<"channels">;
	form: Form;
	stage: Stage;
	medianViews: number;
	/** Scale-free recent daily-growth rate driving Stage; the card's indicator. */
	momentum: number | null;
	/** Similar-channel count — the niche's crowdedness; null until measured. */
	saturation: number | null;
	clonability: number | null;
	channel: {
		ytId: string;
		title: string;
		handle: string | null;
		avatarUrl: string | null;
	};
};

/** One column of the Feed: a Stage and its cards, sorted by Clonability desc. */
export type FeedGroup = { stage: Stage; cards: FeedCard[] };

/** Sort by Clonability descending, keeping listings with no score yet last. */
function byClonabilityDesc(a: FeedCard, b: FeedCard): number {
	if (a.clonability === b.clonability) return 0;
	if (a.clonability === null) return 1;
	if (b.clonability === null) return -1;
	return b.clonability - a.clonability;
}

/**
 * The Feed: Proven Listings of the selected form, grouped into the lifecycle
 * columns and sorted by Clonability. The Feed is a shared, global surface, so
 * the form/stage args are only a lens — but it still requires sign-in.
 */
export const feed = query({
	args: {
		form: formValidator,
		stages: v.optional(v.array(stageValidator)),
	},
	handler: async (ctx, args): Promise<FeedGroup[]> => {
		const identity = await ctx.auth.getUserIdentity();
		if (identity === null) {
			throw new Error("Not authenticated");
		}

		const stageSet = new Set<Stage>(
			args.stages && args.stages.length > 0 ? args.stages : STAGE_ORDER,
		);

		const provenListings = await ctx.db
			.query("listings")
			.withIndex("by_form_and_proven", (q) =>
				q.eq("form", args.form).eq("proven", true),
			)
			.take(MAX_FEED_CARDS);

		const cards: FeedCard[] = [];
		for (const listing of provenListings) {
			if (!stageSet.has(listing.stage)) {
				continue;
			}
			const channel = await ctx.db.get("channels", listing.channelId);
			if (channel === null) {
				continue; // orphaned listing — skip defensively
			}
			cards.push({
				listingId: listing._id,
				channelId: listing.channelId,
				form: listing.form,
				stage: listing.stage,
				medianViews: listing.medianViews,
				momentum: listing.momentum,
				saturation: listing.saturation,
				clonability: listing.clonability,
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
