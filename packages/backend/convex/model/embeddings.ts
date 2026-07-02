/**
 * A humble embeddings adapter (ADR-0003).
 *
 * Channel content embeddings power Saturation via Convex vector search. Anthropic
 * offers no embeddings model, so the provider is Voyage/OpenAI/local, chosen at
 * build time; the default here is Voyage. Like the YouTube adapter this is a
 * "humble object" — it holds only the wire mapping and batching, never gates, and
 * is exercised behind a stub in tests. The one piece worth testing lives here as a
 * pure function: `buildChannelEmbeddingText`, which decides what text represents a
 * channel's niche.
 *
 * The vector index dimension is fixed at build time and must match this
 * provider's output, so `EMBEDDING_DIMENSIONS` is the single source both the
 * schema's vector index and the adapter read.
 */

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";

/** Default Voyage model. `voyage-3.5-lite` supports a configurable output size. */
const DEFAULT_MODEL = "voyage-3.5-lite";

/**
 * The channel-embedding dimension. Fixed at build time because a Convex vector
 * index's `dimensions` is immutable — changing provider/size means a new index.
 * Must equal the adapter's requested output size (ADR-0003).
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** Voyage accepts up to 128 inputs per request; batch to honor that ceiling. */
export const MAX_EMBED_BATCH = 128;

/** Longest channel description we fold into the embedding text — bounds tokens. */
const MAX_DESCRIPTION_CHARS = 500;

/** Most recent upload titles to include as niche signal. */
const MAX_TITLES = 8;

/**
 * The seam the embed cron depends on. The real implementation talks to an
 * embeddings provider; tests pass a stub so no network is hit.
 */
export type EmbeddingsAdapter = {
	/** Embed a batch of texts, returning one vector per input in the same order. */
	embed(texts: string[]): Promise<number[][]>;
};

/** The channel fields that carry niche signal for the embedding. */
export type EmbeddableChannel = {
	title: string;
	description?: string;
};

/**
 * The text that represents a channel's niche to the embeddings model: its title,
 * a trimmed description, and its recent upload titles (the sharpest niche signal —
 * "AI horror shorts" lives in the titles). Deterministic and bounded so the same
 * channel always embeds to the same input.
 */
export function buildChannelEmbeddingText(
	channel: EmbeddableChannel,
	recentTitles: string[],
): string {
	const parts = [channel.title.trim()];
	const description = channel.description?.trim();
	if (description) {
		parts.push(description.slice(0, MAX_DESCRIPTION_CHARS));
	}
	const titles = recentTitles
		.map((t) => t.trim())
		.filter(Boolean)
		.slice(0, MAX_TITLES);
	if (titles.length > 0) {
		parts.push(`Recent uploads:\n${titles.join("\n")}`);
	}
	return parts.join("\n\n");
}

/** Split a list into chunks of at most `size` (honors the per-request ceiling). */
function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

type VoyageResponse = {
	data?: { embedding?: number[]; index?: number }[];
};

export type VoyageOptions = {
	/** Voyage model id. Defaults to `voyage-3.5-lite`. */
	model?: string;
	/** Output dimension; must equal `EMBEDDING_DIMENSIONS`. */
	dimensions?: number;
};

/**
 * Build the real Voyage adapter. `doFetch` is injectable so the request contract
 * (endpoint, batching, output size) can be asserted without a live key.
 */
export function createVoyageEmbeddingsAdapter(
	apiKey: string,
	opts: VoyageOptions = {},
	doFetch: typeof fetch = fetch,
): EmbeddingsAdapter {
	const model = opts.model ?? DEFAULT_MODEL;
	const dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;

	return {
		async embed(texts): Promise<number[][]> {
			const vectors: number[][] = [];
			for (const batch of chunk(texts, MAX_EMBED_BATCH)) {
				const res = await doFetch(VOYAGE_API_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						input: batch,
						model,
						// `document` side of Voyage's asymmetric embeddings — these are the
						// corpus we later search over, not queries.
						input_type: "document",
						output_dimension: dimensions,
					}),
				});
				if (!res.ok) {
					throw new Error(
						`Voyage embeddings failed: ${res.status} ${res.statusText}`,
					);
				}
				const body = (await res.json()) as VoyageResponse;
				// Order by `index` defensively so a vector never lands on the wrong
				// channel, then drop the index.
				const ordered = [...(body.data ?? [])].sort(
					(a, b) => (a.index ?? 0) - (b.index ?? 0),
				);
				for (const item of ordered) {
					vectors.push(item.embedding ?? []);
				}
			}
			return vectors;
		},
	};
}
