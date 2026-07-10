/**
 * Admin Channel Submissions (ADR-0005) — the sole way a Channel now enters the
 * Feed. An Admin pastes a channel reference — a raw `UC…` id, a `/channel/` or
 * `/@handle` URL, or a bare `@handle`; `submitChannel` records a `pending`
 * Submission and returns immediately, scheduling a background worker that resolves
 * the paste (`resolveChannelRef`, plus a live handle lookup when needed), backfills
 * the channel's recent uploads through the shared write path (`upsertDiscovered`),
 * and writes the outcome back onto the row.
 *
 * The boundary mirrors ingest.ts: the humble YouTube adapter (`model/youtube.ts`)
 * is the network seam, `runSubmission` is the tested orchestration (driven with a
 * stub adapter, no network), and the mutations it calls are the DB seam. The
 * `submissionWorker` internalAction wires the live adapter from env.
 *
 * `pending → processing → tracked | failed`. A channel that ingests but misses
 * the lifecycle rules is still `tracked`, never `failed`; `failed` is reserved
 * for an unresolvable paste or an API error (CONTEXT.md: Submission).
 */

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import {
	internalAction,
	internalMutation,
	mutation,
	query,
} from "./_generated/server";
import { requireAdmin } from "./admin";
import { liveYouTubeAdapter } from "./ingest";
import {
	deriveChannelLifecycle,
	lifecycleVideoFromStoredVideo,
} from "./model/channelLifecycle";
import { resolveChannelRef } from "./model/submissions";
import type { SubmissionOutcome, SubmissionStatus } from "./model/validators";
import type { YouTubeAdapter } from "./model/youtube";

/** Uploads a single Submission backfills: up to the latest 50 Shorts, giving the
 * lifecycle enough current short-form data to classify Established channels. */
const SUBMISSION_UPLOAD_LIMIT = 50;

/** Submissions returned to the live admin table, newest-first. Tunable. */
const SUBMISSION_LIST_LIMIT = 50;

/** The failure reason for any adapter throw during resolution/backfill — a
 * network/quota hiccup, retryable by re-pasting (CONTEXT.md: Submission). Shared
 * so the handle-lookup and metadata-fetch catch branches can't drift. */
const API_ERROR_REASON = "YouTube API error — try again.";

/** A row of the live Submissions table — the Submission plus its outcome. */
export type SubmissionRow = {
	_id: Id<"submissions">;
	_creationTime: number;
	rawInput: string;
	status: SubmissionStatus;
	resolvedYtChannelId: string | null;
	channelId: Id<"channels"> | null;
	outcome: SubmissionOutcome | null;
	failureReason: string | null;
};

/**
 * Whether a Submission for `ytChannelId` is already in flight (`pending` or
 * `processing`) — the guard that stops a duplicate Refresh from racing an
 * in-progress one. Derives from existing fields rather than a dedicated index
 * (ADR-0007): an in-flight refresh carries the canonical id as its `rawInput`
 * before it resolves, and a processing row that already resolved carries it as
 * `resolvedYtChannelId`, so matching either catches both. The Submissions set an
 * Admin curates is small enough to scan.
 */
async function hasInFlightSubmissionFor(
	ctx: QueryCtx,
	ytChannelId: string,
): Promise<boolean> {
	const inFlight = await ctx.db
		.query("submissions")
		.filter((q) =>
			q.or(
				q.eq(q.field("status"), "pending"),
				q.eq(q.field("status"), "processing"),
			),
		)
		.collect();
	return inFlight.some(
		(row) =>
			row.resolvedYtChannelId === ytChannelId || row.rawInput === ytChannelId,
	);
}

// --- Admin-facing mutation & query ---------------------------------------------

/**
 * Accept a pasted channel and start ingesting it in the background. Admin-gated;
 * validates that the paste isn't blank, inserts a `pending` Submission, and
 * schedules the worker with `runAfter(0, …)` so the request returns instantly —
 * the Admin never waits on YouTube. Returns the new Submission id.
 */
