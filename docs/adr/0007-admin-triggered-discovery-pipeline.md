# Discovery pipeline runs from admin Submission, not cron upkeep

The discovery pipeline now starts only when an Admin creates a Submission or refreshes a tracked channel by creating a new Submission for the same resolved channel id: the worker resolves the channel, fetches current short-form uploads, upserts channel/video data, derives lifecycle evidence, marks the Submission tracked, and then schedules a separate immediate enrichment action for that Channel only if it is visible in the Feed. There are no scheduled discovery, stats-refresh, snapshot, or enrichment crons; refreshing through a new Submission is the only refresh path. This supersedes ADR-0001's cron-sampled snapshot pipeline, ADR-0003's recurring enrichment assumption, ADR-0005's "keep snapshots/enrich" narrow teardown, and the remaining cron upkeep implied after ADR-0006.

## Consequences

Submission status remains an intake outcome, not a scoring-health indicator: enrichment may lag or fail without changing `tracked` to `failed`. Hidden Tracked channels do not spend enrichment budget until a later Submission refresh makes them visible. Keeping enrichment in a separate action isolates Anthropic latency/failure and Node runtime requirements from the YouTube intake worker, and targeting only the submitted Channel keeps admin-triggered work local and predictable. Feed freshness is bounded by Admin action by design.

The Convex cron registry is removed entirely rather than kept as an empty module.

The enrichment follow-up recomputes the submitted Channel's visibility from database state before spending Anthropic budget, then skips unchanged fingerprints.

Tracked Submission rows may expose a Refresh action that creates a new pending Submission from the canonical `resolvedYtChannelId`; failed rows keep Retry. Refresh is unavailable while another Submission for that same channel id is pending or processing.
