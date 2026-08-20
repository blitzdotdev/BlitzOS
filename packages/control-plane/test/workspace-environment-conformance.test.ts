import { describe, expect, it } from "vitest";
import { parseWorkspaceEnvironmentResponse } from "../core/environment.js";
import type { JsonValue } from "../core/http.js";

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/workspace-environment/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixtures(directory: "valid" | "invalid"): Array<[string, JsonValue]> {
  return Object.entries(fixtureSources)
    .filter(([path]) => path.includes(`/workspace-environment/${directory}/`))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, source]) => [path, JSON.parse(source)]);
}

describe("workspace environment shared fixtures", () => {
  it("accepts every valid response", () => {
    for (const [path, value] of fixtures("valid")) {
      expect(() => parseWorkspaceEnvironmentResponse(value), path).not.toThrow();
    }
  });

  it("rejects every invalid response", () => {
    for (const [path, value] of fixtures("invalid")) {
      expect(() => parseWorkspaceEnvironmentResponse(value), path).toThrow();
    }
  });
});
