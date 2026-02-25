import { describe, it, expect } from "vitest";
import {
  extractRequirements,
  checkEligibility,
  formatMissingReason,
} from "../../src/skills/eligibility.js";
import type { SkillMetadata } from "../../src/skills/frontmatter.js";

describe("extractRequirements", () => {
  it("should return empty arrays for null metadata", () => {
    expect(extractRequirements(null)).toEqual({ env: [], bins: [] });
  });

  it("should parse a single env string", () => {
    const meta = { "requires-env": "GH_TOKEN" } as SkillMetadata;
    expect(extractRequirements(meta)).toEqual({
      env: ["GH_TOKEN"],
      bins: [],
    });
  });

  it("should parse an env array", () => {
    const meta = { "requires-env": ["A", "B"] } as SkillMetadata;
    expect(extractRequirements(meta)).toEqual({
      env: ["A", "B"],
      bins: [],
    });
  });

  it("should parse both env and bins populated", () => {
    const meta = {
      "requires-env": "API_KEY, SECRET",
      "requires-bins": ["git", "gh"],
    } as SkillMetadata;

    expect(extractRequirements(meta)).toEqual({
      env: ["API_KEY", "SECRET"],
      bins: ["git", "gh"],
    });
  });
});

describe("checkEligibility", () => {
  it("should be eligible when there are no requirements", () => {
    const result = checkEligibility({ env: [], bins: [] });
    expect(result).toEqual({
      eligible: true,
      missingEnv: [],
      missingBins: [],
    });
  });

  it("should be eligible when all env vars are present", () => {
    const envMap: Record<string, string> = { A: "1", B: "2" };
    const result = checkEligibility(
      { env: ["A", "B"], bins: [] },
      (key) => envMap[key],
    );
    expect(result.eligible).toBe(true);
    expect(result.missingEnv).toEqual([]);
  });

  it("should be ineligible when env vars are missing", () => {
    const envMap: Record<string, string> = { A: "1" };
    const result = checkEligibility(
      { env: ["A", "B", "C"], bins: [] },
      (key) => envMap[key],
    );
    expect(result.eligible).toBe(false);
    expect(result.missingEnv).toEqual(["B", "C"]);
  });

  it("should be ineligible when binaries are missing", () => {
    const available = new Set(["git"]);
    const result = checkEligibility(
      { env: [], bins: ["git", "docker"] },
      () => undefined,
      (name) => available.has(name),
    );
    expect(result.eligible).toBe(false);
    expect(result.missingBins).toEqual(["docker"]);
  });

  it("should report both missing env and missing bins", () => {
    const result = checkEligibility(
      { env: ["TOKEN"], bins: ["ffmpeg"] },
      () => undefined,
      () => false,
    );
    expect(result.eligible).toBe(false);
    expect(result.missingEnv).toEqual(["TOKEN"]);
    expect(result.missingBins).toEqual(["ffmpeg"]);
  });
});

describe("formatMissingReason", () => {
  it("should format missing env only", () => {
    const reason = formatMissingReason({
      eligible: false,
      missingEnv: ["X", "Y"],
      missingBins: [],
    });
    expect(reason).toBe("Missing env: X, Y");
  });

  it("should format missing bins only", () => {
    const reason = formatMissingReason({
      eligible: false,
      missingEnv: [],
      missingBins: ["docker"],
    });
    expect(reason).toBe("Missing binary: docker");
  });

  it("should format both missing env and bins", () => {
    const reason = formatMissingReason({
      eligible: false,
      missingEnv: ["TOKEN"],
      missingBins: ["gh"],
    });
    expect(reason).toBe("Missing env: TOKEN; Missing binary: gh");
  });

  it("should return empty string when nothing is missing", () => {
    const reason = formatMissingReason({
      eligible: true,
      missingEnv: [],
      missingBins: [],
    });
    expect(reason).toBe("");
  });
});
