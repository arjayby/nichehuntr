/**
 * Pure paste resolution for admin Submissions (ADR-0005).
 *
 * `resolveChannelRef` normalizes whatever an Admin pastes — a raw `UC…` id, a
 * `/channel/UC…` or `/@handle` URL, or a bare `@handle` — into a canonical
 * reference. Two of those forms (a raw id, a `/channel/` URL) resolve straight to
 * an id with no I/O; a handle only names the channel and still needs a live
 * lookup, so it stays a `handle` ref for the worker to resolve behind the adapter.
 * Everything else (video URLs, legacy `/c/` and `/user/` paths, garbage) becomes a
 * typed `error` carrying the human-readable reason the worker records on a `failed`
 * Submission.
 *
 * Keeping this pure — string in, discriminated union out, no network — makes it the
 * primary test seam, mirroring the pure Channel lifecycle tests.
 */

/**
 * A canonical YouTube channel id: the literal `UC` prefix followed by 22 chars of
 * the base64url alphabet (letters, digits, `-`, `_`). Deliberately strict so a
 * stray paste can't masquerade as an id and reach the API.
 */
const RAW_CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;

/**
 * A YouTube handle: `@` plus 3–30 chars of letters, digits, `_`, `.`, `-` (the
 * character set YouTube permits). Used both for a bare `@handle` paste and the
 * `@handle` segment of a channel URL.
 */
const HANDLE = /^@[A-Za-z0-9_.-]{3,30}$/;

/** Hosts we treat as YouTube channel URLs. `youtu.be` is deliberately excluded —
 * it only ever shortens a *video* link, so it's handled as out-of-scope below. */
const YOUTUBE_HOSTS = new Set([
	"youtube.com",
	"www.youtube.com",
	"m.youtube.com",
]);

const UNRECOGNIZED =
	"Couldn't recognize that. Paste a channel URL, an @handle, or a UC… id.";
const VIDEO_URL =
	"That's a video URL. Paste the channel's URL or @handle instead.";
const LEGACY =
	"Legacy /c/ and /user/ URLs aren't supported. Paste the channel's @handle or /channel/UC… URL.";
const MALFORMED_ID = "That channel URL's id isn't a valid UC… id.";
const INVALID_HANDLE = "That doesn't look like a valid @handle.";

/**
 * A resolved Submission paste. `id` is a canonical channel id ready to ingest;
 * `handle` still needs a live lookup to become an id; `error` carries the reason
 * the worker records on a `failed` Submission (CONTEXT.md: Submission).
 */
export type ChannelRef =
	| { kind: "id"; id: string }
	| { kind: "handle"; handle: string }
	| { kind: "error"; reason: string };

/** A validated `@handle` ref, or a typed error if the string isn't a valid handle. */
function handleRef(handle: string): ChannelRef {
	return HANDLE.test(handle)
		? { kind: "handle", handle }
		: { kind: "error", reason: INVALID_HANDLE };
}

/** Parse a string into a URL if it names a YouTube host, tacking on a scheme when
 * the paste omits one (`youtube.com/@x`). Returns `null` for anything that isn't a
 * parseable URL on a YouTube (or `youtu.be`) host. */
function tryParseYouTubeUrl(input: string): URL | null {
	const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	return YOUTUBE_HOSTS.has(url.hostname) || url.hostname === "youtu.be"
		? url
		: null;
}

/** Resolve a parsed YouTube URL to a ref by dispatching on its first path segment. */
function refFromUrl(url: URL): ChannelRef {
	// A youtu.be link is always a video short-link — never a channel.
	if (url.hostname === "youtu.be") {
		return { kind: "error", reason: VIDEO_URL };
	}
	const [first, second] = url.pathname.split("/").filter((s) => s.length > 0);
	if (first === undefined) {
		return { kind: "error", reason: UNRECOGNIZED };
	}
	if (first.startsWith("@")) {
		return handleRef(first);
	}
	if (first === "channel") {
		return second !== undefined && RAW_CHANNEL_ID.test(second)
			? { kind: "id", id: second }
			: { kind: "error", reason: MALFORMED_ID };
	}
	if (first === "c" || first === "user") {
		return { kind: "error", reason: LEGACY };
	}
	if (
		first === "watch" ||
		first === "shorts" ||
		first === "embed" ||
		first === "v" ||
		first === "live"
	) {
		return { kind: "error", reason: VIDEO_URL };
	}
	return { kind: "error", reason: UNRECOGNIZED };
}

/**
 * Normalize a pasted Submission input to a canonical {@link ChannelRef}. Trims
 * surrounding whitespace, then recognizes (in order) a raw `UC…` id, a bare
 * `@handle`, and a YouTube channel URL; anything else — including video URLs and
 * legacy `/c/` `/user/` paths — becomes a typed `error` the worker surfaces as the
 * Submission's failure reason.
 */
export function resolveChannelRef(rawInput: string): ChannelRef {
	const trimmed = rawInput.trim();
	if (RAW_CHANNEL_ID.test(trimmed)) {
		return { kind: "id", id: trimmed };
	}
	if (trimmed.startsWith("@")) {
		return handleRef(trimmed);
	}
	const url = tryParseYouTubeUrl(trimmed);
	if (url !== null) {
		return refFromUrl(url);
	}
	return { kind: "error", reason: UNRECOGNIZED };
}
