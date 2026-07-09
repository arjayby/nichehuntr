import { describe, expect, it } from "vitest";

import {
	asAdmin,
	asSubscribedOperator,
	createGatedTest,
} from "../test/harness";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ChannelUpload, YouTubeAdapter } from "./model/youtube";
import { runSubmission } from "./submissions";

const DAY = 24 * 60 * 60 * 1000;
const LONG_SEC = 600; // > 300s ⇒ ignored by the short-form lifecycle.
const SHORT_SEC = 30; // ≤ 300s ⇒ short-form for the lifecycle.

/** A well-formed `UC…` id built from a readable stem (padded to 22 chars). */
function ucId(stem: string): string {
	return `UC${stem.padEnd(22, "0").slice(0, 22)}`;
}

/** A run of standard, settled uploads for one channel in the shape the adapter
 * hands the worker. */
function uploads(
	channelId: string,
	opts: {
		count: number;
		viewCount: number;
		ageDays: number;
		durationSec: number;
		tag?: string;
	},
): ChannelUpload[] {
	const { count, viewCount, ageDays, durationSec, tag = "v" } = opts;
	return Array.from({ length: count }, (_, i) => ({
		ytVideoId: `${channelId}_${tag}${i}`,
		ytChannelId: channelId,
		title: `${channelId} ${tag} ${i}`,
		durationSec,
		publishedAt: Date.now() - ageDays * DAY,
		viewCount,
		isStandard: true,
	}));
}

/** A stub YouTube adapter — no network. `fetchChannelUploads` echoes a fixed
 * page; the flags exercise the worker's failure branches. `resolveHandle` returns
 * `resolveHandleTo` (default `null` ⇒ handle not found) or throws on
 * `handleThrows`, so the handle-lookup branches are driven without network. */
function stubAdapter(opts: {
	title?: string;
	subscriberCount?: number;
	page: ChannelUpload[];
	channelMissing?: boolean;
	uploadsThrow?: boolean;
	resolveHandleTo?: string | null;
	handleThrows?: boolean;
	uploadLimits?: (number | undefined)[];
}): YouTubeAdapter {
	return {
		fetchChannels: async (ids) =>
			opts.channelMissing
				? []
				: ids.map((id) => ({
						ytChannelId: id,
						title: opts.title ?? `${id} title`,
						handle: `@${id}`,
						subscriberCount: opts.subscriberCount,
					})),
		fetchChannelUploads: async (channelId, fetchOpts) => {
			if (opts.uploadsThrow) {
				throw new Error("YouTube API error");
			}
			opts.uploadLimits?.push(fetchOpts?.limit);
			return opts.page.map((u) => ({ ...u, ytChannelId: channelId }));
		},
		resolveHandle: async () => {
			if (opts.handleThrows) {
				throw new Error("YouTube API error");
			}
			return opts.resolveHandleTo ?? null;
		},
	};
}

/** An adapter every method of which throws — proves a path never touched it, so a
 * clean failure reason came from the pure resolver, not a mislabeled API error. */
function unusableAdapter(): YouTubeAdapter {
	const boom = async (): Promise<never> => {
		throw new Error("adapter must not be called");
	};
	return {
		fetchChannels: boom,
		fetchChannelUploads: boom,
		resolveHandle: boom,
	};
}

/** A gated instance with a signed-in Admin and a subscribed Operator: the Admin
 * drives/reads Submissions, the Operator reads the Feed. */
async function setup() {
	const t = createGatedTest();
	const admin = await asAdmin(t, "sub-admin");
	const operator = await asSubscribedOperator(t, "sub-op");
	return { t, admin, operator };
}

/** Seed a `pending` Submission directly and drive the worker over it with a stub
 * adapter, bypassing the scheduler (which would wire the live, networked one). */
async function runOver(
	t: Awaited<ReturnType<typeof setup>>["t"],
	rawInput: string,
	adapter: YouTubeAdapter,
): Promise<Id<"submissions">> {
	const submissionId = await t.run((ctx) =>
		ctx.db.insert("submissions", {
			rawInput,
			submittedBy: "someone",
			status: "pending",
		}),
	);
	await t.action((ctx) => runSubmission(ctx, adapter, submissionId));
	return submissionId;
}

/** The Submission row the admin table would render for a given id. */
async function submissionRow(
	admin: Awaited<ReturnType<typeof setup>>["admin"],
	submissionId: Id<"submissions">,
) {
	const rows = await admin.query(api.submissions.listSubmissions, {});
	return rows.find((r) => r._id === submissionId);
}

