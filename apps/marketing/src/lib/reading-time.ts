/**
 * Estimate reading time in minutes from a post's raw markdown body.
 *
 * Inline HTML (the SVG figures) would massively inflate a naive word count —
 * every attribute splits as a "word" — so markup is stripped before counting
 * prose. Each figure instead adds a fixed viewing cost (Medium's ~12s
 * heuristic), so the estimate tracks the actual content of the post.
 */
const WORDS_PER_MINUTE = 200;
const SECONDS_PER_FIGURE = 12;

export function readingTime(body: string | undefined): number {
	const source = body ?? "";
	// Count figures before stripping: raw <figure> blocks and markdown images.
	const figures = (source.match(/<figure[\s>]|!\[/g) ?? []).length;
	const prose = source
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<[^>]+>/g, " ");
	const words = prose.split(/\s+/).filter(Boolean).length;
	const minutes =
		words / WORDS_PER_MINUTE + (figures * SECONDS_PER_FIGURE) / 60;
	return Math.max(1, Math.round(minutes));
}
