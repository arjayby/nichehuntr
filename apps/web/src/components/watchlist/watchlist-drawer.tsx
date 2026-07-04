import type { WatchlistEntry } from "@nichehuntr/backend/convex/watchlist";
import { Button } from "@nichehuntr/ui/components/button";
import { Bookmark, PanelRightClose, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { FormBadge, initials } from "@/components/feed/listing-card";
import Loader from "@/components/loader";

const OPEN_STORAGE_KEY = "nichehuntr.watchlist-drawer.open";

/**
 * The desktop drawer's open state, persisted in localStorage. Open by default;
 * the stored value is applied after mount so server and client render the same
 * initial markup (localStorage doesn't exist during SSR).
 */
export function useWatchlistDrawerOpen() {
	const [open, setOpen] = useState(true);

	useEffect(() => {
		const stored = window.localStorage.getItem(OPEN_STORAGE_KEY);
		if (stored !== null) {
			setOpen(stored === "true");
		}
	}, []);

	const setAndPersist = useCallback((value: boolean) => {
		setOpen(value);
		window.localStorage.setItem(OPEN_STORAGE_KEY, String(value));
	}, []);

	return { open, setOpen: setAndPersist };
}

function WatchlistRow({ entry }: { entry: WatchlistEntry }) {
	return (
		<li className="flex items-center gap-3 rounded-2xl border border-border px-3 py-2">
			{entry.channel.avatarUrl ? (
				<img
					src={entry.channel.avatarUrl}
					alt={`${entry.channel.title} avatar`}
					className="size-8 shrink-0 rounded-full object-cover"
				/>
			) : (
				<div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-xs">
					{initials(entry.channel.title)}
				</div>
			)}
			<span className="min-w-0 flex-1 truncate font-medium text-sm">
				{entry.channel.title}
			</span>
			<FormBadge form={entry.form} />
		</li>
	);
}

/** The drawer's body: the Operator's whole Watchlist, newest-first, flat. */
function WatchlistBody({ entries }: { entries: WatchlistEntry[] | undefined }) {
	if (entries === undefined) {
		return <Loader />;
	}
	if (entries.length === 0) {
		return (
			<p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-xs">
				Your Watchlist is empty. Save a clone candidate with the{" "}
				<Bookmark className="inline size-3 align-[-2px]" aria-hidden /> bookmark
				on a Feed card.
			</p>
		);
	}
	return (
		<ul className="flex flex-col gap-2">
			{entries.map((entry) => (
				<WatchlistRow key={entry.entryId} entry={entry} />
			))}
		</ul>
	);
}

function WatchlistHeader({
	count,
	onClose,
	closeIcon,
	closeLabel,
}: {
	count: number | undefined;
	onClose: () => void;
	closeIcon: React.ReactNode;
	closeLabel: string;
}) {
	return (
		<header className="flex items-center gap-2 border-border border-b px-4 py-3">
			<Bookmark className="size-4" aria-hidden />
			<h2 className="font-heading font-medium text-sm">Watchlist</h2>
			{count !== undefined ? (
				<span className="text-muted-foreground text-xs tabular-nums">
					{count}
				</span>
			) : null}
			<Button
				variant="ghost"
				size="icon"
				className="ml-auto"
				onClick={onClose}
				aria-label={closeLabel}
			>
				{closeIcon}
			</Button>
		</header>
	);
}

/**
 * The persistent Watchlist panel on the Feed route (CONTEXT.md: a lens on the
 * Feed — always the whole list, regardless of the Feed's Short/Long toggle).
 * Rendered at `lg` and up as a fixed-width column that pushes the Feed grid.
 */
export function WatchlistDrawer({
	entries,
	onCollapse,
}: {
	entries: WatchlistEntry[] | undefined;
	onCollapse: () => void;
}) {
	return (
		<aside className="hidden w-[380px] shrink-0 flex-col border-border border-l lg:flex">
			<WatchlistHeader
				count={entries?.length}
				onClose={onCollapse}
				closeIcon={<PanelRightClose className="size-4" />}
				closeLabel="Collapse Watchlist"
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				<WatchlistBody entries={entries} />
			</div>
		</aside>
	);
}

/** The below-`lg` fallback: the same Watchlist as a toggleable overlay sheet. */
export function WatchlistSheet({
	entries,
	open,
	onClose,
}: {
	entries: WatchlistEntry[] | undefined;
	open: boolean;
	onClose: () => void;
}) {
	// Standard overlay behavior the plain-div sheet doesn't get for free:
	// Escape closes it and the Feed underneath stops scrolling.
	useEffect(() => {
		if (!open) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			document.body.style.overflow = previousOverflow;
		};
	}, [open, onClose]);

	if (!open) {
		return null;
	}
	return (
		<div
			className="fixed inset-0 z-50 lg:hidden"
			role="dialog"
			aria-modal="true"
			aria-label="Watchlist"
		>
			<div
				className="absolute inset-0 bg-black/50"
				onClick={onClose}
				aria-hidden
			/>
			<div className="absolute inset-y-0 right-0 flex w-[85vw] max-w-[380px] flex-col border-border border-l bg-background">
				<WatchlistHeader
					count={entries?.length}
					onClose={onClose}
					closeIcon={<X className="size-4" />}
					closeLabel="Close Watchlist"
				/>
				<div className="min-h-0 flex-1 overflow-y-auto p-3">
					<WatchlistBody entries={entries} />
				</div>
			</div>
		</div>
	);
}
