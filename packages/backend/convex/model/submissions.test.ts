import { describe, expect, it } from "vitest";

import { resolveChannelRef } from "./submissions";

/** A well-formed `UC…` id: `UC` + 22 base64url chars. */
const RAW_ID = "UC1234567890abcdefABCD-_";

describe("resolveChannelRef", () => {
	describe("raw UC id", () => {
		it("resolves a well-formed raw UC id directly", () => {
			expect(resolveChannelRef(RAW_ID)).toEqual({ kind: "id", id: RAW_ID });
		});

		it("trims surrounding whitespace before matching", () => {
			expect(resolveChannelRef(`  ${RAW_ID}\n`)).toEqual({
				kind: "id",
				id: RAW_ID,
			});
		});
	});

	describe("channel URL", () => {
		it.each([
			`https://youtube.com/channel/${RAW_ID}`,
			`https://www.youtube.com/channel/${RAW_ID}`,
			`http://m.youtube.com/channel/${RAW_ID}`,
			`youtube.com/channel/${RAW_ID}`,
			`https://www.youtube.com/channel/${RAW_ID}/videos`,
		])("resolves %s to its id", (url) => {
			expect(resolveChannelRef(url)).toEqual({ kind: "id", id: RAW_ID });
		});

		it("rejects a /channel/ URL whose id is malformed", () => {
			const ref = resolveChannelRef("https://youtube.com/channel/not-an-id");
			expect(ref).toMatchObject({ kind: "error" });
			expect(ref).toHaveProperty("reason", expect.stringMatching(/id/i));
		});
	});

	describe("handle", () => {
		it("resolves a bare @handle to a handle ref (needs a live lookup)", () => {
			expect(resolveChannelRef("@mrbeast")).toEqual({
				kind: "handle",
				handle: "@mrbeast",
			});
		});

		it("trims a bare @handle", () => {
			expect(resolveChannelRef("  @mrbeast  ")).toEqual({
				kind: "handle",
				handle: "@mrbeast",
			});
		});

		it.each([
			"https://youtube.com/@mrbeast",
			"https://www.youtube.com/@mrbeast",
			"youtube.com/@mrbeast/videos",
		])("resolves the @handle URL %s to a handle ref", (url) => {
			expect(resolveChannelRef(url)).toEqual({
				kind: "handle",
				handle: "@mrbeast",
			});
		});

		it("rejects an @-prefixed string that isn't a valid handle", () => {
			expect(resolveChannelRef("@ab")).toMatchObject({ kind: "error" }); // too short
			expect(resolveChannelRef("@bad handle")).toMatchObject({ kind: "error" });
		});
	});

	describe("out of scope — rejected with a clear reason", () => {
		it.each([
			["https://youtube.com/watch?v=dQw4w9WgXcQ", /video/i],
			["https://www.youtube.com/shorts/abc123", /video/i],
			["https://youtu.be/dQw4w9WgXcQ", /video/i],
			["https://www.youtube.com/embed/abc123", /video/i],
			["https://youtube.com/c/SomeChannel", /legacy|\/c\/|\/user\//i],
			["https://youtube.com/user/SomeUser", /legacy|\/c\/|\/user\//i],
		])("rejects %s", (input, reasonPattern) => {
			const ref = resolveChannelRef(input);
			expect(ref).toMatchObject({ kind: "error" });
			expect(ref).toHaveProperty(
				"reason",
				expect.stringMatching(reasonPattern),
			);
		});
	});

	describe("unrecognized input", () => {
		it.each([
			["", "blank"],
			["   ", "whitespace only"],
			["UC", "prefix only"],
			["UC123", "too short id"],
			[`${RAW_ID}X`, "too long id"],
			["XX1234567890abcdefABCD-_", "wrong prefix"],
			["just some text", "free text"],
			["https://example.com/@mrbeast", "non-YouTube host"],
		])("rejects %j (%s) with a human-readable reason", (input) => {
			const ref = resolveChannelRef(input);
			expect(ref.kind).toBe("error");
			if (ref.kind === "error") {
				expect(ref.reason.length).toBeGreaterThan(0);
			}
		});
	});
});
