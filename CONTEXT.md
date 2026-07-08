# NicheHuntr

A discovery surface for YouTube channels, modeled on token-discovery apps (axiom.trade / nova.trade) but for content niches. It surfaces channels as **clone targets**: proof that a niche works and can be replicated.

## Language

**Operator**:
The user. A creator/operator hunting for proven, replicable YouTube niches to build in — not to buy. Their job-to-be-done is deciding _"should I clone this?"_
_Avoid_: Viewer, investor, acquirer, buyer.

**Clone**:
The Operator's target action: build a new channel that replicates a discovered channel's proven niche/format. The app exists to surface and rank clone targets. Explicitly _not_ acquiring or purchasing the channel.
_Avoid_: Acquire, buy.

**Channel**:
The short-form YouTube entity we discover, score, stage, and show as a clone target. In NicheHuntr, short-form means videos up to 300 seconds. A channel is never forced into a category taxonomy.
_Avoid_: Account, creator (when referring to the discovered entity).

**Listing**:
Deprecated language from the earlier long-form/short-form design. The product now treats the [[Channel]] itself as the scored unit because NicheHuntr tracks short-form channels only.
_Avoid_: Entry, card, row.

**Niche**:
The implicit, inferred content space a channel occupies (e.g. "AI horror shorts"). Deliberately _not_ a first-class taxonomy and never a required classification. Multiple channels in the same niche are shown as separate cards — the duplication is itself signal that the niche is hot.
_Avoid_: Category, tag (as a required field), vertical.

**Feed**:
The single global, shared discovery surface — one canonical set of tracked Channels + Snapshots that every Operator sees. Momentum and saturation are computed once, globally. Per-Operator personalization (long/short filter, stage filter, the [[Watchlist]]) is only a _lens_ on the Feed, never a private dataset.
_Avoid_: Dashboard, my channels.

**Watchlist**:
The Operator's private, curated set of clone candidates, saved from Feed cards. A watchlist entry points to an `(Operator, Channel)` pair. A _lens_ on the [[Feed]]: entries point into the shared dataset and re-derive live Channel data at read time; nothing is copied or frozen.
_Avoid_: Saved channels, favorites, bookmarks.

**Folder**:
The Operator's flat, private grouping inside the [[Watchlist]] — a named bucket expressing curation intent (e.g. "faceless", "next month"). No nesting; a watchlist entry sits in at most one Folder or at the root. Deleting a Folder returns its entries to the root — it never deletes them. Folders group; they do not rank — ordering within the Watchlist is automatic.
_Avoid_: Tag, label, category, collection.

**Admin**:
A privileged operator authorized to submit [[Channel]]s into the [[Feed]]. Distinct from the [[Operator]] paywall — admin is a separate authorization axis (a role, not a subscription), and an Admin need not hold an active subscription to submit. Membership lives in a local role table keyed by the auth user id, granted by email, and bootstrapped once out-of-band. See ADR-0005.
_Avoid_: Superuser, moderator, owner.

**Submission**:
An [[Admin]]'s request to bring a [[Channel]] into the [[Feed]], together with its ingestion outcome. Replaces automated discovery (ADR-0005) as the sole way a channel enters the system. Carries a status lifecycle: _pending_ → _processing_ → _tracked_ or _failed_. Crucially, a channel that ingests but fails the [[Proven]] gate is **tracked, not failed** — the Admin submits candidates; the app decides the lifecycle. `failed` means the paste wouldn't resolve to a channel or the API errored (retryable). A resolved-and-tracked Submission is idempotent per channel, doubling as a manual refresh.
_Avoid_: Queue, request, candidate.

**Tracked**:
A channel that has been ingested and remains in the shared dataset, whether or not it currently qualifies for a lifecycle column. Tracked channels that miss the lifecycle rules are hidden from the Feed rather than treated as failed submissions.
_Avoid_: Failed, rejected.

## Discovery pipeline

The three columns are a left-to-right **channel lifecycle**: a channel's position is a function of its recent short-form reach and channel maturity, so the Operator can time their clone. It is _not_ three independent sorted feeds.

**Stage**:
A channel's position in the lifecycle. One of Emerging, Breaking Out, or Established. Derived from [[Recent Reach]] and channel maturity, not assigned manually. Precedence is Established, then Breaking Out, then Emerging; channels that match none remain [[Tracked]] and hidden from the Feed.

