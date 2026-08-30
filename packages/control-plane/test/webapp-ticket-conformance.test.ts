import { describe, expect, it } from "vitest";
import { MAX_TICKET_SHARE_SESSIONS, WorkspaceWebAppAuth } from "../core/webapp-tickets.js";

/** The control-plane half of the webApp ticket contract. The Go gateway reads
 * the same corpus, so a claim one side starts enforcing and the other still
 * ignores fails here instead of quietly changing who may do what on a box. */

interface TicketExpectation {
  valid: boolean;
  kind?: "ticket" | "static";
  role?: string;
  userId?: string;
  membershipId?: string;
  /** Present only on the shared-session cases. Compared whole, because the
   * claim decides who may read and who may write on somebody else's box
   * (plans/LODY-SHARING.md §3.2). */
  share?: {
    target: string;
    scope: "sessions" | "all";
    read: string[];
    write: string[];
  };
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
      expect(verified?.claims.share).toEqual(fixture.expect.share);
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

  it("mints and verifies a share claim, and refuses one over the id cap", async () => {
    const share = {
      target: "membership-owner",
      scope: "sessions" as const,
      read: ["sess-alpha"],
      write: ["sess-beta"],
    };
    const credential = await auth.mint({
      workspaceId: context.workspaceId,
      userId: "user-grantee",
      membershipId: "membership-grantee",
      role: "editor",
      share,
    }, context.nowSeconds);
    await expect(auth.verify(credential, context.workspaceId, context.nowSeconds))
      .resolves.toMatchObject({ claims: { share } });

    // The cap is what keeps the header under every proxy default in the path.
    // A ticket over it is refused rather than truncated at the verifier: the
    // truncation belongs to the mint, where it can be logged.
    const oversized = await auth.mint({
      workspaceId: context.workspaceId,
      userId: "user-grantee",
      membershipId: "membership-grantee",
      role: "editor",
      share: {
        ...share,
        read: Array.from({ length: MAX_TICKET_SHARE_SESSIONS + 1 }, (_, index) => `sess-${String(index)}`),
      },
    }, context.nowSeconds);
    await expect(auth.verify(oversized, context.workspaceId, context.nowSeconds)).resolves.toBeNull();
  });
});
