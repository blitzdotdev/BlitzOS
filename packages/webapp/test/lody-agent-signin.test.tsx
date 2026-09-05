/**
 * The first canary dogfood finding of the Lody port, pinned in three parts
 * (plans/LODY-RUNTIME-DESIGN.md §12).
 *
 * The report: a fresh workspace shows the whole Lody surface, the member's
 * first prompt dispatches, the reply is "Authentication required", and pressing
 * Retry answers "Workspace context is missing, please retry."
 *
 * Three separate defects sat behind that one screenshot, and each gets its own
 * group below:
 *
 * 1. `currentWorkspaceIdAtom` was never seeded, so every consumer that reads the
 *    workspace id directly saw `null` — the ACP sign-in panel among them, which
 *    is the Retry error verbatim.
 * 2. The agent-config bootstrap resolved on the LOCAL CRDT write, so a prompt
 *    sent before the row reached the daemon launched the managed claude runtime
 *    with no `runtimeOverrides` — no box shim, no minted token, `auth_required`.
 * 3. A box with no Claude connection has nothing to mint, and the surface said
 *    nothing a member could act on.
 *
 * NONE OF THIS NEEDS A DAEMON. Every group drives our own seam with a stub
 * runtime, so all of it gates a merge — which is the point: the phase-2 and
 * phase-3 exit tests skip in CI, and that is how these three reached canary.
 */
import { act, useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Provider as JotaiProvider, createStore } from "jotai";
import { I18nextProvider } from "react-i18next";
import { RouterProvider } from "@tanstack/react-router";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { machineMetaCacheAtom } from "@lody/components/atoms/doc-meta";
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  setWorkspaceContextAtom,
} from "@lody/components/atoms/workspace-context";
import { useMachineAcpAuthentication } from "@lody/components/hooks/use-machine-acp-authentication";
import {
  ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  MACHINE_PROTOCOL_CAPABILITIES,
  getMachineRoomId,
} from "@lody/shared";
import type { JsonValue } from "@blitzos/schema";
import { AUTH_NOTICE_POLL_MS, LodyAgentAuthNotice } from "../src/lody/agent-auth-notice";
import { sessionNeedsAgentSignIn } from "../src/lody/session-auth-recovery";
import {
  LodyAgentConfigGate,
  SURFACE_BOOT_DEADLINE_MS,
  resetAgentConfigGateMemoForTests,
} from "../src/lody/agent-config-gate";
import { BLITZ_CLAUDE_CONFIG_ID, bootstrapLodyAgentConfigs } from "../src/lody/agent-configs";
import { initLodyI18n } from "../src/lody/i18n";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "../src/lody/runtime";
import { seedLodySurfaceWorkspaceContext } from "../src/lody/surface-workspace-context";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";

/**
 * `createLodySessionRouter` is loaded LATE, on purpose.
 *
 * The route tree names `ChatLanding` and `SessionDetail`, and `SessionDetail`
 * pulls Monaco, which decides at MODULE LOAD whether it can register its
 * clipboard commands and throws under jsdom without
 * `document.queryCommandSupported`. A static import here would be hoisted above
 * `installLodyDomStubs()` and take the whole file down — the same trap
 * `lody-session-surface.test.tsx` documents.
 */
let createLodySessionRouter: typeof import("../src/lody/router")["createLodySessionRouter"];
beforeAll(async () => {
  installLodyDomStubs();
  ({ createLodySessionRouter } = await import("../src/lody/router"));
}, 120_000);

// Every test here is a FIRST VISIT. The gate remembers a successful bootstrap
// per box identity for the page lifetime, this file never resets modules, and
// its cases share one machine id — so without this, an early success would open
// the gate the later hang-shaped cases exist to see shut.
beforeEach(() => {
  resetAgentConfigGateMemoForTests();
});

const WORKSPACE_ID = "lw_11111111111111111111111111111111";
const WORKSPACE_SLUG = "local";
const MACHINE_ID = "5d1f8f2e-0000-4000-8000-000000000001";

/** Every member of the seam a group here touches, and nothing else. The real
 * shapes are Lody's and are checked by the daemon-backed suites; what these
 * tests pin is OUR behaviour around them. */
