/**
 * A humble YouTube Data API v3 adapter (ADR-0001).
 *
 * This is a "humble object": the only logic it holds is the mapping of YouTube's
 * wire format into our domain shapes plus quota discipline (batch 50 ids / unit,
 * never `search.list`). Everything worth testing — Channel lifecycle, upserts,
 * and submission orchestration — lives behind it and is exercised with a stub
 * adapter, so this file is deliberately thin and is not richly tested against
 * the network.
 */

import { SHORT_MAX_SEC } from "./channelLifecycle";

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
	subscriberCount?: number;
};

/**
 * One backfilled short-form upload — the shape the shared write path
 * (`upsertDiscovered`) ingests. Hydrated from `videos.list` so it carries
 * duration, a fresh view count, and standardness (live streams/premieres).
 */
export type ChannelUpload = {
	ytVideoId: string;
	ytChannelId: string;
	title: string;
	thumbnailUrl?: string;
	durationSec: number;
	/** Upload time, ms since epoch. */
	publishedAt: number;
	viewCount: number;
	/** False for live streams / premieres, which lifecycle evidence excludes. */
	isStandard: boolean;
};

/**
 * A raw `search.list` hit before hydration: the candidate video and the channel
 * that published it. `search.list` returns the channel id in the snippet but no
 * statistics, so the Scout uses this to drop already-tracked channels *before*
 * spending a hydration unit on their videos (ADR-0008).
 */
export type CandidateRef = {
	ytVideoId: string;
	ytChannelId: string;
};

/** A hydrated candidate video: identity plus the current view count the Scout
 * ranks unseen channels by. */
export type CandidateVideoStats = {
	ytVideoId: string;
	ytChannelId: string;
	viewCount: number;
};

/**
 * The seam the ingestion upkeep, the Submission worker, and the Scout depend on.
 * Real implementation talks to YouTube; tests pass a stub so no network is hit.
 * Channel metadata and `fetchChannelUploads` back the Submission backfill;
 * `searchRecentShorts` + `hydrateCandidateStats` are the Scout's discovery seam
 * — the one place this humble adapter deliberately spends `search.list` quota
 * (ADR-0008 amends ADR-0001's "never search.list" note).
 */
export type YouTubeAdapter = {
	fetchChannels(channelIds: string[]): Promise<ChannelInfo[]>;
	fetchChannelUploads(
		channelId: string,
		opts?: { limit?: number },
	): Promise<ChannelUpload[]>;
	/** Resolve a `@handle` to its canonical `UC…` channel id (or `null` if no
	 * channel owns it). The Submission worker's handle-lookup seam — a URL/id paste
	 * never reaches it. One `channels.list?forHandle` unit. */
	resolveHandle(handle: string): Promise<string | null>;
	/**
	 * Search recent, popular Shorts for a Niche Query — the Scout's discovery seam.
	 * One `search.list` unit (100 quota): `type=video`, `videoDuration=short`,
	 * `order=viewCount`, and `publishedAfter` the recent-window cutoff (ms epoch).
	 * Returns the hits as `{video, channel}` refs — `search.list` carries no
	 * statistics — so the Scout can drop already-tracked channels before hydrating.
	 * Throws {@link QuotaExceededError} when the day's quota is exhausted.
	 */
	searchRecentShorts(
		query: string,
		opts: { publishedAfter: number; maxResults: number },
	): Promise<CandidateRef[]>;
	/** Hydrate candidate videos with their current view counts via `videos.list`,
	 * 50 ids per unit — the Scout ranks unseen channels by these. */
	hydrateCandidateStats(videoIds: string[]): Promise<CandidateVideoStats[]>;
};

/**
 * Thrown when YouTube reports daily quota exhaustion (a `403` whose body carries
 * the `quotaExceeded` reason). The Scout treats this specially: it aborts the
 * whole run cleanly rather than skipping a single query, so the failure mode is
 * fewer searches, not a half-ingested run (PRD user story #15).
 */
export class QuotaExceededError extends Error {
	constructor() {
		super("YouTube API daily quota exceeded");
		this.name = "QuotaExceededError";
	}
}

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
	snippet?: {
		title?: string;
		channelId?: string;
		publishedAt?: string;
		liveBroadcastContent?: string;
		thumbnails?: ThumbnailSet;
	};
	contentDetails?: { duration?: string };
	statistics?: { viewCount?: string };
};

type PlaylistItemResource = {
	contentDetails?: { videoId?: string };
};

type SearchResultResource = {
	id?: { videoId?: string };
	snippet?: { channelId?: string };
};

type ChannelResource = {
	id: string;
	snippet?: {
		title?: string;
		customUrl?: string;
		description?: string;
		thumbnails?: ThumbnailSet;
	};
	statistics?: {
		subscriberCount?: string;
		hiddenSubscriberCount?: boolean;
	};
};

