import { describe, expect, it } from "vitest";
import { parseMintResult } from "../core/connections/pull-wire.js";

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/connection-pull/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixtures(directory: "valid" | "invalid"): [string, unknown][] {
  return Object.entries(fixtureSources)
    .filter(([path]) => path.includes(`/connection-pull/${directory}/`))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => [path, JSON.parse(source)]);
}

describe("connection pull shared fixtures", () => {
  it("finds the corpus", () => {
    // A glob that matched nothing would let every assertion below pass while
    // testing nothing.
    expect(fixtures("valid").length).toBeGreaterThan(0);
    expect(fixtures("invalid").length).toBeGreaterThan(0);
  });

  it("accepts every valid body", () => {
    for (const [path, value] of fixtures("valid")) {
      expect(() => parseMintResult(value), path).not.toThrow();
    }
  });

  it("rejects every invalid body", () => {
    for (const [path, value] of fixtures("invalid")) {
      expect(() => parseMintResult(value), path).toThrow();
    }
  });

  it("returns the body unchanged, so the box reads exactly what was minted", () => {
    for (const [path, value] of fixtures("valid")) {
      expect(parseMintResult(value), path).toEqual(value);
    }
  });
});
