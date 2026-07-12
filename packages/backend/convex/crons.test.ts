import { getFunctionName } from "convex/server";
import { describe, expect, it } from "vitest";

import { internal } from "./_generated/api";
import crons from "./crons";

/**
 * ADR-0008 reintroduces exactly one scheduled surface (superseding ADR-0007's
 * "no crons" stance): the Scout run every 3 hours and the wildcat call daily,
 * both registered through Convex's top-level `crons.ts` default export. These
 * assert the registry's *contents* — the cadence and the exact entrypoints —
 * replacing the old guard that asserted no registry existed.
 */
describe("Scout cron registry (ADR-0008)", () => {
	const jobs = Object.values(crons.crons);
	/** The registered job that fires the given internal function, or undefined. */
	const jobByFn = (ref: Parameters<typeof getFunctionName>[0]) =>
		jobs.find((job) => job.name === getFunctionName(ref));

	it("registers exactly the Scout run and the wildcat call", () => {
		expect(jobs).toHaveLength(2);
	});

	it("fires the Scout run every 3 hours via scout:scoutRunAction", () => {
		const scout = jobByFn(internal.scout.scoutRunAction);
		expect(scout).toBeDefined();
		expect(scout?.schedule).toEqual({ type: "interval", hours: 3 });
	});

	it("fires the wildcat call daily via enrichChannel:wildcatWorker", () => {
		const wildcat = jobByFn(internal.enrichChannel.wildcatWorker);
		expect(wildcat).toBeDefined();
		// A fixed daily cron at 00:00 UTC — `crons.cron`, not the `daily` helper.
		expect(wildcat?.schedule).toEqual({ type: "cron", cron: "0 0 * * *" });
	});

	it("fires the cron Scout run identically to a manual scoutRunAction", () => {
		// scoutRunAction takes no args; the cron passes only the empty args object,
		// so a cron-fired run is behaviorally identical to a manual
		// `convex run scout:scoutRunAction`.
		expect(jobByFn(internal.scout.scoutRunAction)?.args).toEqual([{}]);
	});
});
