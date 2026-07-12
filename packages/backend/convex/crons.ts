/**
 * The Scout's cron registry (ADR-0008, superseding ADR-0007's "no crons"
 * stance). Exactly two scheduled triggers, both narrow: they only *create*
 * work through existing, test-covered entrypoints — nothing here refreshes,
 * snapshots, or re-enriches on a schedule (refresh stays admin-triggered).
 *
 *  - The **Scout run** fires every 3 hours (`scout:scoutRunAction`). A cron-fired
 *    run is identical to a manual `convex run scout:scoutRunAction`: both call
 *    the same action with the same `DEFAULT_SCOUT_CONFIG`, so the cron is just a
 *    second caller of the same machinery.
 *  - The **wildcat call** fires once daily at 00:00 UTC
 *    (`enrichChannel:wildcatWorker`), injecting unseeded niche novelty so the
 *    seeded loop doesn't close on itself.
 *
 * Per-run budget/lifecycle knobs (searches per run, seeded/exploration split,
 * submission cap, view floor, retirement threshold) are *not* here — they live
 * as readable config in `DEFAULT_SCOUT_CONFIG` (model/scout.ts). This module
 * owns only the deployment cadence, which is the other half of the quota math:
 * up to 8 runs/day (every 3h) × the ~10 searches/run that config allows × 100
 * units ≈ 8,000 search units, plus hydration and downstream ingest, targets
 * ≈9,000 of the 10,000 daily YouTube quota units, leaving a ~1,000-unit seatbelt
 * (PRD #75). `crons.interval` anchors to the previous run's completion, so a slow
 * run only *lowers* the daily count — the seatbelt is a ceiling, not a floor.
 */

import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

/** How often a Scout run fires. Paired with `DEFAULT_SCOUT_CONFIG`'s
 * searches-per-run to land under the daily YouTube quota (see module header). */
const SCOUT_RUN_INTERVAL = { hours: 3 } as const;

/** When the daily wildcat call fires — 00:00 UTC. `crons.cron` (not the `daily`
 * helper) per the Convex cron guidelines; a fixed daily time keeps the novelty
 * injection stable rather than drifting with deploy time. */
const WILDCAT_DAILY_CRON = "0 0 * * *";

const crons = cronJobs();

crons.interval(
	"scout run",
	SCOUT_RUN_INTERVAL,
	internal.scout.scoutRunAction,
	{},
);

crons.cron(
	"wildcat call",
	WILDCAT_DAILY_CRON,
	internal.enrichChannel.wildcatWorker,
	{},
);

export default crons;
