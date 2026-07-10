import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { Id } from "@nichehuntr/backend/convex/_generated/dataModel";
import type { SubmissionRow } from "@nichehuntr/backend/convex/submissions";
import { Button } from "@nichehuntr/ui/components/button";
import { Input } from "@nichehuntr/ui/components/input";
import { cn } from "@nichehuntr/ui/lib/utils";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useState } from "react";
import { toast } from "sonner";

import Loader from "@/components/loader";

/**
 * Admin surface: authenticated but NOT paywalled. It lives directly under
 * `_auth` (outside `_subscribed`) because curating the Feed is an operational
 * action on a separate authorization axis from being a paying Operator — an
 * admin needs no active subscription (ADR-0005).
 */
export const Route = createFileRoute("/_auth/admin")({
	beforeLoad: async ({ context }) => {
		// `isAdmin` never throws: an unauthenticated caller reads false, but they
		// never get here — the parent `_auth` guard has already bounced them to
		// sign-in. So a false here means a signed-in non-admin; send them home.
		const isAdmin = await context.queryClient.ensureQueryData(
			convexQuery(api.admin.isAdmin, {}),
		);
		if (!isAdmin) {
			throw redirect({ to: "/" });
		}
	},
	head: () => ({
		meta: [{ title: "Admin · nichehuntr" }],
	}),
	component: AdminPage,
});

function AdminPage() {
	return (
		<main className="min-w-0 flex-1 overflow-y-auto">
			<div className="container mx-auto max-w-4xl px-4 py-6">
				<div className="mb-6">
					<h1 className="font-bold text-2xl">Admin</h1>
					<p className="text-muted-foreground text-sm">
						Paste a channel URL, an @handle, or a UC… id to submit it into the
						Feed. Ingestion runs in the background; the table updates live.
					</p>
				</div>
				<SubmitBox />
				<SubmissionsTable />
			</div>
		</main>
	);
}

/** The paste box + submit. Accepts instantly (the worker runs in the background),
 * so on success we just clear the field — the row appears in the live table. */
function SubmitBox() {
	const submit = useMutation(api.submissions.submitChannel);
	const [rawInput, setRawInput] = useState("");
	const [pending, setPending] = useState(false);

	const onSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		const value = rawInput.trim();
		if (value.length === 0 || pending) {
			return;
		}
		setPending(true);
		try {
			await submit({ rawInput: value });
			setRawInput("");
		} catch (err) {
			const code = err instanceof ConvexError ? String(err.data) : "";
			toast.error(
				code === "EMPTY_INPUT"
					? "Paste a channel URL, @handle, or id first."
					: "Couldn't submit that channel. Try again.",
			);
		} finally {
			setPending(false);
		}
	};

	return (
		<form onSubmit={onSubmit} className="mb-8 flex flex-wrap gap-2">
			<Input
				value={rawInput}
				onChange={(e) => setRawInput(e.target.value)}
				placeholder="youtube.com/@handle, /channel/UC…, or a UC… id"
				aria-label="Channel URL, handle, or id"
				className="max-w-md font-mono"
				spellCheck={false}
				autoComplete="off"
			/>
			<Button type="submit" disabled={pending || rawInput.trim().length === 0}>
				Submit
			</Button>
		</form>
	);
}

/**
 * The set of resolved YouTube channel ids that have a Submission currently
 * `pending` or `processing` — mirrors the server's in-flight guard so Refresh is
 * hidden on a tracked row whose Channel is already being (re)submitted. An
 * in-flight refresh carries the canonical id as its `rawInput` before it
 * resolves and as `resolvedYtChannelId` once it does, so we collect both.
 */
function inFlightChannelIds(rows: readonly SubmissionRow[]): Set<string> {
	const ids = new Set<string>();
	for (const row of rows) {
		if (row.status !== "pending" && row.status !== "processing") {
			continue;
		}
		ids.add(row.rawInput);
		if (row.resolvedYtChannelId) {
			ids.add(row.resolvedYtChannelId);
		}
	}
	return ids;
}

/** The Refresh affordance for a tracked row: shown only when it has a canonical
 * resolved id and no Submission for that Channel is already in flight. */
function canRefresh(row: SubmissionRow, inFlight: Set<string>): boolean {
	return (
		row.status === "tracked" &&
		row.resolvedYtChannelId !== null &&
		!inFlight.has(row.resolvedYtChannelId)
	);
}