export const submitChannel = mutation({
	args: { rawInput: v.string() },
	handler: async (ctx, { rawInput }): Promise<Id<"submissions">> => {
		const admin = await requireAdmin(ctx);
		const trimmed = rawInput.trim();
		if (trimmed.length === 0) {
			throw new ConvexError("EMPTY_INPUT");
		}
		const submissionId = await ctx.db.insert("submissions", {
			rawInput: trimmed,
			submittedBy: admin._id,
			status: "pending",
		});
		await ctx.scheduler.runAfter(0, internal.submissions.submissionWorker, {
			submissionId,
		});
		return submissionId;
	},
});

/** Recent Submissions, newest-first, for the live admin table. Admin-gated.
 * Reads off `_creationTime` (default order) — no per-admin scoping: the Feed is a
 * shared, curated surface, so every admin sees the whole submission history. */
export const listSubmissions = query({
	args: {},
	handler: async (ctx): Promise<SubmissionRow[]> => {
		await requireAdmin(ctx);
		const rows = await ctx.db
			.query("submissions")
			.order("desc")
			.take(SUBMISSION_LIST_LIMIT);
		return rows.map((row) => ({
			_id: row._id,
			_creationTime: row._creationTime,
			rawInput: row.rawInput,
			status: row.status,
			resolvedYtChannelId: row.resolvedYtChannelId ?? null,
			channelId: row.channelId ?? null,
			outcome: row.outcome ?? null,
			failureReason: row.failureReason ?? null,
		}));
	},
});

/**
 * Re-run a `failed` Submission with one click — a transient API error shouldn't
 * force the Admin to re-paste. Admin-gated; resets the row to `pending`, clears
 * the stale failure reason, and re-schedules the worker over the same paste. Only
 * `failed` Submissions are retryable (a `pending`/`processing` one is already in
 * flight, a `tracked` one uses re-submission to refresh); anything else is
 * `NOT_RETRYABLE`. No automatic retry/backoff — this is manual only (ADR-0005).
 */
export const retrySubmission = mutation({
	args: { submissionId: v.id("submissions") },
	handler: async (ctx, { submissionId }): Promise<null> => {
		await requireAdmin(ctx);
		const submission = await ctx.db.get("submissions", submissionId);
		if (submission === null) {
			throw new ConvexError("SUBMISSION_NOT_FOUND");
		}
		if (submission.status !== "failed") {
			throw new ConvexError("NOT_RETRYABLE");
		}
		await ctx.db.patch("submissions", submissionId, {
			status: "pending",
			failureReason: undefined,
		});
		await ctx.scheduler.runAfter(0, internal.submissions.submissionWorker, {
			submissionId,
		});
		return null;
	},
});

/**
 * Refresh a `tracked` Channel by starting a fresh Submission for it — the
 * deliberate way to re-pull a known Channel's stats without re-pasting its URL
 * (ADR-0007). Admin-gated; creates a new `pending` Submission whose `rawInput`
 * is the row's canonical `resolvedYtChannelId` (so handle changes or the
 * original paste format can't affect the refresh) and schedules the worker over
 * it, returning the new Submission id. Each refresh gets its own outcome
 * history — unlike Retry, it never mutates the existing row.
 *
 * Only `tracked` rows with a resolved id can refresh (`NOT_REFRESHABLE`
 * otherwise), and a refresh is rejected while another Submission for the same
 * resolved channel id is already `pending`/`processing` (`REFRESH_IN_FLIGHT`),
 * so duplicate in-flight refreshes can't race.
 */
export const refreshSubmission = mutation({
	args: { submissionId: v.id("submissions") },
	handler: async (ctx, { submissionId }): Promise<Id<"submissions">> => {
		const admin = await requireAdmin(ctx);
		const submission = await ctx.db.get("submissions", submissionId);
		if (submission === null) {
			throw new ConvexError("SUBMISSION_NOT_FOUND");
		}
		const resolvedYtChannelId = submission.resolvedYtChannelId;
		if (submission.status !== "tracked" || !resolvedYtChannelId) {
			throw new ConvexError("NOT_REFRESHABLE");
		}
		if (await hasInFlightSubmissionFor(ctx, resolvedYtChannelId)) {
			throw new ConvexError("REFRESH_IN_FLIGHT");
		}
		const newSubmissionId = await ctx.db.insert("submissions", {
			rawInput: resolvedYtChannelId,
			submittedBy: admin._id,
			status: "pending",
		});
		await ctx.scheduler.runAfter(0, internal.submissions.submissionWorker, {
			submissionId: newSubmissionId,
		});
		return newSubmissionId;
	},
});

