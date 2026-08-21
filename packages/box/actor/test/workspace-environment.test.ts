import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CredentialSource, parseWorkspaceEnvironmentVariables } from "../src/credentials.js";

const fixtures = fileURLToPath(
  new URL("../../../schema/fixtures/workspace-environment/", import.meta.url),
);

/** The actor consumes only `env`, so it answers to the fixtures that constrain
 * `env`. The startup script and files-ready flag are the broker's to validate. */
const notActorConcerns = new Set([
  "extra-field.json",
  "files-ready-type.json",
  "startup-script-type.json",
]);

function sources(kind: "valid" | "invalid"): Array<[string, string]> {
  return readdirSync(join(fixtures, kind))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, readFileSync(join(fixtures, kind, name), "utf8")]);
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "blitz-actor-env-"));
}

describe("workspace environment state fixtures", () => {
  it("accepts every valid response persisted by the box", () => {
    for (const [name, source] of sources("valid")) {
      expect(() => parseWorkspaceEnvironmentVariables(source), name).not.toThrow();
    }
  });

  it("rejects every invalid environment persisted by the box", () => {
    for (const [name, source] of sources("invalid")) {
      if (notActorConcerns.has(name)) continue;
      expect(() => parseWorkspaceEnvironmentVariables(source), name).toThrow();
    }
  });

  it("reads the variables the broker stored", () => {
    const directory = stateDir();
    mkdirSync(join(directory, "env"), { recursive: true });
    writeFileSync(join(directory, "env", "environment.json"), JSON.stringify({
      env: { PROJECT_MODE: "analysis" },
      startupScript: "npm install\n",
      filesReady: true,
    }));
    return expect(new CredentialSource(directory).environment())
      .resolves.toMatchObject({ PROJECT_MODE: "analysis" });
  });
});

describe("workspace environment never gates a prompt", () => {
  it("falls back to the process environment when the file is absent", async () => {
    const directory = stateDir();
    // Enrolled: the broker is running, it just has not written the file. This
    // is the state an enrolled box with no environment configured stays in.
    writeFileSync(join(directory, "broker.json"), "{}");
    writeFileSync(join(directory, "origin"), "https://example.test");
    const source = new CredentialSource(directory);
    await expect(source.environment()).resolves.toMatchObject({ PATH: process.env.PATH });
    // Waiting happens once; a later prompt must not pay for it again.
    const started = Date.now();
    await expect(source.environment()).resolves.toMatchObject({ PATH: process.env.PATH });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("falls back when the stored environment is corrupt", async () => {
    const directory = stateDir();
    mkdirSync(join(directory, "env"), { recursive: true });
    writeFileSync(join(directory, "env", "environment.json"), "{ not json");
    await expect(new CredentialSource(directory).environment())
      .resolves.toMatchObject({ PATH: process.env.PATH });
  });

  it("keeps the last good variables when a later read is torn", async () => {
    const directory = stateDir();
    const statePath = join(directory, "env", "environment.json");
    mkdirSync(join(directory, "env"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      env: { KEEP: "yes" },
      startupScript: null,
      filesReady: true,
    }));
    const source = new CredentialSource(directory);
    await expect(source.environment()).resolves.toMatchObject({ KEEP: "yes" });
    writeFileSync(statePath, '{"env": {"KEEP');
    await expect(source.environment()).resolves.toMatchObject({ KEEP: "yes" });
  });
});