function stubRuntime(overrides: Partial<LodyWorkspaceRuntime> = {}): LodyWorkspaceRuntime {
  const unimplemented = (name: string) => () => {
    throw new Error(`stub runtime: ${name} is not part of this test`);
  };
  return {
    workspaceId: WORKSPACE_ID,
    workspaceSlug: WORKSPACE_SLUG,
    writer: {
      startSession: unimplemented("startSession"),
      upsertDocMeta: unimplemented("upsertDocMeta"),
      flockRowPut: unimplemented("flockRowPut"),
      flockRowPutIfAbsent: unimplemented("flockRowPutIfAbsent"),
    },
    repo: {
      openFlockDoc: unimplemented("openFlockDoc"),
      // The banner's poll also repairs a phantom ACP session id
      // (`session-auth-recovery.ts`). Nothing here has one, so answering with
      // no meta at all is the honest stub: the repair stops at its first read.
      getDocMeta: async () => undefined,
    },
    setLocalMachineId: () => undefined,
    resolveMachineTargetPlane: unimplemented("resolveMachineTargetPlane"),
    requestSessionDispatchTurn: unimplemented("requestSessionDispatchTurn"),
    ensureDocStream: unimplemented("ensureDocStream"),
    requestMachineAcpCapabilitiesRefresh: unimplemented("requestMachineAcpCapabilitiesRefresh"),
    withSessionStore: unimplemented("withSessionStore"),
    dispose: async () => undefined,
    ...overrides,
  } as LodyWorkspaceRuntime;
}

// ── 1. The Retry error: workspace context ────────────────────────────────────

/**
 * What `AcpAuthenticationPanel` does, reduced to the two atoms it reads
 * (`components/settings/acp-authentication-panel.tsx:56`) and the one call the
 * member's click makes. The panel itself cannot be mounted here — it lives
 * inside `SessionDetail`, behind Monaco — so the hook is driven directly, with
 * the atoms filled by the same route the surface mounts.
 */
