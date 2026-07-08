import type { FeedCard } from "@nichehuntr/backend/convex/feed";
import { topSignals } from "@nichehuntr/backend/convex/model/clonability";
import type { Form } from "@nichehuntr/backend/convex/model/deriveListings";
import {
	MOMENTUM_MODEST,
	MOMENTUM_STRONG,
	saturationLevel,
} from "@nichehuntr/backend/convex/model/deriveListings";
import type { WatchlistSelection } from "@nichehuntr/backend/convex/watchlist";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@nichehuntr/ui/components/card";
import {
	Bookmark,
	CalendarClock,
	ExternalLink,
	Minus,
	TrendingUp,
	Users,
	Video,
} from "lucide-react";

/** Compact view-count formatter shared by Feed cards and the detail pane. */
export const compactViews = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

/** Human labels for the lifecycle columns, shared by the Feed and the detail pane. */
export const STAGE_LABELS: Record<FeedCard["stage"], string> = {
	emerging: "Emerging",
	breaking_out: "Breaking Out",
	established: "Established",
};

const momentumPct = new Intl.NumberFormat("en", {
	style: "percent",
	maximumFractionDigits: 0,
});

const publishDate = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	year: "numeric",
});

/**
 * A compact Momentum badge: the listing's recent daily growth relative to its
 * baseline reach — the same signal that places it in a column. Strong momentum
 * (Breaking Out territory) reads as a filled brand pill; a still-accelerating
 * listing as plain foreground; a flat/cooled one as a muted dash.
 */
export function MomentumIndicator({ momentum }: { momentum: number | null }) {
	if (momentum === null) {
		return (
			<span className="text-muted-foreground text-xs" title="Momentum pending">
				—
			</span>
		);
	}
	const label = `${momentumPct.format(momentum)}/d`;
	const title = "Recent daily growth vs. baseline reach";
	if (momentum >= MOMENTUM_STRONG) {
		return (
			<span
				className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 font-medium text-primary-foreground text-xs tabular-nums"
				title={title}
			>
				<TrendingUp className="size-3" />
				{label}
			</span>
		);
	}
	const accelerating = momentum >= MOMENTUM_MODEST;
	return (
		<span
			className={`inline-flex items-center gap-1 font-medium text-xs tabular-nums ${
				accelerating ? "text-foreground" : "text-muted-foreground"
			}`}
			title={title}
		>
			{accelerating ? (
				<TrendingUp className="size-3.5" />
			) : (
				<Minus className="size-3.5" />
			)}
			{label}
		</span>
	);
}

/**
 * The niche's crowdedness: how many similar channels already exist (CONTEXT.md:
 * Saturation). A crowded niche is the signal it's too late to clone — so the
 * high band reads as a caution — while a sparse one is neutral. Null until the
 * embed cron measures it.
 */
export function SaturationRead({ saturation }: { saturation: number | null }) {
	if (saturation === null) {
		return (
			<div className="text-center">
				<div className="text-muted-foreground text-xs">Niche</div>
				<div
					className="text-muted-foreground text-sm"
					title="Saturation pending"
				>
					—
				</div>
			</div>
		);
	}
	const level = saturationLevel(saturation);
	const tone =
		level === "high"
			? "text-destructive"
			: level === "medium"
				? "text-foreground"
				: "text-muted-foreground";
	const title =
		level === "high"
			? `${saturation} similar channels — crowded niche, likely too late to clone`
			: `${saturation} similar channels in this niche`;
	return (
		<div className="text-center">
			<div className="text-muted-foreground text-xs">Niche</div>
			<div
				className={`inline-flex items-center gap-1 font-medium text-sm tabular-nums ${tone}`}
				title={title}
			>
				<Users className="size-3.5" />
				{saturation}
			</div>
		</div>
	);
}

/**
 * Clonability score: the tunable weighted mean of this form's signals (CONTEXT.md).
 * It's the within-column sort key, so it reads as the card's headline number. A
 * dash until the enrich cron scores the Listing — Clonability never gates (ADR-0003).
 */
export function ClonabilityRead({
	clonability,
}: {
	clonability: number | null;
}) {
	return (
		<div className="text-right">
			<div className="text-muted-foreground text-xs">Clonability</div>
			<div
				className="font-semibold text-lg tabular-nums"
				title={
					clonability === null
						? "Clonability pending"
						: "Weighted mean of this form's signals"
				}
			>
				{clonability ?? "—"}
			</div>
		</div>
	);
}

/**
 * The top signals behind the Clonability score, as label + score only — the
 * card stays scannable at the Feed's pace. The full one-line rationales the
 * Enrichment pass gave live in the channel-detail modal. Renders nothing until
 * the Listing is enriched.
 */
function SignalScores({ card }: { card: FeedCard }) {
	const tops = topSignals(card.signals, "short", 2);
	if (tops.length === 0) {
		return null;
	}
	return (
		<div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2">
			{tops.map((signal) => (
				<div
					key={signal.name}
					className="flex min-w-0 items-baseline gap-1.5 text-xs"
				>
					<span className="truncate font-medium text-foreground">
						{signal.label}
					</span>
					<span className="shrink-0 text-muted-foreground tabular-nums">
						{signal.score}
					</span>
				</div>
			))}
		</div>
	);
}

