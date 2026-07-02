import { describe, expect, it } from "vitest";

import { buildChannelEmbeddingText } from "./embeddings";

describe("buildChannelEmbeddingText", () => {
	it("folds title, description, and recent upload titles into one input", () => {
		const text = buildChannelEmbeddingText(
			{ title: "AI Horror Shorts", description: "Faceless narrated horror." },
			["The Well", "Room 6"],
		);

		expect(text).toContain("AI Horror Shorts");
		expect(text).toContain("Faceless narrated horror.");
		expect(text).toContain("Recent uploads:");
		expect(text).toContain("The Well");
		expect(text).toContain("Room 6");
	});

	it("is deterministic — the same channel always yields the same text", () => {
		const channel = { title: "Deep Finance", description: "Explainers." };
		expect(buildChannelEmbeddingText(channel, ["A", "B"])).toBe(
			buildChannelEmbeddingText(channel, ["A", "B"]),
		);
	});

	it("caps how many recent titles it folds in", () => {
		const titles = Array.from({ length: 20 }, (_, i) => `Video ${i}`);
		const text = buildChannelEmbeddingText({ title: "Chan" }, titles);

		expect(text).toContain("Video 7");
		expect(text).not.toContain("Video 8"); // MAX_TITLES = 8 keeps 0..7
	});

	it("omits the description and uploads sections when there is nothing to add", () => {
		const text = buildChannelEmbeddingText({ title: "Bare" }, []);

		expect(text).toBe("Bare");
	});
});
