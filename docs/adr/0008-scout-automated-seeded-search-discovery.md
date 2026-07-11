# The Scout automates discovery via seeded YouTube API search

We add **the [[Scout]]**: an automated discoverer that becomes the Feed's primary front door. On a cron it runs seeded searches against the **official YouTube Data API v3**, harvests unseen channels from the results, and creates ordinary [[Submission]]s through the unchanged [[Discovery pipeline]]. This supersedes ADR-0005's admin-only front-door stance and ADR-0007's "no crons" stance, while preserving the spine both share: **the [[Admin]] (now the Scout) submits candidates; the app decides the lifecycle**, and a [[Submission]] remains the sole intake record. The admin paste box, role, and Submissions table stay — as a manual-boost path and as the observability surface for the Scout.

## Why

- **Manual submission could not scale.** Under ADR-0005 the Feed's throughput was "bounded by admin effort, by design" — one person pasting URLs by hand. That volume is not sustainable, and the Admin is stopping manual pastes; without a new front door the Feed stops growing.
- **The Scout inherits the Admin's taste, not just their labor.** Its searches are seeded from the [[Niche Query]] phrases of channels already visible in the Feed, so automated discovery echoes what already worked. A small daily "wildcat" call proposes unseeded niches so the loop is not a pure echo chamber.
- **Automated volume cannot flood the Feed.** The lifecycle gates (ADR-0006) still decide visibility. The Scout only raises the arrival rate of candidates; nothing bypasses the objective stage thresholds, so junk stays [[Tracked]] and hidden.
- **The pipeline is untouched.** The Scout is a new *caller* of existing machinery — resolve → backfill → lifecycle → enrichment is unchanged. We replace the *front door*, never the logic that gates, stages, and scores.

## Decisions

- **Official API, not feed mimicry.** The Scout uses YouTube Data API v3 `search.list`. We explicitly reject mimicking the Admin's actual scrolling via a headless browser or the unofficial Innertube API, because it **violates YouTube's Terms of Service**, is **brittle against bot detection**, and requires **external infrastructure the product does not want to operate**. (The official API has no feed/recommendations endpoint; `relatedToVideoId` was removed in 2023 — seeded search is the sanctioned substitute.)
- **The Scout is a second trigger, not a replacement.** A cron-fired run joins admin Submission as a way channels enter; it does not remove the paste box, the admin role, or the Submissions table. Refresh of tracked channels stays admin-triggered only (ADR-0007 preserved), so quota spend does not grow unbounded with catalog size.
- **Submissions gain a source.** A Submission is now an Admin's *or the Scout's* request; the intake record carries `admin | scout` and renders the Scout's as a badge, so manual and automated intake are distinguishable in one table.
- **Niche Query phrases are internal Scout fuel.** They are minted only as a side effect of [[Enrichment]] (plus the wildcat call), never rendered and never filterable. The glossary's "no niche taxonomy" stance is reaffirmed: duplicate cards in a niche remain the signal that the niche is hot.

## Consequences

- **"No crons" is no longer true.** ADR-0007 removed the Convex cron registry entirely; a Scout cron reintroduces exactly one scheduled trigger. Its scope is deliberately narrow — it only *creates* Submissions; it does not refresh, snapshot, or re-enrich on a schedule.
- **Quota becomes an operational budget.** `search.list` is the expensive call, so a run is bounded (queries per run, submission cap, view floor) and quota exhaustion aborts a run cleanly rather than half-ingesting. Concrete budget numbers live in config, not here.
- **The Feed becomes self-feeding.** Scout → Submission → visible → enriched → new Niche Query phrases → Scout. The wildcat call is the outside-loop novelty injector that keeps the loop from closing on itself.
- **Curation shifts from per-channel to per-query.** The Admin no longer vets each channel; taste is expressed through the seeded query pool and the lifecycle thresholds instead.
