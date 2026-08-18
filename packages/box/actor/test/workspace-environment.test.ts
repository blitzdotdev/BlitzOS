import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWorkspaceEnvironmentState } from "../src/credentials.js";

const fixtures = fileURLToPath(
  new URL("../../../schema/fixtures/workspace-environment/", import.meta.url),
);

function sources(kind: "valid" | "invalid"): Array<[string, string]> {
  return readdirSync(join(fixtures, kind))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, readFileSync(join(fixtures, kind, name), "utf8")]);
}

describe("workspace environment state fixtures", () => {
  it("accepts every valid response persisted by the box", () => {
    for (const [name, source] of sources("valid")) {
      expect(() => parseWorkspaceEnvironmentState(source), name).not.toThrow();
    }
  });

  it("rejects every invalid response persisted by the box", () => {
    for (const [name, source] of sources("invalid")) {
      expect(() => parseWorkspaceEnvironmentState(source), name).toThrow();
    }
  });
});
