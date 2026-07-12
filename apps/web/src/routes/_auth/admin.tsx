import { convexQuery } from "@convex-dev/react-query";
import { api } from "@nichehuntr/backend/convex/_generated/api";
import type { Id } from "@nichehuntr/backend/convex/_generated/dataModel";
import type { ScoutRunRow } from "@nichehuntr/backend/convex/scout";
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
import { inFlightChannelIds, rowAction } from "@/lib/submission-actions";

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
				<ScoutHeartbeat />
			</div>
		</main>
	);
}

/** The Scout's heartbeat: recent `scoutRuns` newest-first, so a dead Scout is
 * visible at a glance. No alerting — this panel is v1's only death signal (issue
 * #83). Admin-gated by the same route guard as the Submissions table above. */
function ScoutHeartbeat() {
	return (
		<section className="mt-10">
			<div className="mb-3">
				<h2 className="font-bold text-lg">Scout runs</h2>
				<p className="text-muted-foreground text-sm">
					The automated discoverer's recent runs, newest first. A stale top row
					or an error is the only sign the Scout has stopped.
				</p>
			</div>
			<ScoutRunsTable />
		</section>
	);
}

/** The live Scout-runs table — reactive, newest-first, counters + timestamps, with
 * error text when a run aborted. */
function ScoutRunsTable() {
	const runs = useQuery(api.scout.listScoutRuns);

	if (runs === undefined) {
		return <Loader />;
	}
	if (runs.length === 0) {
		return (
			<p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
				No Scout runs yet.
			</p>
		);
	}

	return (
		<div className="overflow-x-auto rounded-2xl border border-border">
			<table className="w-full min-w-lg text-sm">
				<thead>
					<tr className="border-border border-b text-left text-muted-foreground text-xs">
						<th className="px-4 py-2 font-medium">Started</th>
						<th className="px-4 py-2 font-medium">Finished</th>
						<th className="px-4 py-2 text-right font-medium">Queries</th>
						<th className="px-4 py-2 text-right font-medium">Candidates</th>
						<th className="px-4 py-2 text-right font-medium">Submitted</th>
						<th className="px-4 py-2 text-right font-medium">Quota</th>
						<th className="px-4 py-2 font-medium">Error</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((run) => (
						<tr key={run._id} className="border-border border-b last:border-0">
							<td className="px-4 py-3 font-mono text-xs">
								{runTimestamp.format(run.startedAt)}
							</td>
							<td className="px-4 py-3">
								<FinishedCell run={run} />
							</td>
							<td className="px-4 py-3 text-right font-mono text-xs">
								{run.queriesUsed}
							</td>
							<td className="px-4 py-3 text-right font-mono text-xs">
								{run.candidatesSeen}
							</td>
							<td className="px-4 py-3 text-right font-mono text-xs">
								{run.channelsSubmitted}
							</td>
							<td className="px-4 py-3 text-right font-mono text-xs">
								{run.estimatedQuotaUnits}
							</td>
							<td className="max-w-xs px-4 py-3">
								{run.error ? (
									<span className="text-destructive text-xs">{run.error}</span>
								) : (
									<span className="text-muted-foreground" aria-hidden>
										—
									</span>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const runTimestamp = new Intl.DateTimeFormat("en", {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

/** The Finished column: a running row (no `finishedAt`) reads "Running…"; a
 * settled one shows when it finished. */
function FinishedCell({ run }: { run: ScoutRunRow }) {
	if (run.finishedAt === null) {
		return <span className="text-primary text-xs">Running…</span>;
	}
	return (
		<span className="font-mono text-xs">
			{runTimestamp.format(run.finishedAt)}
		</span>
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
						<th className="px-4 py-2 font-medium">Source</th>
						<th className="px-4 py-2 font-medium">Status</th>
						<th className="px-4 py-2 font-medium">Outcome</th>
						<th className="px-4 py-2 text-right font-medium">
							<span className="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{submissions.map((row) => {
						const action = rowAction(row, inFlight);
						return (
							<tr
								key={row._id}
								className="border-border border-b last:border-0"
							>
								<td className="max-w-xs truncate px-4 py-3 font-mono text-xs">
									{row.rawInput}
								</td>
								<td className="px-4 py-3">
									<SourceBadge source={row.source} />
								</td>
								<td className="px-4 py-3">
									<StatusBadge status={row.status} />
								</td>
								<td className="px-4 py-3 text-muted-foreground">
									<OutcomeText row={row} />
								</td>
								<td className="px-4 py-3 text-right">
									{action === "retry" && <RetryButton submissionId={row._id} />}
									{action === "refresh" && (
										<RefreshButton submissionId={row._id} />
									)}
								</td>
							</tr>
						);
					})}
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
 * in-flight, so `rowAction` hides this button until that refresh finishes; we
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

/** The shared pill shape behind the Source and Status columns — one border/text
 * tone fed in per badge. Keeps the two columns visually identical by construction. */
function Badge({
	tone,
	children,
}: {
	tone: string;
	children: React.ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
				tone,
			)}
		>
			{children}
		</span>
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
	return <Badge tone={STATUS_STYLES[status]}>{STATUS_LABELS[status]}</Badge>;
}

const SOURCE_STYLES: Record<SubmissionRow["source"], string> = {
	admin: "border-border text-muted-foreground",
	scout: "border-primary/40 text-primary",
};

const SOURCE_LABELS: Record<SubmissionRow["source"], string> = {
	admin: "Admin",
	scout: "Scout",
};

/** Which front door a Submission came through: an Admin paste or the automated
 * Scout (ADR-0008). A manual boost vs. the primary intake at a glance. */
function SourceBadge({ source }: { source: SubmissionRow["source"] }) {
	return <Badge tone={SOURCE_STYLES[source]}>{SOURCE_LABELS[source]}</Badge>;
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
