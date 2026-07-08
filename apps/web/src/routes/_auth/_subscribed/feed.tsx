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
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import {
	ChannelDetailDialog,
	type ChannelDetailSeed,
} from "@/components/feed/channel-detail";
import { ListingCard, STAGE_LABELS } from "@/components/feed/listing-card";
import Loader from "@/components/loader";
import {
	useWatchlistDrawerOpen,
	WatchlistDrawer,
	WatchlistSheet,
} from "@/components/watchlist/watchlist-drawer";
import { toggleEntryOptimistic } from "@/lib/watchlist-optimistic";

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
const FEED_WATCHLIST_FORM: Form = "short";

/** The saved-state key the Feed paints on cards: the entry's channel + form. */
function savedKey(channelId: string, form: Form): string {
	return `${channelId}:${form}`;
}

function FeedPage() {
	const navigate = Route.useNavigate();
	const search = Route.useSearch();
	const groups = useQuery(api.feed.feed, {});

	// The whole Watchlist, independent of the form lens: it feeds the drawer
	// (Folders + root entries) and the saved-state keys painted on cards under
	// both toggles. The keys flatten across every Folder and the root.
	const watchlist = useQuery(api.watchlist.list);
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
	// The detail modal's LIVE state — the (channel, form) it shows plus the
	// identity we already held for it (ADR-0004 entry identity). Kept in local
	// state, not read off the URL, so open/close flip synchronously: the Dialog is
	// controlled, and gating its `open` on a `navigate()` round-trip is what made
	// opening and closing feel slow (Base UI won't start the enter/exit animation
	// until the prop flips). The URL is a mirror synced below, not the render gate.
	// Seeded from the URL on first render so a deep-link/refresh opens straight up.
	const [detail, setDetail] = useState<{
		selection: WatchlistSelection;
		seed: ChannelDetailSeed | null;
	} | null>(() =>
		search.channel && search.form
			? {
					selection: {
						channelId: search.channel as Id<"channels">,
						form: search.form,
					},
					seed: null,
				}
			: null,
	);
	const selection = detail?.selection ?? null;
	// The identity we already hold for a (channel, form) — the clicked card or
	// saved row — so the modal paints its header instantly instead of on a
	// spinner. Found in the loaded Feed groups first, else the Watchlist; absent
	// on a cold deep-link (nothing loaded/clicked), where the header skeletons in.
	const resolveSeed = (sel: WatchlistSelection): ChannelDetailSeed | null => {
		const matches = (channelId: string, form: Form) =>
			channelId === sel.channelId && form === sel.form;
		if (groups !== undefined) {
			for (const group of groups) {
				const card = group.cards.find((c) =>
					matches(c.channelId, FEED_WATCHLIST_FORM),
				);
				if (card !== undefined) {
					return {
						channelId: card.channelId,
						form: FEED_WATCHLIST_FORM,
						channel: card.channel,
					};
				}
			}
		}
		if (watchlist !== undefined) {
			const entries = [
				...watchlist.root,
				...watchlist.folders.flatMap((folder) => folder.entries),
			];
			const entry = entries.find((e) => matches(e.channelId, e.form));
			if (entry !== undefined) {
				return {
					channelId: entry.channelId,
					form: entry.form,
					channel: entry.channel,
				};
			}
		}
		return null;
	};
	// Follow URL changes we didn't originate — a deep-link, or the Back/Forward
	// button. Our own open/close set local state *before* navigating, so when the
	// URL catches up it already agrees here and this no-ops (preserving the seed).
	// biome-ignore lint/correctness/useExhaustiveDependencies: sync on URL only.
	useEffect(() => {
		const urlSelection: WatchlistSelection | null =
			search.channel && search.form
				? { channelId: search.channel as Id<"channels">, form: search.form }
				: null;
		setDetail((prev) => {
			const prevSel = prev?.selection ?? null;
			const agree =
				(prevSel === null && urlSelection === null) ||
				(prevSel !== null &&
					urlSelection !== null &&
					prevSel.channelId === urlSelection.channelId &&
					prevSel.form === urlSelection.form);
			if (agree) {
				return prev;
			}
			return urlSelection === null
				? null
				: { selection: urlSelection, seed: resolveSeed(urlSelection) };
		});
	}, [search.channel, search.form]);
	const selectionSaved =
		selection !== null &&
		savedKeys.has(savedKey(selection.channelId, selection.form));
	const openDetail = (sel: WatchlistSelection) => {
		// Flip local state first (instant animation), then mirror to the URL for
		// deep-linking + Back — the navigate runs in the background off the path.
		setDetail({ selection: sel, seed: resolveSeed(sel) });
		navigate({
			search: (prev) => ({ ...prev, channel: sel.channelId, form: sel.form }),
		});
	};
	const closeDetail = () => {
		setDetail(null);
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
	// pair may ride along — no extra entry fields. The optimistic update paints
	// the change instantly: a remove filters the pair out of the cached list; an
	// add prepends a synthesized root row, sourcing the channel identity from data
	// already in scope — the open detail modal's seed first (covers a selection
	// off the current Feed lens), then the loaded Feed / Watchlist via resolveSeed.
	// Convex rolls the overlay back on rejection, where the `.catch` toast fires.
	const toggleSave = useMutation(api.watchlist.toggle).withOptimisticUpdate(
		(store, { channelId, form }) => {
			const list = store.getQuery(api.watchlist.list, {});
			if (list === undefined) {
				return;
			}
			const detailSeed =
				detail?.seed &&
				detail.seed.channelId === channelId &&
				detail.seed.form === form
					? detail.seed
					: null;
			const identity = detailSeed ?? resolveSeed({ channelId, form });
			store.setQuery(
				api.watchlist.list,
				{},
				toggleEntryOptimistic(list, channelId, form, identity?.channel ?? null),
			);
		},
	);
	const toggleSaveSelection = (sel: WatchlistSelection) => {
		toggleSave({ channelId: sel.channelId, form: sel.form }).catch(() => {
			toast.error("Could not update your Watchlist.");
		});
	};
	const handleToggleSave = (card: FeedCard) => {
		toggleSaveSelection({
			channelId: card.channelId,
			form: FEED_WATCHLIST_FORM,
		});
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
								Channels to clone, grouped by lifecycle evidence.
							</p>
						</div>
						<div className="flex items-center gap-2">
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

			<WatchlistDrawer
				list={watchlist}
				selection={selection}
				open={drawer.open}
				onSelect={openDetail}
				onRemove={handleRemoveEntry}
				onCollapse={() => drawer.setOpen(false)}
			/>
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
				seed={detail?.seed ?? null}
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
					No channels yet.
				</p>
			) : (
				cards.map((card) => (
					<ListingCard
						key={card.channelId}
						card={card}
						saved={savedKeys.has(savedKey(card.channelId, FEED_WATCHLIST_FORM))}
						onToggleSave={onToggleSave}
						onOpen={onOpen}
					/>
				))
			)}
		</section>
	);
}
