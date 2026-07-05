import {
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	PointerSensor,
	pointerWithin,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { Id } from "@nichehuntr/backend/convex/_generated/dataModel";
import type {
	WatchlistEntry,
	WatchlistFolderGroup,
	WatchlistList,
	WatchlistSelection,
} from "@nichehuntr/backend/convex/watchlist";
import { Button } from "@nichehuntr/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@nichehuntr/ui/components/dropdown-menu";
import { Input } from "@nichehuntr/ui/components/input";
import {
	browserLayoutStorage,
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
	useDefaultLayout,
} from "@nichehuntr/ui/components/resizable";
import { useMutation, useQuery } from "convex/react";
import {
	Bookmark,
	BookmarkX,
	ChevronDown,
	ChevronRight,
	Folder,
	FolderInput,
	FolderPlus,
	MoreHorizontal,
	PanelRightClose,
	Pencil,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { FormBadge, initials } from "@/components/feed/listing-card";
import Loader from "@/components/loader";
import {
	DetailHint,
	WatchlistDetailPane,
} from "@/components/watchlist/watchlist-detail";
import { cn } from "@/lib/utils";

const OPEN_STORAGE_KEY = "nichehuntr.watchlist-drawer.open";
const SPLIT_LAYOUT_ID = "nichehuntr.watchlist-drawer.split";
const COLLAPSED_STORAGE_KEY = "nichehuntr.watchlist.collapsed-folders";

/** The un-file target: dropping an entry here clears its Folder (back to root). */
const ROOT_DROPPABLE_ID = "watchlist-root";

/** Namespaced droppable id for a Folder, so drag-end can tell folders from the
 * root without colliding with the raw folder id. */
function folderDroppableId(folderId: Id<"watchlistFolders">): string {
	return `folder:${folderId}`;
}

/** Two entries share one identity when they point at the same (channel, form)
 * pair — the entry identity of ADR-0004. */
export function sameSelection(
	a: WatchlistSelection | null,
	b: WatchlistSelection | null,
): boolean {
	return (
		a !== null && b !== null && a.channelId === b.channelId && a.form === b.form
	);
}

/** Total saved entries across the root and every Folder — the header count. */
function totalEntries(list: WatchlistList): number {
	return (
		list.root.length +
		list.folders.reduce((sum, folder) => sum + folder.entries.length, 0)
	);
}

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

/**
 * Which Folders are collapsed, persisted in localStorage as an array of folder
 * ids. Same SSR-safe shape as `useWatchlistDrawerOpen`: default expanded, the
 * stored set applied after mount.
 */
function useCollapsedFolders() {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	useEffect(() => {
		const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
		if (stored !== null) {
			try {
				setCollapsed(new Set(JSON.parse(stored) as string[]));
			} catch {
				// Corrupt value — start from all-expanded rather than crash.
			}
		}
	}, []);

	const toggle = useCallback((folderId: string) => {
		setCollapsed((current) => {
			const next = new Set(current);
			if (next.has(folderId)) {
				next.delete(folderId);
			} else {
				next.add(folderId);
			}
			window.localStorage.setItem(
				COLLAPSED_STORAGE_KEY,
				JSON.stringify([...next]),
			);
			return next;
		});
	}, []);

	return { collapsed, toggle };
}

/**
 * Whether the primary pointer is fine (a mouse/trackpad). Drag-and-drop filing
 * is gated on this: on coarse (touch) pointers dragging would fight the Sheet's
 * scroll, so there the `⋯` menu is the filing path (issue #22). SSR-safe —
 * defaults to false and resolves after mount, matching the drawer's other
 * localStorage-style hooks.
 */
function useIsFinePointer(): boolean {
	const [fine, setFine] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(pointer: fine)");
		setFine(query.matches);
		const onChange = () => setFine(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return fine;
}

/** The `⋯` icon-trigger shared by entry and Folder menus. On mouse (fine
 * pointer) devices it stays quiet at rest and reveals on hover/focus/open; on
 * touch (coarse pointer) there is no hover, so it is always visible or the menu
 * would be unreachable in the mobile sheet. */
const MENU_TRIGGER_CLASS =
	"size-7 shrink-0 text-muted-foreground opacity-100 transition-opacity data-[popup-open]:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100";

/** An inline text field for naming or renaming a Folder: Enter commits a
 * non-empty name, Escape or blur cancels. Autofocused so it's type-ready. */
function FolderNameInput({
	initialValue = "",
	placeholder,
	onSubmit,
	onCancel,
}: {
	initialValue?: string;
	placeholder?: string;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(initialValue);
	return (
		<Input
			autoFocus
			value={value}
			placeholder={placeholder}
			aria-label={placeholder ?? "Folder name"}
			className="h-8 text-sm"
			onChange={(event) => setValue(event.target.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					const trimmed = value.trim();
					if (trimmed.length > 0) {
						onSubmit(trimmed);
					}
				} else if (event.key === "Escape") {
					event.preventDefault();
					onCancel();
				}
			}}
			onBlur={onCancel}
		/>
	);
}

/** The per-entry `⋯` menu: file into a Folder / back to root / a new Folder, or
 * remove from the Watchlist (identical to toggling the card's bookmark off). */
function EntryMenu({
	entry,
	folders,
	onMove,
	onNewFolderFor,
	onRemove,
}: {
	entry: WatchlistEntry;
	folders: WatchlistFolderGroup[];
	onMove: (
		entry: WatchlistEntry,
		folderId: Id<"watchlistFolders"> | null,
	) => void;
	onNewFolderFor: (entry: WatchlistEntry) => void;
	onRemove: (entry: WatchlistEntry) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className={MENU_TRIGGER_CLASS}
						aria-label={`Actions for ${entry.channel.title}`}
					/>
				}
			>
				<MoreHorizontal className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<FolderInput /> Move to folder
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						{entry.folderId !== null ? (
							<>
								<DropdownMenuItem onClick={() => onMove(entry, null)}>
									Move to root
								</DropdownMenuItem>
								<DropdownMenuSeparator />
							</>
						) : null}
						{folders.map((folder) => (
							<DropdownMenuItem
								key={folder.folderId}
								disabled={folder.folderId === entry.folderId}
								onClick={() => onMove(entry, folder.folderId)}
							>
								<Folder /> <span className="truncate">{folder.name}</span>
							</DropdownMenuItem>
						))}
						{folders.length > 0 ? <DropdownMenuSeparator /> : null}
						<DropdownMenuItem onClick={() => onNewFolderFor(entry)}>
							<FolderPlus /> New folder…
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onClick={() => onRemove(entry)}>
					<BookmarkX /> Remove from watchlist
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function WatchlistRow({
	entry,
	selected,
	folders,
	draggable,
	onSelect,
	onMove,
	onNewFolderFor,
	onRemove,
}: {
	entry: WatchlistEntry;
	selected: boolean;
	folders: WatchlistFolderGroup[];
	/** When true the row can be dragged to file it (fine pointers only). */
	draggable: boolean;
	onSelect: (selection: WatchlistSelection) => void;
	onMove: (
		entry: WatchlistEntry,
		folderId: Id<"watchlistFolders"> | null,
	) => void;
	onNewFolderFor: (entry: WatchlistEntry) => void;
	onRemove: (entry: WatchlistEntry) => void;
}) {
	// Whole-row draggable. Listeners are spread only on fine pointers; the
	// PointerSensor's distance activation (see WatchlistBody) means a click still
	// selects and only a real drag files. `attributes` are deliberately left off
	// so the row keeps a single tab stop (its select button) and the `⋯` menu
	// stays the keyboard/touch filing path.
	const { setNodeRef, listeners, isDragging } = useDraggable({
		id: entry.entryId,
		disabled: !draggable,
	});
	return (
		<li>
			<div
				ref={setNodeRef}
				{...(draggable ? listeners : {})}
				className={cn(
					"group flex items-center gap-1 rounded-2xl border border-border pr-1 transition-colors hover:bg-accent",
					selected && "border-foreground/30 bg-accent",
					// Off the Feed: muted but still selectable — the detail pane
					// explains why (ADR-0004: the entry outlives the Listing).
					!entry.onFeed && "opacity-60",
					// The DragOverlay stands in for the dragged row; fade the source.
					isDragging && "opacity-40",
					// No `touch-none`: dragging is gated to fine pointers, so the only
					// effect would be to block touch-scroll over rows on hybrid devices.
					draggable && "cursor-grab active:cursor-grabbing",
				)}
			>
				<button
					type="button"
					aria-current={selected}
					onClick={() =>
						onSelect({ channelId: entry.channelId, form: entry.form })
					}
					className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
				>
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
				</button>
				<EntryMenu
					entry={entry}
					folders={folders}
					onMove={onMove}
					onNewFolderFor={onNewFolderFor}
					onRemove={onRemove}
				/>
			</div>
		</li>
	);
}

/** A Folder: a collapsible header (chevron + name + count + `⋯` rename/delete)
 * over its entries, newest-first. Collapsing hides the entries only. */
function FolderGroup({
	folder,
	collapsed,
	selection,
	folders,
	dndEnabled,
	onToggleCollapse,
	onRename,
	onDelete,
	onSelect,
	onMove,
	onNewFolderFor,
	onRemove,
}: {
	folder: WatchlistFolderGroup;
	collapsed: boolean;
	selection: WatchlistSelection | null;
	folders: WatchlistFolderGroup[];
	/** Whether drag-and-drop filing is active (fine pointers only). */
	dndEnabled: boolean;
	onToggleCollapse: (folderId: string) => void;
	onRename: (folderId: Id<"watchlistFolders">, name: string) => void;
	onDelete: (folderId: Id<"watchlistFolders">) => void;
	onSelect: (selection: WatchlistSelection) => void;
	onMove: (
		entry: WatchlistEntry,
		folderId: Id<"watchlistFolders"> | null,
	) => void;
	onNewFolderFor: (entry: WatchlistEntry) => void;
	onRemove: (entry: WatchlistEntry) => void;
}) {
	const [renaming, setRenaming] = useState(false);
	// The whole Folder (header + entries) is one drop target, so even a collapsed
	// or empty Folder still accepts a drop on its header.
	const { setNodeRef, isOver } = useDroppable({
		id: folderDroppableId(folder.folderId),
		disabled: !dndEnabled,
	});

	return (
		<div
			ref={setNodeRef}
			className={cn(
				"flex flex-col gap-2 rounded-2xl transition-colors",
				// Ring in while a drag hovers, so the drop target is unambiguous.
				isOver && "bg-accent/60 ring-2 ring-foreground/30 ring-inset",
			)}
		>
			<div className="group flex items-center gap-1">
				{renaming ? (
					<div className="flex-1 pl-1">
						<FolderNameInput
							initialValue={folder.name}
							placeholder="Folder name"
							onSubmit={(name) => {
								setRenaming(false);
								onRename(folder.folderId, name);
							}}
							onCancel={() => setRenaming(false)}
						/>
					</div>
				) : (
					<button
						type="button"
						aria-expanded={!collapsed}
						onClick={() => onToggleCollapse(folder.folderId)}
						className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
					>
						{collapsed ? (
							<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 flex-1 truncate font-medium text-sm">
							{folder.name}
						</span>
						<span className="text-muted-foreground text-xs tabular-nums">
							{folder.entries.length}
						</span>
					</button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon"
								className={MENU_TRIGGER_CLASS}
								aria-label={`Folder actions for ${folder.name}`}
							/>
						}
					>
						<MoreHorizontal className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => setRenaming(true)}>
							<Pencil /> Rename
						</DropdownMenuItem>
						<DropdownMenuItem
							variant="destructive"
							onClick={() => onDelete(folder.folderId)}
						>
							<Trash2 /> Delete folder
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{!collapsed && folder.entries.length > 0 ? (
				<ul className="flex flex-col gap-2 pl-2">
					{folder.entries.map((entry) => (
						<WatchlistRow
							key={entry.entryId}
							entry={entry}
							selected={sameSelection(selection, entry)}
							folders={folders}
							draggable={dndEnabled}
							onSelect={onSelect}
							onMove={onMove}
							onNewFolderFor={onNewFolderFor}
							onRemove={onRemove}
						/>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** Filing a new Folder around a specific entry, or `null` to just create one. */
type NewFolderTarget = { entryId: Id<"watchlistEntries"> | null };

/**
 * The root drop target: dropping an entry here un-files it (back to the root).
 * The root entries live inside it, so their own area is the un-file zone; when
 * the root is empty it renders a dashed placeholder while a drag is in flight so
 * there is still somewhere to drop.
 */
function RootDropZone({
	dndEnabled,
	dragging,
	children,
}: {
	dndEnabled: boolean;
	dragging: boolean;
	children: React.ReactNode;
}) {
	const { setNodeRef, isOver } = useDroppable({
		id: ROOT_DROPPABLE_ID,
		disabled: !dndEnabled,
	});
	const hasChildren = children !== null;
	return (
		<div
			ref={setNodeRef}
			className={cn(
				"rounded-2xl transition-colors",
				isOver && "bg-accent/60 ring-2 ring-foreground/30 ring-inset",
			)}
		>
			{hasChildren ? (
				children
			) : dragging ? (
				<p className="rounded-2xl border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-xs">
					Drop here to remove from a folder
				</p>
			) : null}
		</div>
	);
}

/** The compact card that follows the cursor mid-drag — a chrome-free echo of the
 * row so the Operator sees exactly what they're filing. */
function DragPreviewCard({ entry }: { entry: WatchlistEntry }) {
	return (
		<div className="flex items-center gap-3 rounded-2xl border border-foreground/30 bg-background px-3 py-2 shadow-lg">
			{entry.channel.avatarUrl ? (
				<img
					src={entry.channel.avatarUrl}
					alt=""
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
		</div>
	);
}

/** Flatten a Watchlist's entries (folders + root) to find one by its id — used
 * on drag start to resolve the dragged row and on drag end to skip no-op moves. */
function findEntry(
	list: WatchlistList,
	entryId: Id<"watchlistEntries">,
): WatchlistEntry | undefined {
	for (const folder of list.folders) {
		const hit = folder.entries.find((entry) => entry.entryId === entryId);
		if (hit !== undefined) {
			return hit;
		}
	}
	return list.root.find((entry) => entry.entryId === entryId);
}

/**
 * The drawer's list section: the Operator's whole Watchlist grouped into
 * Folders (alphabetical) over the root entries (newest-first). Folder create /
 * rename / delete and entry filing all run against the watchlist mutations;
 * removal reuses the caller's bookmark toggle for parity with the Feed card.
 */
function WatchlistBody({
	list,
	selection,
	onSelect,
	onRemove,
}: {
	list: WatchlistList | undefined;
	selection: WatchlistSelection | null;
	onSelect: (selection: WatchlistSelection) => void;
	onRemove: (entry: WatchlistEntry) => void;
}) {
	const createFolder = useMutation(api.watchlist.createFolder);
	const renameFolder = useMutation(api.watchlist.renameFolder);
	const deleteFolder = useMutation(api.watchlist.deleteFolder);
	const setEntryFolder = useMutation(api.watchlist.setEntryFolder);
	const { collapsed, toggle: toggleCollapse } = useCollapsedFolders();
	const [newFolder, setNewFolder] = useState<NewFolderTarget | null>(null);
	// Drag-and-drop filing runs on fine pointers only (see useIsFinePointer);
	// touch keeps the Sheet scrollable and files via the `⋯` menu.
	const dndEnabled = useIsFinePointer();
	const [activeEntry, setActiveEntry] = useState<WatchlistEntry | null>(null);
	// A distance threshold lets a plain click still select a row and only a real
	// drag (>6px) begin filing — no long-press, no drag handle needed.
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
	);

	const handleCreateFolder = (name: string, target: NewFolderTarget) => {
		setNewFolder(null);
		createFolder({ name })
			.then(({ folderId }) =>
				// "New folder…" from an entry files it into the folder in one motion.
				target.entryId !== null
					? setEntryFolder({ entryId: target.entryId, folderId })
					: undefined,
			)
			.catch(() => toast.error("Could not create the folder."));
	};
	const handleRename = (folderId: Id<"watchlistFolders">, name: string) => {
		renameFolder({ folderId, name }).catch(() =>
			toast.error("Could not rename the folder."),
		);
	};
	const handleDelete = (folderId: Id<"watchlistFolders">) => {
		deleteFolder({ folderId }).catch(() =>
			toast.error("Could not delete the folder."),
		);
	};
	const handleMove = (
		entry: WatchlistEntry,
		folderId: Id<"watchlistFolders"> | null,
	) => {
		setEntryFolder({ entryId: entry.entryId, folderId }).catch(() =>
			toast.error("Could not move the entry."),
		);
	};
	const openNewFolderFor = (entry: WatchlistEntry) =>
		setNewFolder({ entryId: entry.entryId });

	const handleDragStart = (event: DragStartEvent) => {
		if (list === undefined) {
			return;
		}
		setActiveEntry(
			findEntry(list, event.active.id as Id<"watchlistEntries">) ?? null,
		);
	};
	const handleDragEnd = (event: DragEndEvent) => {
		setActiveEntry(null);
		const { active, over } = event;
		if (list === undefined || over === null) {
			return;
		}
		const entry = findEntry(list, active.id as Id<"watchlistEntries">);
		if (entry === undefined) {
			return;
		}
		// Root un-files; a folder droppable's namespaced id carries the target.
		const target: Id<"watchlistFolders"> | null =
			over.id === ROOT_DROPPABLE_ID
				? null
				: (String(over.id).slice("folder:".length) as Id<"watchlistFolders">);
		// Dropping back where it already sits is a no-op — skip the mutation.
		if ((entry.folderId ?? null) === target) {
			return;
		}
		handleMove(entry, target);
	};

	if (list === undefined) {
		return <Loader />;
	}

	const { folders, root } = list;
	const isEmpty = folders.length === 0 && root.length === 0;

	return (
		<DndContext
			sensors={sensors}
			// Resolve the drop by where the cursor is, not by rect overlap — filing
			// should land the entry in the Folder the Operator points at.
			collisionDetection={pointerWithin}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragCancel={() => setActiveEntry(null)}
		>
			<div className="flex flex-col gap-2">
				<div className="flex justify-end">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 gap-1 px-2 text-muted-foreground text-xs"
						onClick={() => setNewFolder({ entryId: null })}
					>
						<FolderPlus className="size-3.5" /> New folder
					</Button>
				</div>

				{newFolder !== null ? (
					<FolderNameInput
						placeholder="Folder name"
						onSubmit={(name) => handleCreateFolder(name, newFolder)}
						onCancel={() => setNewFolder(null)}
					/>
				) : null}

				{folders.map((folder) => (
					<FolderGroup
						key={folder.folderId}
						folder={folder}
						collapsed={collapsed.has(folder.folderId)}
						selection={selection}
						folders={folders}
						dndEnabled={dndEnabled}
						onToggleCollapse={toggleCollapse}
						onRename={handleRename}
						onDelete={handleDelete}
						onSelect={onSelect}
						onMove={handleMove}
						onNewFolderFor={openNewFolderFor}
						onRemove={onRemove}
					/>
				))}

				{/* Rendered whenever there are root entries, and — so an un-file has a
				    target — also while a drag is in flight even if the root is empty. */}
				{root.length > 0 || activeEntry !== null ? (
					<RootDropZone dndEnabled={dndEnabled} dragging={activeEntry !== null}>
						{root.length > 0 ? (
							<ul className="flex flex-col gap-2">
								{root.map((entry) => (
									<WatchlistRow
										key={entry.entryId}
										entry={entry}
										selected={sameSelection(selection, entry)}
										folders={folders}
										draggable={dndEnabled}
										onSelect={onSelect}
										onMove={handleMove}
										onNewFolderFor={openNewFolderFor}
										onRemove={onRemove}
									/>
								))}
							</ul>
						) : null}
					</RootDropZone>
				) : null}

				{isEmpty ? (
					<p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-xs">
						Your Watchlist is empty. Save a clone candidate with the{" "}
						<Bookmark className="inline size-3 align-[-2px]" aria-hidden />{" "}
						bookmark on a Feed card.
					</p>
				) : null}
			</div>

			<DragOverlay dropAnimation={null}>
				{activeEntry !== null ? <DragPreviewCard entry={activeEntry} /> : null}
			</DragOverlay>
		</DndContext>
	);
}

/**
 * The list/detail split: a vertical resizable group favoring the list (~55/45),
 * with a 25% floor per section so neither can be crushed. The ratio persists
 * via the library's own layout storage; drag and arrow-key resize are built in.
 */
function WatchlistPanels({
	list,
	selection,
	onSelect,
	onRemove,
}: {
	list: WatchlistList | undefined;
	selection: WatchlistSelection | null;
	onSelect: (selection: WatchlistSelection) => void;
	onRemove: (entry: WatchlistEntry) => void;
}) {
	const { defaultLayout, onLayoutChanged } = useDefaultLayout({
		id: SPLIT_LAYOUT_ID,
		storage: browserLayoutStorage,
		onlySaveAfterUserInteractions: true,
	});
	const detail = useQuery(api.watchlist.detail, selection ?? "skip");

	return (
		<ResizablePanelGroup
			orientation="vertical"
			className="min-h-0 flex-1"
			defaultLayout={defaultLayout}
			onLayoutChanged={onLayoutChanged}
		>
			{/* Percent strings, not bare numbers: the library reads numbers as px. */}
			<ResizablePanel id="list" defaultSize="55%" minSize="25%">
				<div className="h-full overflow-y-auto p-3">
					<WatchlistBody
						list={list}
						selection={selection}
						onSelect={onSelect}
						onRemove={onRemove}
					/>
				</div>
			</ResizablePanel>
			{/* Amplified so it reads as draggable: a tall grab zone with an
			    always-visible grip pill and a strip highlight on hover/drag.
			    The resize cursor and arrow-key handling come from the library. */}
			<ResizableHandle
				withHandle
				aria-label="Resize Watchlist sections"
				className="transition-colors after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent active:after:bg-accent aria-[orientation=horizontal]:after:h-3"
			/>
			<ResizablePanel id="detail" defaultSize="45%" minSize="25%">
				<div className="h-full overflow-y-auto p-3">
					{selection === null ? (
						<DetailHint />
					) : (
						<WatchlistDetailPane detail={detail} />
					)}
				</div>
			</ResizablePanel>
		</ResizablePanelGroup>
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
	list,
	selection,
	onSelect,
	onRemove,
	onCollapse,
}: {
	list: WatchlistList | undefined;
	selection: WatchlistSelection | null;
	onSelect: (selection: WatchlistSelection) => void;
	onRemove: (entry: WatchlistEntry) => void;
	onCollapse: () => void;
}) {
	return (
		<aside className="hidden w-[380px] shrink-0 flex-col border-border border-l lg:flex">
			<WatchlistHeader
				count={list ? totalEntries(list) : undefined}
				onClose={onCollapse}
				closeIcon={<PanelRightClose className="size-4" />}
				closeLabel="Collapse Watchlist"
			/>
			<WatchlistPanels
				list={list}
				selection={selection}
				onSelect={onSelect}
				onRemove={onRemove}
			/>
		</aside>
	);
}

/** The below-`lg` fallback: the same Watchlist as a toggleable overlay sheet. */
export function WatchlistSheet({
	list,
	selection,
	onSelect,
	onRemove,
	open,
	onClose,
}: {
	list: WatchlistList | undefined;
	selection: WatchlistSelection | null;
	onSelect: (selection: WatchlistSelection) => void;
	onRemove: (entry: WatchlistEntry) => void;
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
					count={list ? totalEntries(list) : undefined}
					onClose={onClose}
					closeIcon={<X className="size-4" />}
					closeLabel="Close Watchlist"
				/>
				<WatchlistPanels
					list={list}
					selection={selection}
					onSelect={onSelect}
					onRemove={onRemove}
				/>
			</div>
		</div>
	);
}