// --- Internal mutations & query (the DB seam the worker drives) -----------------

/** Mark a Submission `processing` and hand its raw paste to the worker in one
 * round trip. */
export const beginSubmission = internalMutation({
	args: { submissionId: v.id("submissions") },
	handler: async (ctx, { submissionId }): Promise<{ rawInput: string }> => {
		const submission = await ctx.db.get("submissions", submissionId);
		if (submission === null) {
			throw new ConvexError("SUBMISSION_NOT_FOUND");
		}
		await ctx.db.patch("submissions", submissionId, { status: "processing" });
		return { rawInput: submission.rawInput };
	},
});

/**
 * Finish a Submission as `tracked`: derive the current short-form Channel
 * lifecycle evidence and stamp the resolved id / channel / outcome. Missing a
 * visible lifecycle stage still lands here — the channel remains tracked.
 *
 * When the tracked Channel is Feed-visible, schedule a separate immediate
 * single-Channel Enrichment follow-up for that Channel only (ADR-0007). Hidden
 * Tracked Channels get no follow-up — scoring off-Feed Channels would be wasted
 * Anthropic budget. Enrichment runs after this write and independently: its
 * success or failure never changes the `tracked` status recorded here.
 */
export const completeSubmission = internalMutation({
	args: {
		submissionId: v.id("submissions"),
		ytChannelId: v.string(),
	},
	handler: async (ctx, { submissionId, ytChannelId }): Promise<null> => {
		const channel = await ctx.db
			.query("channels")
			.withIndex("by_ytId", (q) => q.eq("ytId", ytChannelId))
			.unique();
		if (channel === null) {
			// The write path just upserted it, so this is unreachable in practice; be
			// defensive rather than throw and strand the Submission in `processing`.
			await ctx.db.patch("submissions", submissionId, {
				status: "failed",
				failureReason: "Channel vanished after ingest.",
			});
			return null;
		}
		const videos = await ctx.db
			.query("videos")
			.withIndex("by_channel_and_publishedAt", (q) =>
				q.eq("channelId", channel._id),
			)
			.order("desc")
			.take(SUBMISSION_UPLOAD_LIMIT);
		const lifecycle = deriveChannelLifecycle({
			subscriberCount: channel.subscriberCount ?? 0,
			videos: videos.map(lifecycleVideoFromStoredVideo),
			now: Date.now(),
		});
		await ctx.db.patch("submissions", submissionId, {
			status: "tracked",
			resolvedYtChannelId: ytChannelId,
			channelId: channel._id,
			outcome: {
				stage: lifecycle.stage,
				feedVisibility: lifecycle.feedVisibility,
				fetchedShorts: lifecycle.evidence.fetchedShorts,
				recentShortsChecked: lifecycle.evidence.recentShortsChecked,
				shortsAtOrAbove50k: lifecycle.evidence.shortsAtOrAbove50k,
				shortsAtOrAbove100k: lifecycle.evidence.shortsAtOrAbove100k,
			},
			failureReason: undefined,
		});
		if (lifecycle.feedVisibility === "visible") {
			await ctx.scheduler.runAfter(
				0,
				internal.enrichChannel.enrichChannelWorker,
				{ channelId: channel._id },
			);
		}
		return null;
	},
});

/** Mark a Submission `failed` with a human-readable reason — an unresolvable
 * paste or an API error (both retryable by re-pasting). */
export const failSubmission = internalMutation({
	args: { submissionId: v.id("submissions"), reason: v.string() },
	handler: async (ctx, { submissionId, reason }): Promise<null> => {
		await ctx.db.patch("submissions", submissionId, {
			status: "failed",
			failureReason: reason,
		});
		return null;
	},
});

