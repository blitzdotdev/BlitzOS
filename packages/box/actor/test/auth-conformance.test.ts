import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ActorAuthenticator } from "../src/auth.js";

/** The actor's half of the webApp ticket contract. The control plane mints
 * against this corpus and the Go gateway verifies it too; three hand-written
 * parsers for one wire format is what these fixtures exist to pin. */

interface FixtureContext {
  rootSecret: string;
  workspaceId: string;
  workspaceToken: string;
  nowSeconds: number;
}

interface TicketFixture {
  credential: string;
  expect: {
    valid: boolean;
    kind?: string;
    role?: string;
    userId?: string;
    membershipId?: string;
  };
  note: string;
}

const fixtureDir = join(import.meta.dirname, "..", "..", "..", "schema", "fixtures", "webapp-ticket");

async function readJson<Value>(path: string): Promise<Value> {
  return JSON.parse(await readFile(path, "utf8")) as Value;
}

const context = await readJson<FixtureContext>(join(fixtureDir, "context.json"));
const names = (await readdir(join(fixtureDir, "tickets"))).filter((n) => n.endsWith(".json")).sort();

function authenticator(): ActorAuthenticator {
  const directory = mkdtempSync(join(tmpdir(), "actor-ticket-"));
  const tokenPath = join(directory, "webapp-token");
  const workspacePath = join(directory, "workspace-id");
  writeFileSync(tokenPath, context.workspaceToken, { mode: 0o600 });
  writeFileSync(workspacePath, context.workspaceId, { mode: 0o600 });
  return new ActorAuthenticator(tokenPath, workspacePath, () => context.nowSeconds);
}

describe("webApp ticket conformance", () => {
  expect(names.length).toBeGreaterThan(0);

  for (const name of names) {
    test(name, async () => {
      const fixture = await readJson<TicketFixture>(join(fixtureDir, "tickets", name));
      const identity = authenticator().verify(fixture.credential);
      if (!fixture.expect.valid) {
        expect(identity, fixture.note).toBeNull();
        return;
      }
      expect(identity, fixture.note).not.toBeNull();
      expect(identity?.role).toBe(fixture.expect.role);
      expect(identity?.userId).toBe(fixture.expect.userId);
      expect(identity?.membershipId).toBe(fixture.expect.membershipId);
    });
  }
});