function AuthenticationProbe(props: {
  runtime: LodyWorkspaceRuntime | null;
  workspaceId: string | null;
  onResult: (result: { error: string | null }) => void;
}) {
  // SAFETY: the vendor seam erases `@lody/*` types (`vendor-modules.d.ts`), so
  // the hook's two parameters cross it untyped. Both are checked by the atoms
  // this test reads back on the other side.
  const auth = useMachineAcpAuthentication(props.runtime, props.workspaceId) as {
    startAuthentication: (args: Record<string, unknown>) => { promise: Promise<unknown> };
  };
  const { onResult } = props;
  useEffect(() => {
    const started = auth.startAuthentication({
      machineId: MACHINE_ID,
      configId: BLITZ_CLAUDE_CONFIG_ID,
      cliType: "builtin",
      agentType: "claude",
      runtimeOverrides: { claudeCodeExecutable: "/usr/local/bin/claude" },
      env: {},
    });
    started.promise.then(
      () => onResult({ error: null }),
      (cause: unknown) => onResult({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
    // Once. A second start would take a second per-agent login slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe("the retained surface seeds the workspace context its sign-in panel reads", () => {
  /** Mounts a route leaf that needs no renderer provider stack. */
  async function mountRoute(
    store: LodyAtomStore,
  ): Promise<{ unmount: () => Promise<void> }> {
    const router = createLodySessionRouter(WORKSPACE_SLUG);
    await act(async () => {
      await router.navigate({
        to: "/$workspaceName/settings/about",
        params: { workspaceName: WORKSPACE_SLUG },
      });
    });
    const mounted = await render(
      <JotaiProvider store={store}>
        <RouterProvider router={router} />
      </JotaiProvider>,
    );
    await settle();
    return mounted;
  }

  it("publishes the daemon's workspace id, not just its slug", async () => {
    const store = createStore();
    const release = seedLodySurfaceWorkspaceContext(store, {
      workspace: { slug: WORKSPACE_SLUG, workspaceId: WORKSPACE_ID },
    });
    const mounted = await mountRoute(store);
    try {
      expect(store.get(currentWorkspaceSlugAtom)).toBe(WORKSPACE_SLUG);
      expect(store.get(currentWorkspaceIdAtom)).toBe(WORKSPACE_ID);
    } finally {
      await mounted.unmount();
      release();
    }
  });

  it("does not let the route duplicate workspace-context ownership", async () => {
    const store = createStore();
    const mounted = await mountRoute(store);
    try {
      expect(store.get(currentWorkspaceSlugAtom)).toBeNull();
      expect(store.get(currentWorkspaceIdAtom)).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("lets the ACP sign-in start instead of refusing on a missing context", async () => {
    const sent: Record<string, unknown>[] = [];
    const runtime = stubRuntime({
      sendControl: (message: Record<string, unknown>) => {
        sent.push(message);
      },
      subscribeMachineAcpAuthenticationProgress: () => () => undefined,
      // The daemon's answer, stubbed: what is under test is whether the request
      // is ATTEMPTED, not what the CLI does with it.
      waitForMachineAcpAuthenticateResponse: async () => ({
        type: "machine/acp-authenticate_response",
        machineId: MACHINE_ID,
        requestId: "r",
        agentType: "claude",
        success: true,
        disposition: "authenticated",
      }),
    } as unknown as Partial<LodyWorkspaceRuntime>);

    const store = createStore();
    store.set(runtimeAtom, runtime);
    const release = seedLodySurfaceWorkspaceContext(store, {
      workspace: { slug: WORKSPACE_SLUG, workspaceId: WORKSPACE_ID },
    });
    const router = createLodySessionRouter(WORKSPACE_SLUG);
    await act(async () => {
      await router.navigate({
        to: "/$workspaceName/settings/about",
        params: { workspaceName: WORKSPACE_SLUG },
      });
    });
    const results: { error: string | null }[] = [];
    const i18n = initLodyI18n();
    const mounted = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </JotaiProvider>,
    );
    await settle();
    // The route has run; now drive the panel's hook with exactly what the panel
    // reads out of the atoms it just filled.
    const probe = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={i18n}>
          <AuthenticationProbe
            runtime={runtime}
            workspaceId={store.get(currentWorkspaceIdAtom)}
            onResult={(next) => {
              results.push(next);
            }}
          />
        </I18nextProvider>
      </JotaiProvider>,
    );
    await settle();
    try {
      expect(sent.map((message) => message.type)).toContain("machine/acp-authenticate");
      expect(sent[0]?.workspaceId).toBe(WORKSPACE_ID);
      expect(results).toEqual([{ error: null }]);
    } finally {
      await probe.unmount();
      await mounted.unmount();
      release();
    }
  });

  it("still refuses with the reported message when the id is absent", async () => {
    // The other half of the pin: the message a member saw on canary, so a
    // regression is recognised rather than merely detected.
    const results: { error: string | null }[] = [];
    const i18n = initLodyI18n();
    const store = createStore();
    const probe = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={i18n}>
          <AuthenticationProbe
            runtime={stubRuntime()}
            workspaceId={null}
            onResult={(next) => {
              results.push(next);
            }}
          />
        </I18nextProvider>
      </JotaiProvider>,
    );
    await settle();
    try {
      expect(results[0]?.error ?? "").toMatch(/workspace context/iu);
    } finally {
      await probe.unmount();
    }
  });
});

// ── 2. The race: a prompt sent before the daemon has the config row ──────────

describe("the agent-config bootstrap pushes before it resolves", () => {
  /** A Flock handle that records the order of everything done to it. */
  function recordingRuntime(): { runtime: LodyWorkspaceRuntime; calls: string[] } {
    const calls: string[] = [];
    // `readMachineFlockRowsFromFlock` scans the body at the end of the
    // bootstrap to publish the rows into the jotai cache; an empty scan is
    // enough, because what this test reads is the CALL ORDER above it.
    const handle = {
      flock: { scan: () => [] } as never,
      syncOnce: async () => {
        calls.push("syncOnce");
      },
    };
    const runtime = stubRuntime({
      repo: {
        openFlockDoc: async () => {
          calls.push("openFlockDoc");
          return handle;
        },
      },
      writer: {
        startSession: async () => undefined,
        upsertDocMeta: async () => undefined,
        flockRowPut: async () => undefined,
        flockRowPutIfAbsent: async (_docId: string, key: readonly string[], value: JsonValue) => {
          calls.push(`put:${key.join("/")}`);
          return { inserted: true, value };
        },
      },
    } as unknown as Partial<LodyWorkspaceRuntime>);
    return { runtime, calls };
  }

  it("syncs the room again AFTER the rows are written", async () => {
    const { runtime, calls } = recordingRuntime();
    const store = createStore();
    const created = await bootstrapLodyAgentConfigs(store, runtime, MACHINE_ID);
    expect(created).toEqual(["blitz-claude", "blitz-codex"]);
    // The regression: phase 3 synced ONCE, before the writes, so the rows were
    // only ever local when this resolved and the caller had nothing to gate on.
    // `WorkspaceWriter`'s accept boundary is the local CRDT write
    // (`providers/workspace-writer.ts:52`), so the second sync is the only
    // thing that puts the row on the daemon before a dispatch can name it.
    const lastPut = calls.lastIndexOf("put:agentConfig/blitz-codex");
    const lastSync = calls.lastIndexOf("syncOnce");
    expect(lastPut).toBeGreaterThan(-1);
    expect(lastSync).toBeGreaterThan(lastPut);
  });

  it("still resolves when the push fails, so the gate cannot trap a member", async () => {
    const store = createStore();
    const runtime = stubRuntime({
      repo: {
        openFlockDoc: async () => ({
          flock: { scan: () => [] } as never,
          syncOnce: async () => {
            throw new Error("room unreachable");
          },
        }),
      },
      writer: {
        startSession: async () => undefined,
        upsertDocMeta: async () => undefined,
        flockRowPut: async () => undefined,
        flockRowPutIfAbsent: async (_docId: string, _key: readonly string[], value: JsonValue) => ({
          inserted: true,
          value,
        }),
      },
    } as unknown as Partial<LodyWorkspaceRuntime>);
    await expect(bootstrapLodyAgentConfigs(store, runtime, MACHINE_ID)).resolves.toEqual([
      "blitz-claude",
      "blitz-codex",
    ]);
  });
});

describe("the gate holds the chat surface until the bootstrap settles", () => {
  const endpoints = {
    syncUrl: "ws://127.0.0.1:1/sync",
    rpcUrl: "http://127.0.0.1:1/rpc",
    controlUrl: "http://127.0.0.1:1/control",
    projectUrl: "http://127.0.0.1:1/project",
    platformUrl: "http://127.0.0.1:1/platform",
    filesBase: "http://127.0.0.1:1/workspace",
  };

  /** The gate calls four things in order; only the first decides when it opens,
   * so the rest are satisfied and ignored. */
  function gateRuntime(release: Promise<void>): LodyWorkspaceRuntime {
    return stubRuntime({
      repo: {
        openFlockDoc: async () => {
          await release;
          return { flock: { scan: () => [] } as never, syncOnce: async () => undefined };
        },
      },
      writer: {
        startSession: async () => undefined,
        upsertDocMeta: async () => undefined,
        flockRowPut: async () => undefined,
        flockRowPutIfAbsent: async (_docId: string, _key: readonly string[], value: JsonValue) => ({
          inserted: true,
          value,
        }),
      },
      requestMachineAcpCapabilitiesRefresh: async () => ({ success: true }),
    } as unknown as Partial<LodyWorkspaceRuntime>);
  }

  it("holds the surface back until the rows are on the daemon, then renders it", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const store = createStore();
    store.set(runtimeAtom, gateRuntime(gate));
    const mounted = await render(
      <JotaiProvider store={store}>
        <LodyAgentConfigGate store={store} machineId={MACHINE_ID} endpoints={endpoints}>
          <div data-testid="chat">chat surface</div>
        </LodyAgentConfigGate>
      </JotaiProvider>,
    );
    try {
      // The window the canary finding lived in: phase 3 rendered the composer
      // here, and a prompt sent now dispatched against a config the daemon
      // could not resolve. It is still shut — and it now SAYS so, which is the
      // fresh-box finding below.
      expect(mounted.container.textContent).not.toContain("chat surface");
      expect(mounted.container.textContent).toContain("Starting sessions");
      await act(async () => {
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settle();
      expect(mounted.container.textContent).toContain("chat surface");
    } finally {
      await mounted.unmount();
    }
  });

  /**
   * THE FRESH-BOX BLANK SURFACE (canary, workspace `silver-falcon`, 2026-09-01).
   *
   * Reported as "/chat is completely empty": a live vendored rail — New session,
   * a Terminals section, a Claude row — over a content area with nothing in it
   * at all. Reproduced against canary in a real Chromium by stalling
   * `/lody/sync` and nothing else: `/lody/platform` is answered by the box
   * BRIDGE, so the capability probe reads `present`, `SessionSurface` mounts,
   * the rail portal draws above this gate, and the gate's awaits hang below it.
   *
   * The two groups pin the two hangs. Neither is a rejection, so neither
   * reaches the `catch` that opens the gate on failure, and the old `null`
   * return made both of them look like a broken product.
   */
  describe("a boot that never finishes is a message, never an empty pane", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** The runtime never arrives: their `RuntimeProvider` boots once and does
     * not retry, so on a box whose daemon is still starting `runtimeAtom` stays
     * `null` and `run` returns at its first line for good. This is the shape the
     * user's screenshot was in. */
    it("says the surface is starting while the runtime has not arrived", async () => {
      const store = createStore();
      store.set(runtimeAtom, null);
      const mounted = await render(
        <JotaiProvider store={store}>
          <LodyAgentConfigGate store={store} machineId={MACHINE_ID} endpoints={endpoints}>
            <div>chat surface</div>
          </LodyAgentConfigGate>
        </JotaiProvider>,
      );
      try {
        expect(mounted.container.textContent).toContain("Starting sessions");
        expect(mounted.container.querySelector("button")).toBeNull();
      } finally {
        await mounted.unmount();
      }
    });

    it("offers a reload once the boot has outlived the vendored first-sync wait", async () => {
      const store = createStore();
      store.set(runtimeAtom, null);
      const mounted = await render(
        <JotaiProvider store={store}>
          <LodyAgentConfigGate store={store} machineId={MACHINE_ID} endpoints={endpoints}>
            <div>chat surface</div>
          </LodyAgentConfigGate>
        </JotaiProvider>,
      );
      try {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SURFACE_BOOT_DEADLINE_MS);
        });
        expect(mounted.container.textContent).toContain("did not finish starting");
        expect(mounted.container.querySelector("button")?.textContent).toBe("Reload");
        // The deadline reports; it never opens the gate. Opening it would put
        // the composer back in the window this file's second group closed.
        expect(mounted.container.textContent).not.toContain("chat surface");
      } finally {
        await mounted.unmount();
      }
    });

    /** The second hang: the runtime is there and `openFlockDoc` never answers.
     * A REJECTION is fine — the gate's own `catch` opens on it — but a promise
     * that never settles is not a rejection. */
    it("offers a reload when the bootstrap itself never settles", async () => {
      const store = createStore();
      store.set(runtimeAtom, gateRuntime(new Promise<void>(() => undefined)));
      const mounted = await render(
        <JotaiProvider store={store}>
          <LodyAgentConfigGate store={store} machineId={MACHINE_ID} endpoints={endpoints}>
            <div>chat surface</div>
          </LodyAgentConfigGate>
        </JotaiProvider>,
      );
      try {
        expect(mounted.container.textContent).toContain("Starting sessions");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(SURFACE_BOOT_DEADLINE_MS);
        });
        expect(mounted.container.querySelector("button")?.textContent).toBe("Reload");
      } finally {
        await mounted.unmount();
      }
    });
  });

  it("hands the surface a runtime that defaults a projectless session to /workspace", async () => {
    // The product path does NOT build its runtime through `createLodyRuntime`:
    // their `RuntimeProvider` builds it and writes `runtimeAtom`
    // (`providers/runtime-provider.tsx:311`). So the gate is where the writer
    // is decorated, and this is the assertion that the composer's send — which
    // reads that atom — gets the decorated one. Without it a chat with no repo
    // runs in the daemon's chats directory and its relative file chips open on
    // nothing (`src/lody/workdir-default.ts`).
    const store = createStore();
    const starts: JsonValue[] = [];
    const original = stubRuntime({
      repo: {
        openFlockDoc: async () => ({
          flock: { scan: () => [] } as never,
          syncOnce: async () => undefined,
        }),
      },
      writer: {
        startSession: async (_sessionId: string, meta: JsonValue) => {
          starts.push(meta);
        },
        upsertDocMeta: async () => undefined,
        flockRowPut: async () => undefined,
        flockRowPutIfAbsent: async (_docId: string, _key: readonly string[], value: JsonValue) => ({
          inserted: true,
          value,
        }),
      },
      requestMachineAcpCapabilitiesRefresh: async () => ({ success: true }),
    } as unknown as Partial<LodyWorkspaceRuntime>);
    store.set(runtimeAtom, original);
    const project = {
      localProjectId: "local-workspace",
      name: "workspace",
      rootPath: "/workspace",
      workspaceIds: [WORKSPACE_ID],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, type: "local-project/add", result: project }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const mounted = await render(
      <JotaiProvider store={store}>
        <LodyAgentConfigGate
          store={store}
          machineId={MACHINE_ID}
          endpoints={{ ...endpoints, fetchImpl }}
        >
          <div>chat surface</div>
        </LodyAgentConfigGate>
      </JotaiProvider>,
    );
    try {
      await settle();
      const mounted_runtime = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      expect(mounted_runtime).not.toBe(original);
      await mounted_runtime?.writer.startSession(
        "s-1",
        { id: "s-1" },
        {},
        { sessionId: "s-1", userTurnId: "t-1", userId: "u", timestamp: "t", inputConfig: {} },
      );
      expect(starts).toEqual([
        { id: "s-1", project: { kind: "local", localProjectId: "local-workspace" } },
      ]);
    } finally {
      await mounted.unmount();
    }
  });

  it("opens anyway when the bootstrap throws", async () => {
    const store = createStore();
    store.set(
      runtimeAtom,
      stubRuntime({
        repo: {
          openFlockDoc: async () => {
            throw new Error("no room");
          },
        },
      } as unknown as Partial<LodyWorkspaceRuntime>),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mounted = await render(
      <JotaiProvider store={store}>
        <LodyAgentConfigGate store={store} machineId={MACHINE_ID} endpoints={endpoints}>
          <div>chat surface</div>
        </LodyAgentConfigGate>
      </JotaiProvider>,
    );
    try {
      await settle();
      expect(mounted.container.textContent).toContain("chat surface");
    } finally {
      warn.mockRestore();
      await mounted.unmount();
    }
  });
});

