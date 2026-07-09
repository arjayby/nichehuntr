import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";
import { channelEnrichmentFor } from "./model/channelEnrichment";
import {
	type ChannelLifecycleStage,
	deriveChannelLifecycle,
	type LifecycleEvidence,
	lifecycleVideoFromStoredVideo,
	SHORT_MAX_SEC,
} from "./model/channelLifecycle";
import { computeClonability, type Signals } from "./model/clonability";
import { requireActiveSubscription } from "./polar";

/** Safety cap on entries read per request; pagination is deferred like the Feed's. */
const MAX_WATCHLIST_ENTRIES = 500;

/** Safety cap on Folders read per request — the drawer's folder list. */
const MAX_WATCHLIST_FOLDERS = 200;

/** Folder names are a short curation label, not free text; trimmed and bounded. */
const MAX_FOLDER_NAME_LENGTH = 60;

/** Recent short-form uploads shown in the detail pane. */
const RECENT_UPLOADS_LIMIT = 12;

/** Safety cap on videos scanned while finding recent standard Shorts. */
const MAX_UPLOADS_SCAN = 10 * RECENT_UPLOADS_LIMIT;

/** Safety cap on channel videos scanned while deriving lifecycle evidence. */
const MAX_CHANNEL_VIDEOS = 200;

type FeedStage = Exclude<ChannelLifecycleStage, "tracked">;

/**
 * One Watchlist row: the saved Channel plus the channel identity the drawer
 * renders. A lens on the Feed (CONTEXT.md) — channel data is re-derived at read
 * time, never copied into the entry.
 */
export type WatchlistEntry = {
	entryId: Id<"watchlistEntries">;
	channelId: Id<"channels">;
	/** Whether the Channel is currently visible on the Feed — false renders the
	 * row muted ("no longer on the Feed"), never hides it. */
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
 * Save or unsave a Channel for the calling Operator. Deduped on the exact
 * (Operator, Channel) pair: toggling an existing entry removes it, so saving
 * the same Channel twice is impossible.
 */
export const toggle = mutation({
	args: {
		channelId: v.id("channels"),
	},
	handler: async (ctx, args): Promise<{ saved: boolean }> => {
		const operator = await requireActiveSubscription(ctx);

		const existing = await ctx.db
			.query("watchlistEntries")
			.withIndex("by_operator_and_channel", (q) =>
				q.eq("operatorId", operator._id).eq("channelId", args.channelId),
			)
			.take(MAX_WATCHLIST_ENTRIES);

		if (existing.length > 0) {
			await Promise.all(
				existing.map((entry) => ctx.db.delete("watchlistEntries", entry._id)),
			);
			return { saved: false };
		}

		await ctx.db.insert("watchlistEntries", {
			operatorId: operator._id,
			channelId: args.channelId,
		});
		return { saved: true };
	},
});

/** An entry's identity as the client passes it around: the Channel id. */
export type WatchlistSelection = {
	channelId: Id<"channels">;
};

/**
 * The deep detail for one Watchlist entry. Feed state is re-derived live by
 * Channel at read time: `feed` carries the current lifecycle evidence while the
 * Channel is on the Feed, and is `null` when the Channel is Tracked/hidden.
 */
export type WatchlistDetail = {
	channelId: Id<"channels">;
	channel: {
		ytId: string;
		title: string;
		handle: string | null;
		avatarUrl: string | null;
		description: string | null;
	};
	feed: {
		stage: FeedStage;
		evidence: LifecycleEvidence;
		clonability: number | null;
		signals: Signals | null;
	} | null;
	uploads: WatchlistUpload[];
};

/** One row of the detail pane's recent-uploads strip. `viewCount` is the
 * video's latest observed current count, or null before its first reading —
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

async function videosForLifecycle(ctx: QueryCtx, channelId: Id<"channels">) {
	const videos = await ctx.db
		.query("videos")
		.withIndex("by_channel_and_publishedAt", (q) =>
			q.eq("channelId", channelId),
		)
		.order("desc")
		.take(MAX_CHANNEL_VIDEOS);

	return videos.map(lifecycleVideoFromStoredVideo);
}

/**
 * The Channel's current Feed state, or null when it is Tracked/hidden. Null is a
 * product state — "no longer on the Feed" — not an error.
 */
async function liveFeedStateFor(
	ctx: QueryCtx,
	channel: Doc<"channels">,
): Promise<WatchlistDetail["feed"]> {
	const [videos, enrichment] = await Promise.all([
		videosForLifecycle(ctx, channel._id),
		channelEnrichmentFor(ctx, channel._id),
	]);
	const lifecycle = deriveChannelLifecycle({
		subscriberCount: channel.subscriberCount ?? 0,
		videos,
		now: Date.now(),
	});
	if (lifecycle.feedVisibility === "hidden" || lifecycle.stage === "tracked") {
		return null;
	}
	return {
		stage: lifecycle.stage,
		evidence: lifecycle.evidence,
		clonability: computeClonability(enrichment?.signals ?? null),
		signals: enrichment?.signals ?? null,
	};
}

/** The entry's recent-uploads strip: the channel's last standard Shorts,
 * newest-first, with current raw view counts when available. */
async function recentUploads(
	ctx: QueryCtx,
	channelId: Id<"channels">,
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
		if (matching.length >= RECENT_UPLOADS_LIMIT || scanned > MAX_UPLOADS_SCAN) {
			break;
		}
		if (video.isStandard && video.durationSec <= SHORT_MAX_SEC) {
			matching.push(video);
		}
	}
	return matching.map((video) => ({
		videoId: video._id,
		ytId: video.ytId,
		title: video.title,
		thumbnailUrl: video.thumbnailUrl ?? null,
		publishedAt: video.publishedAt,
		viewCount: video.currentViewCount ?? null,
	}));
}

