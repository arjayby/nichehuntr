import type { FeedCard } from "@nichehuntr/backend/convex/feed";
import {
	CHANNEL_SIGNAL_NAMES,
	type Signals,
	topSignals,
} from "@nichehuntr/backend/convex/model/clonability";
import type { WatchlistSelection } from "@nichehuntr/backend/convex/watchlist";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@nichehuntr/ui/components/card";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@nichehuntr/ui/components/hover-card";
import { Bookmark, CalendarClock, ExternalLink, Video } from "lucide-react";

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

const publishDate = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	year: "numeric",
});

/**
 * Clonability score: the tunable weighted mean of the Channel's signals (CONTEXT.md).
 * It's the within-column sort key, so it reads as the card's headline number. A
 * dash until Enrichment scores the Channel — Clonability never gates (ADR-0003).
 * Hovering the number opens the Enrichment behind it: every scored signal with
 * its full rationale, without leaving the Feed.
 */
export function ClonabilityRead({
	clonability,
	signals,
}: {
	clonability: number | null;
	signals: Signals | null;
}) {
	const scored = topSignals(signals, CHANNEL_SIGNAL_NAMES.length);
	return (
		<div className="text-right">
			<div className="text-muted-foreground text-xs">Clonability</div>
			<HoverCard>
				<HoverCardTrigger
					render={<div className="font-semibold text-lg tabular-nums" />}
				>
					{clonability ?? "—"}
				</HoverCardTrigger>
				{/* stopPropagation: the popup portals inside the clickable Card's React
				    tree, so a click on it would otherwise open the detail modal. */}
				<HoverCardContent
					className="w-72 text-left"
					onClick={(event) => event.stopPropagation()}
				>
					{scored.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							Clonability pending. Signals not scored yet.
						</p>
					) : (
						<div className="flex flex-col gap-2">
							<p className="text-muted-foreground text-xs">
								Weighted mean of this Channel's signals
							</p>
							<ul className="flex flex-col gap-2">
								{scored.map((signal) => (
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
						</div>
					)}
				</HoverCardContent>
			</HoverCard>
		</div>
	);
}

/**
 * The top signals behind the Clonability score, as label + score only — the
 * card stays scannable at the Feed's pace. The full one-line rationales the
 * Enrichment pass gave live in the channel-detail modal. Renders nothing until
 * the Channel is enriched.
 */
function SignalScores({ card }: { card: FeedCard }) {
	const tops = topSignals(card.signals, 2);
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

export function ChannelCard({
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
	const open = () => onOpen({ channelId: card.channelId });
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
						<ClonabilityRead
							clonability={card.clonability}
							signals={card.signals}
						/>
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
