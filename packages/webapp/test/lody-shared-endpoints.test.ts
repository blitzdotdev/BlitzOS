// @vitest-environment node
//
// Node, not jsdom: this file reads the share-claim corpus off disk, and under
// jsdom Vitest serves test modules over its own dev server — `import.meta.url`
// is an `http:` URL there and `fileURLToPath` throws. Nothing here touches the
// DOM (`lody-daemon-harness.ts` records the same trap).
/**
 * The grantee's addresses, both kinds (plans/LODY-SHARING.md §8 steps 2 and 4).
 *
 * A shared session is reached by two things and they must agree: a URL the
 * browser can be deep-linked to, and a box prefix the control plane routes to
 * another member's machine. Both name the OWNER's membership, and neither may
 * be derivable from the other by accident.
 *
 * The third case here is the one that would otherwise only be caught on a box:
 * the rail's session titles are read out of the very bundle the bridge's own
 * corpus says a grantee receives, so the two readers are pinned to one fixture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JsonValue, WorkspaceView } from "@blitzos/schema";
import { standaloneResolver } from "../src/resolver.js";
import {
  parseAppRoute,
  workspaceChatPath,
  workspaceSharedChatPath,
} from "../src/sessions-page-state.js";
import { sessionTitlesFromMetaBundle, titleKeySessionId } from "../src/lody/shared-sessions.js";

const CORPUS = fileURLToPath(
  new URL("../../schema/fixtures/lody-share-claim/decisions.json", import.meta.url),
);

// SAFETY: the corpus is checked-in JSON this repo owns, and the two fields read
// below are the ones its README documents.
const decisions = JSON.parse(readFileSync(CORPUS, "utf8")) as {
  metaProjections: {
    claim: string;
    from: { payload: { bundle: JsonValue } };
    to: { payload: { bundle: JsonValue } };
  }[];
};

// SAFETY: the resolver reads `id` and nothing else off a workspace.
const workspace = { id: "ws-1" } as WorkspaceView;

describe("the shared box prefix", () => {
  const resolver = standaloneResolver({ files: 7445 }, "https://cp.example");

  it("swaps one prefix and leaves every box path alone", () => {
    const own = resolver.resolve(workspace);
    const shared = resolver.resolveShared(workspace, "mem-owner");
    expect(shared.lodySyncUrl).toBe(
      "wss://cp.example/workspaces/ws-1/shared/mem-owner/webapp/7445/lody/sync",
    );
    expect(shared.lodyPlatformUrl).toBe(
      "https://cp.example/workspaces/ws-1/shared/mem-owner/webapp/7445/lody/platform",
    );
    // Everything after `/webapp/` is byte-for-byte the own-box path, which is
    // what lets `isWebAppSurfacePath` and the whole webapp-surface contract
    // apply to a shared request unchanged.
    for (const key of ["lodySyncUrl", "lodyRpcUrl", "lodyControlUrl", "lodyProjectUrl", "lodyPlatformUrl", "filesBase", "terminalUrl"] as const) {
      expect(shared[key].split("/webapp/")[1]).toBe(own[key].split("/webapp/")[1]);
    }
  });

  it("escapes a membership id rather than letting it add a path segment", () => {
    const shared = resolver.resolveShared(workspace, "mem/../other");
    expect(shared.lodyRpcUrl).toContain("/shared/mem%2F..%2Fother/webapp/");
  });

  it("still refuses to build any surface without a control-plane origin", () => {
    const nowhere = standaloneResolver({ files: 7445 }, "");
    expect(() => nowhere.resolveShared(workspace, "mem-owner")).toThrow(/control-plane origin/u);
  });
});

describe("the shared chat address", () => {
  it("round-trips through the URL, owner and all", () => {
    const path = workspaceSharedChatPath("ws-1", "mem-owner", "sess-alpha");
    expect(path).toBe("/workspaces/ws-1/chat/shared/mem-owner/sess-alpha");
    expect(parseAppRoute(path)).toEqual({
      workspaceId: "ws-1",
      page: "webApp",
      chat: { sessionId: "sess-alpha", sharedFrom: "mem-owner" },
    });
  });

  it("leaves an own-box session address exactly where it was", () => {
    expect(parseAppRoute(workspaceChatPath("ws-1", "sess-alpha"))).toEqual({
      workspaceId: "ws-1",
      page: "webApp",
      chat: { sessionId: "sess-alpha" },
    });
    expect(parseAppRoute("/workspaces/ws-1/chat")).toMatchObject({ chat: "landing" });
    expect(parseAppRoute("/workspaces/ws-1")).toMatchObject({ chat: null });
  });

  it("sends a half-written shared address home rather than somewhere plausible", () => {
    // Two segments after `/chat` match neither branch, so the address is not an
    // address. Better than the alternative, which would be to open the owner's
    // membership id as if it were a session on the caller's own box.
    expect(parseAppRoute("/workspaces/ws-1/chat/shared/mem-owner")).toEqual({
      workspaceId: null,
      page: "home",
    });
    // `shared` alone still matches the one-segment branch, which is exactly why
    // `workspaceChatPath` may never be handed it as a session id.
    expect(parseAppRoute("/workspaces/ws-1/chat/shared")).toMatchObject({
      chat: { sessionId: "shared" },
    });
  });
});

describe("session titles out of a projected meta bundle", () => {
  it("reads what the bridge's own corpus says a grantee receives", () => {
    const projection = decisions.metaProjections.find((entry) => entry.claim === "ro");
    if (projection === undefined) throw new Error("no read-only projection in the corpus");
    // The bridge is what narrows this; the rail is what reads it. One fixture,
    // so a change to either side fails on the other.
    expect(sessionTitlesFromMetaBundle(projection.to.payload.bundle)).toEqual(
      new Map([["sess-alpha", "the granted session"]]),
    );
    // And the unnarrowed bundle carries the session the grantee must never see,
    // which is what makes the assertion above mean something.
    expect(sessionTitlesFromMetaBundle(projection.from.payload.bundle).has("sess-zulu")).toBe(true);
  });

  it("ignores every key that is not a session title", () => {
    expect(titleKeySessionId('["m","session-a","title"]')).toBe("a");
    expect(titleKeySessionId('["m","session-a","status"]')).toBe(null);
    expect(titleKeySessionId('["m","machine-a","name"]')).toBe(null);
    expect(titleKeySessionId('["e","session-a"]')).toBe(null);
    expect(titleKeySessionId("not json")).toBe(null);
  });

  it("answers an empty map for a bundle it cannot read", () => {
    expect(sessionTitlesFromMetaBundle(undefined).size).toBe(0);
    expect(sessionTitlesFromMetaBundle(null).size).toBe(0);
    expect(sessionTitlesFromMetaBundle({ version: 1 }).size).toBe(0);
  });
});
