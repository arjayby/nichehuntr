import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * The live-ingestion schedule (ADR-0001, ADR-0003, ADR-0005). Automated
 * discovery is gone (ADR-0005): channels now enter only by admin Submission, so
 * there is no trending or snowball cron. What remains is the judgment engine's
 * upkeep — cadences are deliberately frugal: snapshots batch 50 video ids per
 * unit, and the embed pass spends no YouTube quota (only the embeddings
 * provider) — so all sit far under the ~10k units/day budget. Intervals are
 * tunable.
 */
const crons = cronJobs();

crons.interval(
	"youtube snapshots",
	{ hours: 6 },
	internal.ingest.snapshotCron,
	{},
);

// Embed + measure Saturation between snapshot cycles so a submitted channel gets
// a niche read soon after intake, and existing reads track the growing graph.
crons.interval(
	"embed and saturate",
	{ hours: 6 },
	internal.ingest.embedCron,
	{},
);

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