/** The form badge shared by Watchlist rows and the detail pane. */
export function FormBadge({ form }: { form: Form }) {
	return (
		<span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground text-xs uppercase">
			{form}
		</span>
	);
}

function EvidenceRead({ card }: { card: FeedCard }) {
	const latest = card.evidence.latestShortPublishedAt;
	return (
		<div className="grid grid-cols-2 gap-3">
			<div>
				<div className="text-muted-foreground text-xs">Subscribers</div>
				<div className="font-semibold text-lg tabular-nums">
					{compactViews.format(card.evidence.subscriberCount)}
				</div>
			</div>
			<div className="text-right">
				<div className="text-muted-foreground text-xs">Recent reach</div>
				<div className="font-semibold text-lg tabular-nums">
					{card.evidence.shortsAtOrAbove100k}/
					{card.evidence.recentShortsChecked}
				</div>
				<div className="text-[11px] text-muted-foreground">100K+ Shorts</div>
			</div>
			<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<Video className="size-3.5" aria-hidden />
				<span className="tabular-nums">
					{card.evidence.fetchedShorts} Shorts fetched
				</span>
			</div>
			<div className="flex items-center justify-end gap-1.5 text-muted-foreground text-xs">
				<CalendarClock className="size-3.5" aria-hidden />
				<span className="truncate">
					{latest === null ? "No Shorts yet" : publishDate.format(latest)}
				</span>
			</div>
			<div className="col-span-2 flex items-center justify-between rounded-md bg-muted/60 px-2 py-1 text-xs">
				<span className="text-muted-foreground">50K+ Shorts</span>
				<span className="font-medium tabular-nums">
					{card.evidence.shortsAtOrAbove50k}/{card.evidence.recentShortsChecked}
				</span>
			</div>
		</div>
	);
}

/** Up to two initials for the avatar fallback, e.g. "AI Horror Shorts" → "AH". */
export function initials(title: string): string {
	return title
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
}

/** Link straight to the real channel on YouTube — prefer the handle when known. */
export function channelUrl(channel: FeedCard["channel"]): string {
	return channel.handle
		? `https://www.youtube.com/@${channel.handle}`
		: `https://www.youtube.com/channel/${channel.ytId}`;
}

export function ListingCard({
	card,
	saved,
	onToggleSave,
	onOpen,
}: {
	card: FeedCard;
	saved: boolean;
	onToggleSave: (card: FeedCard) => void;
	onOpen: (selection: WatchlistSelection) => void;
}) {
	// The Feed is channel-based; existing detail/watchlist surfaces still use the
	// Shorts selection for this card until their own channel-only migration.
	const open = () => onOpen({ channelId: card.channelId, form: "short" });
	return (
		<Card
			size="sm"
			role="button"
			tabIndex={0}
			aria-label={`View ${card.channel.title} detail`}
			onClick={open}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					open();
				}
			}}
			className="cursor-pointer transition-transform hover:-translate-y-0.5 hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<CardHeader>
				<div className="flex items-center gap-3">
					{card.channel.avatarUrl ? (
						<img
							src={card.channel.avatarUrl}
							alt={`${card.channel.title} avatar`}
							className="size-10 shrink-0 rounded-full object-cover"
						/>
					) : (
						<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs">
							{initials(card.channel.title)}
						</div>
					)}
					<div className="min-w-0">
						<CardTitle className="truncate">{card.channel.title}</CardTitle>
						{card.channel.handle ? (
							<p className="truncate text-muted-foreground text-xs">
								@{card.channel.handle}
							</p>
						) : null}
					</div>
					<div className="ml-auto flex flex-col items-end gap-1">
						{/* Save + open-on-YouTube ride together at the top right; both
						    swallow the click so they never open the detail modal. */}
						<div className="flex items-center gap-1">
							<button
								type="button"
								aria-pressed={saved}
								aria-label={
									saved ? "Remove from Watchlist" : "Save to Watchlist"
								}
								title={saved ? "Remove from Watchlist" : "Save to Watchlist"}
								onClick={(event) => {
									event.stopPropagation();
									onToggleSave(card);
								}}
								className={`rounded-md p-1 transition-colors ${
									saved
										? "text-primary"
										: "text-muted-foreground hover:text-foreground"
								}`}
							>
								<Bookmark className={`size-4 ${saved ? "fill-current" : ""}`} />
							</button>
							<a
								href={channelUrl(card.channel)}
								target="_blank"
								rel="noreferrer"
								aria-label="Open channel on YouTube"
								title="Open channel on YouTube"
								onClick={(event) => event.stopPropagation()}
								className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
							>
								<ExternalLink className="size-4" />
							</a>
						</div>
						<ClonabilityRead clonability={card.clonability} />
					</div>
				</div>
			</CardHeader>
			<CardContent>
				<EvidenceRead card={card} />
				<SignalScores card={card} />
			</CardContent>
		</Card>
	);
}
