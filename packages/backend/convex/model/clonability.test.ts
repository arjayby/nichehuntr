import { describe, expect, it } from "vitest";

import {
	buildEnrichmentFingerprint,
	computeClonability,
	type EnrichmentInput,
	type Signals,
	topSignals,
} from "./clonability";

/** A signal with a given score; rationale text is irrelevant to the weighting. */
const sig = (score: number, rationale = "because") => ({ score, rationale });

describe("computeClonability — weighting per form", () => {
	it("takes the weighted mean of short-form signals, biasing Automatable", () => {
		// short weights: automatable 2, transformative 1, improvable 1.
		// (2·90 + 1·30 + 1·30) / 4 = 240 / 4 = 60.
		const signals: Signals = {
			automatable: sig(90),
			transformative: sig(30),
			improvable: sig(30),
		};
		expect(computeClonability(signals, "short")).toBe(60);
	});

	it("lets Automatable move the short-form score more than its peers", () => {
		const base: Signals = {
			automatable: sig(50),
			transformative: sig(50),
			improvable: sig(50),
		};
		expect(computeClonability(base, "short")).toBe(50);

		const bumpAutomatable = computeClonability(
			{ ...base, automatable: sig(100) },
			"short",
		);
		const bumpTransformative = computeClonability(
			{ ...base, transformative: sig(100) },
			"short",
		);

		// The same +50 bump lands harder on the double-weighted signal: +25 for
		// Automatable (weight 2) vs +13 for a single-weighted peer.
		expect(bumpAutomatable).toBe(75); // (2·100 + 50 + 50) / 4
		expect(bumpTransformative).toBe(63); // (2·50 + 100 + 50) / 4 = 62.5 → 63
	});

	it("weights the two long-form signals evenly", () => {
		const signals: Signals = {
			enterprise_value: sig(80),
			improvable: sig(40),
		};
		expect(computeClonability(signals, "long")).toBe(60);
	});

	it("counts only the form's own signals, ignoring stray keys", () => {
		// enterprise_value is a long-form signal — it must not affect a short score.
		const signals: Signals = {
			automatable: sig(70),
			transformative: sig(70),
			improvable: sig(70),
			enterprise_value: sig(0),
		};
		expect(computeClonability(signals, "short")).toBe(70);
	});

	it("rounds the mean to a whole 0–100 score", () => {
		// (81 + 40) / 2 = 60.5 → 61.
		expect(
			computeClonability(
				{ enterprise_value: sig(81), improvable: sig(40) },
				"long",
			),
		).toBe(61);
	});

	it("clamps out-of-range scores into 0–100 before averaging", () => {
		expect(
			computeClonability(
				{ enterprise_value: sig(150), improvable: sig(-20) },
				"long",
			),
		).toBe(50); // clamps to 100 and 0 → (100 + 0) / 2
	});
});

describe("computeClonability — graceful degradation (ADR-0003: never gates)", () => {
	it("returns null when signals have not been computed yet", () => {
		expect(computeClonability(null, "short")).toBeNull();
		expect(computeClonability(null, "long")).toBeNull();
	});

	it("returns null when no scorable signal is present", () => {
		expect(computeClonability({}, "short")).toBeNull();
		// Only a stray, wrong-form signal — none of short's own are present.
		expect(
			computeClonability({ enterprise_value: sig(90) }, "short"),
		).toBeNull();
	});

	it("renormalizes over whichever signals are present", () => {
		// Only Automatable scored: the mean is just that score, not diluted by the
		// missing peers.
		expect(computeClonability({ automatable: sig(80) }, "short")).toBe(80);
	});

	it("drops a malformed score and averages the rest", () => {
		expect(
			computeClonability(
				{ enterprise_value: sig(Number.NaN), improvable: sig(40) },
				"long",
			),
		).toBe(40);
		// Every signal malformed ⇒ nothing to average ⇒ null.
		expect(
			computeClonability(
				{ enterprise_value: sig(Number.NaN), improvable: sig(Number.NaN) },
				"long",
			),
		).toBeNull();
	});
});

describe("topSignals", () => {
	it("returns the form's present signals, highest score first", () => {
		const signals: Signals = {
			automatable: sig(40, "cheap"),
			transformative: sig(90, "reactions"),
			improvable: sig(70, "lazy thumbs"),
		};
		const top = topSignals(signals, "short");
		expect(top.map((s) => s.name)).toEqual(["transformative", "improvable"]);
		expect(top[0]).toMatchObject({
			label: "Transformative",
			score: 90,
			rationale: "reactions",
		});
	});

	it("honors the limit and ignores signals outside the form", () => {
		const signals: Signals = {
			enterprise_value: sig(30),
			improvable: sig(80),
			automatable: sig(99), // short-form signal — not part of long
		};
		expect(topSignals(signals, "long", 1).map((s) => s.name)).toEqual([
			"improvable",
		]);
	});

	it("returns nothing when signals are absent", () => {
		expect(topSignals(null, "short")).toEqual([]);
		expect(topSignals({}, "long")).toEqual([]);
	});
});

describe("buildEnrichmentFingerprint — material-change detection", () => {
	const input: EnrichmentInput = {
		form: "short",
		channelTitle: "AI Horror Shorts",
		channelDescription: "Faceless narrated horror.",
		videos: [
			{ ytId: "v1", title: "The Well", thumbnailUrl: "https://img/1.jpg" },
			{ ytId: "v2", title: "Room 6", thumbnailUrl: "https://img/2.jpg" },
		],
	};

	it("is deterministic for the same inputs", () => {
		expect(buildEnrichmentFingerprint(input)).toBe(
			buildEnrichmentFingerprint(structuredClone(input)),
		);
	});

	it("changes when a title is edited", () => {
		const edited = structuredClone(input);
		const [first] = edited.videos;
		if (first) {
			first.title = "The Deep Well";
		}
		expect(buildEnrichmentFingerprint(edited)).not.toBe(
			buildEnrichmentFingerprint(input),
		);
	});

	it("changes when a thumbnail is swapped", () => {
		const edited = structuredClone(input);
		const [first] = edited.videos;
		if (first) {
			first.thumbnailUrl = "https://img/1-new.jpg";
		}
		expect(buildEnrichmentFingerprint(edited)).not.toBe(
			buildEnrichmentFingerprint(input),
		);
	});

	it("changes when a new upload appears", () => {
		const edited = structuredClone(input);
		edited.videos.push({ ytId: "v3", title: "Attic", thumbnailUrl: "u" });
		expect(buildEnrichmentFingerprint(edited)).not.toBe(
			buildEnrichmentFingerprint(input),
		);
	});
});
