import { api } from "@nichehuntr/backend/convex/_generated/api";
import {
	SIGNAL_SETS,
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
import { useQuery } from "convex/react";
import { AlertCircle, Bookmark, ExternalLink, X } from "lucide-react";

import {
	channelUrl,
	ClonabilityRead,
	compactViews,
	FormBadge,
	initials,
	MomentumIndicator,
	SaturationRead,
	STAGE_LABELS,
} from "@/components/feed/listing-card";
import Loader from "@/components/loader";

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** The last ~12 standard uploads of the entry's form, newest-first, as a
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
	listing,
	form,
}: {
	listing: NonNullable<WatchlistDetail["listing"]>;
	form: WatchlistDetail["form"];
}) {
	// All of the form's scored signals, not the card's top-two teaser.
	const signals = topSignals(listing.signals, form, SIGNAL_SETS[form].length);
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
 * dismiss folded onto the end. */
function DetailControls({
	detail,
	saved,
	onToggleSave,
}: {
	detail: WatchlistDetail;
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
				onClick={() =>
					onToggleSave({ channelId: detail.channelId, form: detail.form })
				}
				className={`rounded-md p-1.5 transition-colors ${
					saved
						? "text-primary"
						: "text-muted-foreground hover:text-foreground"
				}`}
			>
				<Bookmark className={`size-4 ${saved ? "fill-current" : ""}`} />
			</button>
			<a
				href={channelUrl(detail.channel)}
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

/** Identity row for the detail: avatar, title + form badge, and the channel
 * handle. The save / external / close controls ride at the far right. */
function DetailHeader({
	detail,
	saved,
	onToggleSave,
}: {
	detail: WatchlistDetail;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
}) {
	return (
		<header className="flex items-start gap-3">
			{detail.channel.avatarUrl ? (
				<img
					src={detail.channel.avatarUrl}
					alt={`${detail.channel.title} avatar`}
					className="size-10 shrink-0 rounded-full object-cover"
				/>
			) : (
				<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs">
					{initials(detail.channel.title)}
				</div>
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<DialogTitle className="truncate text-sm">
						{detail.channel.title}
					</DialogTitle>
					<FormBadge form={detail.form} />
				</div>
				<DialogDescription className="text-xs">
					{detail.channel.handle
						? `@${detail.channel.handle}`
						: "Channel detail"}
				</DialogDescription>
			</div>
			<DetailControls detail={detail} saved={saved} onToggleSave={onToggleSave} />
		</header>
	);
}

/**
 * The detail body for a resolved (channel, form). The Listing half is re-derived
 * live (ADR-0004): when the pair is off the Feed the pane degrades to identity +
 * uploads with an explicit notice — a product state, not an error — since the
 * videos persist even when the Listing doesn't.
 */
function DetailBody({
	detail,
	saved,
	onToggleSave,
}: {
	detail: WatchlistDetail;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
}) {
	return (
		<div className="flex flex-col gap-4">
			<DetailHeader detail={detail} saved={saved} onToggleSave={onToggleSave} />
			{detail.channel.description ? (
				<p className="text-muted-foreground text-xs">
					{detail.channel.description}
				</p>
			) : null}
			{detail.listing !== null ? (
				<>
					<div className="flex items-center gap-2">
						<span className="rounded-full border border-border px-2 py-0.5 font-medium text-xs">
							{STAGE_LABELS[detail.listing.stage]}
						</span>
						<MomentumIndicator momentum={detail.listing.momentum} />
					</div>
					<div className="flex items-end justify-between gap-3">
						<div>
							<div className="text-muted-foreground text-xs">Median views</div>
							<div className="font-semibold text-lg tabular-nums">
								{compactViews.format(detail.listing.medianViews)}
							</div>
						</div>
						<SaturationRead saturation={detail.listing.saturation} />
						<ClonabilityRead clonability={detail.listing.clonability} />
					</div>
					<SignalBreakdown listing={detail.listing} form={detail.form} />
				</>
			) : (
				<p className="flex items-center gap-2 rounded-2xl border border-border border-dashed px-3 py-2 text-muted-foreground text-xs">
					<AlertCircle className="size-3.5 shrink-0" aria-hidden />
					No longer on the Feed — scores are unavailable.
				</p>
			)}
			<UploadsStrip uploads={detail.uploads} />
		</div>
	);
}

/**
 * The channel-details modal, opened from a Feed card or a saved Watchlist row.
 * Open state is owned by the caller (a URL search param on the Feed route), so
 * the detail is deep-linkable and the browser Back button closes it. Powered by
 * `watchlist.detail`, which resolves for any (channel, form) — saved or not — so
 * the modal works straight off an unsaved Feed card.
 */
export function ChannelDetailDialog({
	selection,
	saved,
	onToggleSave,
	onClose,
}: {
	selection: WatchlistSelection | null;
	saved: boolean;
	onToggleSave: (selection: WatchlistSelection) => void;
	onClose: () => void;
}) {
	const detail = useQuery(api.watchlist.detail, selection ?? "skip");

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
				className="max-h-[85vh] max-w-xl overflow-y-auto"
			>
				{selection === null ? null : detail === undefined ? (
					<>
						<DialogTitle className="sr-only">Channel detail</DialogTitle>
						<Loader />
					</>
				) : detail === null ? (
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
				) : (
					<DetailBody
						detail={detail}
						saved={saved}
						onToggleSave={onToggleSave}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
