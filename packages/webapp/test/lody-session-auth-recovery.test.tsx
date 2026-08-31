/**
 * THE PHANTOM ACP SESSION, WITHOUT A DAEMON
 * (plans/LODY-RUNTIME-DESIGN.md §14.2, the third canary dogfood's report 4).
 *
 * `packages/webapp/test/lody-post-signin-turn.test.ts` proves the whole story
 * against a real `lody@0.88.1` and a real signed-out CLI, and it skips without
 * a 21 MB bundle — which is CI. So the DECISION lives here, over a stub runtime
 * on our own seam, and every case gates a merge.
 *
 * What the decision is: after a turn fails `acp_auth_required`, the session's
 * meta still names the ACP session the adapter minted before it refused the
 * prompt. Resuming that id is what produces the member's second symptom — a
 * "Resuming conversation from chat history" divider and a turn with no output —
 * so it is dropped. The three conditions in `session-auth-recovery.ts` are what
 * keep it from dropping an id that names a real conversation, and each one has
 * a case below.
 */
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { JsonValue } from "@blitzos/schema";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { initLodyI18n } from "../src/lody/i18n";
import { LodyAgentAuthNotice } from "../src/lody/agent-auth-notice";
import {
  phantomAcpSessionId,
  repairPhantomAcpSession,
  sessionIsActive,
  sessionProducedAgentOutput,
} from "../src/lody/session-auth-recovery";
import type { LodyDocMetaSnapshot, LodyWorkspaceRuntime } from "../src/lody/runtime";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";

const SESSION_ID = "9a1f8f2e-0000-4000-8000-000000000001";
const ACP_SESSION_ID = "585b37cc-eeb0-4c89-b3ec-ae89b157c0c5";

afterEach(() => {
  vi.useRealTimers();
});

/** One `chat_failed` history entry, the shape the daemon writes
 * (`apps/cli/src/lib/message-handler.ts:1687`). */
function failure(reason: string): JsonValue {
  return {
    id: `n-${reason}`,
    role: "system",
    items: [{ type: "system_notice", name: "chat_failed", meta: { reason } }],
  };
}

function assistant(items: JsonValue[]): JsonValue {
  return { id: "a-1", role: "assistant", items };
}

/** The meta a session carries after its first prompt was refused. */
function meta(fields: Record<string, JsonValue>): LodyDocMetaSnapshot {
  return { meta: { id: SESSION_ID, ...fields }, deleted: false };
}

interface StubCalls {
  patches: Record<string, JsonValue | undefined>[];
}

/** Every member of the seam the repair touches, and nothing else. */
function stubRuntime(options: {
  history: JsonValue[];
  snapshot: LodyDocMetaSnapshot | undefined;
}): { runtime: LodyWorkspaceRuntime; calls: StubCalls } {
  const calls: StubCalls = { patches: [] };
  const runtime = {
    workspaceId: "lw_1",
    workspaceSlug: "local",
    writer: {
      upsertDocMeta: async (_roomId: string, patch: Record<string, JsonValue | undefined>) => {
        calls.patches.push(patch);
      },
    },
    repo: { getDocMeta: async () => options.snapshot },
    withSessionStore: async <T,>(_sessionId: string, fn: (store: { getState: () => unknown }) => T) =>
      fn({ getState: () => ({ history: options.history }) }),
    dispose: async () => undefined,
  } as unknown as LodyWorkspaceRuntime;
  return { runtime, calls };
}

describe("the three conditions", () => {
  it("reads an assistant row with no items as silence", () => {
    // The daemon writes the row as soon as the adapter accepts the turn, with
    // `items: []` and only `modelInfo` filled. A session whose only assistant
    // row is that one has produced nothing.
    expect(sessionProducedAgentOutput({ history: [assistant([])] })).toBe(false);
    expect(
      sessionProducedAgentOutput({ history: [assistant([{ type: "text", text: "ok" }])] }),
    ).toBe(true);
    expect(sessionProducedAgentOutput({})).toBe(false);
  });

  it("treats the daemon's three active statuses as a turn in flight", () => {
    for (const type of ["running", "initializing", "requestPermission"]) {
      expect(sessionIsActive(meta({ status: { type } })), type).toBe(true);
    }
    expect(sessionIsActive(meta({ status: { type: "idle" } }))).toBe(false);
    expect(sessionIsActive(meta({}))).toBe(false);
    expect(sessionIsActive(undefined)).toBe(false);
  });

  it("names the id to drop only when no turn is in flight", () => {
    expect(phantomAcpSessionId(meta({ acpSessionId: ACP_SESSION_ID }))).toBe(ACP_SESSION_ID);
    expect(
      phantomAcpSessionId(meta({ acpSessionId: ACP_SESSION_ID, status: { type: "running" } })),
    ).toBeNull();
    expect(phantomAcpSessionId(meta({ status: { type: "idle" } }))).toBeNull();
    expect(phantomAcpSessionId(undefined)).toBeNull();
  });
});

