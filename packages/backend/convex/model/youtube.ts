/**
 * A humble YouTube Data API v3 adapter (ADR-0001).
 *
 * This is a "humble object": the only logic it holds is the mapping of YouTube's
 * wire format into our domain shapes plus quota discipline (batch 50 ids / unit,
 * never `search.list`). Everything worth testing — the Proven gate, upserts,
 * Listing derivation — lives behind it and is exercised with a stub adapter, so
 * this file is deliberately thin and is not richly tested against the network.
 */

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

/** YouTube caps `id`-list requests at 50 ids per unit of quota (ADR-0001). */
export const MAX_IDS_PER_REQUEST = 50;

/** Channel identity/metadata for the `channels` table. */
export type ChannelInfo = {
	ytChannelId: string;
	title: string;
	handle?: string;
	avatarUrl?: string;
	description?: string;
};

/** A point-in-time view count for one video, feeding a `videoSnapshots` row. */
export type VideoStat = { ytVideoId: string; viewCount: number };

/**
 * The seam the ingestion upkeep depends on. Real implementation talks to
 * YouTube; tests pass a stub so no network is hit. Automated discovery is gone
 * (ADR-0005), so this is down to channel metadata and the snapshot stats refresh
 * — a later slice adds `fetchChannelUploads` for the Submission backfill.
 */
export type YouTubeAdapter = {
	fetchChannels(channelIds: string[]): Promise<ChannelInfo[]>;
	fetchVideoStats(videoIds: string[]): Promise<VideoStat[]>;
};

/** Split a list into chunks of at most `size` (used to honor the 50-id cap). */
export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/**
 * Parse an ISO-8601 duration (e.g. `PT1H2M3S`, `PT45S`, `P0D`) into whole
 * seconds. Live streams report `P0D`, which maps to 0. Anything unparseable is
 * treated as 0 so a malformed field never crashes ingestion.
 */
export function parseIso8601Duration(iso: string): number {
	const match =
		/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
			iso,
		);
	if (!match) return 0;
	const [, weeks, days, hours, minutes, seconds] = match;
	return (
		Number(weeks ?? 0) * 7 * 86400 +
		Number(days ?? 0) * 86400 +
		Number(hours ?? 0) * 3600 +
		Number(minutes ?? 0) * 60 +
		Number(seconds ?? 0)
	);
}

// --- YouTube wire shapes (only the fields we consume) --------------------------

type ThumbnailSet = Record<string, { url?: string } | undefined>;

type VideoResource = {
	id: string;
	statistics?: { viewCount?: string };
};

type ChannelResource = {
	id: string;
	snippet?: {
		title?: string;
		customUrl?: string;
		description?: string;
		thumbnails?: ThumbnailSet;
	};
};

type ListResponse<T> = { items?: T[] };

/** Prefer the crispest thumbnail YouTube offers, falling back progressively. */
function pickThumbnail(thumbnails?: ThumbnailSet): string | undefined {
	if (!thumbnails) return undefined;
	return (
		thumbnails.high?.url ??
		thumbnails.medium?.url ??
		thumbnails.default?.url ??
		undefined
	);
}

function toViewCount(raw?: string): number {
	const n = Number(raw);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Build the real adapter. `doFetch` is injectable purely so the quota contract
 * (batching, endpoints hit) can be asserted without a live key.
 */
export function createYouTubeAdapter(
	apiKey: string,
	doFetch: typeof fetch = fetch,
): YouTubeAdapter {
	async function get<T>(
		path: string,
		params: Record<string, string>,
	): Promise<ListResponse<T>> {
		const url = new URL(`${YT_API_BASE}/${path}`);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		url.searchParams.set("key", apiKey);
		const res = await doFetch(url.toString());
		if (!res.ok) {
			throw new Error(
				`YouTube API ${path} failed: ${res.status} ${res.statusText}`,
			);
		}
		return (await res.json()) as ListResponse<T>;
	}

	/** Fetch a `videos.list`/`channels.list` resource for many ids, 50 at a time. */
	async function getByIds<T>(
		path: string,
		part: string,
		ids: string[],
	): Promise<T[]> {
		const items: T[] = [];
		for (const batch of chunk(ids, MAX_IDS_PER_REQUEST)) {
			const body = await get<T>(path, { part, id: batch.join(",") });
			items.push(...(body.items ?? []));
		}
		return items;
	}

	return {
		async fetchChannels(channelIds): Promise<ChannelInfo[]> {
			const items = await getByIds<ChannelResource>(
				"channels",
				"snippet",
				channelIds,
			);
			return items.map((item) => ({
				ytChannelId: item.id,
				title: item.snippet?.title ?? "",
				handle: item.snippet?.customUrl,
				avatarUrl: pickThumbnail(item.snippet?.thumbnails),
				description: item.snippet?.description,
			}));
		},

		async fetchVideoStats(videoIds): Promise<VideoStat[]> {
			const items = await getByIds<VideoResource>(
				"videos",
				"statistics",
				videoIds,
			);
			return items.map((item) => ({
				ytVideoId: item.id,
				viewCount: toViewCount(item.statistics?.viewCount),
			}));
		},
	};
}
