import { describe, expect, it } from "vitest";

import {
	chunk,
	createYouTubeAdapter,
	MAX_IDS_PER_REQUEST,
	parseIso8601Duration,
} from "./youtube";

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
	it("batches video-stats ids 50 at a time", async () => {
		const urls: string[] = [];
		const adapter = createYouTubeAdapter("KEY", recordingFetch(urls));
		const ids = Array.from({ length: 101 }, (_, i) => `v${i}`);

		const stats = await adapter.fetchVideoStats(ids);

		expect(urls).toHaveLength(3); // 50 + 50 + 1
		for (const u of urls) {
			const idCount = new URL(u).searchParams.get("id")?.split(",").length ?? 0;
			expect(idCount).toBeLessThanOrEqual(MAX_IDS_PER_REQUEST);
			expect(new URL(u).searchParams.get("part")).toBe("statistics");
			expect(u.includes("/search")).toBe(false);
		}
		expect(stats).toHaveLength(101);
		expect(stats[0]).toEqual({ ytVideoId: "v0", viewCount: 100 });
	});

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
		await expect(adapter.fetchVideoStats(["v0"])).rejects.toThrow(/403/);
	});
});
