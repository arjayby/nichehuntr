"use node";

/**
 * The enrich cron's Node.js entrypoint (Slice 5, ADR-0003). The Anthropic SDK
 * reaches for Node built-ins (fs/path, for optional credential files), so it can't
 * run in Convex's default V8 runtime — this file carries the `"use node"`
 * directive and therefore holds *only* the action. The DB seam
 * (`listChannelsToEnrich`, `applyEnrichment`) and the `runEnrich` orchestration
 * stay in `enrich.ts` on the default runtime; this action just builds the live
 * adapter and hands it to that same, test-covered orchestration.
 */

import { internalAction } from "./_generated/server";
import { type EnrichResult, runEnrich } from "./enrich";
import type { EnrichmentAdapter } from "./model/clonability";
import { createAnthropicEnrichmentAdapter } from "./model/enrichment";

/** Build the live enrichment adapter, failing loudly if its key isn't set. */
function liveEnrichmentAdapter(): EnrichmentAdapter {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error(
			"ANTHROPIC_API_KEY is not set — configure it in the Convex dashboard.",
		);
	}
	return createAnthropicEnrichmentAdapter(apiKey);
}

export const enrichCron = internalAction({
	args: {},
	handler: async (ctx): Promise<EnrichResult> =>
		runEnrich(ctx, liveEnrichmentAdapter()),
});
