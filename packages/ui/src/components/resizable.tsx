import { cn } from "@nichehuntr/ui/lib/utils";
import * as ResizablePrimitive from "react-resizable-panels";

function ResizablePanelGroup({
	className,
	...props
}: ResizablePrimitive.GroupProps) {
	return (
		<ResizablePrimitive.Group
			data-slot="resizable-panel-group"
			className={cn(
				"flex h-full w-full aria-[orientation=vertical]:flex-col",
				className,
			)}
			{...props}
		/>
	);
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
	return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
	withHandle,
	className,
	...props
}: ResizablePrimitive.SeparatorProps & {
	withHandle?: boolean;
}) {
	return (
		<ResizablePrimitive.Separator
			data-slot="resizable-handle"
			className={cn(
				"relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
				className,
			)}
			{...props}
		>
			{withHandle && (
				<div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
			)}
		</ResizablePrimitive.Separator>
	);
}

export type {
	Layout,
	LayoutChangedMeta,
	LayoutStorage,
} from "react-resizable-panels";
// Re-exported so consumers can persist layouts without depending on
// react-resizable-panels directly. `useDefaultLayout` is v4's replacement for
// the old `autoSaveId` prop: wire its `defaultLayout`/`onLayoutChanged` onto
// ResizablePanelGroup, passing `browserLayoutStorage` below — the hook's
// default storage reads the bare `localStorage` global, which throws during
// server rendering.
export { useDefaultLayout } from "react-resizable-panels";

/** localStorage behind an SSR guard for `useDefaultLayout`: the hook reads its
 * storage during server rendering too (via a server snapshot), where `window`
 * doesn't exist. */
export const browserLayoutStorage: ResizablePrimitive.LayoutStorage = {
	getItem: (key) =>
		typeof window === "undefined" ? null : window.localStorage.getItem(key),
	setItem: (key, value) => {
		if (typeof window !== "undefined") {
			window.localStorage.setItem(key, value);
		}
	},
};

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
