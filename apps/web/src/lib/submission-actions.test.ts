import type {
	Id,
	TableNames,
} from "@nichehuntr/backend/convex/_generated/dataModel";
import type { SubmissionRow } from "@nichehuntr/backend/convex/submissions";
import { describe, expect, it } from "vitest";

import { inFlightChannelIds, rowAction } from "./submission-actions";

function id<T extends TableNames>(value: string): Id<T> {
	return value as Id<T>;
}

/** Build a SubmissionRow with sensible per-status defaults, overridable per test.
 * Tracked rows default to carrying a resolved id (the eligible-refresh shape).
 * Row-action visibility never reads `outcome`, so leaving it null is fine. */
function row(overrides: Partial<SubmissionRow>): SubmissionRow {
	const status = overrides.status ?? "pending";
	return {
		_id: id("sub_default"),
		_creationTime: 0,
		rawInput: "UCdefault",
		source: "admin",
		status,
		resolvedYtChannelId: status === "tracked" ? "UCdefault" : null,
		channelId: null,
		outcome: null,
		failureReason:
			status === "failed" ? "YouTube API error — try again." : null,
		...overrides,
	};
}

const NONE_IN_FLIGHT: ReadonlySet<string> = new Set();

describe("rowAction", () => {
	it("gives a failed row Retry", () => {
		expect(rowAction(row({ status: "failed" }), NONE_IN_FLIGHT)).toBe("retry");
	});

	it("gives an eligible tracked row Refresh", () => {
		expect(rowAction(row({ status: "tracked" }), NONE_IN_FLIGHT)).toBe(
			"refresh",
		);
	});

	it("gives a pending row no action", () => {
		expect(rowAction(row({ status: "pending" }), NONE_IN_FLIGHT)).toBe("none");
	});

	it("gives a processing row no action", () => {
		expect(rowAction(row({ status: "processing" }), NONE_IN_FLIGHT)).toBe(
			"none",
		);
	});

	it("never offers Refresh on a failed row", () => {
		// A failed refresh attempt could still carry a resolved id, but Retry — not
		// Refresh — is the failed-row affordance.
		expect(
			rowAction(
				row({ status: "failed", resolvedYtChannelId: "UCfailed" }),
				NONE_IN_FLIGHT,
			),
		).toBe("retry");
	});

	it("withholds Refresh from a tracked row with no resolved id", () => {
		// Legacy rows tracked before the resolved id was recorded can't be refreshed
		// — Refresh needs a canonical id to submit from.
		expect(
			rowAction(
				row({ status: "tracked", resolvedYtChannelId: null }),
				NONE_IN_FLIGHT,
			),
		).toBe("none");
	});

	it("withholds Refresh while the same channel is already in flight", () => {
		const inFlight = new Set(["UCbusy"]);
		expect(
			rowAction(
				row({ status: "tracked", resolvedYtChannelId: "UCbusy" }),
				inFlight,
			),
		).toBe("none");
	});

	it("still offers Refresh when a different channel is in flight", () => {
		const inFlight = new Set(["UCother"]);
		expect(
			rowAction(
				row({ status: "tracked", resolvedYtChannelId: "UCbusy" }),
				inFlight,
			),
		).toBe("refresh");
	});
});

describe("inFlightChannelIds", () => {
	it("collects the raw input and resolved id of pending and processing rows", () => {
		const ids = inFlightChannelIds([
			row({ status: "pending", rawInput: "UCpending" }),
			row({
				status: "processing",
				rawInput: "@handle",
				resolvedYtChannelId: "UCprocessing",
			}),
		]);
		expect(ids).toEqual(new Set(["UCpending", "@handle", "UCprocessing"]));
	});

	it("ignores tracked and failed rows", () => {
		const ids = inFlightChannelIds([
			row({ status: "tracked", resolvedYtChannelId: "UCtracked" }),
			row({ status: "failed", rawInput: "UCfailed" }),
		]);
		expect(ids.size).toBe(0);
	});

	it("catches an in-flight refresh by its raw input before it resolves", () => {
		// A fresh Refresh submits the canonical id as rawInput and hasn't resolved
		// yet, so the pending row must still shadow its tracked source.
		const ids = inFlightChannelIds([
			row({
				status: "pending",
				rawInput: "UCcanonical",
				resolvedYtChannelId: null,
			}),
		]);
		expect(ids.has("UCcanonical")).toBe(true);
	});
});
