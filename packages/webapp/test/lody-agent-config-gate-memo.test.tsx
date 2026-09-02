/**
 * A REVISITED BOX MUST NOT PAY THE BOOTSTRAP GATE TWICE.
 *
 * `LodyAgentConfigGate` holds the chat surface behind the agent-config
 * bootstrap — a Flock room join and two `syncOnce` round trips that, over a
 * real tunnel, are the serialized bulk of what a workspace switch costs (the
 * switch-cost probe measured the local floor at ~750 ms with the bootstrap
 * itself near zero; the field's ~3 s is those round trips). The rows the gate
 * guarantees are durable on the daemon, so once a box's bootstrap has succeeded
 * this page lifetime there is nothing left to win by blocking the composer on
 * it again.
 *
 * So the gate remembers SUCCESS per box identity (machineId + `lw_` workspace
 * id — minted by the daemon, so a rescue-rebuilt box misses the memo and gets
 * the full gated boot; a URL key would pin a dead identity, the seam-patch-17
 * class). On a revisit it opens at once and re-runs the bootstrap in the
 * background, because the bootstrap is idempotent and the gate already opens on
 * failure.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { render } from "./dom.js";
import type { LodyRuntimeEndpoints, LodyWorkspaceRuntime } from "../src/lody/runtime.js";

/** One deferred per bootstrap call, in call order, plus the identity it was
 * called for — so a test can settle any call and count them. */
const state = vi.hoisted(() => ({
  calls: [] as Array<{ machineId: string; resolve: () => void; reject: (e: unknown) => void }>,
}));

vi.mock("../src/lody/agent-configs.js", () => ({
  bootstrapLodyAgentConfigs: (_store: unknown, _runtime: unknown, machineId: string) =>
    new Promise<void>((resolve, reject) => {
      state.calls.push({ machineId, resolve: () => resolve(), reject });
    }),
  refreshLodyAcpCapabilities: async () => undefined,
}));
vi.mock("../src/lody/local-projects.js", () => ({
  mirrorLocalProjectsToMachineMeta: async () => undefined,
  // An unverified probe, so the gate never writes the worktree default into
  // this process's localStorage.
  publishBoxReposAsWorkspaceRepos: async () => ({
    publishedFullNames: [],
    gitProbe: "no-git-project",
  }),
  registerWorkspaceRepositories: async () => undefined,
}));
vi.mock("../src/lody/workdir-default.js", () => ({
  applyDefaultSessionProject: (runtime: unknown) => runtime,
  createSessionProjectDefaults: () => ({}),
  seedWorktreeWorkdirDefault: () => null,
}));

import { LodyAgentConfigGate, resetAgentConfigGateMemoForTests } from "../src/lody/agent-config-gate.js";

const ENDPOINTS = {
  syncUrl: "wss://box.invalid/lody/sync",
  rpcUrl: "https://box.invalid/lody/rpc",
  controlUrl: "https://box.invalid/lody/control",
  projectUrl: "https://box.invalid/lody/project",
  platformUrl: "https://box.invalid/lody/platform",
  filesBase: "https://box.invalid/files/",
} as LodyRuntimeEndpoints;

function storeWithRuntime(workspaceId: string) {
  const store = createStore();
  // SAFETY (test-only): the gate reads `workspaceId` off the runtime and hands
  // the rest to the mocked bootstrap chain, which ignores it.
  store.set(runtimeAtom, { workspaceId } as unknown as LodyWorkspaceRuntime);
  return store;
}

async function mountGate(machineId: string, workspaceId: string) {
  const view = await render(
    <LodyAgentConfigGate store={storeWithRuntime(workspaceId)} machineId={machineId} endpoints={ENDPOINTS}>
      <div data-testid="open">through</div>
    </LodyAgentConfigGate>,
  );
  const isOpen = () => (view.container.textContent ?? "").includes("through");
  return { view, isOpen };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  resetAgentConfigGateMemoForTests();
  state.calls.length = 0;
});

describe("the agent-config gate across revisits", () => {
  it("gates the first visit, opens the revisit at once, and still re-runs", async () => {
    // FIRST VISIT: shut until the bootstrap resolves.
    const first = await mountGate("machine-1", "lw_one");
    expect(first.isOpen()).toBe(false);
    expect(state.calls).toHaveLength(1);
    await act(async () => state.calls[0]!.resolve());
    await flush();
    expect(first.isOpen()).toBe(true);
    await first.view.unmount();

    // REVISIT, SAME BOX: open immediately — the second bootstrap call exists
    // but is still PENDING, so the open cannot have waited on it.
    const second = await mountGate("machine-1", "lw_one");
    expect(state.calls).toHaveLength(2);
    expect(second.isOpen()).toBe(true);
    await act(async () => state.calls[1]!.resolve());
    await second.view.unmount();

    // A DIFFERENT BOX shares nothing: gated until its own bootstrap lands.
    const other = await mountGate("machine-2", "lw_two");
    expect(other.isOpen()).toBe(false);
    await act(async () => state.calls[2]!.resolve());
    await flush();
    expect(other.isOpen()).toBe(true);
    await other.view.unmount();
  });

  it("does not remember a failed bootstrap", async () => {
    const first = await mountGate("machine-3", "lw_three");
    expect(first.isOpen()).toBe(false);
    // Failure opens the gate (a member with existing configs must get through)…
    await act(async () => state.calls[0]!.reject(new Error("room never synced")));
    await flush();
    expect(first.isOpen()).toBe(true);
    await first.view.unmount();

    // …but must NOT count as a success: the revisit is gated again, because the
    // daemon may genuinely not have the rows yet.
    const second = await mountGate("machine-3", "lw_three");
    expect(second.isOpen()).toBe(false);
    await act(async () => state.calls[1]!.resolve());
    await flush();
    expect(second.isOpen()).toBe(true);
    await second.view.unmount();
  });

  it("a rescue-rebuilt box at the same URL misses the memo", async () => {
    const first = await mountGate("machine-4", "lw_before");
    await act(async () => state.calls[0]!.resolve());
    await flush();
    expect(first.isOpen()).toBe(true);
    await first.view.unmount();

    // Same endpoints object — same URL — but the daemon re-minted its identity.
    // The memo must not recognise it.
    const rebuilt = await mountGate("machine-4-reborn", "lw_after");
    expect(rebuilt.isOpen()).toBe(false);
    await act(async () => state.calls[1]!.resolve());
    await flush();
    expect(rebuilt.isOpen()).toBe(true);
    await rebuilt.view.unmount();
  });
});
