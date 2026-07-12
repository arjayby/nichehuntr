import { describe, expect, it } from "vitest";

import { rankCandidateChannels } from "./scout";

/** A candidate video in the shape ranking consumes: the channel that published
 * it and its current view count. */
function video(ytChannelId: string, viewCount: number) {
	return { ytChannelId, viewCount };
}

describe("rankCandidateChannels — global best-video ranking with floor and cap", () => {
	it("scores each channel by its best found-video and orders by that descending", () => {
		const ranked = rankCandidateChannels(
			[
				video("UC_a", 20_000),
				video("UC_a", 90_000), // a's best
				video("UC_b", 50_000),
				video("UC_c", 30_000),
			],
			{ viewFloor: 10_000, cap: 30 },
		);

		expect(ranked).toEqual([
			{ ytChannelId: "UC_a", bestViewCount: 90_000 },
			{ ytChannelId: "UC_b", bestViewCount: 50_000 },
			{ ytChannelId: "UC_c", bestViewCount: 30_000 },
		]);
	});

	it("drops channels whose best video is under the view floor, keeping the floor itself", () => {
		const ranked = rankCandidateChannels(
			[
				video("UC_at", 10_000), // exactly the floor ⇒ kept
				video("UC_under", 9_999), // under the floor ⇒ dropped
				video("UC_over", 15_000),
			],
			{ viewFloor: 10_000, cap: 30 },
		);

		expect(ranked.map((c) => c.ytChannelId)).toEqual(["UC_over", "UC_at"]);
	});

	it("keeps a channel whose best clears the floor even if a weaker video is under it", () => {
		const ranked = rankCandidateChannels(
			[video("UC_a", 5_000), video("UC_a", 40_000)],
			{ viewFloor: 10_000, cap: 30 },
		);

		expect(ranked).toEqual([{ ytChannelId: "UC_a", bestViewCount: 40_000 }]);
	});

	it("caps the run at the top N channels globally", () => {
		const videos = Array.from({ length: 40 }, (_, i) =>
			// Higher index ⇒ more views, so the top `cap` are the highest-numbered.
			video(`UC_${String(i).padStart(2, "0")}`, 10_000 + i * 1_000),
		);

		const ranked = rankCandidateChannels(videos, {
			viewFloor: 10_000,
			cap: 30,
		});

		expect(ranked).toHaveLength(30);
		expect(ranked[0]).toEqual({ ytChannelId: "UC_39", bestViewCount: 49_000 });
		// The 10 lowest-view channels fall outside the cap.
		expect(ranked.map((c) => c.ytChannelId)).not.toContain("UC_00");
		expect(ranked.map((c) => c.ytChannelId)).not.toContain("UC_09");
	});

	it("breaks view-count ties by channel id for a deterministic selection", () => {
		const ranked = rankCandidateChannels(
			[video("UC_z", 50_000), video("UC_a", 50_000), video("UC_m", 50_000)],
			{ viewFloor: 10_000, cap: 2 },
		);

		// All tied on views; the cap keeps the two lexicographically-first ids.
		expect(ranked.map((c) => c.ytChannelId)).toEqual(["UC_a", "UC_m"]);
	});

	it("returns nothing for an empty candidate set", () => {
		expect(rankCandidateChannels([], { viewFloor: 10_000, cap: 30 })).toEqual(
			[],
		);
	});
});
