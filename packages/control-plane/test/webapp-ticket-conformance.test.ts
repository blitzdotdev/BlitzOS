import { describe, expect, it } from "vitest";
import { WorkspaceWebAppAuth } from "../core/webapp-tickets.js";

/** The control-plane half of the webApp ticket contract. The Go gateway and
 * the Node actor read the same corpus, so a claim one side starts enforcing
 * and another still ignores fails here instead of quietly changing who may do
 * what on a box. */

interface TicketExpectation {
  valid: boolean;
  kind?: "ticket" | "static";
  role?: string;
  userId?: string;
  membershipId?: string;
}

interface TicketFixture {
  credential: string;
  expect: TicketExpectation;
  note: string;
}

interface FixtureContext {
  rootSecret: string;
  workspaceId: string;
  workspaceToken: string;
  nowSeconds: number;
}

const contextSource = import.meta.glob<string>(
  "../../schema/fixtures/webapp-ticket/context.json",
  { eager: true, import: "default", query: "?raw" },
);
const ticketSources = import.meta.glob<string>(
  "../../schema/fixtures/webapp-ticket/tickets/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function parsed<Value>(source: string | undefined, label: string): Value {
  if (source === undefined) throw new Error(`missing fixture: ${label}`);
  return JSON.parse(source) as Value;
}

const context = parsed<FixtureContext>(Object.values(contextSource)[0], "context.json");

describe("webApp ticket conformance", () => {
  const auth = new WorkspaceWebAppAuth(context.rootSecret);

  it("derives the workspace token the guests are given", async () => {
    await expect(auth.tokenFor(context.workspaceId)).resolves.toBe(context.workspaceToken);
  });

  const entries = Object.entries(ticketSources).sort(([left], [right]) =>
    left.localeCompare(right));
  expect(entries.length).toBeGreaterThan(0);

  for (const [path, source] of entries) {
    const name = path.split("/").at(-1) ?? path;
    const fixture = parsed<TicketFixture>(source, name);
    it(`${name}: ${fixture.note}`, async () => {
      const verified = await auth.verify(
        fixture.credential,
        context.workspaceId,
        context.nowSeconds,
      );
      if (!fixture.expect.valid) {
        expect(verified).toBeNull();
        return;
      }
      expect(verified).not.toBeNull();
      expect(verified?.kind).toBe(fixture.expect.kind);
      expect(verified?.claims.role).toBe(fixture.expect.role);
      expect(verified?.claims.userId).toBe(fixture.expect.userId);
      expect(verified?.claims.membershipId).toBe(fixture.expect.membershipId);
      expect(verified?.claims.workspaceId).toBe(context.workspaceId);
    });
  }

  it("mints tickets its own verifier accepts", async () => {
    const credential = await auth.mint({
      workspaceId: context.workspaceId,
      userId: "user-round-trip",
      membershipId: "membership-round-trip",
      role: "editor",
    }, context.nowSeconds);
    await expect(auth.verify(credential, context.workspaceId, context.nowSeconds))
      .resolves.toMatchObject({ kind: "ticket", claims: { role: "editor" } });
  });
});
