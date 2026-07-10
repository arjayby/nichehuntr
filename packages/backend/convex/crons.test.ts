import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { internal } from "./_generated/api";

/**
 * ADR-0007 removes cron upkeep entirely: the Discovery pipeline is Admin-
 * triggered, so there must be no Convex cron registry and no leftover cron
 * module. Convex only registers crons from a top-level `convex/crons.ts`
 * default export, so its literal absence means no cron jobs can be registered.
 */
describe("no cron upkeep (ADR-0007)", () => {
	it("has no crons registry module", () => {
		const cronsPath = fileURLToPath(new URL("./crons.ts", import.meta.url));
		expect(existsSync(cronsPath)).toBe(false);
	});

	it("has no leftover enrichCron module in the generated API", () => {
		const modules = Object.keys(internal);
		expect(modules).not.toContain("enrichCron");
		expect(modules).not.toContain("crons");
	});
});
