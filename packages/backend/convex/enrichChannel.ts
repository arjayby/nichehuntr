"use node";

/**
 * The single-Channel Enrichment action's Node.js entrypoint (ADR-0007). The
 * Anthropic SDK reaches for Node built-ins (fs/path, for optional credential
 * files), so it can't run in Convex's default V8 runtime — this file carries the
 * `"use node"` directive and therefore holds *only* the action. The DB seam
 * (`buildChannelEnrichmentTarget`, `applyChannelEnrichment`) and the
 * `runEnrichChannel` orchestration stay in `enrich.ts` on the default runtime;
 * this action just builds the live adapter and hands it, plus the target Channel
 * id, to that same test-covered orchestration.
 *
 * A tracked, Feed-visible Submission schedules this worker for its Channel only
 * (`submissions.completeSubmission`); there is no cron and no batch scan.
 */

import { v } from "convex/values";

import { internalAction } from "./_generated/server";
import { type EnrichChannelResult, runEnrichChannel } from "./enrich";
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

export const enrichChannelWorker = internalAction({
	args: { channelId: v.id("channels") },
	handler: async (ctx, { channelId }): Promise<EnrichChannelResult> =>
		runEnrichChannel(ctx, liveEnrichmentAdapter(), channelId),
});
