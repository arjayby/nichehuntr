/**
 * Pure paste resolution for admin Submissions (ADR-0005).
 *
 * This slice resolves only a raw `UC…` channel id — the spine's tracer-bullet
 * path. Channel URLs and bare handles are a follow-up slice (they need a live
 * lookup, which belongs behind the adapter, not in this pure function). Keeping
 * resolution pure makes it the primary test seam: string in, canonical id or
 * `null` out, no I/O.
 */

/**
 * A canonical YouTube channel id: the literal `UC` prefix followed by 22 chars
 * of the base64url alphabet (letters, digits, `-`, `_`). Deliberately strict so
 * a stray paste can't masquerade as an id and reach the API.
 */
const RAW_CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;

/**
 * Resolve a pasted Submission input to a canonical `UC…` channel id, or `null`
 * if it isn't one this slice can handle. Trims surrounding whitespace first; a
 * `null` return is the worker's cue to `fail` the Submission with a clear reason
 * (unresolvable input), distinct from a downstream API error.
 */
export function resolveChannelId(rawInput: string): string | null {
	const trimmed = rawInput.trim();
	return RAW_CHANNEL_ID.test(trimmed) ? trimmed : null;
}
