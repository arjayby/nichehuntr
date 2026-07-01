import { describe, expect, it } from "vitest";

import {
	classifyForm,
	deriveListings,
	type ProvenVideo,
} from "./deriveListings";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);

/** Build a settled (old enough), standard video of the given duration. */
function video(
	durationSec: number,
	viewCount: number,
	overrides: Partial<ProvenVideo> = {},
): ProvenVideo {
	return {
		durationSec,
		viewCount,
		publishedAt: NOW - 30 * DAY,
		isStandard: true,
		...overrides,
	};
}

const longVideo = (viewCount: number, overrides: Partial<ProvenVideo> = {}) =>
	video(600, viewCount, overrides);
const shortVideo = (viewCount: number, overrides: Partial<ProvenVideo> = {}) =>
	video(45, viewCount, overrides);

describe("classifyForm", () => {
	it("classifies a video at exactly 3 minutes as short-form", () => {
		expect(classifyForm(180)).toBe("short");
	});

	it("classifies a video just over 3 minutes as long-form", () => {
		expect(classifyForm(181)).toBe("long");
	});
});

describe("deriveListings — Proven gate", () => {
	it("emits one proven long-form listing when the median clears the long threshold", () => {
		const listings = deriveListings({
			channelId: "chan_1",
			now: NOW,
			// sorted views: 110, 120, 130, 140, 150 (k) → median 130k ≥ 100k long threshold
			videos: [
				longVideo(120_000),
				longVideo(140_000),
				longVideo(110_000),
				longVideo(130_000),
				longVideo(150_000),
			],
		});

		expect(listings).toHaveLength(1);
		expect(listings[0]).toMatchObject({
			channelId: "chan_1",
			form: "long",
			proven: true,
			medianViews: 130_000,
		});
	});

	it("holds short-form to a higher bar: a 300k median passes long but fails short", () => {
		const views = [280_000, 300_000, 320_000, 300_000, 300_000]; // median 300k

		const asLong = deriveListings({
			channelId: "c",
			now: NOW,
			videos: views.map((v) => longVideo(v)),
		});
		const asShort = deriveListings({
			channelId: "c",
			now: NOW,
			videos: views.map((v) => shortVideo(v)),
		});

		expect(asLong[0]?.proven).toBe(true); // 300k ≥ 100k
		expect(asShort[0]?.proven).toBe(false); // 300k < 500k
	});

	it("median shrugs off a single viral fluke, keeping an unproven channel out", () => {
		// eleven honest 95k longs + one 5M spike. mean ≈ 504k (would pass), median 95k (fails).
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [...Array(11).fill(95_000), 5_000_000].map((v) => longVideo(v)),
		});

		expect(listings[0]).toMatchObject({ medianViews: 95_000, proven: false });
	});

	it("median shrugs off a single dud, keeping a proven channel in", () => {
		// eleven strong 105k longs + one 2k dud. mean ≈ 96k (would fail), median 105k (passes).
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [...Array(11).fill(105_000), 2_000].map((v) => longVideo(v)),
		});

		expect(listings[0]).toMatchObject({ medianViews: 105_000, proven: true });
	});
});

describe("deriveListings — form partitioning (ADR-0002)", () => {
	it("yields two Listings for a channel that clears both forms' gates", () => {
		const listings = deriveListings({
			channelId: "straddler",
			now: NOW,
			videos: [
				shortVideo(600_000),
				shortVideo(700_000),
				shortVideo(650_000),
				shortVideo(620_000),
				longVideo(150_000),
				longVideo(140_000),
				longVideo(160_000),
				longVideo(155_000),
			],
		});

		expect(listings).toHaveLength(2);
		const byForm = Object.fromEntries(listings.map((l) => [l.form, l]));
		expect(byForm.short).toMatchObject({ proven: true });
		expect(byForm.long).toMatchObject({ proven: true });
	});

	it("does not emit a Listing for a form with too few settled uploads", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [
				shortVideo(600_000), // only 2 shorts — below MIN_SETTLED_VIDEOS
				shortVideo(700_000),
				longVideo(150_000),
				longVideo(160_000),
				longVideo(140_000),
			],
		});

		expect(listings).toHaveLength(1);
		expect(listings[0]?.form).toBe("long");
	});
});

describe("deriveListings — window selection", () => {
	it("excludes uploads too fresh to have settled", () => {
		// 3 settled 40k longs (fail) + 5 fresh 500k longs. Counting the fresh ones
		// would pass the gate; excluding them leaves a 40k median that fails.
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [
				longVideo(40_000),
				longVideo(40_000),
				longVideo(40_000),
				longVideo(500_000, { publishedAt: NOW - 2 * DAY }),
				longVideo(500_000, { publishedAt: NOW - 2 * DAY }),
				longVideo(500_000, { publishedAt: NOW - 2 * DAY }),
				longVideo(500_000, { publishedAt: NOW - 2 * DAY }),
				longVideo(500_000, { publishedAt: NOW - 2 * DAY }),
			],
		});

		expect(listings[0]).toMatchObject({ medianViews: 40_000, proven: false });
	});

	it("excludes non-standard items such as live streams", () => {
		// 3 settled 40k standard longs (fail) + 4 huge live streams. Counting the
		// live streams would pass the gate; excluding them fails it.
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [
				longVideo(40_000),
				longVideo(40_000),
				longVideo(40_000),
				longVideo(1_000_000, { isStandard: false }),
				longVideo(1_000_000, { isStandard: false }),
				longVideo(1_000_000, { isStandard: false }),
				longVideo(1_000_000, { isStandard: false }),
			],
		});

		expect(listings[0]).toMatchObject({ medianViews: 40_000, proven: false });
	});

	it("considers only the most recent uploads within the window", () => {
		// 12 recent 40k longs + 3 older 5M longs. The window keeps the 12 recent
		// ones, so the older blockbusters can't rescue the median.
		const recent = Array(12)
			.fill(0)
			.map(() => longVideo(40_000, { publishedAt: NOW - 10 * DAY }));
		const older = Array(3)
			.fill(0)
			.map(() => longVideo(5_000_000, { publishedAt: NOW - 100 * DAY }));

		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [...recent, ...older],
		});

		expect(listings[0]).toMatchObject({ medianViews: 40_000, proven: false });
	});
});

describe("deriveListings — Slice 1 placeholders", () => {
	it("leaves stage at Emerging and the AI-derived signals unset", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [longVideo(150_000), longVideo(160_000), longVideo(140_000)],
		});

		expect(listings[0]).toMatchObject({
			stage: "emerging",
			baseline: null,
			momentum: null,
			saturation: null,
			clonability: null,
			signals: null,
		});
	});
});
