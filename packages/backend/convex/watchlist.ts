import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { Form } from "./model/deriveListings";
import { formValidator } from "./model/validators";
import { requireActiveSubscription } from "./polar";

/** Safety cap on entries read per request; pagination is deferred like the Feed's. */
const MAX_WATCHLIST_ENTRIES = 500;

/**
 * One Watchlist row: the saved `(channel, form)` plus the channel identity the
 * drawer renders. A lens on the Feed (CONTEXT.md) — channel data is re-derived
 * at read time, never copied into the entry (ADR-0004).
 */
export type WatchlistEntry = {
	entryId: Id<"watchlistEntries">;
	channelId: Id<"channels">;
	form: Form;
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

		const result: WatchlistEntry[] = [];
		for (const row of rows) {
			const channel = await ctx.db.get("channels", row.channelId);
			if (channel === null) {
				continue; // channel deleted from under the entry — skip defensively
			}
			result.push({
				entryId: row._id,
				channelId: row.channelId,
				form: row.form,
				channel: {
					ytId: channel.ytId,
					title: channel.title,
					handle: channel.handle ?? null,
					avatarUrl: channel.avatarUrl ?? null,
				},
			});
		}
		return result;
	},
});