async function feedTitlesByStage(
	operator: Awaited<ReturnType<typeof setup>>["operator"],
) {
	const groups = await operator.query(api.feed.feed, {});
	return Object.fromEntries(
		groups.map((group) => [
			group.stage,
			group.cards.map((card) => card.channel.title),
		]),
	) as Record<"emerging" | "breaking_out" | "established", string[]>;
}

describe("runSubmission — the ingest spine", () => {
	it("tracks a visible short-form channel and stores current stats for lifecycle reads", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("visible");
		const uploadLimits: (number | undefined)[] = [];

		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Visible Shorts",
				subscriberCount: 12_000,
				uploadLimits,
				page: [
					...uploads(id, {
						count: 3,
						viewCount: 120_000,
						ageDays: 1,
						durationSec: SHORT_SEC,
						tag: "short",
					}),
					...uploads(id, {
						count: 2,
						viewCount: 1_000_000,
						ageDays: 1,
						durationSec: LONG_SEC,
						tag: "long",
					}),
				],
			}),
		);

		expect(uploadLimits).toEqual([50]);
		expect(await submissionRow(admin, submissionId)).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: {
				stage: "breaking_out",
				feedVisibility: "visible",
				fetchedShorts: 3,
				recentShortsChecked: 3,
				shortsAtOrAbove50k: 3,
				shortsAtOrAbove100k: 3,
			},
		});

		const titles = await feedTitlesByStage(operator);
		expect(titles.breaking_out).toContain("Visible Shorts");

		const stored = await t.run(async (ctx) => {
			const channel = await ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", id))
				.unique();
			const videos =
				channel === null
					? []
					: await ctx.db
							.query("videos")
							.withIndex("by_channel_and_publishedAt", (q) =>
								q.eq("channelId", channel._id),
							)
							.collect();
			return {
				subscriberCount: channel?.subscriberCount,
				currentViewCounts: videos
					.filter((video) => video.durationSec <= 300)
					.map((video) => video.currentViewCount)
					.sort((a, b) => (a ?? 0) - (b ?? 0)),
			};
		});
		expect(stored).toEqual({
			subscriberCount: 12_000,
			currentViewCounts: [120_000, 120_000, 120_000],
		});
	});

	it("keeps a successfully ingested hidden channel tracked rather than failed", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("hidden");

		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Hidden Tracked",
				page: [
					...uploads(id, {
						count: 2,
						viewCount: 1_000_000,
						ageDays: 1,
						durationSec: SHORT_SEC,
						tag: "short",
					}),
					...uploads(id, {
						count: 20,
						viewCount: 1_000_000,
						ageDays: 1,
						durationSec: LONG_SEC,
						tag: "long",
					}),
				],
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			outcome: {
				stage: "tracked",
				feedVisibility: "hidden",
				fetchedShorts: 2,
			},
		});
		expect(row?.failureReason).toBeNull();
		expect(
			Object.values(await feedTitlesByStage(operator)).flat(),
		).not.toContain("Hidden Tracked");
	});

	it("tracks a mature stale channel as Established from 50 fetched Shorts and subscribers", async () => {
		const { admin, operator, t } = await setup();
		const id = ucId("mature");

		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Mature Shorts",
				subscriberCount: 60_000,
				page: uploads(id, {
					count: 50,
					viewCount: 150_000,
					ageDays: 45,
					durationSec: SHORT_SEC,
				}),
			}),
		);

		expect(await submissionRow(admin, submissionId)).toMatchObject({
			status: "tracked",
			outcome: {
				stage: "established",
				feedVisibility: "visible",
				fetchedShorts: 50,
			},
		});
		const titles = await feedTitlesByStage(operator);
		expect(titles.established).toContain("Mature Shorts");
	});

	it("re-submitting a tracked channel refreshes current stats in place and can hide it from the Feed", async () => {
		const { t, operator } = await setup();
		const id = ucId("refresh");
		const strong = uploads(id, {
			count: 3,
			viewCount: 130_000,
			ageDays: 1,
			durationSec: SHORT_SEC,
		});

		await runOver(
			t,
			id,
			stubAdapter({ title: "Refreshable Shorts", page: strong }),
		);
		expect((await feedTitlesByStage(operator)).breaking_out).toContain(
			"Refreshable Shorts",
		);

		await runOver(
			t,
			id,
			stubAdapter({
				title: "Refreshable Shorts",
				page: strong.map((video) => ({ ...video, viewCount: 1_000 })),
			}),
		);

		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			currentViewCounts: (await ctx.db.query("videos").collect()).map(
				(video) => video.currentViewCount,
			),
		}));
		expect(counts).toEqual({
			channels: 1,
			videos: 3,
			currentViewCounts: [1_000, 1_000, 1_000],
		});
		expect(
			Object.values(await feedTitlesByStage(operator)).flat(),
		).not.toContain("Refreshable Shorts");
	});

	it("stamps submitted channels with source 'admin'", async () => {
		const { t } = await setup();
		const id = ucId("source");
		await runOver(
			t,
			id,
			stubAdapter({
				page: uploads(id, {
					count: 3,
					viewCount: 150_000,
					ageDays: 1,
					durationSec: SHORT_SEC,
				}),
			}),
		);

		const channel = await t.run((ctx) =>
			ctx.db
				.query("channels")
				.withIndex("by_ytId", (q) => q.eq("ytId", id))
				.unique(),
		);
		expect(channel?.source).toBe("admin");
	});

	it("tracks a channel that ingests but misses Feed lifecycle rules", async () => {
		const { t, admin } = await setup();
		const id = ucId("weak");
		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Weak Channel",
				page: uploads(id, {
					count: 3,
					viewCount: 40_000,
					ageDays: 1,
					durationSec: SHORT_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			outcome: {
				stage: "tracked",
				feedVisibility: "hidden",
				fetchedShorts: 3,
				shortsAtOrAbove50k: 0,
			},
		});
		expect(row?.failureReason).toBeNull();
	});

	it("tracks a visible channel pasted as a /channel/ URL", async () => {
		const { t, admin } = await setup();
		const id = ucId("urlchan");
		const submissionId = await runOver(
			t,
			`https://www.youtube.com/channel/${id}`,
			stubAdapter({
				title: "URL Channel",
				page: uploads(id, {
					count: 3,
					viewCount: 150_000,
					ageDays: 1,
					durationSec: SHORT_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { stage: "breaking_out", feedVisibility: "visible" },
		});
	});

	it.each([
		["a bare @handle", "@mrbeast"],
		["an @handle URL", "https://youtube.com/@mrbeast"],
	])("resolves %s to its id and tracks the channel", async (_label, paste) => {
		const { t, admin } = await setup();
		const id = ucId("handle");
		const submissionId = await runOver(
			t,
			paste,
			stubAdapter({
				title: "Handle Channel",
				resolveHandleTo: id, // the live lookup maps @mrbeast → this id
				page: uploads(id, {
					count: 3,
					viewCount: 150_000,
					ageDays: 1,
					durationSec: SHORT_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { stage: "breaking_out", feedVisibility: "visible" },
		});
	});

	it("fails a handle no channel owns with a resolve reason", async () => {
		const { t, admin } = await setup();
		const submissionId = await runOver(
			t,
			"@ghosthandle",
			stubAdapter({ page: [], resolveHandleTo: null }),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row?.status).toBe("failed");
		expect(row?.failureReason).toMatch(/resolve/i);
	});

	it("fails with an API-error reason when the handle lookup throws", async () => {
		const { t, admin } = await setup();
		const submissionId = await runOver(
			t,
			"@flakyhandle",
			stubAdapter({ page: [], handleThrows: true }),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row?.status).toBe("failed");
		expect(row?.failureReason).toMatch(/api error/i);
	});

	it.each([
		["a video URL", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", /video/i],
		["a legacy /c/ URL", "https://youtube.com/c/SomeChannel", /legacy|\/c\//i],
		["free-text garbage", "not a channel at all", /recognize/i],
	])("fails %s without touching the adapter", async (_label, paste, reasonPattern) => {
		const { t, admin } = await setup();
		// The adapter throws on any call, so reaching it would surface an
		// API-error reason — asserting the clean reason proves the pure resolver
		// rejected the paste before any network.
		const submissionId = await runOver(t, paste, unusableAdapter());

		const row = await submissionRow(admin, submissionId);
		expect(row?.status).toBe("failed");
		expect(row?.failureReason).toMatch(reasonPattern);
	});

	it("fails when the id resolves but no channel exists", async () => {
		const { t, admin } = await setup();
		const id = ucId("ghost");
		const submissionId = await runOver(
			t,
			id,
			stubAdapter({ page: [], channelMissing: true }),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row?.status).toBe("failed");
		expect(row?.failureReason).toMatch(/no youtube channel/i);
	});

	it("fails with an API-error reason when the adapter throws", async () => {
		const { t, admin } = await setup();
		const id = ucId("apierr");
		const submissionId = await runOver(
			t,
			id,
			stubAdapter({ page: [], uploadsThrow: true }),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row?.status).toBe("failed");
		expect(row?.failureReason).toMatch(/api error/i);
	});

	it("is an idempotent refresh — re-running does not duplicate", async () => {
		const { t, admin } = await setup();
		const id = ucId("refresh");
		const page = uploads(id, {
			count: 3,
			viewCount: 150_000,
			ageDays: 1,
			durationSec: SHORT_SEC,
		});

		await runOver(t, id, stubAdapter({ title: "Refresh", page }));
		const secondId = await runOver(
			t,
			id,
			stubAdapter({ title: "Refresh", page }),
		);

		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			listings: (await ctx.db.query("listings").collect()).length,
			snapshots: (await ctx.db.query("videoSnapshots").collect()).length,
		}));
		expect(counts).toEqual({
			channels: 1,
			videos: 3,
			listings: 0,
			snapshots: 0,
		});

		const row = await submissionRow(admin, secondId);
		expect(row).toMatchObject({
			status: "tracked",
			outcome: { stage: "breaking_out", feedVisibility: "visible" },
		});
	});

	it("re-submitting a tracked channel refreshes it — fresh data, no duplicate", async () => {
		const { t, admin } = await setup();
		const id = ucId("restale");

		// First submission: the channel ingests but misses Feed lifecycle rules.
		const firstId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Refreshable",
				page: uploads(id, {
					count: 3,
					viewCount: 40_000,
					ageDays: 1,
					durationSec: SHORT_SEC,
				}),
			}),
		);
		expect((await submissionRow(admin, firstId))?.outcome).toMatchObject({
			stage: "tracked",
			feedVisibility: "hidden",
		});

		// Re-submit the same channel with stronger current counts. The shared write
		// path patches in place by YouTube id and the channel can re-enter the Feed.
		const secondId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Refreshable",
				page: uploads(id, {
					count: 3,
					viewCount: 150_000,
					ageDays: 1,
					durationSec: SHORT_SEC,
				}),
			}),
		);

		expect(await submissionRow(admin, secondId)).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { stage: "breaking_out", feedVisibility: "visible" },
		});
		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			currentViewCounts: (await ctx.db.query("videos").collect()).map(
				(video) => video.currentViewCount,
			),
			listings: (await ctx.db.query("listings").collect()).length,
			snapshots: (await ctx.db.query("videoSnapshots").collect()).length,
		}));
		expect(counts).toEqual({
			channels: 1,
			videos: 3,
			currentViewCounts: [150_000, 150_000, 150_000],
			listings: 0,
			snapshots: 0,
		});
	});

	it("moves a failed Submission forward when the worker is re-run", async () => {
		const { t, admin } = await setup();
		const id = ucId("retryok");
		const page = uploads(id, {
			count: 3,
			viewCount: 150_000,
			ageDays: 1,
			durationSec: SHORT_SEC,
		});

		// A transient API error fails the Submission on the first run.
		const submissionId = await t.run((ctx) =>
			ctx.db.insert("submissions", {
				rawInput: id,
				submittedBy: "someone",
				status: "pending",
			}),
		);
		await t.action((ctx) =>
			runSubmission(
				ctx,
				stubAdapter({ page, uploadsThrow: true }),
				submissionId,
			),
		);
		expect((await submissionRow(admin, submissionId))?.status).toBe("failed");

		// Re-running the worker over the same row with the API now healthy tracks
		// it without requiring a re-paste.
		await t.action((ctx) =>
			runSubmission(ctx, stubAdapter({ title: "Retried", page }), submissionId),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			outcome: { stage: "breaking_out", feedVisibility: "visible" },
		});
		expect(row?.failureReason).toBeNull();
	});
});