/** The live Submissions table — reactive, newest-first, status → outcome. */
function SubmissionsTable() {
	const submissions = useQuery(api.submissions.listSubmissions);

	if (submissions === undefined) {
		return <Loader />;
	}
	if (submissions.length === 0) {
		return (
			<p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
				No submissions yet.
			</p>
		);
	}

	const inFlight = inFlightChannelIds(submissions);

	return (
		<div className="overflow-x-auto rounded-2xl border border-border">
			<table className="w-full min-w-lg text-sm">
				<thead>
					<tr className="border-border border-b text-left text-muted-foreground text-xs">
						<th className="px-4 py-2 font-medium">Input</th>
						<th className="px-4 py-2 font-medium">Status</th>
						<th className="px-4 py-2 font-medium">Outcome</th>
						<th className="px-4 py-2 text-right font-medium">
							<span className="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{submissions.map((row) => (
						<tr key={row._id} className="border-border border-b last:border-0">
							<td className="max-w-xs truncate px-4 py-3 font-mono text-xs">
								{row.rawInput}
							</td>
							<td className="px-4 py-3">
								<StatusBadge status={row.status} />
							</td>
							<td className="px-4 py-3 text-muted-foreground">
								<OutcomeText row={row} />
							</td>
							<td className="px-4 py-3 text-right">
								{row.status === "failed" && (
									<RetryButton submissionId={row._id} />
								)}
								{canRefresh(row, inFlight) && (
									<RefreshButton submissionId={row._id} />
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** One-click retry for a failed row — re-runs the same paste in the background so a
 * transient API error doesn't force a re-paste. On success the mutation moves the
 * row off `failed` server-side; the reactive `listSubmissions` query re-runs and
 * this button (rendered only for failed rows) unmounts — so we only clear `pending`
 * on the error path. A row that re-fails is keyed by `_id`, so it remounts a fresh
 * button rather than getting stuck disabled. */
function RetryButton({ submissionId }: { submissionId: Id<"submissions"> }) {
	const retry = useMutation(api.submissions.retrySubmission);
	const [pending, setPending] = useState(false);

	const onRetry = async () => {
		if (pending) {
			return;
		}
		setPending(true);
		try {
			await retry({ submissionId });
		} catch {
			toast.error("Couldn't retry that submission. Try again.");
			setPending(false);
		}
	};

	return (
		<Button variant="outline" size="xs" onClick={onRetry} disabled={pending}>
			Retry
		</Button>
	);
}

/** Refresh a tracked row — re-pulls the Channel's current stats by starting a
 * fresh Submission from its canonical resolved id (ADR-0007). On success a new
 * pending row appears in the reactive table and this row's Channel becomes
 * in-flight, so `canRefresh` hides this button until that refresh finishes; we
 * only clear `pending` on the error path. A concurrent refresh the server
 * rejects surfaces as a toast. */
function RefreshButton({ submissionId }: { submissionId: Id<"submissions"> }) {
	const refresh = useMutation(api.submissions.refreshSubmission);
	const [pending, setPending] = useState(false);

	const onRefresh = async () => {
		if (pending) {
			return;
		}
		setPending(true);
		try {
			await refresh({ submissionId });
		} catch (err) {
			const code = err instanceof ConvexError ? String(err.data) : "";
			toast.error(
				code === "REFRESH_IN_FLIGHT"
					? "That channel already has a refresh in progress."
					: "Couldn't refresh that channel. Try again.",
			);
			setPending(false);
		}
	};

	return (
		<Button variant="outline" size="xs" onClick={onRefresh} disabled={pending}>
			Refresh
		</Button>
	);
}

const STATUS_STYLES: Record<SubmissionRow["status"], string> = {
	pending: "border-border text-muted-foreground",
	processing: "border-primary/40 text-primary",
	tracked: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
	failed: "border-destructive/40 text-destructive",
};

const STATUS_LABELS: Record<SubmissionRow["status"], string> = {
	pending: "Pending",
	processing: "Processing",
	tracked: "Tracked",
	failed: "Failed",
};

function StatusBadge({ status }: { status: SubmissionRow["status"] }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
				STATUS_STYLES[status],
			)}
		>
			{STATUS_LABELS[status]}
		</span>
	);
}

const OUTCOME_STAGE_LABELS = {
	emerging: "Emerging",
	breaking_out: "Breaking Out",
	established: "Established",
	tracked: "Tracked off-Feed",
} as const;

/** The human read of a Submission's result: lifecycle state for tracked rows,
 * the failure reason for failed rows, and a dash while still in flight. */
function OutcomeText({ row }: { row: SubmissionRow }) {
	if (row.status === "failed") {
		return <span className="text-destructive">{row.failureReason}</span>;
	}
	if (row.status === "tracked") {
		const outcome = row.outcome;
		if (!outcome) {
			return <span>Tracked</span>;
		}
		if ("stage" in outcome) {
			const stage = OUTCOME_STAGE_LABELS[outcome.stage];
			const reach =
				outcome.shortsAtOrAbove100k > 0
					? `${outcome.shortsAtOrAbove100k}/${outcome.recentShortsChecked} Shorts at 100K+`
					: `${outcome.shortsAtOrAbove50k}/${outcome.recentShortsChecked} Shorts at 50K+`;
			return (
				<span
					className={
						outcome.feedVisibility === "visible" ? "text-foreground" : undefined
					}
				>
					{stage} · {outcome.fetchedShorts} Shorts · {reach}
				</span>
			);
		}
		return <span>Tracked before lifecycle cutover</span>;
	}
	return <span aria-hidden>—</span>;
}
