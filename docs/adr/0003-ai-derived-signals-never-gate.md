# Subjective signals are AI-derived scores that never gate

Core signals depend on AI: **channel embeddings** (an embeddings provider — Anthropic offers none, so Voyage/OpenAI/local) power [[Saturation]] via Convex vector search, and a **multimodal Claude pass** over metadata + recent titles + thumbnails produces the subjective Clonability signals (automatable, transformative, improvable, enterprise value). The firm rule: **only the objective `Proven` gate can exclude a Listing.** Every AI-derived signal is a *score*, never a filter.

## Why

- **Trust.** LLM judgment is noisy; if a misjudged "transformative" could remove a genuinely proven channel, the Feed becomes untrustworthy and thin. Gating solely on the objective 100k-median floor keeps the Feed defensible.
- **Graceful degradation.** If enrichment or embeddings are slow, rate-limited, or down, Listings still appear (gated on hard metrics) and simply lack scores until backfilled. The app is never blocked on AI.
- **Rejected alternatives:** gate on *all* criteria (Feed too thin, brittle to LLM error) and gate on *none* (garbage floods in). Gating on exactly one objective criterion is the middle path.

## Consequences

- Two external AI dependencies enter the pipeline (embeddings + Claude). Both are async, cached, and off the read path.
- Scores are nullable in the schema; the UI must render a Listing with missing/pending signals.
- Exact Claude model and embeddings provider are chosen at build time against current pricing (consult the claude-api reference before picking the model).
