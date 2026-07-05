import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { Id } from "@nichehuntr/backend/convex/_generated/dataModel";
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
import { z } from "zod";

import { ChannelDetailDialog } from "@/components/feed/channel-detail";
import { ListingCard, STAGE_LABELS } from "@/components/feed/listing-card";
import Loader from "@/components/loader";
import {
	useWatchlistDrawerOpen,
	WatchlistDrawer,
	WatchlistSheet,
} from "@/components/watchlist/watchlist-drawer";

// The open channel-detail modal, deep-linked in the URL: `channel` is the
// channel id, `form` its Short/Long variant. Both present ⇒ the modal is open,
// so Back closes it and the detail is shareable. Independent of the Feed's own
// Short/Long toggle (which stays local state — you can inspect a saved Long
// channel while the Feed shows Shorts).
const searchSchema = z.object({
	channel: z.string().optional().catch(undefined),
	form: z.enum(["short", "long"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_auth/_subscribed/feed")({
	validateSearch: searchSchema,
	component: FeedPage,
});

type Form = "short" | "long";
type Stage = FeedGroup["stage"];

/** The saved-state key the Feed paints on cards: the entry's channel + form. */
function savedKey(channelId: string, form: Form): string {
	return `${channelId}:${form}`;
}

function FeedPage() {
	const navigate = Route.useNavigate();
	const search = Route.useSearch();
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
	// Which (channel, form) the detail modal shows, read straight from the URL
	// (ADR-0004 entry identity). Both params present ⇒ open.
	const selection: WatchlistSelection | null =
		search.channel && search.form
			? { channelId: search.channel as Id<"channels">, form: search.form }
			: null;
	const selectionSaved =
		selection !== null &&
		savedKeys.has(savedKey(selection.channelId, selection.form));
	const openDetail = (sel: WatchlistSelection) => {
		navigate({
			search: (prev) => ({ ...prev, channel: sel.channelId, form: sel.form }),
		});
	};
	const closeDetail = () => {
		// Replace, not push: opening the modal pushed a history entry, so closing
		// must not leave a params-bearing entry behind — otherwise Back after an
		// explicit close (×/Escape/backdrop) would reopen the modal.
		navigate({
			replace: true,
			search: (prev) => ({ ...prev, channel: undefined, form: undefined }),
		});
	};
	// Save/unsave is decoupled from opening the modal: the bookmark just toggles
	// the (channel, form) pair. `toggle` validates its args strictly, so only the
	// pair may ride along — no extra entry fields.
	const toggleSaveSelection = (sel: WatchlistSelection) => {
		toggleSave({ channelId: sel.channelId, form: sel.form }).catch(() => {
			toast.error("Could not update your Watchlist.");
		});
	};
	const handleToggleSave = (card: FeedCard) => {
		toggleSaveSelection({ channelId: card.channelId, form: card.form });
	};
	const handleRemoveEntry = (entry: WatchlistEntry) => {
		toggleSaveSelection({ channelId: entry.channelId, form: entry.form });
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
									onOpen={openDetail}
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
					onSelect={openDetail}
					onRemove={handleRemoveEntry}
					onCollapse={() => drawer.setOpen(false)}
				/>
			) : null}
			<WatchlistSheet
				list={watchlist}
				selection={selection}
				onSelect={openDetail}
				onRemove={handleRemoveEntry}
				open={sheetOpen}
				onClose={() => setSheetOpen(false)}
			/>
			<ChannelDetailDialog
				selection={selection}
				saved={selectionSaved}
				onToggleSave={toggleSaveSelection}
				onClose={closeDetail}
			/>
		</div>
	);
}

function FeedColumn({
	stage,
	cards,
	savedKeys,
	onToggleSave,
	onOpen,
}: {
	stage: Stage;
	cards: FeedCard[];
	savedKeys: Set<string>;
	onToggleSave: (card: FeedCard) => void;
	onOpen: (selection: WatchlistSelection) => void;
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
						onOpen={onOpen}
					/>
				))
			)}
		</section>
	);
}
