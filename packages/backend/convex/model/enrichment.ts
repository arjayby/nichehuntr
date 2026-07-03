"use node";

/**
 * The humble multimodal Enrichment adapter (ADR-0003, Slice 5).
 *
 * Produces the subjective Clonability signals: a single multimodal Claude call
 * over a channel's metadata, recent video titles, and recent thumbnail images,
 * returning a {score 0–100, rationale} per form-appropriate signal (CONTEXT.md:
 * Enrichment). Like the YouTube and embeddings adapters this is a "humble object" —
 * it only maps the request/response and holds no policy. The tunable weighting
 * that turns these signals into Clonability lives in the pure `clonability.ts`, and
 * the enrich cron drives this behind the `EnrichmentAdapter` seam so tests run
 * against a stub and never hit the network. Transcripts are deliberately out of
 * scope — too costly for marginal gain on these judgments (CONTEXT.md).
 */

import Anthropic from "@anthropic-ai/sdk";

import {
	type EnrichmentAdapter,
	type EnrichmentInput,
	SIGNAL_DEFINITIONS,
	SIGNAL_LABELS,
	SIGNAL_SETS,
	type Signals,
} from "./clonability";
import type { Form } from "./deriveListings";

/**
 * The Enrichment model. Haiku is the cheapest multimodal tier — the right fit for
 * a humble, recurring per-Listing scoring pass over titles + thumbnails. Swap here
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

/** A handful of short {score, rationale} objects need little generation. */
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
	"You assess a YouTube channel as a *clone target*: how attractive it would be for an operator to build a new channel replicating its proven niche and format (not to buy it). Judge only the requested signals for the given content form, grounded in the metadata, recent titles, and thumbnail images provided. Be decisive and concise. Always report via the record_signals tool.";

export type EnrichmentOptions = {
	/** Override the model id (defaults to a cheap multimodal tier). */
	model?: string;
};

/**
 * JSON Schema for the record_signals tool, built from the form's signal set.
 * Score bounds live in the descriptions and are clamped downstream, since strict
 * structured schemas don't support numeric min/max.
 */
function signalsSchema(form: Form) {
	const properties: Record<string, unknown> = {};
	for (const name of SIGNAL_SETS[form]) {
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
	return {
		type: "object" as const,
		properties,
		required: [...SIGNAL_SETS[form]],
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
			`Recent ${input.form}-form uploads:`,
			...titles.map((title) => `- ${title}`),
		);
	}
	lines.push(
		"",
		"Score each signal 0–100 (higher = more true of this channel), each with a one-line rationale:",
		...SIGNAL_SETS[input.form].map(
			(name) => `- ${SIGNAL_LABELS[name]}: ${SIGNAL_DEFINITIONS[name]}`,
		),
	);
	return lines.join("\n");
}

/**
 * Coerce the tool call's input into well-formed Signals for the form: keep only
 * the form's signals, clamp scores to 0–100, default a missing rationale to empty.
 * Strict tool use already guarantees the shape; this is belt-and-suspenders so a
 * malformed field can never poison the downstream Clonability mean.
 */
function normalizeSignals(raw: unknown, form: Form): Signals {
	const record = (raw ?? {}) as Record<
		string,
		{ score?: unknown; rationale?: unknown } | undefined
	>;
	const signals: Signals = {};
	for (const name of SIGNAL_SETS[form]) {
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
		async enrich(input): Promise<Signals> {
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
						description: `Record the clonability signal scores for this ${input.form}-form channel.`,
						input_schema: signalsSchema(input.form),
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
			return normalizeSignals(toolUse.input, input.form);
		},
	};
}