describe("retrySubmission — one-click retry of a failed Submission", () => {
	it("resets a failed Submission to pending, clears the reason, and schedules the worker", async () => {
		const { t, admin } = await setup();
		const submissionId = await t.run((ctx) =>
			ctx.db.insert("submissions", {
				rawInput: ucId("failed"),
				submittedBy: "someone",
				status: "failed",
				failureReason: "YouTube API error — try again.",
			}),
		);

		await admin.mutation(api.submissions.retrySubmission, { submissionId });

		const row = await submissionRow(admin, submissionId);
		expect(row?.status).toBe("pending");
		expect(row?.failureReason).toBeNull();

		// The worker was scheduled to re-run this exact Submission in the background.
		const scheduled = await t.run((ctx) =>
			ctx.db.system.query("_scheduled_functions").collect(),
		);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.name).toMatch(/submissionWorker/);
		expect(scheduled[0]?.args).toEqual([{ submissionId }]);
	});

	it("rejects retrying a Submission that isn't failed", async () => {
		const { t, admin } = await setup();
		const submissionId = await t.run((ctx) =>
			ctx.db.insert("submissions", {
				rawInput: ucId("tracked"),
				submittedBy: "someone",
				status: "tracked",
				resolvedYtChannelId: ucId("tracked"),
				outcome: {
					stage: "breaking_out",
					feedVisibility: "visible",
					fetchedShorts: 3,
					recentShortsChecked: 3,
					shortsAtOrAbove50k: 3,
					shortsAtOrAbove100k: 3,
				},
			}),
		);

		await expect(
			admin.mutation(api.submissions.retrySubmission, { submissionId }),
		).rejects.toThrow(/NOT_RETRYABLE/);
	});

	it("admin allowed, subscribed non-admin and anon rejected", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "gate-admin-3");
		const operator = await asSubscribedOperator(t, "gate-op-3");
		const submissionId = await t.run((ctx) =>
			ctx.db.insert("submissions", {
				rawInput: ucId("gate"),
				submittedBy: "someone",
				status: "failed",
				failureReason: "boom",
			}),
		);

		await expect(
			operator.mutation(api.submissions.retrySubmission, { submissionId }),
		).rejects.toThrow(/ADMIN_REQUIRED/);
		await expect(
			t.mutation(api.submissions.retrySubmission, { submissionId }),
		).rejects.toThrow(/UNAUTHENTICATED/);
		await expect(
			admin.mutation(api.submissions.retrySubmission, { submissionId }),
		).resolves.toBeNull();
	});
});