**Emerging** (column 1):
A short-form channel whose latest Short was published within the last 14 days and whose recent Shorts are already clearing the lower recent-reach bar, but not the Breaking Out reach bar. If the channel has 10 or more fetched Shorts, at least 5 of the latest 10 must meet that bar; if it has 3-9 fetched Shorts, at least half rounded up must meet it. Operator's read: risky, but early.

**Breaking Out** (column 2):
A short-form channel whose latest Short was published within the last 14 days and whose recent Shorts are clearing the higher recent-reach bar, but that has not yet met the Established maturity cutoff. If the channel has 10 or more fetched Shorts, at least 5 of the latest 10 must meet that bar; if it has 3-9 fetched Shorts, at least half rounded up must meet it. The sweet spot — clone _now_.

**Established** (column 3):
A short-form channel with Breaking Out-level recent reach that has already accumulated a mature audience and upload catalog: at least 50,000 subscribers and at least 50 fetched Shorts. It uses the same 100,000-view recent-reach rule as Breaking Out, but unlike Emerging and Breaking Out, Established does not require the latest Short to have been published within the last 14 days.

**Snapshot**:
Deprecated language from the earlier acceleration-based lifecycle. The simplified short-form lifecycle reads current video stats on refresh and does not require a view-count time series.

**Baseline**:
A deprecated signal from the earlier acceleration-based lifecycle. The simplified short-form lifecycle reads recent view counts directly instead of comparing against a historical norm.

**Recent Reach**:
How many views a channel's recent Shorts have already earned, measured from raw current per-video view counts without age adjustment. The lifecycle reads the latest 10 Shorts when available; channels with 3-9 fetched Shorts can still qualify if at least half rounded up meet the stage's view threshold, while channels with fewer than 3 fetched Shorts stay [[Tracked]] and hidden. Long-form uploads are ignored for recent-reach and latest-upload checks.
_Avoid_: Momentum, velocity, percent per day, trending, hype.

**Lifecycle Evidence**:
The plain counters that explain a channel's stage: subscriber count, fetched Shorts count, latest Short publish date, number of recent Shorts checked, number above 50,000 views, and number above 100,000 views. These replace baseline, momentum, saturation, Proven, form, and long-form metrics on the card.
_Avoid_: Advanced metrics, technical indicators.

**Proven** (the gate):
Deprecated language from the earlier gate-first design. The simplified short-form lifecycle no longer has a separate Proven gate; a channel is visible when it qualifies for Emerging, Breaking Out, or Established, and otherwise remains [[Tracked]] and hidden.
_Metric note_: "100k" always means 100,000 views on an individual video, never channel totals or subscribers.

**Enrichment**:
The per-[[Channel]] AI pass that produces short-form subjective signals: a single multimodal call over the channel's metadata, recent video titles, and recent thumbnail images, returning a structured per-signal score plus a one-line rationale each. Feeds [[Clonability]] but never determines lifecycle stage or feed visibility.

**Clonability**:
An overall per-[[Channel]] score synthesizing the subjective [[Enrichment]] signals into how attractive a short-form clone target is. Computed as a tunable weighted mean of [[Automatable]], [[Transformative]], and [[Improvable]]; it sharpens ranking and detail views within a lifecycle stage but never gates. Degrades gracefully: a channel can appear before its Clonability signals are computed.
_Avoid_: Quality score, rating.

**Automatable** (short-form signal):
Can the content be mass-produced from a repeatable template, cheaply (no specific on-camera talent, no expensive shoot), from an effectively _infinite_ supply of source material. Absorbs the brief's "cheap" and "infinite source pull." Weighted highest in short-form Clonability.

**Transformative** (short-form signal):
Repackages _existing_ material (compilations, reactions, edits, AI remixes) rather than requiring original creation.

**Improvable** (both forms):
Visible headroom to out-execute — lazy thumbnails, weak editing, shallow content — while the channel is _still winning_. High = easy to beat.

**Enterprise value** (long-form signal):
Deprecated long-form signal from the earlier mixed-form design.

**Saturation**:
Deprecated language from the earlier competitor-counting design. The simplified short-form lifecycle does not measure comparable channels, competitor counts, or niche crowdedness.
_Avoid_: Competition, crowdedness.
