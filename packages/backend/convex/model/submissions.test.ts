import { describe, expect, it } from "vitest";

import { resolveChannelId } from "./submissions";

/** A well-formed `UC…` id: `UC` + 22 base64url chars. */
const RAW_ID = "UC1234567890abcdefABCD-_";

describe("resolveChannelId", () => {
	it("accepts a well-formed raw UC id", () => {
		expect(resolveChannelId(RAW_ID)).toBe(RAW_ID);
	});

	it("trims surrounding whitespace before matching", () => {
		expect(resolveChannelId(`  ${RAW_ID}\n`)).toBe(RAW_ID);
	});

	it("returns null for a channel URL (deferred to a later slice)", () => {
		expect(
			resolveChannelId(`https://youtube.com/channel/${RAW_ID}`),
		).toBeNull();
	});

	it("returns null for a bare handle (deferred to a later slice)", () => {
		expect(resolveChannelId("@mrbeast")).toBeNull();
	});

	it.each([
		["", "blank input"],
		["UC", "prefix only"],
		["UC123", "too short"],
		[`${RAW_ID}X`, "too long"],
		["XX1234567890abcdefABCD-_", "wrong prefix"],
		["UC1234567890abcdefABCD-!", "illegal character"],
	])("returns null for %j (%s)", (input) => {
		expect(resolveChannelId(input)).toBeNull();
	});
});
