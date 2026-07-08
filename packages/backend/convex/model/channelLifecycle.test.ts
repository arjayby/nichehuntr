import { describe, expect, it } from "vitest";

import { deriveChannelLifecycle } from "./channelLifecycle";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);

type Video = Parameters<typeof deriveChannelLifecycle>[0]["videos"][number];

function short(viewCount: number, overrides: Partial<Video> = {}): Video {
	return {
		durationSec: 45,
		publishedAt: NOW - 1 * DAY,
		viewCount,
		...overrides,
	};
}

function videos(viewCounts: number[], overrides: Partial<Video> = {}): Video[] {
	return viewCounts.map((viewCount, i) =>
		short(viewCount, {
			publishedAt: NOW - (i + 1) * DAY,
			...overrides,
		}),
	);
}

describe("deriveChannelLifecycle", () => {
	it.each([
		{
			name: "Emerging when recent Shorts clear 50k but not 100k",
			subscriberCount: 1_000,
			videos: videos([80_000, 60_000, 10_000]),
			stage: "emerging",
			feedVisibility: "visible",
		},
		{
			name: "Breaking Out when recent Shorts clear 100k before maturity",
			subscriberCount: 1_000,
			videos: videos([120_000, 130_000, 10_000]),
			stage: "breaking_out",
			feedVisibility: "visible",
		},
		{
			name: "Established when mature and clearing 100k, even when stale",
			subscriberCount: 50_000,
			videos: [
				...videos(
					[
						120_000, 130_000, 140_000, 150_000, 160_000, 10_000, 20_000, 30_000,
						40_000, 45_000,
					],
					{ publishedAt: NOW - 30 * DAY },
				),
				...videos(Array(40).fill(1_000), { publishedAt: NOW - 90 * DAY }),
			],
			stage: "established",
			feedVisibility: "visible",
		},
		{
			name: "Tracked when fewer than three fetched Shorts exist",
			subscriberCount: 1_000,
			videos: videos([1_000_000, 1_000_000]),
			stage: "tracked",
			feedVisibility: "hidden",
		},
		{
			name: "Tracked when a non-mature channel is stale",
			subscriberCount: 1_000,
			videos: videos([120_000, 130_000, 140_000], {
				publishedAt: NOW - 15 * DAY,
			}),
			stage: "tracked",
			feedVisibility: "hidden",
		},
		{
			name: "Tracked when mature but recent reach clears only the lower bar",
			subscriberCount: 60_000,
			videos: [
				...videos(
					[
						90_000, 85_000, 80_000, 75_000, 70_000, 20_000, 30_000, 40_000,
						45_000, 49_000,
					],
					{ publishedAt: NOW - 3 * DAY },
				),
				...videos(Array(40).fill(1_000), { publishedAt: NOW - 90 * DAY }),
			],
			stage: "tracked",
			feedVisibility: "hidden",
		},
		{
			name: "Tracked when recent Shorts miss the lower reach threshold",
			subscriberCount: 1_000,
			videos: videos([50_000, 49_999, 1_000]),
			stage: "tracked",
			feedVisibility: "hidden",
		},
	] as const)("$name", ({ subscriberCount, videos, stage, feedVisibility }) => {
		expect(
			deriveChannelLifecycle({ subscriberCount, videos, now: NOW }),
		).toMatchObject({
			stage,
			feedVisibility,
		});
	});

	it.each([
		{
			name: "three checked Shorts need two passes",
			viewCounts: [50_000, 50_000, 49_999],
			stage: "emerging",
			recentShortsChecked: 3,
			above50k: 2,
		},
		{
			name: "nine checked Shorts need five passes",
			viewCounts: [50_000, 50_000, 50_000, 50_000, 50_000, 1, 1, 1, 1],
			stage: "emerging",
			recentShortsChecked: 9,
			above50k: 5,
		},
		{
			name: "ten checked Shorts need five passes",
			viewCounts: [50_000, 50_000, 50_000, 50_000, 50_000, 1, 1, 1, 1, 1],
			stage: "emerging",
			recentShortsChecked: 10,
			above50k: 5,
		},
		{
			name: "ten checked Shorts fail with only four passes",
			viewCounts: [50_000, 50_000, 50_000, 50_000, 49_999, 1, 1, 1, 1, 1],
			stage: "tracked",
			recentShortsChecked: 10,
			above50k: 4,
		},
	] as const)("$name", ({
		viewCounts,
		stage,
		recentShortsChecked,
		above50k,
	}) => {
		const result = deriveChannelLifecycle({
			subscriberCount: 1_000,
			videos: videos(viewCounts),
			now: NOW,
		});

		expect(result).toMatchObject({
			stage,
			evidence: {
				recentShortsChecked,
				shortsAtOrAbove50k: above50k,
			},
		});
	});

	it("gives Established precedence over Breaking Out for mature channels", () => {
		const result = deriveChannelLifecycle({
			subscriberCount: 60_000,
			videos: [
				...videos([120_000, 130_000, 140_000, 150_000, 160_000, 1, 1, 1, 1, 1]),
				...videos(Array(40).fill(1_000), { publishedAt: NOW - 90 * DAY }),
			],
			now: NOW,
		});

		expect(result.stage).toBe("established");
	});

	it("uses raw current view counts without age adjustment", () => {
		const result = deriveChannelLifecycle({
			subscriberCount: 1_000,
			videos: videos([100_000, 100_000, 1], {
				publishedAt: NOW - 60 * 60 * 1000,
			}),
			now: NOW,
		});

		expect(result).toMatchObject({
			stage: "breaking_out",
			evidence: {
				shortsAtOrAbove100k: 2,
			},
		});
	});

	it("ignores videos over 300 seconds for latest Short recency and reach checks", () => {
		const result = deriveChannelLifecycle({
			subscriberCount: 1_000,
			videos: [
				short(1_000_000, { durationSec: 301, publishedAt: NOW }),
				...videos([120_000, 130_000, 140_000], {
					publishedAt: NOW - 30 * DAY,
				}),
			],
			now: NOW,
		});

		expect(result).toMatchObject({
			stage: "tracked",
			evidence: {
				fetchedShorts: 3,
				latestShortPublishedAt: NOW - 30 * DAY,
				shortsAtOrAbove100k: 3,
			},
		});
	});

	it("counts a 300-second video as a Short and excludes a 301-second video", () => {
		const result = deriveChannelLifecycle({
			subscriberCount: 1_000,
			videos: [
				short(1_000_000, { durationSec: 301, publishedAt: NOW }),
				short(60_000, { durationSec: 300, publishedAt: NOW - 2 * DAY }),
				short(60_000, { durationSec: 299, publishedAt: NOW - 3 * DAY }),
				short(1_000, { durationSec: 45, publishedAt: NOW - 4 * DAY }),
			],
			now: NOW,
		});

		expect(result).toMatchObject({
			stage: "emerging",
			evidence: {
				fetchedShorts: 3,
				latestShortPublishedAt: NOW - 2 * DAY,
				recentShortsChecked: 3,
				shortsAtOrAbove50k: 2,
				shortsAtOrAbove100k: 0,
			},
		});
	});
});
