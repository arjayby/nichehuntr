import {
	SIGNAL_SETS,
	topSignals,
} from "@nichehuntr/backend/convex/model/clonability";
import type {
	WatchlistDetail,
	WatchlistUpload,
} from "@nichehuntr/backend/convex/watchlist";
import { AlertCircle, ExternalLink } from "lucide-react";

import {
	ClonabilityRead,
	channelUrl,
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

function DetailHeader({ detail }: { detail: WatchlistDetail }) {
	return (
		<header className="flex items-center gap-3">
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
					<h3 className="truncate font-heading font-medium text-sm">
						{detail.channel.title}
					</h3>
					<FormBadge form={detail.form} />
				</div>
				<a
					href={channelUrl(detail.channel)}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
				>
					{detail.channel.handle
						? `@${detail.channel.handle}`
						: "View on YouTube"}
					<ExternalLink className="size-3" aria-hidden />
				</a>
			</div>
		</header>
	);
}

/** The quiet placeholder when nothing is selected in the list above. */
export function DetailHint() {
	return (
		<p className="px-4 py-8 text-center text-muted-foreground text-xs">
			Select a channel to see its detail.
		</p>
	);
}

/**
 * The drawer's deep detail view for the selected entry. The Listing half is
 * re-derived live (ADR-0004): when the pair is off the Feed the pane degrades
 * to identity + uploads with an explicit notice — a product state, not an
 * error — since the videos persist even when the Listing doesn't.
 */
export function WatchlistDetailPane({
	detail,
}: {
	detail: WatchlistDetail | null | undefined;
}) {
	if (detail === undefined) {
		return <Loader />;
	}
	if (detail === null) {
		// The channel itself is gone from under the entry — nothing to show.
		return <DetailHint />;
	}
	return (
		<div className="flex flex-col gap-4">
			<DetailHeader detail={detail} />
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
