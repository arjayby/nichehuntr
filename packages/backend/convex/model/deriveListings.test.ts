import { describe, expect, it } from "vitest";

import {
	classifyForm,
	deriveListings,
	MOMENTUM_MODEST,
	MOMENTUM_STRONG,
	type ProvenVideo,
	SATURATION_CROWDED,
	SATURATION_WARM,
	type Snapshot,
	saturationLevel,
	stageFor,
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

/**
 * Two snapshots `days` apart ending at NOW, so the derivation sees a real recent
 * velocity slope of (to − from) / days views per day.
 */
function snaps(from: number, to: number, days = 2): Snapshot[] {
	return [
		{ viewCount: from, at: NOW - days * DAY },
		{ viewCount: to, at: NOW },
	];
}

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

describe("deriveListings — Momentum & Stage", () => {
	// Baseline is the median per-video reach, so momentum = medianVelocity /
	// baseline is a scale-free daily-growth rate. Three same-size videos keep the
	// arithmetic obvious: momentum is each video's velocity over its view count.

	it("reads a steep recent slope as strong momentum ⇒ Breaking Out", () => {
		// +50k over 2 days on a 150k baseline ⇒ 25k/day ⇒ momentum ≈ 0.167 ≥ strong.
		const rising = () =>
			longVideo(150_000, { snapshots: snaps(100_000, 150_000) });
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [rising(), rising(), rising()],
		});

		expect(listings[0]?.momentum).toBeGreaterThanOrEqual(MOMENTUM_STRONG);
		expect(listings[0]?.stage).toBe("breaking_out");
	});

	it("reads a shallow recent slope as modest momentum ⇒ Emerging", () => {
		// +12k over 2 days on 150k ⇒ 6k/day ⇒ momentum 0.04: past modest, below strong.
		const climbing = () =>
			longVideo(150_000, { snapshots: snaps(138_000, 150_000) });
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [climbing(), climbing(), climbing()],
		});

		const momentum = listings[0]?.momentum ?? 0;
		expect(momentum).toBeGreaterThanOrEqual(MOMENTUM_MODEST);
		expect(momentum).toBeLessThan(MOMENTUM_STRONG);
		expect(listings[0]?.stage).toBe("emerging");
	});

	it("reads a flat recent slope as no momentum ⇒ Established", () => {
		const plateaued = () =>
			longVideo(150_000, { snapshots: snaps(150_000, 150_000) });
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [plateaued(), plateaued(), plateaued()],
		});

		expect(listings[0]?.momentum).toBe(0);
		expect(listings[0]?.stage).toBe("established");
	});

	it("reads a cooled/declining velocity as low momentum ⇒ Established", () => {
		// A big listing barely moving: +3k over 2 days on a 500k baseline ⇒ momentum
		// 0.003. Its recent velocity has fallen far below what its size once implied.
		const cooling = () =>
			longVideo(500_000, { snapshots: snaps(497_000, 500_000) });
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [cooling(), cooling(), cooling()],
		});

		const momentum = listings[0]?.momentum ?? 0;
		expect(momentum).toBeGreaterThan(0);
		expect(momentum).toBeLessThan(MOMENTUM_MODEST);
		expect(listings[0]?.stage).toBe("established");
	});

	it("seeds momentum from views ÷ video-age when snapshots are sparse", () => {
		// No snapshots: velocity is the lifetime proxy views/age. With identical
		// views and age across the window momentum collapses to 1/ageDays = 1/30 — a
		// modest positive that surfaces a fresh channel in Emerging, never blank.
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [longVideo(150_000), longVideo(150_000), longVideo(150_000)],
		});

		expect(listings[0]?.momentum).toBeCloseTo(1 / 30, 6);
		expect(listings[0]?.stage).toBe("emerging");
	});

	it("treats a single snapshot as sparse, still using the proxy", () => {
		const oneSnap = () =>
			longVideo(150_000, { snapshots: [{ viewCount: 150_000, at: NOW }] });
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [oneSnap(), oneSnap(), oneSnap()],
		});

		expect(listings[0]?.momentum).toBeCloseTo(1 / 30, 6);
	});

	it("ignores a slope from snapshots too close together (sampling noise)", () => {
		// Two readings 30 min apart would imply an absurd velocity; below the min
		// span they count as one reading and momentum falls back to the proxy.
		const HALF_HOUR = 30 * 60 * 1000;
		const noisy = () =>
			longVideo(150_000, {
				snapshots: [
					{ viewCount: 100_000, at: NOW - HALF_HOUR },
					{ viewCount: 150_000, at: NOW },
				],
			});
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [noisy(), noisy(), noisy()],
		});

		// The proxy, not the 50k-in-30-min slope that would scream Breaking Out.
		expect(listings[0]?.momentum).toBeCloseTo(1 / 30, 6);
		expect(listings[0]?.stage).toBe("emerging");
	});

	it("reports Baseline as the window's median per-video reach", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [longVideo(120_000), longVideo(140_000), longVideo(160_000)],
		});

		expect(listings[0]?.baseline).toBe(140_000);
	});
});

