import { describe, expect, it } from "vitest";

import { chunk, createYouTubeAdapter, parseIso8601Duration } from "./youtube";

describe("parseIso8601Duration", () => {
	it.each([
		["PT45S", 45],
		["PT4M", 240],
		["PT2M30S", 150],
		["PT1H", 3600],
		["PT1H2M3S", 3723],
		["P0D", 0],
		["", 0],
		["not-a-duration", 0],
	])("parses %s as %i seconds", (iso, seconds) => {
		expect(parseIso8601Duration(iso)).toBe(seconds);
	});
});

describe("chunk", () => {
	it("splits into runs of at most the given size", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("returns nothing for an empty list", () => {
		expect(chunk([], 50)).toEqual([]);
	});
});

/** A fake `fetch` that records the URLs it's asked for and echoes the requested
 * ids back as minimal resources so the adapter's mapping has something to chew. */
function recordingFetch(urls: string[]): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		urls.push(url);
		const parsed = new URL(url);
		const ids = parsed.searchParams.get("id");
		const items = (ids?.split(",") ?? []).map((id) => ({
			id,
			snippet: { title: `Title ${id}`, customUrl: `@${id}` },
			statistics: { viewCount: "100" },
		}));
		return new Response(JSON.stringify({ items }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

describe("createYouTubeAdapter — quota contract (ADR-0001)", () => {
	it("batches channel ids 50 at a time", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", recordingFetch(urls));
		const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);

		const infos = await adapter.fetchChannels(ids);

		expect(urls).toHaveLength(2); // 50 + 10
		expect(urls.every((u) => new URL(u).pathname.endsWith("/channels"))).toBe(
			true,
		);
		expect(infos[0]).toMatchObject({ ytChannelId: "c0", handle: "@c0" });
	});

	it("throws on a non-OK response so a failed run is loud", async () => {
		const failing = (async () =>
			new Response("nope", { status: 403 })) as typeof fetch;
		const adapter = createYouTubeAdapter("KEY", failing);
		await expect(adapter.fetchChannels(["c0"])).rejects.toThrow(/403/);
	});
});

describe("resolveHandle", () => {
	/** A `channels.list?forHandle` fake: records the URL and returns one channel
	 * whose id is derived from the handle, unless `empty` (no channel owns it). */
	function handleFetch(urls: string[], empty = false): typeof fetch {
		return (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			urls.push(url);
			const handle = new URL(url).searchParams.get("forHandle");
			const items = empty ? [] : [{ id: `UC_${handle}` }];
			return jsonResponse({ items });
		}) as typeof fetch;
	}

	it("queries channels.list by handle (one unit, no search) and returns the id", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", handleFetch(urls));

		const id = await adapter.resolveHandle("@mrbeast");

		expect(urls).toHaveLength(1);
		const url = new URL(urls[0] ?? "");
		expect(url.pathname.endsWith("/channels")).toBe(true);
		expect(url.searchParams.get("part")).toBe("id");
		// The leading `@` is stripped before hitting the API.
		expect(url.searchParams.get("forHandle")).toBe("mrbeast");
		expect(urls[0]?.includes("/search")).toBe(false);
		expect(id).toBe("UC_mrbeast");
	});

	it("returns null when no channel owns the handle", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", handleFetch(urls, true));

		expect(await adapter.resolveHandle("@ghost")).toBeNull();
	});
});

/** A fake `fetch` for the two-step uploads backfill: `playlistItems` returns a
 * page of video ids, `videos.list` hydrates them with snippet/contentDetails/
 * statistics. Records every URL so the quota contract can be asserted. */
