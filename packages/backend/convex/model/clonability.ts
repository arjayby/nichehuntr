/**
 * Pure channel Clonability logic (ADR-0003, ADR-0006).
 *
 * Clonability is an overall 0–100 score for how attractive a short-form Channel
 * is as a *clone target*, synthesized from per-signal {score, rationale} pairs
 * the Enrichment pass produces (CONTEXT.md: Clonability). It is a tunable
 * weighted mean of Automatable, Transformative, and Improvable, and it never
 * gates: visible Channels can render before any signal is scored, so every
 * function here degrades to `null`/empty rather than throwing when signals are
 * missing.
 *
 * This module is deliberately dependency-free (no Anthropic SDK): it is the tested
 * seam, and both the pure deriver and the frontend card import from it. The wire
 * call to Claude lives behind the humble adapter in `enrichment.ts`.
 */

/** One AI-derived signal: a 0–100 score plus a one-line rationale (CONTEXT.md). */
export type Signal = { score: number; rationale: string };

/** Enrichment output for a Channel, keyed by signal name. */
export type Signals = Record<string, Signal>;

/** The supported short-form Channel signals (CONTEXT.md: Clonability). */
export const CHANNEL_SIGNAL_NAMES = [
	"automatable",
	"transformative",
	"improvable",
] as const;

/**
 * The tunable weighted-mean weights (CONTEXT.md: "a tunable weighted mean …
 * starting near-equal but biasing Automatable highest for short-form").
 * Weights are relative — Clonability renormalizes over whichever signals are
 * actually present, so a Channel with only some signals scored still yields a
 * sensible mean. Automatable carries double the pull of its peers.
 */
export const CLONABILITY_WEIGHTS: Record<string, number> = {
	automatable: 2,
	transformative: 1,
	improvable: 1,
};

/** Human labels for each signal, for the card and the enrichment prompt. */
export const SIGNAL_LABELS: Record<string, string> = {
	automatable: "Automatable",
	transformative: "Transformative",
	improvable: "Improvable",
};

/**
 * One-line definitions handed to the model so each signal is scored on the same
 * axis the Operator cares about (CONTEXT.md). Kept here, next to the signal sets,
 * so the scoring rubric and the weighting can't drift apart.
 */
export const SIGNAL_DEFINITIONS: Record<string, string> = {
	automatable:
		"Can this be mass-produced from a repeatable template, cheaply (no specific on-camera talent, no expensive shoot), from an effectively infinite supply of source material? High = trivially templated and cheap to churn out.",
	transformative:
		"Does it repackage existing material (compilations, reactions, edits, AI remixes) rather than requiring original creation? High = mostly repackaging.",
	improvable:
		"Is there visible headroom to out-execute — lazy thumbnails, weak editing, shallow content — while the channel is still winning? High = easy to beat.",
};

/** Coerce a signal's score to a finite 0–100 number, or `null` if unusable — a
 * malformed score (NaN/∞/non-number) is dropped, never counted as a zero. */
function usableScore(signal: Signal | undefined): number | null {
	if (signal === undefined) {
		return null;
	}
	const { score } = signal;
	if (typeof score !== "number" || !Number.isFinite(score)) {
		return null;
	}
	return Math.max(0, Math.min(100, score));
}

/**
 * Clonability: the tunable weighted mean of short-form Channel signals, 0–100
 * (CONTEXT.md). Weights are renormalized over whichever signals are present.
 * Returns `null` when there is nothing to average, so Clonability never gates and
 * the card simply shows no score yet.
 */
export function computeClonability(signals: Signals | null): number | null {
	if (signals === null) {
		return null;
	}
	let weightedSum = 0;
	let weightTotal = 0;
	for (const [name, weight] of Object.entries(CLONABILITY_WEIGHTS)) {
		const score = usableScore(signals[name]);
		if (score === null) {
			continue; // missing/malformed — renormalize over the rest
		}
		weightedSum += weight * score;
		weightTotal += weight;
	}
	if (weightTotal === 0) {
		return null; // no scorable signals — leave Clonability unmeasured
	}
	return Math.round(weightedSum / weightTotal);
}

/** A signal projected for display: its name, human label, score, and rationale. */
export type RankedSignal = {
	name: string;
	label: string;
	score: number;
	rationale: string;
};

