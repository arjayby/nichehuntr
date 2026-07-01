# The atomic scored unit is a Listing = (Channel, Form), with per-form metrics

The unit that is gated, staged, scored, and rendered as a card is a **Listing**: a `(Channel, Form)` pair, not a bare Channel. A channel's videos are partitioned by duration (short-form ≤ ~3 min, else long-form), and **Proven**, **Momentum**, **Saturation**, **Stage**, and **Clonability** are computed independently over each form's videos. A channel therefore produces up to two Listings and may straddle — e.g. *Breaking Out* under the short-form filter while *Established* under long-form — each with its own honest numbers.

## Considered Options

- **Listing = (Channel, Form), per-form metrics (chosen).** Straddling channels get independent, honest signals per form. Cheap because every video already carries a `duration`, so partitioning is free.
- **Form as a mere filter tag, one blended metric set per channel (rejected).** Simpler to build, but a straddler's momentum and saturation smear across two very different content modes and mislead — defeating the app's core promise of per-form/per-niche timing precision.

## Consequences

- A straddling channel appears **twice** (once per form filter). This is intended: it's honest, and cross-niche duplication is already treated as signal.
- The schema keys metrics by `(channelId, form)`, not `channelId`.
- Form membership is a **set** ({short}, {long}, or {short, long}), derived per channel from its videos passing each form's independent Proven gate.