function uploadsFetch(urls: string[], videoCount: number): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		urls.push(url);
		const parsed = new URL(url);
		if (parsed.pathname.endsWith("/playlistItems")) {
			const items = Array.from({ length: videoCount }, (_, i) => ({
				contentDetails: { videoId: `vid${i}` },
			}));
			return jsonResponse({ items });
		}
		// videos.list hydration
		const ids = parsed.searchParams.get("id")?.split(",") ?? [];
		const items = ids.map((id) => ({
			id,
			snippet: {
				title: `Title ${id}`,
				channelId: "UCchannel",
				publishedAt: "2026-01-02T03:04:05Z",
				liveBroadcastContent: id === "vid1" ? "live" : "none",
				thumbnails: { high: { url: `https://img/${id}.jpg` } },
			},
			contentDetails: { duration: "PT45S" },
			statistics: { viewCount: "4200" },
		}));
		return jsonResponse({ items });
	}) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("fetchChannelUploads", () => {
	it("pages the uploads playlist then hydrates in one details batch (~2 units)", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", uploadsFetch(urls, 50));

		const uploads = await adapter.fetchChannelUploads("UCchannel", {
			limit: 50,
		});

		// Exactly two requests: one playlistItems page + one videos.list batch.
		expect(urls).toHaveLength(2);
		const [playlistUrl, videosUrl] = urls.map((u) => new URL(u));
		expect(playlistUrl?.pathname.endsWith("/playlistItems")).toBe(true);
		// The uploads playlist id is the channel id with UC → UU.
		expect(playlistUrl?.searchParams.get("playlistId")).toBe("UUchannel");
		expect(videosUrl?.pathname.endsWith("/videos")).toBe(true);
		expect(videosUrl?.searchParams.get("part")).toBe(
			"snippet,contentDetails,statistics",
		);
		expect(urls.some((u) => u.includes("/search"))).toBe(false);

		expect(uploads).toHaveLength(50);
		expect(uploads[0]).toEqual({
			ytVideoId: "vid0",
			ytChannelId: "UCchannel",
			title: "Title vid0",
			thumbnailUrl: "https://img/vid0.jpg",
			durationSec: 45,
			publishedAt: Date.parse("2026-01-02T03:04:05Z"),
			viewCount: 4200,
			isStandard: true,
		});
	});

	it("marks live broadcasts non-standard", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", uploadsFetch(urls, 3));

		const uploads = await adapter.fetchChannelUploads("UCchannel");

		// vid1 is flagged `liveBroadcastContent: "live"` in the fake.
		expect(uploads.find((u) => u.ytVideoId === "vid1")?.isStandard).toBe(false);
		expect(uploads.find((u) => u.ytVideoId === "vid0")?.isStandard).toBe(true);
	});

	it("pages past long uploads and returns only up to the requested Shorts", async () => {
		const urls: string[] = [];
		const pagedFetch = (async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			urls.push(url);
			const parsed = new URL(url);
			if (parsed.pathname.endsWith("/playlistItems")) {
				const pageToken = parsed.searchParams.get("pageToken");
				const prefix = pageToken === "second" ? "short" : "long";
				const items = Array.from({ length: 50 }, (_, i) => ({
					contentDetails: { videoId: `${prefix}${i}` },
				}));
				return jsonResponse(
					pageToken === "second"
						? { items }
						: { items, nextPageToken: "second" },
				);
			}
			const ids = parsed.searchParams.get("id")?.split(",") ?? [];
			return jsonResponse({
				items: ids.map((id) => ({
					id,
					snippet: {
						title: `Title ${id}`,
						channelId: "UCchannel",
						publishedAt: "2026-01-02T03:04:05Z",
						liveBroadcastContent: "none",
					},
					contentDetails: {
						duration: id.startsWith("short") ? "PT45S" : "PT10M",
					},
					statistics: { viewCount: "4200" },
				})),
			});
		}) as typeof fetch;
		const adapter = createYouTubeAdapter("KEY", pagedFetch);

		const uploads = await adapter.fetchChannelUploads("UCchannel", {
			limit: 50,
		});

		expect(
			urls.filter((u) => new URL(u).pathname.endsWith("/playlistItems")),
		).toHaveLength(2);
		expect(
			urls.filter((u) => new URL(u).pathname.endsWith("/videos")),
		).toHaveLength(2);
		expect(uploads).toHaveLength(50);
		expect(uploads.filter((upload) => upload.durationSec <= 300)).toHaveLength(
			50,
		);
	});

	it("returns nothing (and skips hydration) for a channel with no uploads", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", uploadsFetch(urls, 0));

		const uploads = await adapter.fetchChannelUploads("UCempty");

		expect(uploads).toEqual([]);
		expect(urls).toHaveLength(1); // only the playlistItems page, no videos.list
	});
});
