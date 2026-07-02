import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * The live-ingestion schedule (ADR-0001, ADR-0003). Cadences are deliberately
 * frugal: discovery is ~2 quota units per tick (trending + one batched channels
 * call), snapshots batch 50 video ids per unit, and snowball is one
 * `brandingSettings` batch plus one `channels` batch — so all sit far under the
 * ~10k units/day budget. The embed pass spends no YouTube quota (only the
 * embeddings provider). Intervals are tunable.
 */
const crons = cronJobs();

crons.interval(
	"youtube discovery",
	{ hours: 6 },
	internal.ingest.discoveryCron,
	{},
);

crons.interval(
	"youtube snapshots",
	{ hours: 6 },
	internal.ingest.snapshotCron,
	{},
);

// Snowball less often than trending: featured-channel graphs barely move, and
// it only needs to keep same-niche clusters populated for Saturation.
crons.interval(
	"youtube snowball",
	{ hours: 12 },
	internal.ingest.snowballCron,
	{},
);

// Embed + measure Saturation between snapshot cycles so new channels get a niche
// read soon after discovery, and existing reads track the growing graph.
crons.interval(
	"embed and saturate",
	{ hours: 6 },
	internal.ingest.embedCron,
	{},
);

export default crons;
