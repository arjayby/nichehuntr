/**
 * Pure domain logic for deriving Listings from a channel's videos.
 *
 * A Listing is a (Channel, Form) pair (ADR-0002): a channel's videos are
 * partitioned by duration and gated per form, so a channel that qualifies in
 * both forms yields two Listings. Slices 1–4 live here: form classification and
 * the objective Proven gate (Slice 1), per-form Baseline, Momentum, and the
 * momentum-driven Stage (Slice 3), and the Saturation override (Slice 4) —
 * Saturation is passed in per-channel (measured by the embed cron) and dominates
 * Stage once a niche is crowded. Momentum is computed from the slope across a
 * video's Snapshots, seeded with a `views ÷ video-age` proxy while snapshots are
 * still sparse (ADR-0001) so cold-start columns are never blank. Clonability
 * remains a placeholder for a later slice. Keeping this function pure (plain data
 * in, Listing(s) out) makes it the project's primary test seam.
 */

import { computeClonability, type Signals } from "./clonability";

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
 * Momentum thresholds on the scale-free daily-growth rate `computeMomentum`
 * returns (the fraction of a video's Baseline reach the form adds per day). At or
 * above STRONG a listing is Breaking Out — clone now; at or above MODEST it is
 * still meaningfully accelerating and sits in Emerging; below MODEST its momentum
 * has flattened or cooled and it is Established. All tunable (CONTEXT.md).
 */
export const MOMENTUM_STRONG = 0.1; // +10%/day of baseline reach
export const MOMENTUM_MODEST = 0.02; // +2%/day of baseline reach

/**
 * Saturation bands over the similar-channel count (CONTEXT.md: Saturation). A
 * niche in the CROWDED band is treated as too full to clone — the band that
 * dominates Stage. WARM is the "starting to fill in" band, surfaced on the card
 * but not yet decisive. Both tunable.
 */
export const SATURATION_WARM = 3; // ≥ this many similar channels ⇒ warming up
export const SATURATION_CROWDED = 8; // ≥ this ⇒ crowded ⇒ Established (dominant)

/** A Saturation band for the card and the Stage override. */
export type SaturationLevel = "low" | "medium" | "high";

/**
 * Bucket a similar-channel count into a Saturation band. `high` is the crowded
 * band that dominates Stage regardless of Momentum (CONTEXT.md: a crowded niche
 * is Established even under strong momentum).
 */
export function saturationLevel(count: number): SaturationLevel {
	if (count >= SATURATION_CROWDED) {
		return "high";
	}
	if (count >= SATURATION_WARM) {
		return "medium";
	}
	return "low";
}

/**
 * Two snapshots closer together than this are treated as a single reading: the
 * snapshot cron samples only every few hours (crons.ts), so a sub-hour gap is
 * sampling noise whose slope would be dominated by rounding. Below it, velocity
 * falls back to the `views ÷ video-age` proxy. Tunable.
 */
export const MIN_SNAPSHOT_SPAN_MS = 60 * 60 * 1000; // 1 hour

const DAY_MS = 24 * 60 * 60 * 1000;
const FORMS: readonly Form[] = ["short", "long"];

/** Classify a single video into a Form by its duration. */
export function classifyForm(durationSec: number): Form {
	return durationSec <= SHORT_FORM_MAX_SEC ? "short" : "long";
}

/** A point-in-time view-count reading, the raw material for Momentum (ADR-0001). */
export type Snapshot = {
	viewCount: number;
	/** Reading time, ms since epoch. */
	at: number;
};

/**
 * The subset of a video's data the derivation needs. `viewCount` is the video's
 * current view count (resolved from its latest snapshot by the caller) and gates
 * via the median; `snapshots` are its recent readings, from which Momentum reads
 * a view-velocity slope. When fewer than two snapshots span a meaningful
 * interval, velocity falls back to the `views ÷ video-age` proxy, so `snapshots`
 * is optional. `isStandard` is false for non-standard items such as live
 * streams/premieres.
 */
export type ProvenVideo = {
	durationSec: number;
	viewCount: number;
	/** Upload time, ms since epoch. */
	publishedAt: number;
	isStandard: boolean;
	/** Recent view-count readings; order-independent (sorted by time internally). */
	snapshots?: Snapshot[];
};

export type DeriveListingsInput<Cid> = {
	channelId: Cid;
	videos: ProvenVideo[];
	/** Reference "now", ms since epoch — injected so the gate is deterministic. */
	now: number;
	/**
	 * The channel's Saturation: the count of similar tracked channels in its
	 * (implicit) niche — nearest-neighbor cluster size via vector search, or the
	 * snowball-graph density fallback (CONTEXT.md). Per-channel because the content
	 * embedding is per-channel, so it rides every form's Listing alike; `null` until
	 * measured, leaving Stage on the momentum axis.
	 */
	saturation?: number | null;
	/**
	 * Per-form Enrichment signals, from the enrich cron's cache (ADR-0003). Unlike
	 * Saturation these are per-(channel, form) — the signal set and the thumbnails
	 * differ by form — so they're keyed by form and ridden onto the matching
	 * Listing. Absent/`null` for a form leaves its Clonability unmeasured.
	 */
	enrichmentByForm?: Partial<Record<Form, Signals | null>>;
};

/** The reactive read-model row produced per (channel, form). */
export type DerivedListing<Cid> = {
	channelId: Cid;
	form: Form;
	proven: boolean;
	medianViews: number;
	baseline: number;
	momentum: number;
	saturation: number | null;
	stage: Stage;
	clonability: number | null;
	signals: Signals | null;
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
 * A video's current view velocity in views/day. Prefers the slope across its
 * recent snapshots when at least two span `MIN_SNAPSHOT_SPAN_MS`; otherwise
 * falls back to the `views ÷ video-age` lifetime-average proxy (ADR-0001) so a
 * freshly discovered video still gets a velocity before snapshots accumulate.
 * Clamped at zero — a view count that dips (e.g. a spam purge) reads as flat,
 * never negative.
 */
function viewVelocity(video: ProvenVideo, now: number): number {
	const snapshots = video.snapshots ?? [];
	if (snapshots.length >= 2) {
		const sorted = [...snapshots].sort((a, b) => a.at - b.at);
		const first = sorted[0] as Snapshot;
		const last = sorted[sorted.length - 1] as Snapshot;
		const spanMs = last.at - first.at;
		if (spanMs >= MIN_SNAPSHOT_SPAN_MS) {
			return Math.max(
				0,
				((last.viewCount - first.viewCount) / spanMs) * DAY_MS,
			);
		}
	}
	const ageDays = Math.max((now - video.publishedAt) / DAY_MS, 1);
	return Math.max(0, video.viewCount / ageDays);
}

/**
 * A listing's Momentum: the channel's recent per-video view velocity normalized
 * by its Baseline reach — the fraction of a typical video's lifetime views the
 * form is adding per day right now. Dividing by baseline makes it scale-free, so
 * one set of thresholds fits a 100k channel and a 5M channel alike (CONTEXT.md:
 * Momentum is relative to a channel's own baseline). Uses the median velocity
 * across the window so one runaway video can't dominate, mirroring the gate.
 */
function computeMomentum(
	window: ProvenVideo[],
	baseline: number,
	now: number,
): number {
	if (baseline <= 0) {
		return 0;
	}
	const velocities = window.map((video) => viewVelocity(video, now));
	return median(velocities) / baseline;
}

/**
 * Assign Stage from Momentum and Saturation, with **Saturation dominating**
 * (CONTEXT.md): a crowded niche is Established regardless of momentum — too late
 * to clone from either direction. Below the crowded band (or when saturation is
 * `null`, i.e. not measured yet) momentum decides: strong ⇒ Breaking Out,
 * modest-positive ⇒ Emerging, flat/declining ⇒ Established.
 */
export function stageFor(momentum: number, saturation: number | null): Stage {
	if (saturation !== null && saturationLevel(saturation) === "high") {
		return "established";
	}
	if (momentum >= MOMENTUM_STRONG) {
		return "breaking_out";
	}
	if (momentum >= MOMENTUM_MODEST) {
		return "emerging";
	}
	return "established";
}

/**
 * Derive a channel's Listings — one per form that has enough settled, standard
 * uploads to evaluate. Each carries a `proven` verdict (the Feed shows only the
 * proven ones), a Baseline, a Momentum computed from snapshots, and the Stage
 * that momentum places it in.
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
		// Baseline is the channel's own per-video reach norm (CONTEXT.md). Over this
		// window it coincides with the gate's median, but it plays a distinct role:
		// the scale that Momentum is measured against.
		const baseline = medianViews;
		const momentum = computeMomentum(window, baseline, input.now);
		// Saturation is per-channel (the embedding is per-channel), so both forms
		// share it; it dominates Stage once the niche is crowded.
		const saturation = input.saturation ?? null;
		// Enrichment signals ride on per form (ADR-0003: subjective, never gates).
		// Clonability is their tunable weighted mean, or null until they're scored —
		// so the Listing still renders on the Proven gate alone (graceful degradation).
		const signals = input.enrichmentByForm?.[form] ?? null;

		listings.push({
			channelId: input.channelId,
			form,
			proven: medianViews >= PROVEN_THRESHOLD[form],
			medianViews,
			baseline,
			momentum,
			saturation,
			stage: stageFor(momentum, saturation),
			clonability: computeClonability(signals, form),
			signals,
		});
	}

	return listings;
}
