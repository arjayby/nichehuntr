import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { FeedCard, FeedGroup } from "@nichehuntr/backend/convex/feed";
import type {
	WatchlistEntry,
	WatchlistSelection,
} from "@nichehuntr/backend/convex/watchlist";
import { Button } from "@nichehuntr/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Bookmark } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ListingCard, STAGE_LABELS } from "@/components/feed/listing-card";
import Loader from "@/components/loader";
import {
	sameSelection,
	useWatchlistDrawerOpen,
	WatchlistDrawer,
	WatchlistSheet,
} from "@/components/watchlist/watchlist-drawer";

export const Route = createFileRoute("/_auth/_subscribed/feed")({
	component: FeedPage,
});

type Form = "short" | "long";
type Stage = FeedGroup["stage"];

/** The saved-state key the Feed paints on cards: the entry's channel + form. */
function savedKey(channelId: string, form: Form): string {
	return `${channelId}:${form}`;
}

function FeedPage() {
	const [form, setForm] = useState<Form>("short");
	const groups = useQuery(api.feed.feed, { form });

	// The whole Watchlist, independent of the form lens: it feeds the drawer
	// (Folders + root entries) and the saved-state keys painted on cards under
	// both toggles. The keys flatten across every Folder and the root.
	const watchlist = useQuery(api.watchlist.list);
	const toggleSave = useMutation(api.watchlist.toggle);
	const savedKeys = useMemo(() => {
		if (watchlist === undefined) {
			return new Set<string>();
		}
		const all = [
			...watchlist.root,
			...watchlist.folders.flatMap((folder) => folder.entries),
		];
		return new Set(all.map((entry) => savedKey(entry.channelId, entry.form)));
	}, [watchlist]);
	// Which entry the drawer's detail pane shows — session state only, keyed by
	// the entry identity (channel, form) (ADR-0004). Nothing selected initially.
	const [selection, setSelection] = useState<WatchlistSelection | null>(null);
	const handleToggleSave = (card: FeedCard) => {
		const key: WatchlistSelection = {
			channelId: card.channelId,
			form: card.form,
		};
		toggleSave(key)
			.then(({ saved }) => {
				// Saving a card auto-selects its new entry; unsaving the selected
				// entry clears the pane back to the hint.
				setSelection((current) =>
					saved ? key : sameSelection(current, key) ? null : current,
				);
			})
			.catch(() => {
				toast.error("Could not update your Watchlist.");
			});
	};
	// Removing an entry from the drawer is the same unsave as the card bookmark:
	// toggle the (channel, form) off and clear the pane if it was showing it.
	// Narrow to the pair — `toggle` validates its args strictly, so the entry's
	// extra fields must not ride along.
	const handleRemoveEntry = (entry: WatchlistEntry) => {
		const key: WatchlistSelection = {
			channelId: entry.channelId,
			form: entry.form,
		};
		toggleSave(key)
			.then(() => {
				setSelection((current) =>
					sameSelection(current, key) ? null : current,
				);
			})
			.catch(() => {
				toast.error("Could not update your Watchlist.");
			});
	};

	const drawer = useWatchlistDrawerOpen();
	const [sheetOpen, setSheetOpen] = useState(false);

	return (
		<div className="flex h-full min-h-0">
			<main className="min-w-0 flex-1 overflow-y-auto">
				<div className="container mx-auto max-w-6xl px-4 py-6">
					<div className="mb-6 flex flex-wrap items-center justify-between gap-4">
						<div>
							<h1 className="font-bold text-2xl">Feed</h1>
							<p className="text-muted-foreground text-sm">
								Proven channels to clone, across the momentum lifecycle.
							</p>
						</div>
						<div className="flex items-center gap-2">
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
							{/* Below lg the drawer is an overlay sheet; at lg+ the same
							    button collapses/reopens the persistent panel. */}
							<Button
								variant="outline"
								size="sm"
								className="lg:hidden"
								aria-label="Open Watchlist"
								onClick={() => setSheetOpen(true)}
							>
								<Bookmark aria-hidden /> Watchlist
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="hidden lg:inline-flex"
								aria-label="Toggle Watchlist"
								aria-pressed={drawer.open}
								onClick={() => drawer.setOpen(!drawer.open)}
							>
								<Bookmark aria-hidden /> Watchlist
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
									savedKeys={savedKeys}
									onToggleSave={handleToggleSave}
								/>
							))}
						</div>
					)}
				</div>
			</main>

			{drawer.open ? (
				<WatchlistDrawer
					list={watchlist}
					selection={selection}
					onSelect={setSelection}
					onRemove={handleRemoveEntry}
					onCollapse={() => drawer.setOpen(false)}
				/>
			) : null}
			<WatchlistSheet
				list={watchlist}
				selection={selection}
				onSelect={setSelection}
				onRemove={handleRemoveEntry}
				open={sheetOpen}
				onClose={() => setSheetOpen(false)}
			/>
		</div>
	);
}

function FeedColumn({
	stage,
	cards,
	savedKeys,
	onToggleSave,
}: {
	stage: Stage;
	cards: FeedCard[];
	savedKeys: Set<string>;
	onToggleSave: (card: FeedCard) => void;
}) {
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
				cards.map((card) => (
					<ListingCard
						key={card.listingId}
						card={card}
						saved={savedKeys.has(savedKey(card.channelId, card.form))}
						onToggleSave={onToggleSave}
					/>
				))
			)}
		</section>
	);
}