describe("repairPhantomAcpSession", () => {
  it("drops the id a refused first prompt left behind", async () => {
    const { runtime, calls } = stubRuntime({
      history: [{ id: "u-1", role: "user", items: [] }, failure("acp_auth_required")],
      snapshot: meta({ acpSessionId: ACP_SESSION_ID, status: { type: "idle" } }),
    });
    expect(await repairPhantomAcpSession(runtime, SESSION_ID)).toBe(ACP_SESSION_ID);
    // `undefined` is loro-repo's DELETE. `null` would keep the key, and a
    // reader that only checks for presence would still resume it.
    expect(calls.patches).toEqual([{ acpSessionId: undefined }]);
    expect(Object.hasOwn(calls.patches[0] ?? {}, "acpSessionId")).toBe(true);
  });

  it("keeps the id of a session that has really talked to an agent", async () => {
    // A credential that expires mid-conversation fails the same way, and there
    // the id names an ACP session full of context. Dropping it would throw that
    // away and replay the transcript instead.
    const { runtime, calls } = stubRuntime({
      history: [
        assistant([{ type: "text", text: "hello" }]),
        failure("acp_auth_required"),
      ],
      snapshot: meta({ acpSessionId: ACP_SESSION_ID, status: { type: "idle" } }),
    });
    expect(await repairPhantomAcpSession(runtime, SESSION_ID)).toBeNull();
    expect(calls.patches).toEqual([]);
  });

  it("keeps the id while the daemon is mid-turn", async () => {
    // The daemon persists `acpSessionId` seconds before the first block
    // streams, so the poll can land inside that window on a healthy turn.
    const { runtime, calls } = stubRuntime({
      history: [failure("acp_auth_required")],
      snapshot: meta({ acpSessionId: ACP_SESSION_ID, status: { type: "running" } }),
    });
    expect(await repairPhantomAcpSession(runtime, SESSION_ID)).toBeNull();
    expect(calls.patches).toEqual([]);
  });

  it("ignores a failure that is not an authentication failure", async () => {
    const { runtime, calls } = stubRuntime({
      history: [failure("session_restore_failed")],
      snapshot: meta({ acpSessionId: ACP_SESSION_ID, status: { type: "idle" } }),
    });
    expect(await repairPhantomAcpSession(runtime, SESSION_ID)).toBeNull();
    expect(calls.patches).toEqual([]);
  });

  it("does nothing when there is no id to drop", async () => {
    const { runtime, calls } = stubRuntime({
      history: [failure("acp_auth_required")],
      snapshot: meta({ status: { type: "idle" } }),
    });
    expect(await repairPhantomAcpSession(runtime, SESSION_ID)).toBeNull();
    expect(calls.patches).toEqual([]);
  });
});

describe("the banner's poll", () => {
  it("repairs the session it is watching", async () => {
    // The wiring, which is the half a unit test of the decision cannot see: the
    // repair has to run BEFORE the member's next message, and the banner's poll
    // is the one place that already knows a session is sitting on an auth
    // failure. It also covers the member who signs in from a terminal tab and
    // never touches the panel.
    installLodyDomStubs();
    const { runtime, calls } = stubRuntime({
      history: [failure("acp_auth_required")],
      snapshot: meta({ acpSessionId: ACP_SESSION_ID, status: { type: "idle" } }),
    });
    const store = createStore();
    store.set(runtimeAtom, runtime);
    const mounted = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={initLodyI18n()}>
          <LodyAgentAuthNotice store={store} sessionId={SESSION_ID} />
        </I18nextProvider>
      </JotaiProvider>,
    );
    try {
      await settle();
      expect(calls.patches).toEqual([{ acpSessionId: undefined }]);
    } finally {
      await mounted.unmount();
    }
  });
});
