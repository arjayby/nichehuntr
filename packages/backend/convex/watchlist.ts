import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import type { Signals } from "./model/clonability";
import { type Form, PROVEN_WINDOW, type Stage } from "./model/deriveListings";
import { formValidator } from "./model/validators";
import { requireActiveSubscription } from "./polar";

/** Safety cap on entries read per request; pagination is deferred like the Feed's. */
const MAX_WATCHLIST_ENTRIES = 500;

/** Safety cap on Folders read per request — the drawer's folder list. */
const MAX_WATCHLIST_FOLDERS = 200;

/** Folder names are a short curation label, not free text; trimmed and bounded. */
const MAX_FOLDER_NAME_LENGTH = 60;

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
	/** The Folder the entry is filed under, or null when it sits at the root. */
	folderId: Id<"watchlistFolders"> | null;
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

/** Live-join one stored row into the `WatchlistEntry` the drawer renders, or
 * null when its channel has been deleted from under it (skip defensively). */
async function buildEntry(
	ctx: QueryCtx,
	row: Doc<"watchlistEntries">,
): Promise<WatchlistEntry | null> {
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
		folderId: row.folderId ?? null,
		channel: channelIdentity(channel),
	};
}

/** One Folder plus the entries filed under it, newest-first. */
export type WatchlistFolderGroup = {
	folderId: Id<"watchlistFolders">;
	name: string;
	entries: WatchlistEntry[];
};

/**
 * The calling Operator's whole Watchlist, grouped for the drawer: Folders
 * (alphabetical, each with its entries) plus the `root` entries filed under no
 * Folder. Entries are newest-first everywhere. Always the whole list regardless
 * of the Feed's form lens; the flattened (channelId, form) pairs double as the
 * saved-state keys the Feed paints on cards.
 */
export type WatchlistList = {
	folders: WatchlistFolderGroup[];
	root: WatchlistEntry[];
};

export const list = query({
	args: {},
	handler: async (ctx): Promise<WatchlistList> => {
		const operator = await requireActiveSubscription(ctx);

		const [folderRows, entryRows] = await Promise.all([
			ctx.db
				.query("watchlistFolders")
				.withIndex("by_operator", (q) => q.eq("operatorId", operator._id))
				.take(MAX_WATCHLIST_FOLDERS),
			ctx.db
				.query("watchlistEntries")
				.withIndex("by_operator", (q) => q.eq("operatorId", operator._id))
				.order("desc")
				.take(MAX_WATCHLIST_ENTRIES),
		]);

		// Entry rows are independent, so their channel + listing reads run as one
		// batch; the result keeps the newest-first order of `entryRows`.
		const built = (
			await Promise.all(entryRows.map((row) => buildEntry(ctx, row)))
		).filter((entry) => entry !== null);

		// Folders group, they don't rank — sort by name (case-insensitive).
		folderRows.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
		const groups = new Map<Id<"watchlistFolders">, WatchlistEntry[]>(
			folderRows.map((folder) => [folder._id, []]),
		);
		const root: WatchlistEntry[] = [];
		for (const entry of built) {
			// A dangling folderId (folder gone) falls back to the root defensively.
			const bucket =
				entry.folderId !== null ? groups.get(entry.folderId) : undefined;
			if (bucket !== undefined) {
				bucket.push(entry);
			} else {
				root.push(entry);
			}
		}

		return {
			folders: folderRows.map((folder) => ({
				folderId: folder._id,
				name: folder.name,
				entries: groups.get(folder._id) ?? [],
			})),
			root,
		};
	},
});

/** Trim a Folder name to its stored form, rejecting empty or over-long input. */
function normalizeFolderName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		throw new ConvexError("EMPTY_FOLDER_NAME");
	}
	if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
		throw new ConvexError("FOLDER_NAME_TOO_LONG");
	}
	return trimmed;
}

/** Load a Folder and assert it belongs to the Operator — never leak or mutate
 * another Operator's Folder (Folders are private per Operator, CONTEXT.md). */
async function requireOwnedFolder(
	ctx: MutationCtx,
	operatorId: string,
	folderId: Id<"watchlistFolders">,
): Promise<Doc<"watchlistFolders">> {
	const folder = await ctx.db.get("watchlistFolders", folderId);
	if (folder === null || folder.operatorId !== operatorId) {
		throw new ConvexError("FOLDER_NOT_FOUND");
	}
	return folder;
}

/** Create an empty Folder for the calling Operator. */
export const createFolder = mutation({
	args: { name: v.string() },
	handler: async (ctx, args): Promise<{ folderId: Id<"watchlistFolders"> }> => {
		const operator = await requireActiveSubscription(ctx);
		const folderId = await ctx.db.insert("watchlistFolders", {
			operatorId: operator._id,
			name: normalizeFolderName(args.name),
		});
		return { folderId };
	},
});

/** Rename one of the Operator's Folders. */
export const renameFolder = mutation({
	args: { folderId: v.id("watchlistFolders"), name: v.string() },
	handler: async (ctx, args): Promise<null> => {
		const operator = await requireActiveSubscription(ctx);
		await requireOwnedFolder(ctx, operator._id, args.folderId);
		await ctx.db.patch("watchlistFolders", args.folderId, {
			name: normalizeFolderName(args.name),
		});
		return null;
	},
});

/**
 * Delete one of the Operator's Folders. Its entries are reparented to the root
 * (their `folderId` cleared) — deleting a Folder never deletes entries
 * (CONTEXT.md).
 */
export const deleteFolder = mutation({
	args: { folderId: v.id("watchlistFolders") },
	handler: async (ctx, args): Promise<null> => {
		const operator = await requireActiveSubscription(ctx);
		await requireOwnedFolder(ctx, operator._id, args.folderId);

		const contained = await ctx.db
			.query("watchlistEntries")
			.withIndex("by_folder", (q) => q.eq("folderId", args.folderId))
			.take(MAX_WATCHLIST_ENTRIES);
		await Promise.all(
			contained.map((entry) =>
				ctx.db.patch("watchlistEntries", entry._id, { folderId: undefined }),
			),
		);

		await ctx.db.delete("watchlistFolders", args.folderId);
		return null;
	},
});

/**
 * File an entry into a Folder, or un-file it back to the root when `folderId`
 * is null. The single mutation behind both the row menu's "Move to folder" and
 * (later) drag-and-drop.
 */
export const setEntryFolder = mutation({
	args: {
		entryId: v.id("watchlistEntries"),
		folderId: v.union(v.id("watchlistFolders"), v.null()),
	},
	handler: async (ctx, args): Promise<null> => {
		const operator = await requireActiveSubscription(ctx);

		const entry = await ctx.db.get("watchlistEntries", args.entryId);
		if (entry === null || entry.operatorId !== operator._id) {
			throw new ConvexError("ENTRY_NOT_FOUND");
		}
		if (args.folderId !== null) {
			await requireOwnedFolder(ctx, operator._id, args.folderId);
		}

		// `undefined` clears the optional field — the entry returns to the root.
		await ctx.db.patch("watchlistEntries", args.entryId, {
			folderId: args.folderId ?? undefined,
		});
		return null;
	},
});
