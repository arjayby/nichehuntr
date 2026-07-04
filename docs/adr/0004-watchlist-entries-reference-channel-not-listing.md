# Watchlist entries reference (Channel, Form), never a Listing id

A Watchlist entry is stored as an `(Operator, channelId, form)` triple. It deliberately does **not** hold a `v.id("listings")`, even though the thing the Operator clicked Save on is a Listing card and the drawer's detail pane displays Listing data.

## Context

Listings are a derived read model: the recompute pipeline **deletes and reinserts** a channel's Listing rows (ADR-0002), so any stored Listing id dangles after the next recompute. Meanwhile a channel can fall out of the Feed entirely (fails the Proven gate, or a form face stops being emitted) — and per the Watchlist's design, the entry must survive that and degrade visibly rather than vanish.

## Considered Options

- **Reference `(channelId, form)` (chosen).** Channels are stable entities; the pair re-derives the live Listing at read time by the existing `by_channel` lookup. Entries survive recomputes and Feed exits for free, and Listing-level display fidelity is preserved because the form is captured.
- **Reference `listingId` (rejected).** The natural-looking foreign key, but it breaks on every recompute — requiring either recompute-time fixup of all watchlists or cascading deletes that silently eat Operators' saves.
- **Reference bare `channelId` (rejected).** Loses which face of a straddling channel was saved; the detail pane would have to guess a form or show both, and "saved as a short-form clone target" is real intent worth keeping.

## Consequences

- The Watchlist stays a pure **lens**: no Listing data is ever copied into an entry; the detail pane always shows live truth, including "no longer on the Feed."
- A straddling channel saved from both cards yields two distinct entries; dedupe is on the full `(Operator, channelId, form)` triple.
- Every drawer read does a join (`entry → listing by (channelId, form)`); the join can come back empty and the UI must render that degraded state, not treat it as an error.
