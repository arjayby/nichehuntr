import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type QueryCtx, query } from "./_generated/server";
import type { Signals } from "./model/clonability";
import { type Form, PROVEN_WINDOW, type Stage } from "./model/deriveListings";
import { formValidator } from "./model/validators";
import { requireActiveSubscription } from "./polar";

/** Safety cap on entries read per request; pagination is deferred like the Feed's. */
const MAX_WATCHLIST_ENTRIES = 500;

/** Safety cap on how many of a channel's videos the uploads strip scans while
 * looking for its form's last `PROVEN_WINDOW` standard uploads. */
const MAX_UPLOADS_SCAN = 10 * PROVEN_WINDOW;

/**
 * One Watchlist row: the saved `(channel, form)` plus the channel identity the
 * drawer renders. A lens on the Feed (CONTEXT.md) — channel data is re-derived
 * at read time, never copied into the entry (ADR-0004).
 */
export type WatchlistEntry = {
	entryId: Id<"watchlistEntries">;
	channelId: Id<"channels">;
	form: Form;
	/** Whether the pair still has a proven Listing — false renders the row
	 * muted ("no longer on the Feed"), never hides it (ADR-0004). */
	onFeed: boolean;
	channel: {
		ytId: string;
		title: string;
		handle: string | null;
		avatarUrl: string | null;
	};
};

/**
 * Save or unsave a `(channel, form)` for the calling Operator. Deduped on the
 * exact (Operator, Channel, Form) triple (ADR-0004): toggling an existing
 * entry removes it, so saving the same card twice is impossible.
 */
export const toggle = mutation({
	args: {
		channelId: v.id("channels"),
		form: formValidator,
	},
	handler: async (ctx, args): Promise<{ saved: boolean }> => {
		const operator = await requireActiveSubscription(ctx);

		const existing = await ctx.db
			.query("watchlistEntries")
			.withIndex("by_operator_and_channel_and_form", (q) =>
				q
					.eq("operatorId", operator._id)
					.eq("channelId", args.channelId)
					.eq("form", args.form),
			)
			.unique();

		if (existing !== null) {
			await ctx.db.delete("watchlistEntries", existing._id);
			return { saved: false };
		}

		await ctx.db.insert("watchlistEntries", {
			operatorId: operator._id,
			channelId: args.channelId,
			form: args.form,
		});
		return { saved: true };
	},
});

/** An entry's identity as the client passes it around: the `(channel, form)`
 * pair (ADR-0004) — the `detail` query's args and the drawer's selection key. */
export type WatchlistSelection = {
	channelId: Id<"channels">;
	form: Form;
};

/**
 * The deep detail for one Watchlist entry. The Listing is re-derived live by
 * `(channelId, form)` at read time (ADR-0004): `listing` carries the full
 * scores while the pair is on the Feed, and is `null` when the Listing is gone
 * or unproven — the explicit "no longer on the Feed" state, which is a product
 * state, not an error.
 */
export type WatchlistDetail = {
	channelId: Id<"channels">;
	form: Form;
	channel: {
		ytId: string;
		title: string;
		handle: string | null;
		avatarUrl: string | null;
		description: string | null;
	};
	listing: {
		stage: Stage;
		medianViews: number;
		momentum: number | null;
		saturation: number | null;
		clonability: number | null;
		signals: Signals | null;
	} | null;
	uploads: WatchlistUpload[];
};

/** One row of the detail pane's recent-uploads strip. `viewCount` is the
 * video's latest Snapshot reading (ADR-0001), or null before its first one —
 * unmeasured, never zero. */
export type WatchlistUpload = {
	videoId: Id<"videos">;
	ytId: string;
	title: string;
	thumbnailUrl: string | null;
	publishedAt: number;
	viewCount: number | null;
};

/** The channel identity every watchlist read projects for the drawer. */
function channelIdentity(channel: Doc<"channels">) {
	return {
		ytId: channel.ytId,
		title: channel.title,
		handle: channel.handle ?? null,
		avatarUrl: channel.avatarUrl ?? null,
	};
}

/**
 * The live-join half of ADR-0004: the pair's current *proven* Listing, or null
 * when it's off the Feed (row gone after a recompute, or present but
 * unproven). Null is a product state — "no longer on the Feed" — not an error.
 */
