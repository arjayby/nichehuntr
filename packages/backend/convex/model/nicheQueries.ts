/**
 * The Scout's Niche Query pool write path (CONTEXT.md: Niche Query, ADR-0008).
 *
 * Niche Queries are free-text search phrases the Scout runs to find candidate
 * Channels — internal fuel only, never rendered and never a taxonomy. They are
 * minted as a side effect of Enrichment (a visible Channel's own niche as
 * `seeded`, neighboring niches as `adjacent`) and, later, the Scout's `wildcat`
 * call. This module owns normalization and the case-insensitive insert-dedupe so
 * every minting path — the enrichment write path today, the wildcat call
 * tomorrow — agrees on what "the same phrase" means.
 */

import type { MutationCtx } from "../_generated/server";
import type { MintedNicheQuery } from "./validators";

/**
 * Canonicalize a Niche Query phrase for storage and dedupe: trim the ends,
 * lowercase, and collapse internal whitespace runs to a single space. Two phrases
 * that differ only in case or whitespace therefore map to one key, so the pool
 * holds a single row per distinct phrase (CONTEXT.md: Niche Query).
 */
export function normalizeNicheQuery(phrase: string): string {
	return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Mint one Niche Query into the Scout's pool, deduped case-insensitively by its
 * normalized phrase. A phrase not seen before is inserted with a zeroed
 * zero-yield counter. Re-minting an existing phrase *revives* it — it resets the
 * consecutive-zero-yield counter so a phrase the Scout had been retiring gets
 * another run — while preserving the row's original `origin` and `lastRunAt` (a
 * revival is a second chance, not a fresh phrase). A phrase that normalizes to
 * empty is skipped. Idempotent per normalized phrase.
 */
export async function mintNicheQuery(
	ctx: MutationCtx,
	{ phrase, origin }: MintedNicheQuery,
): Promise<void> {
	const normalized = normalizeNicheQuery(phrase);
	if (normalized.length === 0) {
		return;
	}
	const existing = await ctx.db
		.query("searchQueries")
		.withIndex("by_phrase", (q) => q.eq("phrase", normalized))
		.unique();
	if (existing === null) {
		await ctx.db.insert("searchQueries", {
			phrase: normalized,
			origin,
			consecutiveZeroYield: 0,
		});
		return;
	}
	if (existing.consecutiveZeroYield !== 0) {
		await ctx.db.patch("searchQueries", existing._id, {
			consecutiveZeroYield: 0,
		});
	}
}
