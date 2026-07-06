/**
 * One-off data migrations run by hand via `convex run` (the same privileged,
 * non-web-reachable pattern as the seed and sandbox subscription helpers).
 */

import { internalMutation } from "./_generated/server";

/** The pipeline tables the cutover purge empties, in an order safe for the
 * clean slate (leaf snapshots/edges before the channels/videos they reference,
 * though a raw delete needs no particular order). */
const PIPELINE_TABLES = [
	"videoSnapshots",
	"listings",
	"channelEdges",
	"enrichments",
	"videos",
	"channels",
] as const;

type PurgeCounts = Record<(typeof PIPELINE_TABLES)[number], number>;

/**
 * Cutover purge (ADR-0005): clear all automated-discovery pipeline data so the
 * Feed restarts from an empty, 100%-admin-curated slate. Empties channels,
 * videos, videoSnapshots, listings, channelEdges, and enrichments and reports the
 * per-table counts deleted.
 *
 * Run once by hand after deploying the discovery teardown:
 *   npx convex run migrations:purgePipeline
 *
 * Sized for the small pre-cutover catalog (~189 channels), so a single
 * transaction comfortably clears it; it is idempotent — re-running on empty
 * tables is a clean no-op.
 */
export const purgePipeline = internalMutation({
	args: {},
	handler: async (ctx): Promise<PurgeCounts> => {
		const counts = {} as PurgeCounts;
		for (const table of PIPELINE_TABLES) {
			const rows = await ctx.db.query(table).collect();
			for (const row of rows) {
				await ctx.db.delete(table, row._id);
			}
			counts[table] = rows.length;
		}
		return counts;
	},
});
