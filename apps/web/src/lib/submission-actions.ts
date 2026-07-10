import type { SubmissionRow } from "@nichehuntr/backend/convex/submissions";

/**
 * The row action that matches a Submission's intent (issue #68). Retry repairs a
 * `failed` intake in place; Refresh starts a fresh Submission for a successfully
 * `tracked` Channel; in-flight and pre-tracked rows expose nothing. Keeping this
 * one mapping pure and testable is what lets the admin table stay a thin render
 * of it (ADR-0007).
 *
 * - `"retry"`  — a `failed` row (repairs the same row via `retrySubmission`).
 * - `"refresh"` — a `tracked` row with a canonical `resolvedYtChannelId` and no
 *   Submission for that Channel already in flight (starts a new one via
 *   `refreshSubmission`).
 * - `"none"`   — `pending`/`processing` (already in flight), a `tracked` row with
 *   no resolved id, or a `tracked` row whose Channel is being (re)submitted.
 */
export type RowAction = "retry" | "refresh" | "none";

export function rowAction(
	row: SubmissionRow,
	inFlight: ReadonlySet<string>,
): RowAction {
	if (row.status === "failed") {
		return "retry";
	}
	if (
		row.status === "tracked" &&
		row.resolvedYtChannelId !== null &&
		!inFlight.has(row.resolvedYtChannelId)
	) {
		return "refresh";
	}
	return "none";
}

/**
 * The resolved YouTube channel ids with a Submission currently `pending` or
 * `processing` — the client mirror of the server's in-flight guard
 * (`hasInFlightSubmissionFor`) that keeps Refresh hidden on a tracked row whose
 * Channel is already being (re)submitted. An in-flight refresh carries the
 * canonical id as its `rawInput` before it resolves and as `resolvedYtChannelId`
 * once it does, so we collect both.
 */
export function inFlightChannelIds(
	rows: readonly SubmissionRow[],
): Set<string> {
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
