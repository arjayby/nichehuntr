# YouTube Data API v3 as source of record + self-built snapshot time-series

We use the **YouTube Data API v3** as the source of record for channel/video data and **build our own momentum time-series** by periodically snapshotting tracked channels into Convex, rather than buying backfilled history from a third-party service (Social Blade / ViewStats / scraping APIs). Momentum (the primary axis of the discovery pipeline) is a derivative that the API cannot return directly — it only gives point-in-time counts — so a scheduled Convex `action`→`mutation` snapshots view counts over time, and a `cron` re-samples on a cadence. New channels are seeded with a `views ÷ video-age` proxy so columns are never blank; true velocity sharpens as snapshots accumulate.

## Considered Options

- **Direct API v3 + own snapshots (chosen).** Free-ish (~10k quota units/day), fits Convex's action/mutation/cron/reactive-query model, full control, and — decisively — starts recording a channel's trajectory the moment *we* discover it, capturing emergence firsthand.
- **Third-party historical provider (rejected).** Backfilled history kills cold-start and needs no snapshot pipeline, but coverage skews to already-popular channels — weakest exactly at the **Emerging** column, which is our whole differentiator — while adding recurring cost and lock-in.

## Consequences

- **Cold-start is accepted:** momentum for a newly discovered channel is proxy-based until ~24–72h of snapshots exist.
- **Quota is a design constraint:** `search.list` costs 100 units; stats refresh is cheap (batch 50 IDs / 1 unit). Discovery must be frugal (favor trending/related/snowball over raw search). _(Superseded by ADR-0005: automated discovery is removed; channels now enter only by admin Submission. The snapshot time-series and quota constraint below still stand.)_
- **YouTube ToS limits data retention** — snapshots must be refreshed/expired per their rules.