describe("submitChannel — accepts instantly, ingests in the background", () => {
	it("inserts a pending Submission and returns its id", async () => {
		const { t, admin } = await setup();

		const submissionId = await admin.mutation(api.submissions.submitChannel, {
			rawInput: `  ${ucId("bg")}  `,
		});

		const row = await t.run((ctx) => ctx.db.get("submissions", submissionId));
		expect(row).toMatchObject({
			status: "pending",
			rawInput: ucId("bg"), // trimmed
		});
	});

	it("rejects a blank paste", async () => {
		const { admin } = await setup();
		await expect(
			admin.mutation(api.submissions.submitChannel, { rawInput: "   " }),
		).rejects.toThrow(/EMPTY_INPUT/);
	});
});

describe("authorization boundary", () => {
	it("submitChannel: admin allowed, subscribed non-admin and anon rejected", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "gate-admin");
		const operator = await asSubscribedOperator(t, "gate-op");

		await expect(
			admin.mutation(api.submissions.submitChannel, {
				rawInput: ucId("ok"),
			}),
		).resolves.toBeDefined();
		await expect(
			operator.mutation(api.submissions.submitChannel, {
				rawInput: ucId("no"),
			}),
		).rejects.toThrow(/ADMIN_REQUIRED/);
		await expect(
			t.mutation(api.submissions.submitChannel, { rawInput: ucId("no") }),
		).rejects.toThrow(/UNAUTHENTICATED/);
	});

	it("listSubmissions: admin allowed, subscribed non-admin and anon rejected", async () => {
		const t = createGatedTest();
		const admin = await asAdmin(t, "gate-admin-2");
		const operator = await asSubscribedOperator(t, "gate-op-2");

		await expect(
			admin.query(api.submissions.listSubmissions, {}),
		).resolves.toEqual([]);
		await expect(
			operator.query(api.submissions.listSubmissions, {}),
		).rejects.toThrow(/ADMIN_REQUIRED/);
		await expect(t.query(api.submissions.listSubmissions, {})).rejects.toThrow(
			/UNAUTHENTICATED/,
		);
	});
});
