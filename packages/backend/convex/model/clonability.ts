/**
 * Pure Clonability logic (Slice 5, ADR-0003).
 *
 * Clonability is the subjective half of a Listing: an overall 0–100 score for how
 * attractive a channel is as a *clone target*, synthesized from per-signal
 * {score, rationale} pairs the Enrichment pass produces (CONTEXT.md: Clonability).
 * It is a **tunable weighted mean** of the form's applicable signals — short-form
 * biases Automatable highest; Improvable is shared across both forms — and it
 * **never gates** (ADR-0003): a Listing appears on the strength of the Proven gate
 * even before any signal is scored, so every function here degrades to `null`
 * rather than throwing when signals are missing.
 *
 * This module is deliberately dependency-free (no Anthropic SDK): it is the tested
 * seam, and both the pure deriver and the frontend card import from it. The wire
 * call to Claude lives behind the humble adapter in `enrichment.ts`.
 */

import type { Form } from "./deriveListings";

/** One AI-derived signal: a 0–100 score plus a one-line rationale (CONTEXT.md). */
export type Signal = { score: number; rationale: string };

/** Enrichment output for a Listing, keyed by signal name. */
export type Signals = Record<string, Signal>;

/**
 * The signals that apply to each form (CONTEXT.md: Clonability signal sets).
 * Short-form leans on cheap, templated, repackaged production; long-form on
 * monetization. Improvable — visible headroom to out-execute — applies to both.
 */
export const SIGNAL_SETS = {
	short: ["automatable", "transformative", "improvable"],
	long: ["enterprise_value", "improvable"],
} as const satisfies Record<Form, readonly string[]>;

/**
 * The tunable weighted-mean weights per form (CONTEXT.md: "a tunable weighted
 * mean … starting near-equal but biasing Automatable highest for short-form").
 * Weights are relative — Clonability renormalizes over whichever signals are
 * actually present, so a Listing with only some signals scored still yields a
 * sensible mean. Automatable carries double the pull of its short-form peers;
 * long-form weights its two signals evenly.
 */
export const CLONABILITY_WEIGHTS: Record<Form, Record<string, number>> = {
	short: { automatable: 2, transformative: 1, improvable: 1 },
	long: { enterprise_value: 1, improvable: 1 },
};

/** Human labels for each signal, for the card and the enrichment prompt. */
export const SIGNAL_LABELS: Record<string, string> = {
	automatable: "Automatable",
	transformative: "Transformative",
	improvable: "Improvable",
	enterprise_value: "Enterprise value",
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
	enterprise_value:
		"Does the niche pull high-CPM/RPM or B2B/enterprise monetization (finance, software, industry education, high-ticket) versus low-value broad entertainment? High = high monetization.",
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
 * Clonability: the tunable weighted mean of the form's applicable signals, 0–100
 * (CONTEXT.md). Weights are renormalized over whichever signals are present, so
 * the score **degrades gracefully** — a partially enriched Listing still gets a
 * mean over what it has. Returns `null` when there is nothing to average (signals
 * not yet computed, or none of the form's signals present), so Clonability never
 * gates and the card simply shows no score yet.
 */
export function computeClonability(
	signals: Signals | null,
	form: Form,
): number | null {
	if (signals === null) {
		return null;
	}
	let weightedSum = 0;
	let weightTotal = 0;
	for (const [name, weight] of Object.entries(CLONABILITY_WEIGHTS[form])) {
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
 * The form's present signals, highest score first — the card shows the top few
 * rationales beneath the Clonability number. Only the form's own signals count
 * (a stray key is ignored), and malformed scores are dropped, mirroring the mean.
 */
export function topSignals(
	signals: Signals | null,
	form: Form,
	limit = 2,
): RankedSignal[] {
	if (signals === null) {
		return [];
	}
	const ranked: RankedSignal[] = [];
	for (const name of SIGNAL_SETS[form]) {
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
 * Everything the multimodal Enrichment call needs for one Listing: the channel's
 * metadata plus a handful of the form's recent uploads (titles + thumbnails). The
 * signal set is chosen from `form`.
 */
export type EnrichmentInput = {
	form: Form;
	channelTitle: string;
	channelDescription?: string;
	videos: EnrichmentVideo[];
};

/**
 * The seam the enrich cron depends on. The real implementation makes a multimodal
 * Claude call (`enrichment.ts`); tests pass a stub so no network is hit — mirroring
 * the embeddings adapter.
 */
export type EnrichmentAdapter = {
	/** Score the form's signals for one Listing from its metadata + thumbnails. */
	enrich(input: EnrichmentInput): Promise<Signals>;
};

/** NUL — it can't occur in channel metadata, so joining fingerprint fields with
 * it means distinct input sets can never collide by concatenation. Built via
 * `fromCharCode` to keep a raw control byte out of the source. */
const FINGERPRINT_SEPARATOR = String.fromCharCode(0);

/**
 * A deterministic fingerprint of a Listing's enrichment inputs. The enrich cron
 * re-runs a Listing only when this changes (CONTEXT.md: "re-runs on material
 * change") — so an edited title, a swapped thumbnail, or a new upload triggers a
 * refresh, while an unchanged Listing stays cached. Bounded because the caller
 * caps how many videos it folds in.
 */
export function buildEnrichmentFingerprint(input: EnrichmentInput): string {
	const parts = [
		input.form,
		input.channelTitle.trim(),
		(input.channelDescription ?? "").trim(),
		...input.videos.map(
			(video) =>
				`${video.ytId}|${video.title.trim()}|${video.thumbnailUrl ?? ""}`,
		),
	];
	return parts.join(FINGERPRINT_SEPARATOR);
}
