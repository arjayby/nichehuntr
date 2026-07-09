import type {
	Id,
	TableNames,
} from "@nichehuntr/backend/convex/_generated/dataModel";
import type {
	WatchlistEntry,
	WatchlistList,
} from "@nichehuntr/backend/convex/watchlist";
import { describe, expect, it } from "vitest";

import {
	moveEntryOptimistic,
	toggleEntryOptimistic,
} from "./watchlist-optimistic";

const channel = {
	ytId: "yt_ai_horror",
	title: "AI Horror",
	handle: "aihorror",
	avatarUrl: "https://img/ai-horror.jpg",
};

function id<T extends TableNames>(value: string): Id<T> {
	return value as Id<T>;
}

function entry(
	entryId: string,
	channelId: string,
	folderId: string | null = null,
): WatchlistEntry {
	return {
		entryId: id<"watchlistEntries">(entryId),
		channelId: id<"channels">(channelId),
		onFeed: false,
		folderId: folderId === null ? null : id<"watchlistFolders">(folderId),
		channel: { ...channel, ytId: `yt_${channelId}`, title: channelId },
	};
}

describe("watchlist optimistic transforms", () => {
	it("toggles by Channel id only and creates channel-only optimistic rows", () => {
		const list: WatchlistList = {
			root: [],
			folders: [
				{
					folderId: id<"watchlistFolders">("folder_1"),
					name: "faceless",
					entries: [entry("entry_1", "channel_1", "folder_1")],
				},
			],
		};

		const removed = toggleEntryOptimistic(
			list,
			id<"channels">("channel_1"),
			channel,
		);
		expect(removed.folders[0]?.entries).toEqual([]);

		const added = toggleEntryOptimistic(
			removed,
			id<"channels">("channel_2"),
			channel,
		);
		expect(added.root[0]).toMatchObject({
			channelId: "channel_2",
			onFeed: true,
			folderId: null,
			channel,
		});
		expect("form" in (added.root[0] ?? {})).toBe(false);
	});

	it("moves channel-only entries between folders and root", () => {
		const list: WatchlistList = {
			root: [entry("entry_1", "channel_1")],
			folders: [
				{
					folderId: id<"watchlistFolders">("folder_1"),
					name: "faceless",
					entries: [],
				},
			],
		};

		const filed = moveEntryOptimistic(
			list,
			id<"watchlistEntries">("entry_1"),
			id<"watchlistFolders">("folder_1"),
		);
		expect(filed.root).toEqual([]);
		expect(filed.folders[0]?.entries[0]?.folderId).toBe("folder_1");

		const unfiled = moveEntryOptimistic(
			filed,
			id<"watchlistEntries">("entry_1"),
			null,
		);
		expect(unfiled.root[0]?.folderId).toBeNull();
		expect(unfiled.root[0]?.channelId).toBe("channel_1");
	});
});