// ── 3. The banner: what a credential-less box tells the member ───────────────

/** One history entry, in the shape `recordChatFailure` writes
 * (`apps/cli/src/lib/message-handler.ts:1687`). */
function noticeEntry(reason: string): JsonValue {
  return {
    id: `system-notice-${reason}`,
    role: "system",
    items: [{ type: "system_notice", name: "chat_failed", meta: { reason } }],
  };
}

describe("sessionNeedsAgentSignIn", () => {
  it("is false for an empty or absent history", () => {
    expect(sessionNeedsAgentSignIn({})).toBe(false);
    expect(sessionNeedsAgentSignIn({ history: [] })).toBe(false);
  });

  it("is true when the last notice is the ACP auth failure", () => {
    expect(
      sessionNeedsAgentSignIn({
        history: [{ id: "u1", role: "user", items: [] }, noticeEntry("acp_auth_required")],
      }),
    ).toBe(true);
  });

  it("is false for a different chat failure", () => {
    expect(sessionNeedsAgentSignIn({ history: [noticeEntry("session_restore_failed")] })).toBe(false);
  });

  it("clears once a later assistant turn arrives", () => {
    // A signed-in re-send leaves the old notice in the transcript forever. A
    // banner keyed on "has ever failed" would never go away.
    expect(
      sessionNeedsAgentSignIn({
        history: [
          noticeEntry("acp_auth_required"),
          { id: "a1", role: "assistant", items: [{ type: "text", text: "ok" }] },
        ],
      }),
    ).toBe(false);
  });

  it("clears once a later notice reports a different reason", () => {
    expect(
      sessionNeedsAgentSignIn({
        history: [noticeEntry("acp_auth_required"), noticeEntry("session_restore_failed")],
      }),
    ).toBe(false);
  });
});

