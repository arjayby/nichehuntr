import type { Id } from "@nichehuntr/backend/convex/_generated/dataModel";
import type {
	WatchlistEntry,
	WatchlistFolderGroup,
	WatchlistList,
} from "@nichehuntr/backend/convex/watchlist";

/**
 * Pure `WatchlistList -> WatchlistList` transforms that mirror the backend
 * mutations, so a Convex optimistic update can paint each Watchlist write the
 * instant it's requested instead of one round-trip later. The list re-renders
 * reactively when the mutation lands (and Convex drops the overlay); on a
 * rejection Convex rolls the overlay back and the caller's error toast fires.
 *
 * Ordering matches `watchlist.list`: root and folder entries are newest-first,
 * folders alphabetical (case-insensitive). Where a transform can't reproduce the
 * server order without a per-entry timestamp — a reparent or a drag into a
 * populated destination — it lands the entry at the top and accepts a one-frame
 * settle when the server's age-ordered result arrives.
 */

type ChannelIdentity = WatchlistEntry["channel"];

/**
 * A throwaway id for an optimistically-inserted row or folder. It exists only
 * for the in-flight window and as a React key; the real mutation carries real
 * args (never this id), and when it resolves Convex drops the overlay so the
 * server's real id takes over.
 */
function tempId(): string {
	return `optimistic-${crypto.randomUUID()}`;
}

/** Folders group but don't rank — same case-insensitive name sort as the query. */
function sortFolders(folders: WatchlistFolderGroup[]): WatchlistFolderGroup[] {
	return [...folders].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
	);
}

/**
 * Toggle a Channel: remove it if it's already saved anywhere
 * (root or a folder), else prepend a synthesized root entry (newest-first).
 * Returns the list unchanged when adding without a `channel` identity to build
 * the row from — the add then falls back to the reactive round-trip.
 */
export function toggleEntryOptimistic(
	list: WatchlistList,
	channelId: Id<"channels">,
	channel: ChannelIdentity | null,
): WatchlistList {
	const matches = (entry: WatchlistEntry) => entry.channelId === channelId;
	const present =
		list.root.some(matches) ||
		list.folders.some((folder) => folder.entries.some(matches));

	if (present) {
		return {
			root: list.root.filter((entry) => !matches(entry)),
			folders: list.folders.map((folder) => ({
				...folder,
				entries: folder.entries.filter((entry) => !matches(entry)),
			})),
		};
	}

	if (channel === null) {
		return list;
	}

	// A fresh save goes to the top of the root — newest-first, so this is exact.
	const entry: WatchlistEntry = {
		entryId: tempId() as unknown as Id<"watchlistEntries">,
		channelId,
		// Saved from a live Feed card / detail — the Channel is on the Feed by
		// definition, so the row renders un-muted straight away.
		onFeed: true,
		folderId: null,
		channel,
	};
	return { folders: list.folders, root: [entry, ...list.root] };
}

/** Insert a new empty folder at its alphabetical slot. Exact — no entries to
 * order, and the name is known client-side. */
export function createFolderOptimistic(
	list: WatchlistList,
	name: string,
): WatchlistList {
	const folder: WatchlistFolderGroup = {
		folderId: tempId() as unknown as Id<"watchlistFolders">,
		name: name.trim(),
		entries: [],
	};
	return { root: list.root, folders: sortFolders([...list.folders, folder]) };
}

/** Rename a folder and re-sort — exact, since the new name and all siblings are
 * known, so the folder settles into its final position with no snap. */
export function renameFolderOptimistic(
	list: WatchlistList,
	folderId: Id<"watchlistFolders">,
	name: string,
): WatchlistList {
	const folders = list.folders.map((folder) =>
		folder.folderId === folderId ? { ...folder, name: name.trim() } : folder,
	);
	return { root: list.root, folders: sortFolders(folders) };
}

/**
 * Delete a folder optimistically only when it's empty — a clean, exact drop.
 * A populated folder is left untouched (its delete stays reactive, behind the
 * confirm dialog) so we don't have to reproduce the server's age-ordered
 * reparent of its entries into the root.
 */
export function deleteEmptyFolderOptimistic(
	list: WatchlistList,
	folderId: Id<"watchlistFolders">,
): WatchlistList {
	const folder = list.folders.find((f) => f.folderId === folderId);
	if (folder === undefined || folder.entries.length > 0) {
		return list;
	}
	return {
		root: list.root,
		folders: list.folders.filter((f) => f.folderId !== folderId),
	};
}

/**
 * Move an entry into a folder (or back to the root when `target` is null),
 * landing it at the top of the destination. The moved entry keeps its age, so a
 * populated newest-first destination will settle it into place when the server
 * result arrives — an accepted one-frame nudge, zero for an empty destination.
 */
export function moveEntryOptimistic(
	list: WatchlistList,
	entryId: Id<"watchlistEntries">,
	target: Id<"watchlistFolders"> | null,
): WatchlistList {
	let moved: WatchlistEntry | undefined;
	const takeOut = (entry: WatchlistEntry) => {
		if (entry.entryId === entryId) {
			moved = entry;
			return false;
		}
		return true;
	};

	const root = list.root.filter(takeOut);
	const folders = list.folders.map((folder) => ({
		...folder,
		entries: folder.entries.filter(takeOut),
	}));
	if (moved === undefined) {
		return list;
	}

	const relocated: WatchlistEntry = { ...moved, folderId: target };
	if (target === null) {
		return { folders, root: [relocated, ...root] };
	}
	return {
		root,
		folders: folders.map((folder) =>
			folder.folderId === target
				? { ...folder, entries: [relocated, ...folder.entries] }
				: folder,
		),
	};
}
