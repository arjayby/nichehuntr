"use node";

/**
 * The humble multimodal Enrichment adapter (ADR-0003, ADR-0006).
 *
 * Produces the subjective Clonability signals: a single multimodal Claude call
 * over a channel's metadata, recent short-form titles, and recent thumbnail
 * images, returning a {score 0–100, rationale} per supported short-form signal (CONTEXT.md:
 * Enrichment). Like the YouTube and embeddings adapters this is a "humble object" —
 * it only maps the request/response and holds no policy. The tunable weighting
 * that turns these signals into Clonability lives in the pure `clonability.ts`, and
 * the single-Channel enrich action drives this behind the `EnrichmentAdapter` seam so tests run
 * against a stub and never hit the network. Transcripts are deliberately out of
 * scope — too costly for marginal gain on these judgments (CONTEXT.md).
 */

import Anthropic from "@anthropic-ai/sdk";

import {
	CHANNEL_SIGNAL_NAMES,
	type EnrichmentAdapter,
	type EnrichmentInput,
	type EnrichmentNicheQuery,
	type EnrichmentResult,
	SIGNAL_DEFINITIONS,
	SIGNAL_LABELS,
	type Signals,
} from "./clonability";

/**
 * The Enrichment model. Haiku is the cheapest multimodal tier — the right fit for
 * a humble, recurring per-Channel scoring pass over titles + thumbnails. Swap here
 * (or via `EnrichmentOptions.model`) to trade cost for sharper judgment.
 */
const DEFAULT_MODEL = "claude-haiku-4-5";

/** Bound on thumbnails sent per call — a few recent covers are enough to read
 * production quality, and each image costs tokens. */
const MAX_THUMBNAILS = 4;

/** Recent upload titles folded into the prompt as niche/format signal. */
const MAX_TITLES = 8;

/** Longest channel description folded into the prompt — bounds tokens. */
const MAX_DESCRIPTION_CHARS = 500;

/** A handful of short {score, rationale} objects plus a few query phrases need
 * little generation. */
const MAX_TOKENS = 1024;

/** How many own-niche (`seeded`) query phrases to ask the model for — the pool's
 * primary fuel (CONTEXT.md: Niche Query). Also caps how many we keep. */
const OWN_NICHE_QUERY_LIMIT = 3;

/** How many adjacent-niche (`adjacent`) query phrases to ask for and keep — the
 * outside-the-echo-chamber slice. */
const ADJACENT_NICHE_QUERY_LIMIT = 2;

const SYSTEM_PROMPT =
	"You assess a short-form YouTube channel as a *clone target*: how attractive it would be for an operator to build a new channel replicating its proven niche and format (not to buy it). Judge only Automatable, Transformative, and Improvable, grounded in the channel metadata, recent Shorts titles, and thumbnail images provided. You also propose YouTube search phrases that would surface other channels in the same and adjacent niches, to seed automated discovery. Be decisive and concise. Always report via the record_signals tool.";

export type EnrichmentOptions = {
	/** Override the model id (defaults to a cheap multimodal tier). */
	model?: string;
};

/**
 * JSON Schema for the record_signals tool: the per-signal {score, rationale}
 * objects plus the Niche Query phrase arrays (own-niche `seeded` and adjacent
 * `adjacent`). Score bounds live in the descriptions and are clamped downstream,
 * since strict structured schemas don't support numeric min/max; phrase counts
 * are likewise clamped downstream.
 */
function signalsSchema() {
	const properties: Record<string, unknown> = {};
	for (const name of CHANNEL_SIGNAL_NAMES) {
		properties[name] = {
			type: "object",
			properties: {
				score: {
					type: "number",
					description: `0–100. ${SIGNAL_DEFINITIONS[name]}`,
				},
				rationale: {
					type: "string",
					description: "One concise line justifying the score.",
				},
			},
			required: ["score", "rationale"],
			additionalProperties: false,
		};
	}
	properties.ownNicheQueries = {
		type: "array",
		items: { type: "string" },
		description: `${OWN_NICHE_QUERY_LIMIT} YouTube search phrases that would surface OTHER channels in THIS channel's own niche and format. Concrete and searchable (e.g. "ai horror shorts", "reddit story narration"), not abstract labels.`,
	};
	properties.adjacentNicheQueries = {
		type: "array",
		items: { type: "string" },
		description: `${ADJACENT_NICHE_QUERY_LIMIT} YouTube search phrases for ADJACENT niches an operator might also clone — neighboring content spaces, not identical to this channel's.`,
	};
	return {
		type: "object" as const,
		properties,
		required: [
			...CHANNEL_SIGNAL_NAMES,
			"ownNicheQueries",
			"adjacentNicheQueries",
		],
		additionalProperties: false,
	};
}

/**
 * The prompt text: channel metadata, recent titles, and the scoring rubric. The
 * thumbnails ride alongside as image blocks so the model can judge production
 * quality and improvability from the covers themselves.
 */