describe("the signed-out banner", () => {
  function noticeRuntime(history: JsonValue[]): LodyWorkspaceRuntime {
    return stubRuntime({
      withSessionStore: async <T,>(_sessionId: string, fn: (store: { getState: () => unknown }) => T) =>
        fn({ getState: () => ({ history }) }),
    } as unknown as Partial<LodyWorkspaceRuntime>);
  }

  async function mountNotice(
    history: JsonValue[],
    machineId?: string,
  ): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
    const store = createStore();
    store.set(runtimeAtom, noticeRuntime(history));
    const mounted = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={initLodyI18n()}>
          <LodyAgentAuthNotice
            store={store}
            sessionId="session-1"
            {...(machineId === undefined ? {} : { machineId })}
          />
        </I18nextProvider>
      </JotaiProvider>,
    );
    await settle();
    return mounted;
  }

  it("stays out of the way while the agent is signed in", async () => {
    const mounted = await mountNotice([{ id: "a1", role: "assistant", items: [] }]);
    try {
      expect(mounted.container.textContent).toBe("");
    } finally {
      await mounted.unmount();
    }
  });

  it("offers Lody's sign-in and the terminal, and never the connections panel", async () => {
    // The second canary dogfood finding. The first version of this banner said
    // "connect Claude in the workspace Connections panel" — and there is no
    // Claude card in that catalog, so the one instruction it gave could not be
    // followed. Both routes named here are routes that exist.
    const mounted = await mountNotice([noticeEntry("acp_auth_required")], MACHINE_ID);
    try {
      const text = mounted.container.textContent ?? "";
      expect(text).toContain("not signed in");
      expect(text).toContain("terminal tab");
      expect(text).not.toContain("connection");
      const labels = [...mounted.container.querySelectorAll("button")].map(
        (button) => button.textContent ?? "",
      );
      expect(labels.some((label) => /Sign in with Claude/u.test(label))).toBe(true);
      expect(labels).not.toContain("Open connections");
    } finally {
      await mounted.unmount();
    }
  });

  it("still explains itself with no machine to address", async () => {
    const mounted = await mountNotice([noticeEntry("acp_auth_required")]);
    try {
      const text = mounted.container.textContent ?? "";
      expect(text).toContain("not signed in");
      expect(text).toContain("terminal tab");
    } finally {
      await mounted.unmount();
    }
  });

  it("can be dismissed", async () => {
    const mounted = await mountNotice([noticeEntry("acp_auth_required")]);
    try {
      const dismiss = [...mounted.container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Dismiss",
      );
      await act(async () => {
        dismiss?.click();
      });
      expect(mounted.container.textContent).toBe("");
    } finally {
      await mounted.unmount();
    }
  });

  it("draws nothing on the chat landing, where there is no session to read", async () => {
    const store = createStore();
    store.set(runtimeAtom, noticeRuntime([noticeEntry("acp_auth_required")]));
    const mounted = await render(<LodyAgentAuthNotice store={store} sessionId={null} />);
    await settle();
    try {
      expect(mounted.container.textContent).toBe("");
    } finally {
      await mounted.unmount();
    }
  });

  it("polls slowly enough to cost nothing", () => {
    // Guards against a future edit turning a per-turn banner into a hot loop
    // over the whole session document.
    expect(AUTH_NOTICE_POLL_MS).toBeGreaterThanOrEqual(1_000);
  });
});

