import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/**
 * The live-ingestion schedule (ADR-0001). Cadences are deliberately frugal:
 * discovery is ~2 quota units per tick (trending + one batched channels call)
 * and snapshots batch 50 video ids per unit, so both sit far under the ~10k
 * units/day budget. Intervals are tunable.
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

export default crons;
