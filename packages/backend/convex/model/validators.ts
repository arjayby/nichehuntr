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

/** Which front door a Submission came through (CONTEXT.md: Submission, ADR-0008):
 * an `admin` paste (the manual-boost path) or the automated `scout`. Distinct
 * from `sourceValidator`, which records how a *Channel* was discovered. Kept as a
 * closed set so a new front door is a deliberate schema change. */
export const submissionSourceValidator = v.union(
	v.literal("admin"),
	v.literal("scout"),
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
export type SubmissionSource = Infer<typeof submissionSourceValidator>;

/** Where a Niche Query phrase came from (CONTEXT.md: Niche Query, ADR-0008).
 * `seeded` names a visible Channel's own niche and `adjacent` a neighboring one —
 * both minted by Enrichment. `wildcat` is the Scout's unseeded exploration call
 * (a later slice mints those). Closed set so a new origin is a deliberate schema
 * change. */
export const nicheQueryOriginValidator = v.union(
	v.literal("seeded"),
	v.literal("adjacent"),
	v.literal("wildcat"),
);

/** The subset of origins the Enrichment pass can mint: a Channel's own niche
 * (`seeded`) and adjacent niches (`adjacent`). `wildcat` comes from the Scout, not
 * enrichment, so the enrichment write path can never stamp it. */
export const mintedNicheQueryOriginValidator = v.union(
	v.literal("seeded"),
	v.literal("adjacent"),
);

/** One phrase the Enrichment pass mints into the Scout's pool: the search text
 * plus the origin it was discovered through (own niche or adjacent). Kept next to
 * the origin validators so the enrichment write path and the schema share one
 * source for the shape. */
export const mintedNicheQueryValidator = v.object({
	phrase: v.string(),
	origin: mintedNicheQueryOriginValidator,
});

export type NicheQueryOrigin = Infer<typeof nicheQueryOriginValidator>;
export type MintedNicheQueryOrigin = Infer<
	typeof mintedNicheQueryOriginValidator
>;
export type MintedNicheQuery = Infer<typeof mintedNicheQueryValidator>;

/** One AI-derived Clonability signal: a 0–100 score plus a one-line rationale. */
export const signalValidator = v.object({
	score: v.number(),
	rationale: v.string(),
});

/** Enrichment output keyed by signal name (form-specific sets), or null until
 * the AI pass runs. ADR-0003: these never gate — they only score. */
export const signalsValidator = v.record(v.string(), signalValidator);
