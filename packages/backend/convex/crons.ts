import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/** Live upkeep. Snapshot momentum and saturation jobs are retired by ADR-0006;
 * only Channel-level enrichment remains because Clonability ranks visible
 * Channels but never gates lifecycle stage or Feed visibility. */
const crons = cronJobs();

// Enrich visible Channels with subjective Clonability signals (ADR-0003/0006).
// Spends only the Anthropic budget (one multimodal call per stale Channel), and
// re-runs a Channel only when its short-form inputs materially change.
crons.interval(
	"enrich clonability",
	{ hours: 6 },
	internal.enrichCron.enrichCron,
	{},
);

export default crons;
