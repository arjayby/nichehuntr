import { describe, expect, it } from "vitest";

import {
	asAdmin,
	asSubscribedOperator,
	createGatedTest,
} from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_SCOUT_CONFIG, type ScoutConfig } from "./model/scout";
import {
	type CandidateVideoStats,
	type ChannelUpload,
	QuotaExceededError,
	type YouTubeAdapter,
} from "./model/youtube";
import { runScoutRun } from "./scout";
import { runSubmission } from "./submissions";

const DAY = 24 * 60 * 60 * 1000;
const SHORT_SEC = 30;

/** A well-formed `UC…` id from a readable stem (padded to 22 chars). */
function ucId(stem: string): string {
	return `UC${stem.padEnd(22, "0").slice(0, 22)}`;
}

/** One candidate video the Scout could harvest: which query surfaces it, the
 * video/channel identity, and the view count hydration reports. */
type Candidate = {
	query: string;
	ytVideoId: string;
	ytChannelId: string;
	viewCount: number;
};

type ScoutStubOpts = {
	candidates?: Candidate[];
	/** Queries whose `search.list` throws — `"quota"` aborts the run, anything
	 * else is a transient per-query skip. */
	searchThrows?: Record<string, "quota" | "transient">;
	/** Make hydration throw a quota error, to exercise a mid-run abort. */
	hydrateThrows?: boolean;
	/** Downstream channel fixtures for driving the Submission worker to `tracked`. */
	channels?: Record<
		string,
		{ title?: string; subscriberCount?: number; uploads: ChannelUpload[] }
	>;
	/** Records, in call order, the queries searched and the video ids hydrated. */
	searched?: string[];
	hydrated?: string[];
};

/** A stub YouTube adapter for the Scout — no network. `searchRecentShorts` and
 * `hydrateCandidateStats` drive the run; the Submission-worker methods let the
 * same stub carry a created Submission through to `tracked`. */
function scoutAdapter(opts: ScoutStubOpts): YouTubeAdapter {
	const candidates = opts.candidates ?? [];
	return {
		searchRecentShorts: async (query) => {
			opts.searched?.push(query);
			const throws = opts.searchThrows?.[query];
			if (throws === "quota") {
				throw new QuotaExceededError();
			}
			if (throws !== undefined) {
				throw new Error("transient search failure");
			}
			return candidates
				.filter((candidate) => candidate.query === query)
				.map(({ ytVideoId, ytChannelId }) => ({ ytVideoId, ytChannelId }));
		},
		hydrateCandidateStats: async (videoIds): Promise<CandidateVideoStats[]> => {
			if (opts.hydrateThrows) {
				throw new QuotaExceededError();
			}
			opts.hydrated?.push(...videoIds);
			return candidates
				.filter((candidate) => videoIds.includes(candidate.ytVideoId))
				.map(({ ytVideoId, ytChannelId, viewCount }) => ({
					ytVideoId,
					ytChannelId,
					viewCount,
				}));
		},
		fetchChannels: async (ids) =>
			ids.map((id) => ({
				ytChannelId: id,
				title: opts.channels?.[id]?.title ?? `${id} title`,
				subscriberCount: opts.channels?.[id]?.subscriberCount,
			})),
		fetchChannelUploads: async (channelId) =>
			(opts.channels?.[channelId]?.uploads ?? []).map((upload) => ({
				...upload,
				ytChannelId: channelId,
			})),
		resolveHandle: async () => null,
	};
}

/** A run of standard short uploads for one channel, strong enough to make the
 * channel Feed-visible (Breaking Out). */
function strongShorts(channelId: string, count = 3): ChannelUpload[] {
	return Array.from({ length: count }, (_, i) => ({
		ytVideoId: `${channelId}_v${i}`,
		ytChannelId: channelId,
		title: `${channelId} short ${i}`,
		durationSec: SHORT_SEC,
		publishedAt: Date.now() - DAY,
		viewCount: 150_000,
		isStandard: true,
	}));
}

function config(overrides: Partial<ScoutConfig> = {}): ScoutConfig {
	return { ...DEFAULT_SCOUT_CONFIG, ...overrides };
}

async function setup() {
	const t = createGatedTest();
	const admin = await asAdmin(t, "scout-admin");
	const operator = await asSubscribedOperator(t, "scout-op");
	return { t, admin, operator };
}

/** Seed a Niche Query into the pool (optionally already run at `lastRunAt`). */
async function seedQuery(
	t: Awaited<ReturnType<typeof setup>>["t"],
	phrase: string,
	lastRunAt?: number,
) {
	await t.run((ctx) =>
		ctx.db.insert("searchQueries", {
			phrase,
			origin: "seeded",
			consecutiveZeroYield: 0,
			lastRunAt,
		}),
	);
}

/** The pending `scout` Submissions a run created, newest-first is irrelevant —
 * sorted by resolved raw input for stable assertions. */
