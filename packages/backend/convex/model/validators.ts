import { v } from "convex/values";

/** Shared Convex validators for the discovery domain, kept in one place so the
 * schema and the functions that read/write it can't drift apart. */

export const formValidator = v.union(v.literal("short"), v.literal("long"));

export const stageValidator = v.union(
	v.literal("emerging"),
	v.literal("breaking_out"),
	v.literal("established"),
);

/** How a channel entered the Feed (ADR-0001: trending firehose + snowball). */
export const sourceValidator = v.union(
	v.literal("seed"),
	v.literal("trending"),
	v.literal("snowball"),
);

/** One AI-derived Clonability signal: a 0–100 score plus a one-line rationale. */
export const signalValidator = v.object({
	score: v.number(),
	rationale: v.string(),
});

/** Enrichment output keyed by signal name (form-specific sets), or null until
 * the AI pass runs. ADR-0003: these never gate — they only score. */
export const signalsValidator = v.record(v.string(), signalValidator);
