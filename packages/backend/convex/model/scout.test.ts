import { describe, expect, it } from "vitest";

import {
	isRetired,
	nextZeroYield,
	rankCandidateChannels,
	selectRunQueries,
} from "./scout";
import type { NicheQueryOrigin } from "./validators";

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

/** A pooled Niche Query in the shape selection consumes: its origin slice and
 * retirement counter, plus a `name` label so assertions can name the picked rows.
 * Callers list these already sorted stalest-first, as `selectRunQueries` expects. */
function query(
	name: string,
	origin: NicheQueryOrigin,
	consecutiveZeroYield = 0,
) {
	return { name, origin, consecutiveZeroYield };
}

const SPLIT = {
	seededPerRun: 8,
	explorationPerRun: 2,
	retirementThreshold: 3,
};

/** The names picked, in pick order. */
function pickedNames<T extends { name: string }>(picked: T[]): string[] {
	return picked.map((query) => query.name);
}

describe("selectRunQueries — LRU slice split with borrow and retirement", () => {
	it("draws the seeded and exploration targets LRU-first within each slice", () => {
		// 10 seeded + 3 exploration, all live, already LRU-ordered.
		const pool = [
			...Array.from({ length: 10 }, (_, i) => query(`s${i}`, "seeded")),
			query("a0", "adjacent"),
			query("w0", "wildcat"),
			query("a1", "adjacent"),
		];

		const picked = selectRunQueries(pool, SPLIT);

		// 8 stalest seeded + 2 stalest exploration (a0 then w0), in that order.
		expect(pickedNames(picked)).toEqual([
			"s0",
			"s1",
			"s2",
			"s3",
			"s4",
			"s5",
			"s6",
			"s7",
			"a0",
			"w0",
		]);
	});

	it("treats adjacent and wildcat as one exploration slice", () => {
		const pool = [query("w", "wildcat"), query("a", "adjacent")];
		const picked = selectRunQueries(pool, SPLIT);
		// Both are exploration; LRU order keeps w ahead of a.
		expect(pickedNames(picked)).toEqual(["w", "a"]);
	});

	it("borrows from exploration when the seeded slice is short", () => {
		// Only 3 seeded, but plenty of exploration; total target is 10.
		const pool = [
			query("s0", "seeded"),
			query("s1", "seeded"),
			query("s2", "seeded"),
			...Array.from({ length: 12 }, (_, i) => query(`a${i}`, "adjacent")),
		];

		const picked = selectRunQueries(pool, SPLIT);

		expect(picked).toHaveLength(10);
		// 3 seeded + its 2 exploration target + 5 borrowed exploration (LRU-first).
		expect(pickedNames(picked)).toEqual([
			"s0",
			"s1",
			"s2",
			"a0",
			"a1",
			"a2",
			"a3",
			"a4",
			"a5",
			"a6",
		]);
	});

	it("borrows from seeded when the exploration slice is short", () => {
		const pool = [
			...Array.from({ length: 12 }, (_, i) => query(`s${i}`, "seeded")),
			query("a0", "adjacent"),
		];

		const picked = selectRunQueries(pool, SPLIT);

		expect(picked).toHaveLength(10);
		// 8 seeded target + 1 exploration + 1 borrowed seeded (s8, the next stalest).
		expect(pickedNames(picked)).toEqual([
			"s0",
			"s1",
			"s2",
			"s3",
			"s4",
			"s5",
			"s6",
			"s7",
			"a0",
			"s8",
		]);
	});

	it("never picks a retired query, even when the pool would otherwise be short", () => {
		const pool = [
			query("dead", "seeded", 3), // retired ⇒ skipped
			query("dying", "seeded", 4), // over threshold ⇒ skipped
			query("live", "seeded", 2), // one short of retirement ⇒ picked
			query("exp", "adjacent", 3), // retired exploration ⇒ skipped
		];

		expect(pickedNames(selectRunQueries(pool, SPLIT))).toEqual(["live"]);
	});

	it("returns nothing for an empty pool", () => {
		expect(selectRunQueries([], SPLIT)).toEqual([]);
	});
});

describe("isRetired / nextZeroYield — the pool's self-pruning rules", () => {
	it("retires a query only once it reaches the threshold", () => {
		expect(isRetired(2, 3)).toBe(false);
		expect(isRetired(3, 3)).toBe(true);
		expect(isRetired(4, 3)).toBe(true);
	});

	it("resets the counter on a yielding run and advances it on a barren one", () => {
		expect(nextZeroYield(0, false)).toBe(1);
		expect(nextZeroYield(2, false)).toBe(3); // the run that retires it
		expect(nextZeroYield(2, true)).toBe(0); // an unseen channel revives progress
		expect(nextZeroYield(0, true)).toBe(0);
	});
});
