# Channels enter the Feed only by admin Submission, not automated discovery

We **remove automated YouTube discovery** (the trending-firehose and snowball crons) and make an **admin-submitted [[Submission]] the sole way a [[Channel]] enters the system**. An [[Admin]] pastes a channel URL / handle / id; a background worker resolves it, backfills the channel's recent uploads, and hands it to the existing judgment engine, which decides the [[Stage]] as before. This supersedes ADR-0001's "favor trending/related/snowball" discovery stance; ADR-0001's self-built [[Snapshot]] time-series is otherwise unchanged.

## Why

- **The firehose could never do the job it implied.** Trending returns the same ~50 slow-moving videos per call and captured only 1–2 videos per channel, so 189 discovered channels collapsed to 7 Listings. Snowball's `featuredChannelsUrls` source is deprecated by YouTube and produced 0 edges. Automated discovery was expensive machinery yielding a trickle of low-control inventory.
- **Curation is the product.** The Operator wants *proven, clonable* niches. A human (admin) picking channels is higher-signal than a trending scrape, and it makes the Feed's contents intentional. "A new channel every minute" is explicitly a non-goal — becoming [[Proven]] is an earned, time-accumulated property, not an instantaneous event, so feed *liveness* comes from Listings moving across Stage columns, not from arrival rate.
- **The judgment engine is untouched.** Snapshots, embeddings/Saturation, and Enrichment still run. We replace the *front door* (how channels get in), never the logic that gates, stages, and scores them — "the admin submits candidates; the app decides the lifecycle."

## Decisions

- **Narrow teardown.** Remove only the `discovery` + `snowball` crons and their orchestration; repurpose the channel/video/snapshot upsert as the backfill's write path. Keep `snapshots`, `embed/saturate`, `enrich`. Keep the YouTube adapter (`fetchChannels`, `fetchVideoStats`); add `fetchChannelUploads`, drop `fetchTrending`/`fetchRelatedChannels`.
- **Admin is a role, separate from the subscription axis.** A local `adminUsers` table keyed by the auth `userId`, granted **by email** (grantee must have signed up), bootstrapped once via a `convex run` internal mutation. A `requireAdmin(ctx)` helper mirrors `requireActiveSubscription`. An admin needs no active subscription to submit.
- **Submission is the intake record** with states `pending → processing → tracked | failed`. A channel that ingests but misses the Proven gate is **`tracked`, not `failed`** — it stays tracked, snapshots continue, and it can become Proven later. `failed` means the paste wouldn't resolve or the API errored (manual retry, no auto-retry). Re-submitting a tracked channel is an idempotent refresh.
- **Resolution accepts** channel URL / bare handle / raw `UC…` id, normalized server-side to the canonical id; video-URL and legacy `/c/`, `/user/` paths are deferred. Unresolvable pastes `fail` with a reason.
- **Backfill depth** is the latest ~50 uploads (one `playlistItems` page + one `videos.list` hydration batch, ~2 quota units), one snapshot per video.
- **Full clean slate.** Purge all existing pipeline data; the Feed is 100% admin-curated from empty.
- **Admin surface** is a route under `_auth` but outside `_subscribed` (authenticated, not paywalled): a paste box + a live Submissions table with per-row outcome and a Retry action.

## Consequences

- **Saturation cold-starts weak.** It is a population statistic (nearest-neighbor cluster size); on a fresh, small, admin-curated catalog almost everything reads low-saturation, so "Established" fills mainly via *cooled momentum* until the catalog grows. The `snowballDensity` fallback in `listings.ts` is now permanently 0 (no edges written) — dead code to simplify; `channelEdges` is no longer written.
- **Momentum cold-starts on the proxy.** A freshly submitted channel has one snapshot per video, so Stage uses the `views ÷ video-age` proxy until the snapshot cron accumulates a slope over ~24–72h (unchanged from ADR-0001).
- **Feed throughput is bounded by admin effort**, by design. There is no automated top-of-funnel; growth is exactly what admins submit.
- **A short-heavy (or long-heavy) channel may produce only one form's Listing** when 50 uploads don't yield a full window in the other form — correct behavior, not a gap.