export const detail = query({
	args: {
		channelId: v.id("channels"),
	},
	handler: async (ctx, args): Promise<WatchlistDetail | null> => {
		await requireActiveSubscription(ctx);

		const channel = await ctx.db.get("channels", args.channelId);
		if (channel === null) {
			return null; // channel deleted from under the entry — nothing to show
		}

		// Feed state and the uploads strip read disjoint tables.
		const [feed, uploads] = await Promise.all([
			liveFeedStateFor(ctx, channel),
			recentUploads(ctx, args.channelId),
		]);

		return {
			channelId: args.channelId,
			channel: {
				...channelIdentity(channel),
				description: channel.description ?? null,
			},
			uploads,
			feed,
		};
	},
});

/** Live-join one stored row into the `WatchlistEntry` the drawer renders, or
 * null when its channel has been deleted from under it (skip defensively). */
async function buildEntry(
	ctx: QueryCtx,
	row: Doc<"watchlistEntries">,
): Promise<WatchlistEntry | null> {
	const channel = await ctx.db.get("channels", row.channelId);
	if (channel === null) {
		return null; // channel deleted from under the entry — skip defensively
	}
	const feed = await liveFeedStateFor(ctx, channel);
	return {
		entryId: row._id,
		channelId: row.channelId,
		onFeed: feed !== null,
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
 * of any Feed filtering; the flattened channel ids double as the saved-state
 * keys the Feed paints on cards.
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

		const seenChannels = new Set<Id<"channels">>();
		const uniqueEntryRows: Doc<"watchlistEntries">[] = [];
		for (const row of entryRows) {
			if (seenChannels.has(row.channelId)) {
				continue;
			}
			seenChannels.add(row.channelId);
			uniqueEntryRows.push(row);
		}

		// Entry rows are independent, so their channel + Feed-state reads run as
		// one batch; the result keeps the newest-first order of `entryRows`.
		const built = (
			await Promise.all(uniqueEntryRows.map((row) => buildEntry(ctx, row)))
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
