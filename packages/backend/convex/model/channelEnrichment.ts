import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { CHANNEL_SIGNAL_NAMES, type Signals } from "./clonability";

type EnrichmentReadCtx = QueryCtx | MutationCtx;

export type ChannelEnrichmentWrite = {
	channelId: Id<"channels">;
	signals: Signals;
	fingerprint: string;
	enrichedAt: number;
};

function supportedSignalCount(row: Doc<"enrichments">): number {
	return CHANNEL_SIGNAL_NAMES.filter((name) => row.signals[name] !== undefined)
		.length;
}

function hasShortFormOnlySignal(row: Doc<"enrichments">): boolean {
	return (
		row.signals.automatable !== undefined ||
		row.signals.transformative !== undefined
	);
}

/** Prefer the row that looks like short-form Channel enrichment; newest wins ties. */
export function preferredChannelEnrichment(
	rows: Doc<"enrichments">[],
): Doc<"enrichments"> | null {
	return (
		rows.filter(hasShortFormOnlySignal).sort((a, b) => {
			const signalDelta = supportedSignalCount(b) - supportedSignalCount(a);
			if (signalDelta !== 0) {
				return signalDelta;
			}
			return b.enrichedAt - a.enrichedAt;
		})[0] ?? null
	);
}

export async function channelEnrichmentsFor(
	ctx: EnrichmentReadCtx,
	channelId: Id<"channels">,
): Promise<Doc<"enrichments">[]> {
	return ctx.db
		.query("enrichments")
		.withIndex("by_channel", (q) => q.eq("channelId", channelId))
		.collect();
}

export async function channelEnrichmentFor(
	ctx: EnrichmentReadCtx,
	channelId: Id<"channels">,
): Promise<Doc<"enrichments"> | null> {
	return preferredChannelEnrichment(
		await channelEnrichmentsFor(ctx, channelId),
	);
}

export async function upsertChannelEnrichment(
	ctx: MutationCtx,
	write: ChannelEnrichmentWrite,
): Promise<void> {
	const rows = await channelEnrichmentsFor(ctx, write.channelId);
	const keeper = preferredChannelEnrichment(rows) ?? rows[0] ?? null;
	const fields = {
		signals: write.signals,
		fingerprint: write.fingerprint,
		enrichedAt: write.enrichedAt,
	};

	if (keeper === null) {
		await ctx.db.insert("enrichments", {
			channelId: write.channelId,
			...fields,
		});
		return;
	}

	await ctx.db.patch("enrichments", keeper._id, fields);
	await Promise.all(
		rows
			.filter((row) => row._id !== keeper._id)
			.map((row) => ctx.db.delete(row._id)),
	);
}