async function scoutSubmissions(t: Awaited<ReturnType<typeof setup>>["t"]) {
	return t.run(async (ctx) => {
		const rows = await ctx.db.query("submissions").collect();
		return rows
			.filter((row) => row.source === "scout")
			.sort((a, b) => a.rawInput.localeCompare(b.rawInput));
	});
}

async function theScoutRun(t: Awaited<ReturnType<typeof setup>>["t"]) {
	return t.run(async (ctx) => {
		const rows = await ctx.db.query("scoutRuns").collect();
		return rows[0];
	});
}

async function feedTitles(
	operator: Awaited<ReturnType<typeof setup>>["operator"],
) {
	const groups = await operator.query(api.feed.feed, {});
	return groups.flatMap((group) =>
		group.cards.map((card) => card.channel.title),
	);
}

describe("runScoutRun — end-to-end tracer bullet (issue #79)", () => {
	it("submits the top unseen channels as scout Submissions that proceed through the pipeline", async () => {
		const { t, admin, operator } = await setup();
		await seedQuery(t, "ai horror shorts");
		const winner = ucId("winner");
		const weak = ucId("weak");

		const adapter = scoutAdapter({
			candidates: [
				{
					query: "ai horror shorts",
					ytVideoId: "v_win",
					ytChannelId: winner,
					viewCount: 120_000,
				},
				// Below the 10k floor ⇒ never submitted.
				{
					query: "ai horror shorts",
					ytVideoId: "v_weak",
					ytChannelId: weak,
					viewCount: 4_000,
				},
			],
			channels: {
				[winner]: { title: "AI Horror Winner", uploads: strongShorts(winner) },
			},
		});

		await t.action((ctx) => runScoutRun(ctx, adapter, config()));

		const submissions = await scoutSubmissions(t);
		expect(submissions).toHaveLength(1);
		expect(submissions[0]).toMatchObject({
			rawInput: winner,
			source: "scout",
			status: "pending",
		});
		// The under-floor channel was never submitted.
		expect(submissions.some((s) => s.rawInput === weak)).toBe(false);

		// Drive the Submission worker the run scheduled (convex-test doesn't auto-run
		// scheduled jobs, and the live worker would wire the networked adapter).
		await t.action((ctx) =>
			runSubmission(ctx, adapter, submissions[0]._id as Id<"submissions">),
		);

		const row = (await admin.query(api.submissions.listSubmissions, {})).find(
			(r) => r._id === submissions[0]._id,
		);
		expect(row).toMatchObject({
			source: "scout",
			status: "tracked",
			resolvedYtChannelId: winner,
			outcome: { stage: "breaking_out", feedVisibility: "visible" },
		});
		expect(await feedTitles(operator)).toContain("AI Horror Winner");
	});

	it("excludes already-tracked channels before spending any hydration quota", async () => {
		const { t } = await setup();
		await seedQuery(t, "reddit stories");
		const tracked = ucId("tracked");
		const fresh = ucId("fresh");
		// Pre-track a channel so its candidate must be dropped before hydration.
		await t.run((ctx) =>
			ctx.db.insert("channels", {
				ytId: tracked,
				title: "Already Tracked",
				discoveredAt: Date.now(),
				source: "admin",
			}),
		);

		const hydrated: string[] = [];
		const adapter = scoutAdapter({
			hydrated,
			candidates: [
				{
					query: "reddit stories",
					ytVideoId: "v_tracked",
					ytChannelId: tracked,
					viewCount: 999_999,
				},
				{
					query: "reddit stories",
					ytVideoId: "v_fresh",
					ytChannelId: fresh,
					viewCount: 80_000,
				},
			],
			channels: { [fresh]: { title: "Fresh", uploads: strongShorts(fresh) } },
		});

		await t.action((ctx) => runScoutRun(ctx, adapter, config()));

		// The tracked channel's video was never hydrated; only the fresh one was.
		expect(hydrated).toEqual(["v_fresh"]);
		const submissions = await scoutSubmissions(t);
		expect(submissions.map((s) => s.rawInput)).toEqual([fresh]);
	});

	it("ranks globally across the run and caps how many channels it submits", async () => {
		const { t } = await setup();
		await seedQuery(t, "q_a");
		await seedQuery(t, "q_b");
		// Two queries, five above-floor channels split across them; cap at 3.
		const candidates: Candidate[] = [
			{
				query: "q_a",
				ytVideoId: "va1",
				ytChannelId: ucId("c1"),
				viewCount: 10_000,
			},
			{
				query: "q_a",
				ytVideoId: "va2",
				ytChannelId: ucId("c2"),
				viewCount: 90_000,
			},
			{
				query: "q_b",
				ytVideoId: "vb3",
				ytChannelId: ucId("c3"),
				viewCount: 50_000,
			},
			{
				query: "q_b",
				ytVideoId: "vb4",
				ytChannelId: ucId("c4"),
				viewCount: 70_000,
			},
			{
				query: "q_b",
				ytVideoId: "vb5",
				ytChannelId: ucId("c5"),
				viewCount: 30_000,
			},
		];

		await t.action((ctx) =>
			runScoutRun(
				ctx,
				scoutAdapter({ candidates }),
				config({ submissionCap: 3 }),
			),
		);

		const submissions = await scoutSubmissions(t);
		// The three highest best-view channels globally: c2 (90k), c4 (70k), c3 (50k).
		expect(submissions.map((s) => s.rawInput).sort()).toEqual(
			[ucId("c2"), ucId("c3"), ucId("c4")].sort(),
		);
	});

	it("records the run's counters on a scoutRuns heartbeat row", async () => {
		const { t } = await setup();
		await seedQuery(t, "q1");
		const chan = ucId("counted");

		await t.action((ctx) =>
			runScoutRun(
				ctx,
				scoutAdapter({
					candidates: [
						{
							query: "q1",
							ytVideoId: "v1",
							ytChannelId: chan,
							viewCount: 50_000,
						},
					],
					channels: {
						[chan]: { title: "Counted", uploads: strongShorts(chan) },
					},
				}),
				config(),
			),
		);

		const run = await theScoutRun(t);
		expect(run).toMatchObject({
			queriesUsed: 1,
			candidatesSeen: 1,
			channelsSubmitted: 1,
		});
		expect(run?.error).toBeUndefined();
		expect(run?.startedAt).toBeGreaterThan(0);
		expect(run?.finishedAt).toBeGreaterThanOrEqual(run?.startedAt ?? 0);
		expect(run?.estimatedQuotaUnits).toBeGreaterThanOrEqual(100);
	});

	it("updates the last-run timestamp of every searched query", async () => {
		const { t } = await setup();
		await seedQuery(t, "q1");
		await seedQuery(t, "q2");

		await t.action((ctx) =>
			runScoutRun(ctx, scoutAdapter({ candidates: [] }), config()),
		);

		const rows = await t.run((ctx) => ctx.db.query("searchQueries").collect());
		expect(rows.every((row) => (row.lastRunAt ?? 0) > 0)).toBe(true);
	});

	it("picks queries least-recently-run first, never-run before the stalest", async () => {
		const { t } = await setup();
		const base = Date.now();
		await seedQuery(t, "recent", base); // freshest — should not be picked
		await seedQuery(t, "stale", base - 5 * DAY);
		await seedQuery(t, "never"); // never run — picked first

		const searched: string[] = [];
		await t.action((ctx) =>
			runScoutRun(
				ctx,
				scoutAdapter({ searched, candidates: [] }),
				config({ queriesPerRun: 2 }),
			),
		);

		expect(searched.sort()).toEqual(["never", "stale"]);
	});
});