// ── 4. The popup: a progress frame is what navigates it ──────────────────────

/**
 * The other half of the second canary finding, at the surface it was seen on.
 *
 * `AcpAuthenticationPanel.handleStart` opens a placeholder window reading
 * "Preparing Claude sign-in…" and navigates it only when `onProgress` delivers
 * `{ status: 'authorization', authorizationUrl }`. On canary that frame never
 * arrived — `/lody/control` was answered as one buffered batch, so a response
 * emitted WHILE `claude auth login` waited for the member could not reach the
 * browser until that wait was over. The popup sat at `about:blank` forever.
 *
 * The transport half of the fix is pinned against a real daemon in
 * `lody-acp-authentication.test.ts`. This is the renderer half: given the frame,
 * the panel must reach its authorization state and navigate the window it
 * opened. Both are needed — a chain that carries the frame to a panel that
 * ignores it is the same stuck popup.
 */
interface FakePopup {
  closed: boolean;
  opener: unknown;
  document: { title: string; body: { textContent: string; style: { cssText: string } } };
  location: { href: string };
  close: () => void;
}

function installFakePopups(): { popups: FakePopup[]; restore: () => void } {
  const popups: FakePopup[] = [];
  const original = window.open;
  window.open = ((url?: string | URL) => {
    const popup: FakePopup = {
      closed: false,
      opener: window,
      document: { title: "", body: { textContent: "", style: { cssText: "" } } },
      location: { href: url === undefined || String(url) === "" ? "about:blank" : String(url) },
      close: () => {
        popup.closed = true;
      },
    };
    popups.push(popup);
    return popup as unknown as Window;
  }) as typeof window.open;
  return { popups, restore: () => { window.open = original; } };
}

