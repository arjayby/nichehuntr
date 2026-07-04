import type { FeedCard } from "@nichehuntr/backend/convex/feed";
import { topSignals } from "@nichehuntr/backend/convex/model/clonability";
import {
	MOMENTUM_MODEST,
	MOMENTUM_STRONG,
	saturationLevel,
} from "@nichehuntr/backend/convex/model/deriveListings";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@nichehuntr/ui/components/card";
import { Bookmark, ExternalLink, Minus, TrendingUp, Users } from "lucide-react";

const compactViews = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

const momentumPct = new Intl.NumberFormat("en", {
	style: "percent",
	maximumFractionDigits: 0,
});

/**
 * A compact Momentum badge: the listing's recent daily growth relative to its
 * baseline reach — the same signal that places it in a column. Strong momentum
 * (Breaking Out territory) reads as a filled brand pill; a still-accelerating
 * listing as plain foreground; a flat/cooled one as a muted dash.
 */
function MomentumIndicator({ momentum }: { momentum: number | null }) {
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
function SaturationRead({ saturation }: { saturation: number | null }) {
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
function ClonabilityRead({ card }: { card: FeedCard }) {
	return (
		<div className="text-right">
			<div className="text-muted-foreground text-xs">Clonability</div>
			<div
				className="font-semibold text-lg tabular-nums"
				title={
					card.clonability === null
						? "Clonability pending"
						: "Weighted mean of this form's signals"
				}
			>
				{card.clonability ?? "—"}
			</div>
		</div>
	);
}

/**
 * The top signal rationales behind the Clonability score — the one-line reasons
 * the Enrichment pass gave, so the Operator sees *why* it's a clone target, not
 * just the number. Renders nothing until the Listing is enriched.
 */
function SignalRationales({ card }: { card: FeedCard }) {
	const tops = topSignals(card.signals, card.form, 2);
	if (tops.length === 0) {
		return null;
	}
	return (
		<div className="mt-3 flex flex-col gap-1 border-t pt-2">
			{tops.map((signal) => (
				<div key={signal.name} className="flex items-baseline gap-1.5 text-xs">
					<span className="shrink-0 font-medium text-foreground">
						{signal.label}
					</span>
					<span className="shrink-0 text-muted-foreground tabular-nums">
						{signal.score}
					</span>
					<span
						className="truncate text-muted-foreground"
						title={signal.rationale}
					>
						{signal.rationale}
					</span>
				</div>
			))}
		</div>
	);
}

/** The form badge shared by Feed cards and Watchlist rows. */
export function FormBadge({ form }: { form: FeedCard["form"] }) {
	return (
		<span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground text-xs uppercase">
			{form}
		</span>
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
function channelUrl(channel: FeedCard["channel"]): string {
	return channel.handle
		? `https://www.youtube.com/@${channel.handle}`
		: `https://www.youtube.com/channel/${channel.ytId}`;
}

export function ListingCard({
	card,
	saved,
	onToggleSave,
}: {
	card: FeedCard;
	saved: boolean;
	onToggleSave: (card: FeedCard) => void;
}) {
	return (
		<a
			href={channelUrl(card.channel)}
			target="_blank"
			rel="noreferrer"
			className="block transition-transform hover:-translate-y-0.5"
		>
			<Card size="sm" className="hover:ring-foreground/20">
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
							<div className="flex items-center gap-1.5">
								<FormBadge form={card.form} />
								{/* Toggles the Watchlist save; must never follow the card's
								    YouTube link, so it swallows the click before the anchor. */}
								<button
									type="button"
									aria-pressed={saved}
									aria-label={
										saved ? "Remove from Watchlist" : "Save to Watchlist"
									}
									title={saved ? "Remove from Watchlist" : "Save to Watchlist"}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										onToggleSave(card);
									}}
									className={`-m-1 rounded-md p-1 transition-colors ${
										saved
											? "text-primary"
											: "text-muted-foreground hover:text-foreground"
									}`}
								>
									<Bookmark
										className={`size-4 ${saved ? "fill-current" : ""}`}
									/>
								</button>
							</div>
							<MomentumIndicator momentum={card.momentum} />
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<div className="flex items-end justify-between gap-3">
						<div>
							<div className="text-muted-foreground text-xs">Median views</div>
							<div className="font-semibold text-lg tabular-nums">
								{compactViews.format(card.medianViews)}
							</div>
						</div>
						<SaturationRead saturation={card.saturation} />
						<ClonabilityRead card={card} />
						<ExternalLink className="size-4 self-center text-muted-foreground" />
					</div>
					<SignalRationales card={card} />
				</CardContent>
			</Card>
		</a>
	);
}