type ListResponse<T> = { items?: T[]; nextPageToken?: string };

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
			// YouTube signals daily quota exhaustion as a `403` carrying a
			// `quotaExceeded` reason; surface it as a typed error the Scout can abort
			// the whole run on. Any other failure stays a loud generic throw.
			const body = await res.text().catch(() => "");
			if (res.status === 403 && body.includes("quotaExceeded")) {
				throw new QuotaExceededError();
			}
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
				"snippet,statistics",
				channelIds,
			);
			return items.map((item) => ({
				ytChannelId: item.id,
				title: item.snippet?.title ?? "",
				handle: item.snippet?.customUrl,
				avatarUrl: pickThumbnail(item.snippet?.thumbnails),
				description: item.snippet?.description,
				subscriberCount:
					item.statistics?.hiddenSubscriberCount === true
						? undefined
						: toViewCount(item.statistics?.subscriberCount),
			}));
		},

		async searchRecentShorts(query, opts): Promise<CandidateRef[]> {
			// `search.list` is the Scout's one deliberate search spend (100 units). It
			// carries no statistics, so we return just the video + channel ids and
			// hydrate view counts separately after tracked channels are filtered out.
			const body = await get<SearchResultResource>("search", {
				part: "snippet",
				type: "video",
				videoDuration: "short",
				order: "viewCount",
				q: query,
				maxResults: String(opts.maxResults),
				publishedAfter: new Date(opts.publishedAfter).toISOString(),
			});
			const refs: CandidateRef[] = [];
			for (const item of body.items ?? []) {
				const ytVideoId = item.id?.videoId;
				const ytChannelId = item.snippet?.channelId;
				if (ytVideoId !== undefined && ytChannelId !== undefined) {
					refs.push({ ytVideoId, ytChannelId });
				}
			}
			return refs;
		},

		async hydrateCandidateStats(videoIds): Promise<CandidateVideoStats[]> {
			// One `videos.list` unit per 50 ids (the shared 50-id batching), returning
			// only what ranking needs: the publishing channel and current view count.
			const items = await getByIds<VideoResource>(
				"videos",
				"snippet,statistics",
				videoIds,
			);
			return items.map((item) => ({
				ytVideoId: item.id,
				ytChannelId: item.snippet?.channelId ?? "",
				viewCount: toViewCount(item.statistics?.viewCount),
			}));
		},

		async resolveHandle(handle): Promise<string | null> {
			// `forHandle` accepts the handle with or without the leading `@`; strip
			// it so a paste like `@mrbeast` and the URL form `/@mrbeast` hit the same
			// query. `part=id` is the cheapest projection — the worker fetches full
			// metadata separately via `fetchChannels`.
			const body = await get<ChannelResource>("channels", {
				part: "id",
				forHandle: handle.replace(/^@/, ""),
			});
			return body.items?.[0]?.id ?? null;
		},

		async fetchChannelUploads(channelId, opts): Promise<ChannelUpload[]> {
			// Every channel's uploads live in a playlist whose id is the channel id
			// with the `UC` prefix swapped for `UU` — a documented YouTube invariant,
			// so we page it directly without spending a `channels.list` unit first.
			// Keep paging until the hydrated uploads contain the requested number of
			// Shorts or the playlist ends. Duration is only known after videos.list
			// hydration, so long-form uploads are skipped after hydration rather than
			// returned to the write path.
			const uploadsPlaylistId = `UU${channelId.slice(2)}`;
			const shortTarget = opts?.limit ?? MAX_IDS_PER_REQUEST;
			const uploads: ChannelUpload[] = [];
			let shortCount = 0;
			let pageToken: string | undefined;
			while (shortCount < shortTarget) {
				const params: Record<string, string> = {
					part: "contentDetails",
					playlistId: uploadsPlaylistId,
					maxResults: String(MAX_IDS_PER_REQUEST),
				};
				if (pageToken !== undefined) {
					params.pageToken = pageToken;
				}
				const page = await get<PlaylistItemResource>("playlistItems", params);
				const videoIds = (page.items ?? [])
					.map((item) => item.contentDetails?.videoId)
					.filter((id): id is string => id !== undefined);
				if (videoIds.length > 0) {
					// One hydration batch pulls duration, a fresh view count, and
					// standardness for the whole page.
					const items = await getByIds<VideoResource>(
						"videos",
						"snippet,contentDetails,statistics",
						videoIds,
					);
					const hydrated = items.map((item) => ({
						ytVideoId: item.id,
						ytChannelId: item.snippet?.channelId ?? channelId,
						title: item.snippet?.title ?? "",
						thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
						durationSec: parseIso8601Duration(
							item.contentDetails?.duration ?? "",
						),
						publishedAt: Date.parse(item.snippet?.publishedAt ?? "") || 0,
						viewCount: toViewCount(item.statistics?.viewCount),
						isStandard:
							(item.snippet?.liveBroadcastContent ?? "none") === "none",
					}));
					for (const upload of hydrated) {
						if (upload.durationSec > SHORT_MAX_SEC) {
							continue;
						}
						if (shortCount >= shortTarget) {
							continue;
						}
						shortCount += 1;
						uploads.push(upload);
					}
				}
				pageToken = page.nextPageToken;
				if (pageToken === undefined) {
					break;
				}
			}
			return uploads;
		},
	};
}