/** A claude.com authorization URL in the shape `claude auth login --claudeai`
 * prints it — measured against claude 2.1.228, and the shape
 * `isTrustedAuthorizationUrl` accepts (`acp-authentication-output.ts:24`). */
const AUTHORIZATION_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code";

describe("the ACP sign-in panel, given a progress frame", () => {
  it("asks for a machine update instead of opening a window without interactive auth", async () => {
    const popups = installFakePopups();
    const store = createStore();
    store.set(runtimeAtom, stubRuntime({
      withSessionStore: async <T,>(
        _sessionId: string,
        fn: (store: { getState: () => unknown }) => T,
      ) => fn({ getState: () => ({ history: [noticeEntry("acp_auth_required")] }) }),
    } as unknown as Partial<LodyWorkspaceRuntime>));
    store.set(setWorkspaceContextAtom, { slug: WORKSPACE_SLUG, workspaceId: WORKSPACE_ID });
    const mounted = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={initLodyI18n()}>
          <LodyAgentAuthNotice store={store} sessionId="session-1" machineId={MACHINE_ID} />
        </I18nextProvider>
      </JotaiProvider>,
    );
    try {
      await settle();
      const start = [...mounted.container.querySelectorAll("button")].find((button) =>
        /Sign in with Claude/u.test(button.textContent ?? ""),
      );
      expect(start?.disabled).toBe(true);
      expect(mounted.container.textContent).toContain(
        "Update the target Machine to use interactive authentication for this Provider.",
      );
      expect(popups.popups).toHaveLength(0);
    } finally {
      popups.restore();
      await mounted.unmount();
    }
  });

  it("reaches its authorization state and navigates the window it opened", async () => {
    const popups = installFakePopups();
    let emit: ((message: Record<string, unknown>) => void) | null = null;
    const runtime = stubRuntime({
      // The banner only draws for a session whose last notice is the auth
      // failure; the panel under test is inside it.
      withSessionStore: async <T,>(_sessionId: string, fn: (store: { getState: () => unknown }) => T) =>
        fn({ getState: () => ({ history: [noticeEntry("acp_auth_required")] }) }),
      sendControl: () => undefined,
      subscribeMachineAcpAuthenticationProgress: (
        _machineId: string,
        _requestId: string,
        listener: (message: Record<string, unknown>) => void,
      ) => {
        emit = listener;
        return () => {
          emit = null;
        };
      },
      // Never settles inside the test: the panel leaves `running` only when the
      // daemon answers, and what is under test is the state BEFORE that.
      waitForMachineAcpAuthenticateResponse: () => new Promise(() => undefined),
    } as unknown as Partial<LodyWorkspaceRuntime>);

    const store = createStore();
    store.set(runtimeAtom, runtime);
    store.set(setWorkspaceContextAtom, { slug: WORKSPACE_SLUG, workspaceId: WORKSPACE_ID });
    store.set(machineMetaCacheAtom, {
      [getMachineRoomId(MACHINE_ID)]: {
        id: MACHINE_ID,
        protocolCapabilities: {
          [MACHINE_PROTOCOL_CAPABILITIES.acpAuthenticationInteractions]:
            ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
        },
      },
    });
    const mounted = await render(
      <JotaiProvider store={store}>
        <I18nextProvider i18n={initLodyI18n()}>
          <LodyAgentAuthNotice store={store} sessionId="session-1" machineId={MACHINE_ID} />
        </I18nextProvider>
      </JotaiProvider>,
    );
    try {
      await settle();
      const start = [...mounted.container.querySelectorAll("button")].find((button) =>
        /Sign in with Claude/u.test(button.textContent ?? ""),
      );
      expect(start).toBeDefined();
      await act(async () => {
        start?.click();
      });
      await settle();

      // The placeholder, exactly as a member sees it before anything arrives.
      expect(popups.popups).toHaveLength(1);
      expect(popups.popups[0]?.location.href).toBe("about:blank");
      expect(popups.popups[0]?.document.body.textContent).toContain("Preparing Claude sign-in");
      expect(emit).not.toBeNull();

      await act(async () => {
        emit?.({
          type: "machine/acp-authentication-progress",
          machineId: MACHINE_ID,
          requestId: "r",
          agentType: "claude",
          status: "authorization",
          authorizationUrl: AUTHORIZATION_URL,
          acceptsAuthorizationCode: true,
        });
      });
      await settle();

      expect(popups.popups[0]?.location.href).toBe(AUTHORIZATION_URL);
      const text = mounted.container.textContent ?? "";
      expect(text).toContain("Finish signing in to Claude");
      expect(text).toContain("Authorization code");
    } finally {
      popups.restore();
      await mounted.unmount();
    }
  });
});
