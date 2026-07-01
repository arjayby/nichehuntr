/**
 * Pure domain logic for deriving Listings from a channel's videos.
 *
 * A Listing is a (Channel, Form) pair (ADR-0002): a channel's videos are
 * partitioned by duration and gated per form, so a channel that qualifies in
 * both forms yields two Listings. This module holds the Slice-1 rules only —
 * form classification and the objective Proven gate. Stage, Momentum,
 * Saturation, and Clonability are placeholders here and are filled in by later
 * slices; keeping this function pure (plain data in, Listing(s) out) makes it
 * the project's primary test seam.
 */

/** A content form. A video/listing is either short-form or long-form. */
export type Form = "short" | "long";

/** A listing's position in the momentum lifecycle (CONTEXT.md: Stage). */
export type Stage = "emerging" | "breaking_out" | "established";

/** Videos at or below this duration are short-form (ADR-0002: ~3 minutes). */
export const SHORT_FORM_MAX_SEC = 180;

/** How many of a channel's most recent settled uploads the gate considers. */
export const PROVEN_WINDOW = 12;

/** Uploads younger than this are too fresh to have "settled" and are excluded. */
export const SETTLED_MIN_AGE_DAYS = 7;

/**
 * Minimum settled, standard uploads a form needs before it can produce a
 * Listing at all. Guards against a stray cross-form upload spawning a flimsy
 * one-video Listing, keeping "consistent" meaningful. Tunable.
 */
export const MIN_SETTLED_VIDEOS = 3;

/**
 * Form-specific median-views floor for the Proven gate. A Short hitting 100k is
 * near-trivial, so short-form demands a higher bar (CONTEXT.md: Proven). Tunable.
 */
export const PROVEN_THRESHOLD: Record<Form, number> = {
	long: 100_000,
	short: 500_000,
};

/**
 * Stage assigned in Slice 1. Momentum/Saturation are not computed yet, so every
 * Proven listing lands in a single placeholder column until the Stage engine
 * exists. A freshly surfaced, freshly proven listing with unknown momentum is
 * provisionally treated as Emerging.
 */
export const PLACEHOLDER_STAGE: Stage = "emerging";

const DAY_MS = 24 * 60 * 60 * 1000;
const FORMS: readonly Form[] = ["short", "long"];

/** Classify a single video into a Form by its duration. */
export function classifyForm(durationSec: number): Form {
	return durationSec <= SHORT_FORM_MAX_SEC ? "short" : "long";
}

/**
 * The subset of a video's data the derivation needs. `viewCount` is the video's
 * current view count (resolved from its latest snapshot by the caller);
 * `isStandard` is false for non-standard items such as live streams/premieres.
 */
export type ProvenVideo = {
	durationSec: number;
	viewCount: number;
	/** Upload time, ms since epoch. */
	publishedAt: number;
	isStandard: boolean;
};

export type DeriveListingsInput<Cid> = {
	channelId: Cid;
	videos: ProvenVideo[];
	/** Reference "now", ms since epoch — injected so the gate is deterministic. */
	now: number;
};

/** The reactive read-model row produced per (channel, form). */
export type DerivedListing<Cid> = {
	channelId: Cid;
	form: Form;
	proven: boolean;
	medianViews: number;
	baseline: number | null;
	momentum: number | null;
	saturation: number | null;
	stage: Stage;
	clonability: number | null;
	signals: null;
};

/** Median of a non-empty list of numbers (average of the two middles if even). */
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid] as number;
	}
	return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Derive a channel's Listings — one per form that has enough settled, standard
 * uploads to evaluate. Each carries a `proven` verdict; the Feed shows only the
 * proven ones. Slice 1: form classification + Proven gate only.
 */
export function deriveListings<Cid>(
	input: DeriveListingsInput<Cid>,
): DerivedListing<Cid>[] {
	const settledCutoff = input.now - SETTLED_MIN_AGE_DAYS * DAY_MS;
	const eligible = input.videos.filter(
		(vid) => vid.isStandard && vid.publishedAt <= settledCutoff,
	);

	const listings: DerivedListing<Cid>[] = [];
	for (const form of FORMS) {
		const forForm = eligible
			.filter((vid) => classifyForm(vid.durationSec) === form)
			.sort((a, b) => b.publishedAt - a.publishedAt);

		if (forForm.length < MIN_SETTLED_VIDEOS) {
			continue;
		}

		const window = forForm.slice(0, PROVEN_WINDOW);
		const medianViews = median(window.map((vid) => vid.viewCount));

		listings.push({
			channelId: input.channelId,
			form,
			proven: medianViews >= PROVEN_THRESHOLD[form],
			medianViews,
			baseline: null,
			momentum: null,
			saturation: null,
			stage: PLACEHOLDER_STAGE,
			clonability: null,
			signals: null,
		});
	}

	return listings;
}
