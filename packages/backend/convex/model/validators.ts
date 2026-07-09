import { type Infer, v } from "convex/values";

/** Shared Convex validators for the discovery domain, kept in one place so the
 * schema and the functions that read/write it can't drift apart. */

export const formValidator = v.union(v.literal("short"), v.literal("long"));

export const stageValidator = v.union(
	v.literal("emerging"),
	v.literal("breaking_out"),
	v.literal("established"),
);

/** How a channel entered the Feed. `admin` is the sole live intake now that
 * automated discovery is gone (ADR-0005); `seed`/`trending`/`snowball` are
 * retained only for pre-cutover rows. */
export const sourceValidator = v.union(
	v.literal("seed"),
	v.literal("trending"),
	v.literal("snowball"),
	v.literal("admin"),
);

/** A Submission's lifecycle (ADR-0005/0006, CONTEXT.md): `pending` on insert,
 * `processing` while the worker backfills, then `tracked` (ingested, whether
 * visible on the Feed or not) or `failed` (unresolvable paste / API error). */
export const submissionStatusValidator = v.union(
	v.literal("pending"),
	v.literal("processing"),
	v.literal("tracked"),
	v.literal("failed"),
);

const legacySubmissionOutcomeValidator = v.object({
	listings: v.number(),
	proven: v.number(),
});

/** The machine outcome summary of a tracked Submission. New rows describe the
 * short-form Channel lifecycle; the legacy Listing/Proven shape remains readable
 * so pre-cutover rows don't invalidate the table before a cleanup migration. */
export const submissionOutcomeValidator = v.union(
	v.object({
		stage: v.union(stageValidator, v.literal("tracked")),
		feedVisibility: v.union(v.literal("visible"), v.literal("hidden")),
		fetchedShorts: v.number(),
		recentShortsChecked: v.number(),
		shortsAtOrAbove50k: v.number(),
		shortsAtOrAbove100k: v.number(),
	}),
	legacySubmissionOutcomeValidator,
);

/** Derived TS types so readers (queries, the admin table) share one source with
 * the schema and can't drift from these validators. */
export type SubmissionStatus = Infer<typeof submissionStatusValidator>;
export type SubmissionOutcome = Infer<typeof submissionOutcomeValidator>;

/** One AI-derived Clonability signal: a 0–100 score plus a one-line rationale. */
export const signalValidator = v.object({
	score: v.number(),
	rationale: v.string(),
});

/** Enrichment output keyed by signal name (form-specific sets), or null until
 * the AI pass runs. ADR-0003: these never gate — they only score. */
export const signalsValidator = v.record(v.string(), signalValidator);
