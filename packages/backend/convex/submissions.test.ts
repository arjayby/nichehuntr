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
const LONG_SEC = 600; // > 180s ⇒ long-form; long Proven threshold is 100k.
const SHORT_SEC = 30; // ≤ 180s ⇒ short-form; short Proven threshold is 500k.

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
	page: ChannelUpload[];
	channelMissing?: boolean;
	uploadsThrow?: boolean;
	resolveHandleTo?: string | null;
	handleThrows?: boolean;
}): YouTubeAdapter {
	return {
		fetchChannels: async (ids) =>
			opts.channelMissing
				? []
				: ids.map((id) => ({
						ytChannelId: id,
						title: opts.title ?? `${id} title`,
						handle: `@${id}`,
					})),
		fetchVideoStats: async (ids) =>
			ids.map((id) => ({ ytVideoId: id, viewCount: 0 })),
		fetchChannelUploads: async (channelId) => {
			if (opts.uploadsThrow) {
				throw new Error("YouTube API error");
			}
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
		fetchVideoStats: boom,
		fetchChannelUploads: boom,
		resolveHandle: boom,
	};
}

/** Titles of every card the feed returned, across all columns. */
function titles(
	groups: { cards: { channel: { title: string } }[] }[],
): string[] {
	return groups.flatMap((g) => g.cards).map((c) => c.channel.title);
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

describe("runSubmission — the ingest spine", () => {
	it("tracks a proven channel and surfaces it as a Feed card", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("proven");
		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Proven Channel",
				page: uploads(id, {
					count: 5,
					viewCount: 150_000,
					ageDays: 60,
					durationSec: LONG_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { listings: 1, proven: 1 },
		});

		const longTitles = titles(
			await operator.query(api.feed.feed, { form: "long" }),
		);
		expect(longTitles).toContain("Proven Channel");
	});

	it("stamps submitted channels with source 'admin'", async () => {
		const { t } = await setup();
		const id = ucId("source");
		await runOver(
			t,
			id,
			stubAdapter({
				page: uploads(id, {
					count: 5,
					viewCount: 150_000,
					ageDays: 60,
					durationSec: LONG_SEC,
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

	it("yields two Listings for a channel proven in both forms", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("both");
		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Both Forms",
				page: [
					...uploads(id, {
						count: 5,
						viewCount: 150_000,
						ageDays: 60,
						durationSec: LONG_SEC,
						tag: "long",
					}),
					...uploads(id, {
						count: 5,
						viewCount: 600_000,
						ageDays: 60,
						durationSec: SHORT_SEC,
						tag: "short",
					}),
				],
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row?.outcome).toEqual({ listings: 2, proven: 2 });
		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).toContain("Both Forms");
		expect(
			titles(await operator.query(api.feed.feed, { form: "short" })),
		).toContain("Both Forms");
	});

	it("tracks (not fails) a channel that ingests but misses the Proven gate", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("weak");
		const submissionId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Weak Channel",
				page: uploads(id, {
					count: 5,
					viewCount: 40_000, // below the 100k long threshold
					ageDays: 60,
					durationSec: LONG_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			outcome: { listings: 1, proven: 0 },
		});
		expect(row?.failureReason).toBeNull();

		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).not.toContain("Weak Channel");
	});

	it("tracks a proven channel pasted as a /channel/ URL", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("urlchan");
		const submissionId = await runOver(
			t,
			`https://www.youtube.com/channel/${id}`,
			stubAdapter({
				title: "URL Channel",
				page: uploads(id, {
					count: 5,
					viewCount: 150_000,
					ageDays: 60,
					durationSec: LONG_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { listings: 1, proven: 1 },
		});
		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).toContain("URL Channel");
	});

	it.each([
		["a bare @handle", "@mrbeast"],
		["an @handle URL", "https://youtube.com/@mrbeast"],
	])("resolves %s to its id and tracks the channel", async (_label, paste) => {
		const { t, admin, operator } = await setup();
		const id = ucId("handle");
		const submissionId = await runOver(
			t,
			paste,
			stubAdapter({
				title: "Handle Channel",
				resolveHandleTo: id, // the live lookup maps @mrbeast → this id
				page: uploads(id, {
					count: 5,
					viewCount: 150_000,
					ageDays: 60,
					durationSec: LONG_SEC,
				}),
			}),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { listings: 1, proven: 1 },
		});
		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).toContain("Handle Channel");
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
			count: 5,
			viewCount: 150_000,
			ageDays: 60,
			durationSec: LONG_SEC,
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
		}));
		expect(counts).toEqual({ channels: 1, videos: 5, listings: 1 });

		const row = await submissionRow(admin, secondId);
		expect(row?.status).toBe("tracked");
	});

	it("re-submitting a tracked channel refreshes it — fresh data, no duplicate", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("restale");

		// First submission: the channel ingests but its uploads miss the Proven
		// gate, so it's tracked with no Listing and absent from the Feed.
		const firstId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Refreshable",
				page: uploads(id, {
					count: 5,
					viewCount: 40_000, // below the 100k long threshold
					ageDays: 60,
					durationSec: LONG_SEC,
				}),
			}),
		);
		expect((await submissionRow(admin, firstId))?.outcome).toEqual({
			listings: 1,
			proven: 0,
		});
		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).not.toContain("Refreshable");

		// Re-submit the same channel, now proven. The shared write path patches in
		// place by ytId, recording fresh snapshots and recomputing Listings — the
		// channel now clears the gate and appears in the Feed.
		const secondId = await runOver(
			t,
			id,
			stubAdapter({
				title: "Refreshable",
				page: uploads(id, {
					count: 5,
					viewCount: 150_000, // now clears the long threshold
					ageDays: 60,
					durationSec: LONG_SEC,
				}),
			}),
		);

		expect(await submissionRow(admin, secondId)).toMatchObject({
			status: "tracked",
			resolvedYtChannelId: id,
			outcome: { listings: 1, proven: 1 },
		});
		// Refreshed in place — one Channel, 5 videos, but two snapshots per video
		// (one per run), proving fresh snapshots were recorded rather than replaced.
		const counts = await t.run(async (ctx) => ({
			channels: (await ctx.db.query("channels").collect()).length,
			videos: (await ctx.db.query("videos").collect()).length,
			listings: (await ctx.db.query("listings").collect()).length,
			snapshots: (await ctx.db.query("videoSnapshots").collect()).length,
		}));
		expect(counts).toEqual({
			channels: 1,
			videos: 5,
			listings: 1,
			snapshots: 10,
		});
		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).toContain("Refreshable");
	});

	it("moves a failed Submission forward when the worker is re-run", async () => {
		const { t, admin, operator } = await setup();
		const id = ucId("retryok");
		const page = uploads(id, {
			count: 5,
			viewCount: 150_000,
			ageDays: 60,
			durationSec: LONG_SEC,
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

		// Re-running the worker over the same row (what retry schedules) with the
		// API now healthy tracks it and surfaces the Feed card — no re-paste needed.
		await t.action((ctx) =>
			runSubmission(ctx, stubAdapter({ title: "Retried", page }), submissionId),
		);

		const row = await submissionRow(admin, submissionId);
		expect(row).toMatchObject({
			status: "tracked",
			outcome: { listings: 1, proven: 1 },
		});
		expect(row?.failureReason).toBeNull();
		expect(
			titles(await operator.query(api.feed.feed, { form: "long" })),
		).toContain("Retried");
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
				outcome: { listings: 1, proven: 1 },
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