function buildUserText(input: EnrichmentInput): string {
	const lines = [`Channel: ${input.channelTitle}`];
	const description = input.channelDescription?.trim();
	if (description) {
		lines.push(`About: ${description.slice(0, MAX_DESCRIPTION_CHARS)}`);
	}
	const titles = input.videos
		.map((video) => video.title.trim())
		.filter(Boolean)
		.slice(0, MAX_TITLES);
	if (titles.length > 0) {
		lines.push(
			"Recent short-form uploads:",
			...titles.map((title) => `- ${title}`),
		);
	}
	lines.push(
		"",
		"Score each signal 0–100 (higher = more true of this channel), each with a one-line rationale:",
		...CHANNEL_SIGNAL_NAMES.map(
			(name) => `- ${SIGNAL_LABELS[name]}: ${SIGNAL_DEFINITIONS[name]}`,
		),
		"",
		`Also propose ${OWN_NICHE_QUERY_LIMIT} search phrases for this channel's own niche (ownNicheQueries) and ${ADJACENT_NICHE_QUERY_LIMIT} for adjacent niches (adjacentNicheQueries), as an operator would type them into YouTube search.`,
	);
	return lines.join("\n");
}

/**
 * Coerce a tool-call array field into cleaned Niche Query phrases with the given
 * origin: keep only non-empty strings, trim them, drop case-insensitive
 * duplicates within the array, and cap the count. Canonical normalization and
 * cross-Channel dedupe happen later in the DB write path (`mintNicheQuery`); this
 * just maps the model output into the typed shape.
 */
function collectNicheQueries(
	raw: unknown,
	origin: EnrichmentNicheQuery["origin"],
	limit: number,
): EnrichmentNicheQuery[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const queries: EnrichmentNicheQuery[] = [];
	for (const item of raw) {
		if (typeof item !== "string") {
			continue;
		}
		const phrase = item.trim();
		if (phrase.length === 0) {
			continue;
		}
		const key = phrase.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		queries.push({ phrase, origin });
		if (queries.length >= limit) {
			break;
		}
	}
	return queries;
}

/**
 * Coerce the tool call's input into well-formed Channel Signals: keep only
 * supported short-form signals, clamp scores to 0–100, default missing rationale to empty.
 * Strict tool use already guarantees the shape; this is belt-and-suspenders so a
 * malformed field can never poison the downstream Clonability mean.
 */
function normalizeSignals(raw: unknown): Signals {
	const record = (raw ?? {}) as Record<
		string,
		{ score?: unknown; rationale?: unknown } | undefined
	>;
	const signals: Signals = {};
	for (const name of CHANNEL_SIGNAL_NAMES) {
		const entry = record[name];
		if (!entry) {
			continue;
		}
		const rawScore = entry.score;
		if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
			continue; // omit a malformed score rather than count it as 0 — lets
			// Clonability renormalize over the well-formed signals (ADR-0003).
		}
		signals[name] = {
			score: Math.max(0, Math.min(100, rawScore)),
			rationale: typeof entry.rationale === "string" ? entry.rationale : "",
		};
	}
	return signals;
}

/**
 * Build the real Anthropic Enrichment adapter. `client` is injectable so the cron
 * can pass a preconfigured Anthropic instance — but the enrich cron is exercised
 * end-to-end with a stub `EnrichmentAdapter`, so this wire code is never hit in
 * tests (mirroring the Voyage embeddings adapter).
 */
export function createAnthropicEnrichmentAdapter(
	apiKey: string,
	opts: EnrichmentOptions = {},
	client: Anthropic = new Anthropic({ apiKey }),
): EnrichmentAdapter {
	const model = opts.model ?? DEFAULT_MODEL;
	return {
		async enrich(input): Promise<EnrichmentResult> {
			const thumbnails = input.videos
				.map((video) => video.thumbnailUrl)
				.filter((url): url is string => Boolean(url))
				.slice(0, MAX_THUMBNAILS);

			const message = await client.messages.create({
				model,
				max_tokens: MAX_TOKENS,
				system: SYSTEM_PROMPT,
				tools: [
					{
						name: "record_signals",
						description:
							"Record the clonability signal scores for this short-form channel.",
						input_schema: signalsSchema(),
						strict: true,
					},
				],
				tool_choice: { type: "tool", name: "record_signals" },
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: buildUserText(input) },
							...thumbnails.map((url) => ({
								type: "image" as const,
								source: { type: "url" as const, url },
							})),
						],
					},
				],
			});

			const toolUse = message.content.find(
				(block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
			);
			if (!toolUse) {
				throw new Error("enrichment: model did not return record_signals");
			}
			const raw = (toolUse.input ?? {}) as Record<string, unknown>;
			return {
				signals: normalizeSignals(raw),
				nicheQueries: [
					...collectNicheQueries(
						raw.ownNicheQueries,
						"seeded",
						OWN_NICHE_QUERY_LIMIT,
					),
					...collectNicheQueries(
						raw.adjacentNicheQueries,
						"adjacent",
						ADJACENT_NICHE_QUERY_LIMIT,
					),
				],
			};
		},
	};
}