async function liveListingFor(
	ctx: QueryCtx,
	channelId: Id<"channels">,
	form: Form,
) {
	const listings = await ctx.db
		.query("listings")
		.withIndex("by_channel", (q) => q.eq("channelId", channelId))
		.take(2); // at most one Listing per (channel, form) (ADR-0002)
	const listing = listings.find((row) => row.form === form) ?? null;
	return listing?.proven ? listing : null;
}

/** The entry's recent-uploads strip: the channel's last `PROVEN_WINDOW`
 * standard videos of the entry's form, newest-first — the same window the
 * Proven gate judges (CONTEXT.md) — each with its latest snapshot count. */
async function recentUploads(
	ctx: QueryCtx,
	channelId: Id<"channels">,
	form: Form,
): Promise<WatchlistUpload[]> {
	const matching: Doc<"videos">[] = [];
	let scanned = 0;
	const newestFirst = ctx.db
		.query("videos")
		.withIndex("by_channel_and_publishedAt", (q) =>
			q.eq("channelId", channelId),
		)
		.order("desc");
	for await (const video of newestFirst) {
		scanned += 1;
		if (matching.length >= PROVEN_WINDOW || scanned > MAX_UPLOADS_SCAN) {
			break;
		}
		if (video.isStandard && video.form === form) {
			matching.push(video);
		}
	}
	// The snapshot lookups are independent — resolve them as one parallel batch.
	return Promise.all(
		matching.map(async (video) => {
			const latestSnapshot = await ctx.db
				.query("videoSnapshots")
				.withIndex("by_video_and_at", (q) => q.eq("videoId", video._id))
				.order("desc")
				.first();
			return {
				videoId: video._id,
				ytId: video.ytId,
				title: video.title,
				thumbnailUrl: video.thumbnailUrl ?? null,
				publishedAt: video.publishedAt,
				viewCount: latestSnapshot?.viewCount ?? null,
			};
		}),
	);
}

export const detail = query({
	args: {
		channelId: v.id("channels"),
		form: formValidator,
	},
	handler: async (ctx, args): Promise<WatchlistDetail | null> => {
		await requireActiveSubscription(ctx);

		const channel = await ctx.db.get("channels", args.channelId);
		if (channel === null) {
			return null; // channel deleted from under the entry — nothing to show
		}

		// The Listing join and the uploads strip read disjoint tables.
		const [listing, uploads] = await Promise.all([
			liveListingFor(ctx, args.channelId, args.form),
			recentUploads(ctx, args.channelId, args.form),
		]);

		return {
			channelId: args.channelId,
			form: args.form,
			channel: {
				...channelIdentity(channel),
				description: channel.description ?? null,
			},
			uploads,
			listing:
				listing !== null
					? {
							stage: listing.stage,
							medianViews: listing.medianViews,
							momentum: listing.momentum,
							saturation: listing.saturation,
							clonability: listing.clonability,
							signals: listing.signals,
						}
					: null,
		};
	},
});

/**
 * The calling Operator's Watchlist, newest-first — always the whole list,
 * regardless of the Feed's form lens. Each entry carries the channel identity
 * the drawer row renders; the (channelId, form) pairs double as the saved-state
 * keys the Feed paints on cards.
 */
export const entries = query({
	args: {},
	handler: async (ctx): Promise<WatchlistEntry[]> => {
		const operator = await requireActiveSubscription(ctx);

		const rows = await ctx.db
			.query("watchlistEntries")
			.withIndex("by_operator", (q) => q.eq("operatorId", operator._id))
			.order("desc")
			.take(MAX_WATCHLIST_ENTRIES);

		// Rows are independent, so their channel + listing reads run as one batch.
		const result = await Promise.all(
			rows.map(async (row): Promise<WatchlistEntry | null> => {
				const [channel, listing] = await Promise.all([
					ctx.db.get("channels", row.channelId),
					liveListingFor(ctx, row.channelId, row.form),
				]);
				if (channel === null) {
					return null; // channel deleted from under the entry — skip defensively
				}
				return {
					entryId: row._id,
					channelId: row.channelId,
					form: row.form,
					onFeed: listing !== null,
					channel: channelIdentity(channel),
				};
			}),
		);
		return result.filter((entry) => entry !== null);
	},
});