describe("stageFor — momentum axis (saturation not measured)", () => {
	it("maps strong momentum to Breaking Out (threshold inclusive)", () => {
		expect(stageFor(MOMENTUM_STRONG, null)).toBe("breaking_out");
		expect(stageFor(1, null)).toBe("breaking_out");
	});

	it("maps modest-positive momentum to Emerging", () => {
		expect(stageFor(MOMENTUM_MODEST, null)).toBe("emerging");
		expect(stageFor((MOMENTUM_STRONG + MOMENTUM_MODEST) / 2, null)).toBe(
			"emerging",
		);
	});

	it("maps flat or declining momentum to Established", () => {
		expect(stageFor(0, null)).toBe("established");
		expect(stageFor(MOMENTUM_MODEST - 0.001, null)).toBe("established");
	});
});

describe("stageFor — saturation dominates", () => {
	it("forces Established for a crowded niche even under strong momentum", () => {
		// The whole point of the override: a niche this full is too late to clone,
		// so it lands in Established no matter how hard it is still accelerating.
		expect(stageFor(1, SATURATION_CROWDED)).toBe("established");
		expect(stageFor(MOMENTUM_STRONG, SATURATION_CROWDED + 5)).toBe(
			"established",
		);
	});

	it("does not override while the niche is only warming up", () => {
		// Below the crowded band momentum still decides — a filling-in niche with
		// real momentum is exactly the Breaking Out sweet spot.
		expect(stageFor(MOMENTUM_STRONG, SATURATION_WARM)).toBe("breaking_out");
		expect(stageFor(MOMENTUM_MODEST, SATURATION_CROWDED - 1)).toBe("emerging");
	});

	it("leaves an uncrowded strong listing in Breaking Out", () => {
		expect(stageFor(MOMENTUM_STRONG, 0)).toBe("breaking_out");
	});
});

describe("saturationLevel bucketing", () => {
	it("reads a sparse niche as low", () => {
		expect(saturationLevel(0)).toBe("low");
		expect(saturationLevel(SATURATION_WARM - 1)).toBe("low");
	});

	it("reads a filling-in niche as medium", () => {
		expect(saturationLevel(SATURATION_WARM)).toBe("medium");
		expect(saturationLevel(SATURATION_CROWDED - 1)).toBe("medium");
	});

	it("reads a crowded niche as high (the band that dominates Stage)", () => {
		expect(saturationLevel(SATURATION_CROWDED)).toBe("high");
		expect(saturationLevel(SATURATION_CROWDED + 100)).toBe("high");
	});
});

describe("deriveListings — Saturation threading", () => {
	// A strongly-accelerating channel: on momentum alone it is Breaking Out.
	const surging = () =>
		longVideo(150_000, { snapshots: snaps(100_000, 150_000) });

	it("rides the channel's saturation onto every form's Listing", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			saturation: SATURATION_WARM,
			videos: [surging(), surging(), surging()],
		});

		expect(listings[0]?.saturation).toBe(SATURATION_WARM);
	});

	it("lets a crowded niche sink a strong listing to Established", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			saturation: SATURATION_CROWDED,
			videos: [surging(), surging(), surging()],
		});

		expect(listings[0]?.momentum).toBeGreaterThanOrEqual(MOMENTUM_STRONG);
		expect(listings[0]?.stage).toBe("established");
	});

	it("leaves the same strong listing in Breaking Out while the niche is sparse", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			saturation: 0,
			videos: [surging(), surging(), surging()],
		});

		expect(listings[0]?.stage).toBe("breaking_out");
	});

	it("defaults Saturation to null when it has not been measured yet", () => {
		const listings = deriveListings({
			channelId: "c",
			now: NOW,
			videos: [longVideo(150_000), longVideo(160_000), longVideo(140_000)],
		});

		expect(listings[0]).toMatchObject({
			saturation: null,
			clonability: null,
			signals: null,
		});
	});
});