/**
 * The present Channel signals, highest score first — the card shows the top few
 * rationales beneath the Clonability number. Stray keys are ignored, and
 * malformed scores are dropped, mirroring the mean.
 */
export function topSignals(signals: Signals | null, limit = 2): RankedSignal[] {
	if (signals === null) {
		return [];
	}
	const ranked: RankedSignal[] = [];
	for (const name of CHANNEL_SIGNAL_NAMES) {
		const signal = signals[name];
		const score = usableScore(signal);
		if (signal === undefined || score === null) {
			continue;
		}
		ranked.push({
			name,
			label: SIGNAL_LABELS[name] ?? name,
			score,
			rationale: signal.rationale,
		});
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, limit);
}

// --- Enrichment input + material-change fingerprint ----------------------------

/** A recent upload the Enrichment pass shows the model (title + thumbnail). */
export type EnrichmentVideo = {
	ytId: string;
	title: string;
	thumbnailUrl?: string;
};

/**
 * Everything the multimodal Enrichment call needs for one Channel: metadata plus
 * a handful of recent standard Shorts (titles + thumbnails).
 */
export type EnrichmentInput = {
	channelTitle: string;
	channelDescription?: string;
	videos: EnrichmentVideo[];
};

/**
 * A Niche Query the Enrichment pass mints from a Channel's niche: a search phrase
 * plus whether it names the Channel's own niche (`seeded`) or an adjacent one
 * (`adjacent`). Internal Scout fuel (CONTEXT.md: Niche Query) — never rendered.
 * Kept as a plain literal union so this module stays dependency-free; the DB write
 * path narrows it to the `mintedNicheQueryOriginValidator` origin set.
 */
export type EnrichmentNicheQuery = {
	phrase: string;
	origin: "seeded" | "adjacent";
};

/**
 * What the multimodal Enrichment call returns for one Channel: the Clonability
 * signals plus the Niche Query phrases minted from its own and adjacent niches.
 * Bundling both means a single Claude call powers both Clonability scoring and the
 * Scout's query pool (ADR-0008).
 */
export type EnrichmentResult = {
	signals: Signals;
	nicheQueries: EnrichmentNicheQuery[];
};

/**
 * The seam the enrich action depends on. The real implementation makes a multimodal
 * Claude call (`enrichment.ts`); tests pass a stub so no network is hit — mirroring
 * the embeddings adapter.
 */
export type EnrichmentAdapter = {
	/** Score a short-form Channel and mint its Niche Queries from metadata +
	 * thumbnails, in one multimodal call. */
	enrich(input: EnrichmentInput): Promise<EnrichmentResult>;
};

/** NUL — it can't occur in channel metadata, so joining fingerprint fields with
 * it means distinct input sets can never collide by concatenation. Built via
 * `fromCharCode` to keep a raw control byte out of the source. */
const FINGERPRINT_SEPARATOR = String.fromCharCode(0);

/**
 * Version tag baked into every fingerprint. Bump this whenever the enrichment
 * output changes in a way that should invalidate cached scores even if a
 * Channel's inputs are byte-for-byte unchanged: a version change makes every
 * previously stored fingerprint mismatch, so channels re-enrich rather than skip
 * as unchanged. Bumped to `v2` when Enrichment began also minting Niche Queries
 * (ADR-0008), so the launch sweep re-runs already-enriched Channels and seeds the
 * pool from the existing Feed.
 */
export const ENRICHMENT_FINGERPRINT_VERSION = "v2";

/**
 * A deterministic fingerprint of a Channel's enrichment inputs, prefixed with the
 * output-version tag. The enrich follow-up re-runs a Channel only when this
 * changes (CONTEXT.md: "re-runs on material change") — so an edited title, a
 * swapped thumbnail, a new upload, or a version bump triggers a refresh, while an
 * unchanged Channel on the current version stays cached. Bounded because the
 * caller caps how many videos it folds in.
 */
export function buildEnrichmentFingerprint(input: EnrichmentInput): string {
	const parts = [
		ENRICHMENT_FINGERPRINT_VERSION,
		input.channelTitle.trim(),
		(input.channelDescription ?? "").trim(),
		...input.videos.map(
			(video) =>
				`${video.ytId}|${video.title.trim()}|${video.thumbnailUrl ?? ""}`,
		),
	];
	return parts.join(FINGERPRINT_SEPARATOR);
}
