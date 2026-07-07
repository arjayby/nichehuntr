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

/** The human read of a Submission's result: the Proven summary for a tracked
 * row, the failure reason for a failed one, a dash while it's still in flight. */
function OutcomeText({ row }: { row: SubmissionRow }) {
	if (row.status === "failed") {
		return <span className="text-destructive">{row.failureReason}</span>;
	}
	if (row.status === "tracked") {
		const outcome = row.outcome;
		// No settled uploads cleared enough of a window to make a Listing yet — the
		// channel is tracked and may qualify as snapshots accumulate.
		if (!outcome || outcome.listings === 0) {
			return <span>Tracked — not yet Proven</span>;
		}
		// Always surface the full summary — Listings created, of which Proven — so a
		// channel that ingested but cleared none still shows what it produced.
		const listings = `${outcome.listings} Listing${outcome.listings === 1 ? "" : "s"}`;
		return (
			<span className={outcome.proven > 0 ? "text-foreground" : undefined}>
				{listings}, {outcome.proven} Proven
				{outcome.proven === 0 ? " — not yet Proven" : ""}
			</span>
		);
	}
	return <span aria-hidden>—</span>;
}