// --- Orchestration (plain helper, tested with a stub adapter) -------------------

/**
 * Backfill one Submission end-to-end: resolve its paste → fetch channel metadata
 * + recent uploads → upsert them through the shared write path (stamping
 * `source: "admin"`) → summarize the Channel lifecycle outcome. An unresolvable
 * paste or a missing channel `fail`s with a clear reason; an adapter throw (API
 * error) `fail`s too — everything that actually ingested is `tracked`. Idempotent
 * per channel: re-running refreshes rather than duplicates.
 */
export async function runSubmission(
	ctx: ActionCtx,
	adapter: YouTubeAdapter,
	submissionId: Id<"submissions">,
): Promise<void> {
	const { rawInput } = await ctx.runMutation(
		internal.submissions.beginSubmission,
		{ submissionId },
	);

	// Normalize the paste (pure): a raw id / `/channel/` URL yields an id straight
	// away; a bare/URL `@handle` yields a handle that still needs a live lookup;
	// anything out of scope (video URLs, legacy `/c/` `/user/`, garbage) is an
	// error whose reason we record verbatim on the failed Submission.
	const ref = resolveChannelRef(rawInput);
	if (ref.kind === "error") {
		await ctx.runMutation(internal.submissions.failSubmission, {
			submissionId,
			reason: ref.reason,
		});
		return;
	}

	let ytChannelId: string;
	if (ref.kind === "id") {
		ytChannelId = ref.id;
	} else {
		// A handle only names the channel — resolve it to an id behind the adapter.
		// A throw is a retryable API error; a `null` means no channel owns the handle.
		let resolved: string | null;
		try {
			resolved = await adapter.resolveHandle(ref.handle);
		} catch {
			await ctx.runMutation(internal.submissions.failSubmission, {
				submissionId,
				reason: API_ERROR_REASON,
			});
			return;
		}
		if (resolved === null) {
			await ctx.runMutation(internal.submissions.failSubmission, {
				submissionId,
				reason: `Couldn't resolve the handle ${ref.handle} to a channel.`,
			});
			return;
		}
		ytChannelId = resolved;
	}

	// Only the adapter calls are guarded: a humble adapter surfaces network/quota
	// failures as throws, and the paste was valid, so a throw here is a retryable
	// API error — never an unresolvable input. DB failures in the write path below
	// are left to propagate rather than be mislabeled as an API error. The metadata
	// fetch is one small `channels.list` unit on top of the ~2-unit uploads backfill
	// (playlist page + hydration) — `fetchChannelUploads` carries no channel identity.
	let channel: Awaited<ReturnType<YouTubeAdapter["fetchChannels"]>>[number];
	let uploads: Awaited<ReturnType<YouTubeAdapter["fetchChannelUploads"]>>;
	try {
		const channels = await adapter.fetchChannels([ytChannelId]);
		const found = channels[0];
		if (found === undefined) {
			await ctx.runMutation(internal.submissions.failSubmission, {
				submissionId,
				reason: "No YouTube channel found for that id.",
			});
			return;
		}
		channel = found;
		uploads = await adapter.fetchChannelUploads(ytChannelId, {
			limit: SUBMISSION_UPLOAD_LIMIT,
		});
	} catch {
		await ctx.runMutation(internal.submissions.failSubmission, {
			submissionId,
			reason: API_ERROR_REASON,
		});
		return;
	}

	await ctx.runMutation(internal.ingest.upsertDiscovered, {
		channels: [channel],
		videos: uploads,
		source: "admin",
	});
	await ctx.runMutation(internal.submissions.completeSubmission, {
		submissionId,
		ytChannelId,
	});
}

// --- Worker entrypoint ---------------------------------------------------------

/** The scheduled worker `submitChannel` fires: wires the live adapter from env
 * and runs the Submission. Kept thin — all logic lives in `runSubmission`. */
export const submissionWorker = internalAction({
	args: { submissionId: v.id("submissions") },
	handler: async (ctx, { submissionId }): Promise<null> => {
		await runSubmission(ctx, liveYouTubeAdapter(), submissionId);
		return null;
	},
});