describe("runScoutRun — abort recording", () => {
	it("records an aborting quota error and partial counters, submitting nothing", async () => {
		const { t } = await setup();
		await seedQuery(t, "q1");

		await t.action((ctx) =>
			runScoutRun(
				ctx,
				scoutAdapter({
					hydrateThrows: true, // quota exhaustion during hydration
					candidates: [
						{
							query: "q1",
							ytVideoId: "v1",
							ytChannelId: ucId("x"),
							viewCount: 90_000,
						},
					],
				}),
				config(),
			),
		);

		const run = await theScoutRun(t);
		expect(run?.error).toMatch(/quota/i);
		expect(run?.finishedAt).toBeGreaterThan(0);
		expect(run).toMatchObject({ candidatesSeen: 1, channelsSubmitted: 0 });
		expect(await scoutSubmissions(t)).toHaveLength(0);
	});

	it("skips a query whose search fails transiently without aborting the run", async () => {
		const { t } = await setup();
		await seedQuery(t, "flaky");
		await seedQuery(t, "healthy");
		const chan = ucId("healthy");

		await t.action((ctx) =>
			runScoutRun(
				ctx,
				scoutAdapter({
					searchThrows: { flaky: "transient" },
					candidates: [
						{
							query: "healthy",
							ytVideoId: "v1",
							ytChannelId: chan,
							viewCount: 60_000,
						},
					],
					channels: {
						[chan]: { title: "Healthy", uploads: strongShorts(chan) },
					},
				}),
				config(),
			),
		);

		// The healthy query still produced a submission; the run did not abort.
		const run = await theScoutRun(t);
		expect(run?.error).toBeUndefined();
		expect(await scoutSubmissions(t)).toHaveLength(1);
	});

	it("aborts the whole run when a search reports quota exhaustion", async () => {
		const { t } = await setup();
		await seedQuery(t, "boom");

		await t.action((ctx) =>
			runScoutRun(
				ctx,
				scoutAdapter({ searchThrows: { boom: "quota" }, candidates: [] }),
				config(),
			),
		);

		const run = await theScoutRun(t);
		expect(run?.error).toMatch(/quota/i);
		expect(run?.finishedAt).toBeGreaterThan(0);
	});
});
