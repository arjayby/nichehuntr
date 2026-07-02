import type { FeedCard } from "@nichehuntr/backend/convex/feed";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@nichehuntr/ui/components/card";
import { ExternalLink } from "lucide-react";

const compactViews = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

/** Up to two initials for the avatar fallback, e.g. "AI Horror Shorts" → "AH". */
function initials(title: string): string {
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

export function ListingCard({ card }: { card: FeedCard }) {
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
						<span className="ml-auto rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground text-xs uppercase">
							{card.form}
						</span>
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
						<div className="text-right">
							<div className="text-muted-foreground text-xs">Clonability</div>
							<div className="font-medium tabular-nums">
								{card.clonability ?? "—"}
							</div>
						</div>
						<ExternalLink className="size-4 self-center text-muted-foreground" />
					</div>
				</CardContent>
			</Card>
		</a>
	);
}
