import { describe, expect, it } from "vitest";

import {
	buildEnrichmentFingerprint,
	CHANNEL_SIGNAL_NAMES,
	computeClonability,
	ENRICHMENT_FINGERPRINT_VERSION,
	type EnrichmentInput,
	type Signals,
	topSignals,
} from "./clonability";

/** A signal with a given score; rationale text is irrelevant to the weighting. */
const sig = (score: number, rationale = "because") => ({ score, rationale });

describe("computeClonability — short-form channel weighting", () => {
	it("takes the weighted mean of short-form signals, biasing Automatable", () => {
		// weights: automatable 2, transformative 1, improvable 1.
		// (2*90 + 1*30 + 1*30) / 4 = 240 / 4 = 60.
		const signals: Signals = {
			automatable: sig(90),
			transformative: sig(30),
			improvable: sig(30),
		};
		expect(computeClonability(signals)).toBe(60);
	});

	it("lets Automatable move the score more than its peers", () => {
		const base: Signals = {
			automatable: sig(50),
			transformative: sig(50),
			improvable: sig(50),
		};
		expect(computeClonability(base)).toBe(50);

		const bumpAutomatable = computeClonability({
			...base,
			automatable: sig(100),
		});
		const bumpTransformative = computeClonability({
			...base,
			transformative: sig(100),
		});

		// The same +50 bump lands harder on the double-weighted signal: +25 for
		// Automatable (weight 2) vs +13 for a single-weighted peer.
		expect(bumpAutomatable).toBe(75); // (2*100 + 50 + 50) / 4
		expect(bumpTransformative).toBe(63); // (2*50 + 100 + 50) / 4 = 62.5 -> 63
	});

	it("counts only supported channel signals, ignoring stray keys", () => {
		const signals: Signals = {
			automatable: sig(70),
			transformative: sig(70),
			improvable: sig(70),
			enterprise_value: sig(0),
		};
		expect(computeClonability(signals)).toBe(70);
	});

	it("rounds the mean to a whole 0-100 score", () => {
		// (2*81 + 40 + 40) / 4 = 60.5 -> 61.
		expect(
			computeClonability({
				automatable: sig(81),
				transformative: sig(40),
				improvable: sig(40),
			}),
		).toBe(61);
	});

	it("clamps out-of-range scores into 0-100 before averaging", () => {
		expect(
			computeClonability({
				automatable: sig(150),
				transformative: sig(-20),
				improvable: sig(50),
			}),
		).toBe(63); // clamps to (2*100 + 0 + 50) / 4 = 62.5 -> 63
	});
});

describe("computeClonability — graceful degradation (ADR-0003: never gates)", () => {
	it("returns null when signals have not been computed yet", () => {
		expect(computeClonability(null)).toBeNull();
	});

	it("returns null when no scorable supported signal is present", () => {
		expect(computeClonability({})).toBeNull();
		expect(computeClonability({ enterprise_value: sig(90) })).toBeNull();
	});

	it("renormalizes over whichever supported signals are present", () => {
		expect(computeClonability({ automatable: sig(80) })).toBe(80);
	});

	it("drops a malformed score and averages the rest", () => {
		expect(
			computeClonability({
				automatable: sig(Number.NaN),
				transformative: sig(40),
			}),
		).toBe(40);
		expect(
			computeClonability({
				automatable: sig(Number.NaN),
				transformative: sig(Number.NaN),
			}),
		).toBeNull();
	});
});

describe("topSignals", () => {
	it("returns present supported signals, highest score first", () => {
		const signals: Signals = {
			automatable: sig(40, "cheap"),
			transformative: sig(90, "reactions"),
			improvable: sig(70, "lazy thumbs"),
		};
		const top = topSignals(signals);
		expect(top.map((s) => s.name)).toEqual(["transformative", "improvable"]);
		expect(top[0]).toMatchObject({
			label: "Transformative",
			score: 90,
			rationale: "reactions",
		});
	});

	it("honors the limit and ignores unsupported signals", () => {
		const signals: Signals = {
			enterprise_value: sig(99),
			improvable: sig(80),
			automatable: sig(30),
		};
		expect(topSignals(signals, 1).map((s) => s.name)).toEqual(["improvable"]);
	});

	it("returns nothing when signals are absent", () => {
		expect(topSignals(null)).toEqual([]);
		expect(topSignals({})).toEqual([]);
	});

	it("documents the supported signal names", () => {
		expect(CHANNEL_SIGNAL_NAMES).toEqual([
			"automatable",
			"transformative",
			"improvable",
		]);
	});
});

describe("buildEnrichmentFingerprint — material-change detection", () => {
	const input: EnrichmentInput = {
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

	it("bakes in the output-version tag so a version bump invalidates cached scores", () => {
		// The version is the first component of the fingerprint, so bumping
		// ENRICHMENT_FINGERPRINT_VERSION makes every previously stored fingerprint
		// mismatch — already-enriched channels re-enrich rather than skip.
		expect(
			buildEnrichmentFingerprint(input).startsWith(
				`${ENRICHMENT_FINGERPRINT_VERSION}\0`,
			),
		).toBe(true);
	});
});
