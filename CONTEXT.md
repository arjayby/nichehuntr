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
The underlying YouTube entity we discover and track. It is _not_ the scored unit — see [[Listing]]. A channel is never forced into a category taxonomy.
_Avoid_: Account, creator (when referring to the discovered entity).

**Listing**:
A `(Channel, Form)` pair — the atomic unit that is gated, staged, scored, and shown as a card. A channel's videos are partitioned by duration, and [[Proven]], [[Momentum]], [[Saturation]], [[Stage]], and [[Clonability]] are computed **per form** over just that form's videos. A channel yields up to two Listings and can straddle (e.g. Breaking Out in short-form while Established in long-form). Filtering by form selects Listings. Most channels produce exactly one Listing. See ADR-0002.
_Avoid_: Entry, card, row.

**Niche**:
The implicit, inferred content space a channel occupies (e.g. "AI horror shorts"). Deliberately _not_ a first-class taxonomy and never a required classification. Multiple channels in the same niche are shown as separate cards — the duplication is itself signal that the niche is hot.
_Avoid_: Category, tag (as a required field), vertical.

**Feed**:
The single global, shared discovery surface — one canonical set of tracked Channels + Snapshots that every Operator sees. Momentum and saturation are computed once, globally. Per-Operator personalization (long/short filter, stage filter, the [[Watchlist]]) is only a _lens_ on the Feed, never a private dataset.
_Avoid_: Dashboard, my channels.

**Watchlist**:
The Operator's private, curated set of clone candidates, saved from Feed cards. A watchlist entry is an `(Operator, Channel, Form)` triple — channel-anchored but form-scoped, so the two faces of a straddling channel are two distinct entries, and entries survive Listing recomputes. A _lens_ on the [[Feed]]: entries point into the shared dataset and re-derive live Listing data at read time; nothing is copied or frozen.
_Avoid_: Saved channels, favorites, bookmarks.

**Folder**:
The Operator's flat, private grouping inside the [[Watchlist]] — a named bucket expressing curation intent (e.g. "faceless", "next month"). No nesting; a watchlist entry sits in at most one Folder or at the root. Deleting a Folder returns its entries to the root — it never deletes them. Folders group; they do not rank — ordering within the Watchlist is automatic.
_Avoid_: Tag, label, category, collection.

## Discovery pipeline

The three columns are a left-to-right **momentum lifecycle**: a channel's position is a function of **momentum** and **saturation**, so the Operator can time their clone. It is _not_ three independent sorted feeds.

**Stage**:
A listing's position in the momentum lifecycle. One of Emerging, Breaking Out, or Established. Derived from [[Momentum]] + [[Saturation]], not assigned manually, with **saturation dominating**: a crowded niche is Established regardless of momentum. Otherwise strong momentum ⇒ Breaking Out, modest positive momentum ⇒ Emerging, flat/declining ⇒ Established. All thresholds are tunable.

**Emerging** (column 1):
A channel whose recent uploads are accelerating relative to its own [[Baseline]], reached via snowball, with low saturation. Operator's read: risky, but first-mover. Note: _not_ "brand new to YouTube" — we can't surface never-before-seen channels; emergence is detected as acceleration within the set we've reached.

**Breaking Out** (column 2):
[[Proven]], strong momentum, still low saturation. The sweet spot — clone _now_.

**Established** (column 3):
Too late to clone — from _either_ direction: the niche is crowded (high saturation) **or** its momentum has cooled/flattened. High saturation overrides even strong momentum.

**Snapshot**:
A point-in-time record of a tracked channel/video's view count at a timestamp. The system re-samples on a schedule and stores snapshots so momentum (a derivative) can be computed — the YouTube API only returns current counts, never history. See ADR-0001.

**Baseline**:
A channel's own historical norm for per-video performance (e.g. median views-per-video). Recent uploads are compared against it to detect acceleration. Momentum is relative to a channel's _own_ baseline, not to other channels.

**Momentum**:
How fast a channel's recent per-video viewership is accelerating relative to its own [[Baseline]], computed from the slope across [[Snapshot]]s. The primary axis of Stage. Newly discovered channels are seeded with a `views ÷ video-age` proxy until real snapshots accumulate. (Precise signal still TBD.)
_Avoid_: Trending, hype.

**Proven** (the gate):
The single hard entry gate to the Feed — the only criterion that can _exclude_ a channel. Objective proof the niche works. Precise rule: take the channel's **last ~12 uploads**, drop videos too fresh to have settled (< ~7 days old) and non-standard items (live streams, etc.); the gate passes if the **median per-video view count** of that window ≥ a **form-specific, tunable threshold**. Median (not mean) is what makes it _consistent_ — robust to a single viral fluke or one dud. Thresholds default to **100k for long-form** and a higher default (~500k) for **short-form**, since a Short hitting 100k is near-trivial. Staleness (was huge years ago, dead now) fails the gate.
_Metric note_: "100k" always means 100,000 views on an individual video, never channel totals or subscribers.

**Enrichment**:
The per-[[Listing]] AI pass that produces the subjective signals: a single **multimodal Claude call** over the channel's metadata, recent video titles, and recent **thumbnail images**, returning a structured per-signal score (0–100) plus a one-line rationale each. Runs per form (form-specific signal set). Feeds [[Clonability]]. Transcripts are deliberately out of scope — too costly for marginal gain on these particular judgments. (Cadence TBD.)

**Clonability**:
An overall per-[[Listing]] score synthesizing the _subjective_ [[Enrichment]] signals into how attractive a clone target is. Computed as a **tunable weighted mean** of the form's applicable signals (0–100), starting near-equal but biasing [[Automatable]] highest for short-form. Signal sets — short-form: [[Automatable]] + [[Transformative]] + [[Improvable]]; long-form: [[Enterprise value]] + [[Improvable]]. Rides on the card and sharpens ranking _within_ a column; it never gates. Degrades gracefully — a listing appears on the strength of the [[Proven]] gate even before its Clonability signals are computed.
_Avoid_: Quality score, rating.

**Automatable** (short-form signal):
Can the content be mass-produced from a repeatable template, cheaply (no specific on-camera talent, no expensive shoot), from an effectively _infinite_ supply of source material. Absorbs the brief's "cheap" and "infinite source pull." Weighted highest in short-form Clonability.

**Transformative** (short-form signal):
Repackages _existing_ material (compilations, reactions, edits, AI remixes) rather than requiring original creation.

**Improvable** (both forms):
Visible headroom to out-execute — lazy thumbnails, weak editing, shallow content — while the channel is _still winning_. High = easy to beat.

**Enterprise value** (long-form signal):
The niche pulls high-CPM/RPM or B2B/enterprise monetization (finance, software, industry education, high-ticket) versus low-value broad entertainment.

**Saturation**:
How many comparable channels already exist in the same (implicit) niche. The secondary axis of Stage; high saturation pushes a channel toward Established. Measured as the count of tracked channels whose content embedding falls within a similarity threshold (nearest-neighbor cluster size via Convex vector search) — this keeps niche implicit while still counting competitors. Snowball-graph density is the cold-start fallback before embeddings run.
_Avoid_: Competition, crowdedness.
