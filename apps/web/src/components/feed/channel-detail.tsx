import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { Id } from "@nichehuntr/backend/convex/_generated/dataModel";
import {
	CHANNEL_SIGNAL_NAMES,
	topSignals,
} from "@nichehuntr/backend/convex/model/clonability";
import type {
	WatchlistDetail,
	WatchlistSelection,
	WatchlistUpload,
} from "@nichehuntr/backend/convex/watchlist";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@nichehuntr/ui/components/dialog";
import { Skeleton } from "@nichehuntr/ui/components/skeleton";
import { useQuery } from "convex/react";
import { AlertCircle, Bookmark, ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";

import {
	ClonabilityRead,
	channelUrl,
	compactViews,
	initials,
	STAGE_LABELS,
} from "@/components/feed/channel-card";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The identity we can paint the instant the modal opens — the Channel plus the
 * name/avatar/handle we already held on the clicked card or saved row. It seeds
 * the header so the modal never opens on a bare spinner; the
 * scored body skeletons in until `watchlist.detail` resolves. Deep-links have no
 * seed (nothing was clicked), so the header skeletons too. Shape is a subset of
 * both `FeedCard` and `WatchlistEntry`, so either can produce one directly.
 */
export type ChannelDetailSeed = {
	channelId: Id<"channels">;
	channel: {
		ytId: string;
		title: string;
		handle: string | null;
		avatarUrl: string | null;
	};
};

/** The resolved detail carries the same identity fields as a seed, so the header
 * renders off one shape whether it's painting the seed or the live detail. */
function identityFromDetail(detail: WatchlistDetail): ChannelDetailSeed {
	return {
		channelId: detail.channelId,
		channel: detail.channel,
	};
}

/** Coarse upload age for the strip, e.g. "3d", "2w", "5mo", "1y". */
export function uploadAge(publishedAt: number, now = Date.now()): string {
	const days = Math.max(0, Math.floor((now - publishedAt) / DAY_MS));
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

function UploadTile({ upload }: { upload: WatchlistUpload }) {
	return (
		<li className="w-32 shrink-0">
			{upload.thumbnailUrl ? (
				<img
					src={upload.thumbnailUrl}
					alt=""
					className="aspect-video w-full rounded-md object-cover"
				/>
			) : (
				<div className="flex aspect-video w-full items-center justify-center rounded-md bg-muted text-muted-foreground text-xs">
					No thumbnail
				</div>
			)}
			<p className="mt-1 line-clamp-2 text-xs" title={upload.title}>
				{upload.title}
			</p>
			<p className="text-muted-foreground text-xs tabular-nums">
				{upload.viewCount !== null
					? `${compactViews.format(upload.viewCount)} views`
					: "views pending"}
				{" · "}
				{uploadAge(upload.publishedAt)}
			</p>
		</li>
	);
}

/** The last ~12 standard short-form uploads, newest-first, as a
 * horizontally scrolling strip. Videos persist, so this renders in the
 * degraded off-feed state too. */
function UploadsStrip({ uploads }: { uploads: WatchlistUpload[] }) {
	return (
		<section>
			<h3 className="mb-2 text-muted-foreground text-xs">Recent uploads</h3>
			{uploads.length === 0 ? (
				<p className="rounded-2xl border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-xs">
					No uploads tracked yet.
				</p>
			) : (
				<ul className="flex gap-2 overflow-x-auto pb-1">
					{uploads.map((upload) => (
						<UploadTile key={upload.videoId} upload={upload} />
					))}
				</ul>
			)}
		</section>
	);
}

/** Every scored signal with its untruncated rationale — the full "why" behind
 * the Clonability number, not the card's top-two teaser. */
function SignalBreakdown({
	feed,
}: {
	feed: NonNullable<WatchlistDetail["feed"]>;
}) {
	// All of the scored signals, not the card's top-two teaser.
	const signals = topSignals(feed.signals, CHANNEL_SIGNAL_NAMES.length);
	if (signals.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">Signals not scored yet.</p>
		);
	}
	return (
		<ul className="flex flex-col gap-2">
			{signals.map((signal) => (
				<li key={signal.name} className="text-xs">
					<div className="flex items-baseline gap-1.5">
						<span className="font-medium">{signal.label}</span>
						<span className="text-muted-foreground tabular-nums">
							{signal.score}
						</span>
					</div>
					<p className="text-muted-foreground">{signal.rationale}</p>
				</li>
			))}
		</ul>
	);
}

/** The modal's top-right control cluster: save toggle, open-on-YouTube, close —
 * mirroring the Feed card's own [bookmark][external-link] pair, with the dialog's
 * dismiss folded onto the end. Driven by the identity (seed or live detail), so
 * it's live from the instant the modal opens. */
function DetailControls({
	identity,
	saved,
	onToggleSave,
}: {
	identity: ChannelDetailSeed;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-1">
			<button
				type="button"
				aria-pressed={saved}
				aria-label={saved ? "Remove from Watchlist" : "Save to Watchlist"}
				title={saved ? "Remove from Watchlist" : "Save to Watchlist"}
				onClick={() => onToggleSave({ channelId: identity.channelId })}
				className={`rounded-md p-1.5 transition-colors ${
					saved ? "text-primary" : "text-muted-foreground hover:text-foreground"
				}`}
			>
				<Bookmark className={`size-4 ${saved ? "fill-current" : ""}`} />
			</button>
			<a
				href={channelUrl(identity.channel)}
				target="_blank"
				rel="noreferrer"
				aria-label="Open channel on YouTube"
				title="Open channel on YouTube"
				className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
			>
				<ExternalLink className="size-4" />
			</a>
			<DialogClose
				aria-label="Close"
				className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
			>
				<X className="size-4" />
			</DialogClose>
		</div>
	);
}

/** Identity row for the detail: avatar, title, and the channel handle. The save
 * / external / close controls ride at the far right. Paints
 * from the seed the instant the modal opens, then from the live detail. */
function DetailHeader({
	identity,
	saved,
	onToggleSave,
}: {
	identity: ChannelDetailSeed;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
}) {
	return (
		<header className="flex items-start gap-3">
			{identity.channel.avatarUrl ? (
				<img
					src={identity.channel.avatarUrl}
					alt={`${identity.channel.title} avatar`}
					className="size-10 shrink-0 rounded-full object-cover"
				/>
			) : (
				<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs">
					{initials(identity.channel.title)}
				</div>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<DialogTitle className="truncate text-sm">
						{identity.channel.title}
					</DialogTitle>
				</div>
				<DialogDescription className="text-xs">
					{identity.channel.handle
						? `@${identity.channel.handle}`
						: "Channel detail"}
				</DialogDescription>
			</div>
			<DetailControls
				identity={identity}
				saved={saved}
				onToggleSave={onToggleSave}
			/>
		</header>
	);
}

/** The header with no identity yet — a deep-link or refresh that opened the modal
 * without a clicked card in hand. Avatar/title/handle skeleton in; only the close
 * control is live (save / external need the resolved channel). */
function DetailHeaderSkeleton() {
	return (
		<header className="flex items-start gap-3">
			<DialogTitle className="sr-only">Channel detail</DialogTitle>
			<Skeleton className="size-10 shrink-0 rounded-full" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1">
				<Skeleton className="h-4 w-40 max-w-full" />
				<Skeleton className="h-3 w-24 max-w-full" />
			</div>
			<DialogClose
				aria-label="Close"
				className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
			>
				<X className="size-4" />
			</DialogClose>
		</header>
	);
}

/** The scored half of the detail while `watchlist.detail` is still in flight.
 * Mirrors the resolved lifecycle evidence, signals, and uploads strip so the
 * swap-in doesn't reflow. */
function DetailBodySkeleton() {
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-4/5" />
			</div>
			<div className="flex items-center gap-2">
				<Skeleton className="h-6 w-24 rounded-full" />
				<Skeleton className="h-4 w-16" />
			</div>
			<div className="flex items-end justify-between gap-3">
				<div className="flex flex-col gap-1">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-6 w-16" />
				</div>
				<Skeleton className="h-9 w-16" />
				<Skeleton className="h-9 w-16" />
			</div>
			<div className="flex flex-col gap-2">
				{[0, 1, 2].map((row) => (
					<div key={row} className="flex flex-col gap-1">
						<Skeleton className="h-3 w-32" />
						<Skeleton className="h-3 w-full" />
					</div>
				))}
			</div>
			<section>
				<Skeleton className="mb-2 h-3 w-24" />
				<div className="flex gap-2 overflow-hidden">
					{[0, 1, 2, 3].map((tile) => (
						<div key={tile} className="flex w-32 shrink-0 flex-col gap-1">
							<Skeleton className="aspect-video w-full rounded-md" />
							<Skeleton className="h-3 w-full" />
							<Skeleton className="h-3 w-2/3" />
						</div>
					))}
				</div>
			</section>
		</>
	);
}

/**
 * The resolved detail body below the header: Feed state is re-derived live, so
 * when the Channel is off the Feed the pane degrades to just the description +
 * uploads with an explicit notice — a product state, not an error — since the
 * videos persist even when the Channel is hidden.
 */
function DetailBodyContent({ detail }: { detail: WatchlistDetail }) {
	const feed = detail.feed;
	return (
		<>
			{detail.channel.description ? (
				<p className="text-muted-foreground text-xs">
					{detail.channel.description}
				</p>
			) : null}
			{feed !== null ? (
				<>
					<div className="flex items-center gap-2">
						<span className="rounded-full border border-border px-2 py-0.5 font-medium text-xs">
							{STAGE_LABELS[feed.stage]}
						</span>
					</div>
					<div className="flex items-end justify-between gap-3">
						<div>
							<div className="text-muted-foreground text-xs">Subscribers</div>
							<div className="font-semibold text-lg tabular-nums">
								{compactViews.format(feed.evidence.subscriberCount)}
							</div>
						</div>
						<div className="text-center">
							<div className="text-muted-foreground text-xs">Recent reach</div>
							<div className="font-semibold text-lg tabular-nums">
								{feed.evidence.shortsAtOrAbove100k}/
								{feed.evidence.recentShortsChecked}
							</div>
							<div className="text-[11px] text-muted-foreground">
								100K+ Shorts
							</div>
						</div>
						<ClonabilityRead clonability={feed.clonability} />
					</div>
					<div className="grid grid-cols-2 gap-2 rounded-md bg-muted/60 px-2 py-1 text-xs">
						<span className="text-muted-foreground">Shorts fetched</span>
						<span className="text-right font-medium tabular-nums">
							{feed.evidence.fetchedShorts}
						</span>
						<span className="text-muted-foreground">50K+ Shorts</span>
						<span className="text-right font-medium tabular-nums">
							{feed.evidence.shortsAtOrAbove50k}/
							{feed.evidence.recentShortsChecked}
						</span>
					</div>
					<SignalBreakdown feed={feed} />
				</>
			) : (
				<p className="flex items-center gap-2 rounded-2xl border border-border border-dashed px-3 py-2 text-muted-foreground text-xs">
					<AlertCircle className="size-3.5 shrink-0" aria-hidden />
					No longer on the Feed — scores are unavailable.
				</p>
			)}
			<UploadsStrip uploads={detail.uploads} />
		</>
	);
}

/** The "this channel record is gone" terminal state (detail resolved to null),
 * distinct from the off-Feed degrade handled inside DetailBodyContent. */
function ChannelUnavailable() {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-start justify-between gap-3">
				<DialogTitle className="text-sm">Channel unavailable</DialogTitle>
				<DialogClose
					aria-label="Close"
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
				>
					<X className="size-4" />
				</DialogClose>
			</div>
			<DialogDescription className="text-xs">
				This channel is no longer available.
			</DialogDescription>
		</div>
	);
}

/** The content shown for one open (or closing) detail: header first — from the
 * seed or the live detail, else a skeleton — then the scored body, skeletoned
 * until the query resolves. `detail === null` is the channel-gone terminal. */
function DetailContent({
	seed,
	detail,
	saved,
	onToggleSave,
}: {
	seed: ChannelDetailSeed | null;
	detail: WatchlistDetail | null | undefined;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
}) {
	if (detail === null) {
		return <ChannelUnavailable />;
	}
	const identity = detail !== undefined ? identityFromDetail(detail) : seed;
	return (
		<div className="flex min-w-0 flex-col gap-4">
			{identity ? (
				<DetailHeader
					identity={identity}
					saved={saved}
					onToggleSave={onToggleSave}
				/>
			) : (
				<DetailHeaderSkeleton />
			)}
			{detail === undefined ? (
				<DetailBodySkeleton />
			) : (
				<DetailBodyContent detail={detail} />
			)}
		</div>
	);
}

/**
 * The channel-details modal, opened from a Feed card or a saved Watchlist row.
 * Open state is owned by the caller (a URL search param on the Feed route), so
 * the detail is deep-linkable and the browser Back button closes it. Powered by
 * `watchlist.detail`, which resolves for any Channel — saved or not — so
 * the modal works straight off an unsaved Feed card.
 *
 * Opens instantly: the caller's `seed` paints the header on the first frame while
 * the query loads, and the body skeletons in. Closing keeps the last-shown
 * content mounted through the exit animation (see `snapshot`) — the URL clears
 * the moment we close, so without the snapshot the body would blank out and a
 * bare box would animate away.
 */
export function ChannelDetailDialog({
	selection,
	seed,
	saved,
	onToggleSave,
	onClose,
}: {
	selection: WatchlistSelection | null;
	seed: ChannelDetailSeed | null;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
	onClose: () => void;
}) {
	const detail = useQuery(api.watchlist.detail, selection ?? "skip");

	// Retain the last-shown content so the closing animation runs over the real
	// detail, not an empty box. `selection`/`seed` must be referentially stable
	// across renders (the caller memoizes them) or this effect would loop.
	const [snapshot, setSnapshot] = useState<{
		seed: ChannelDetailSeed | null;
		detail: WatchlistDetail | null | undefined;
		saved: boolean;
	} | null>(null);
	useEffect(() => {
		if (selection !== null) {
			setSnapshot({ seed, detail, saved });
		}
	}, [selection, seed, detail, saved]);

	// Live while open; the retained snapshot while the close animation plays out.
	const shown = selection !== null ? { seed, detail, saved } : snapshot;

	return (
		<Dialog
			open={selection !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent
				showCloseButton={false}
				className="max-h-[85vh] max-w-2xl overflow-y-auto overflow-x-hidden"
			>
				{shown === null ? (
					<DialogTitle className="sr-only">Channel detail</DialogTitle>
				) : (
					<DetailContent
						seed={shown.seed}
						detail={shown.detail}
						saved={shown.saved}
						onToggleSave={onToggleSave}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
