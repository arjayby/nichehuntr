import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { FeedCard, FeedGroup } from "@nichehuntr/backend/convex/feed";
import { Button } from "@nichehuntr/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";

import { ListingCard } from "@/components/feed/listing-card";
import Loader from "@/components/loader";

export const Route = createFileRoute("/_auth/_subscribed/feed")({
	component: FeedPage,
});

type Form = "short" | "long";
type Stage = FeedGroup["stage"];

const STAGE_LABELS: Record<Stage, string> = {
	emerging: "Emerging",
	breaking_out: "Breaking Out",
	established: "Established",
};

function FeedPage() {
	const [form, setForm] = useState<Form>("short");
	const groups = useQuery(api.feed.feed, { form });

	return (
		<div className="container mx-auto max-w-6xl px-4 py-6">
			<div className="mb-6 flex items-center justify-between gap-4">
				<div>
					<h1 className="font-bold text-2xl">Feed</h1>
					<p className="text-muted-foreground text-sm">
						Proven channels to clone, across the momentum lifecycle.
					</p>
				</div>
				<div className="inline-flex gap-1 rounded-2xl border border-border p-1">
					<Button
						variant={form === "short" ? "default" : "ghost"}
						size="sm"
						onClick={() => setForm("short")}
					>
						Short
					</Button>
					<Button
						variant={form === "long" ? "default" : "ghost"}
						size="sm"
						onClick={() => setForm("long")}
					>
						Long
					</Button>
				</div>
			</div>

			{groups === undefined ? (
				<Loader />
			) : (
				<div className="grid gap-4 md:grid-cols-3">
					{groups.map((group) => (
						<FeedColumn
							key={group.stage}
							stage={group.stage}
							cards={group.cards}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function FeedColumn({ stage, cards }: { stage: Stage; cards: FeedCard[] }) {
	return (
		<section className="flex flex-col gap-3">
			<header className="flex items-center justify-between px-1">
				<h2 className="font-heading font-medium text-sm">
					{STAGE_LABELS[stage]}
				</h2>
				<span className="text-muted-foreground text-xs tabular-nums">
					{cards.length}
				</span>
			</header>
			{cards.length === 0 ? (
				<p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-xs">
					No listings yet.
				</p>
			) : (
				cards.map((card) => <ListingCard key={card.listingId} card={card} />)
			)}
		</section>
	);
}
