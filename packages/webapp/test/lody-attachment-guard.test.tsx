/**
 * SEAM PATCH 8, PINNED: a missing cloud token must not preempt the local
 * transport (`vendor/lody/BLITZ-PATCHES.md` §8; canary QA COMPB-1, BUG-CA-01,
 * BUG-CA-02).
 *
 * THE DEFECT. Seam patch 3 opened `canUseElectronLocalFileSend` to a
 * non-Electron bridge, and `lody-attachments.test.ts` proves the channel behind
 * it stages bytes on the box. It still never ran: at each of the three entry
 * points that HAVE a local handoff, a `if (!workspaceId || !authToken)` bail
 * stood IN FRONT of it, and that handoff needs no cloud token. A BlitzOS box
 * holds none, so each `+` attachment failed with "Missing workspace or auth
 * token" before a single MKCOL or PUT was issued (BUG-CA-01), and "Retry upload"
 * re-entered the same guard and did nothing (BUG-CA-02). The fourth,
 * `use-chat-landing-image-draft.ts`, has no local path to move in front of and
 * is deliberately left alone — `BLITZ-PATCHES.md` §8 records that gap.
 *
 * WHAT IS DRIVEN AND WHAT IS PINNED AT THE SOURCE. The landing composer's half
 * lives in a hook, so the REAL vendored `useChatLandingFileDraft` is mounted
 * here over a stub `window.ipc` and asked to stage a file — three times, because
 * the fix is only safe if it changes exactly one of the three cases:
 *
 *   1. no token, bridge present  → the handoff runs (this is the fix)
 *   2. no token, no bridge       → still fails with the same message
 *   3. token AND bridge          → the handoff runs first, as it always did
 *
 * The in-session half lives inside `SessionChatInputArea`, which needs a
 * runtime, a Loro document and a daemon — every suite that mounts that skips
 * wherever the daemon is absent, which is CI. So it is pinned at the source, the
 * same rule `lody-surface-tabs.test.tsx` applies to its own unmountable hunk.
 */
import { useEffect, useRef } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { I18nextProvider } from "react-i18next";
import { Provider as JotaiProvider, createStore } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { localProbeResultAtom } from "@lody/components/atoms/local-probe";
import { useChatLandingFileDraft } from "@lody/components/hooks/use-chat-landing-file-draft";
import { initLodyI18n } from "../src/lody/i18n.js";
import { render, settle } from "./dom.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

// Ids are branded strings upstream, but `@lody/*` are shorthand ambient modules
// on this side (`src/lody/wire-types.ts`), so nothing crosses the seam as a
// type. Nothing here resolves them against a real workspace either — the daemon
// end is a stub — so any string is a valid stand-in.
const WORKSPACE_ID = "lw_guard";
const MACHINE_ID = "m-guard";
const SESSION_ID = "s-guard";

type Handoff = { workspaceId: unknown; sessionId: unknown; machineId: unknown };

/** What this suite reads back off the vendored hook, and nothing more. The
 * hook itself arrives untyped for the reason above. */
type Draft = {
  fileItems: readonly { status: string; error?: string }[];
  buildFileInputBlocks: () => readonly unknown[];
  addFiles: (files: File[]) => void;
};

/**
 * The one channel this suite serves, and nothing else.
 *
 * `getIpcServices()` is a proxy that dispatches `group.method` by string
 * (`lib/electron-ipc-client.ts:22`), so a bridge is exactly an `invoke`. Any
 * other channel throws rather than answering `undefined`: a silent answer would
 * let a future caller pass this suite while doing something it never declared.
 */
function installBridge(calls: Handoff[]): () => void {
  window.ipc = {
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel !== "localProjects.sendSessionFileLocal") {
        throw new Error(`unexpected ipc channel: ${channel}`);
      }
      // SAFETY: the vendored sender is the only caller and always passes the
      // one payload shape; the fields read here are re-asserted by the test.
      const payload = args[0] as Handoff & { files: { fileName: string }[] };
      calls.push({
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        machineId: payload.machineId,
      });
      return {
        ok: true,
        files: payload.files.map((file) => ({
          type: "file",
          fileId: `local-${file.fileName}`,
          fileName: file.fileName,
          mimeType: "text/plain",
          sizeBytes: 5,
          sha256: "0".repeat(64),
          textPreview: true,
          transport: "local",
          machineId: MACHINE_ID,
          uploadedAt: 0,
        })),
      };
    },
    on: () => () => {},
    send: () => {},
  };
  window.__LODY_LOCAL_BRIDGE__ = true;
  return () => {
    delete window.ipc;
    delete window.__LODY_LOCAL_BRIDGE__;
  };
}

/** Mounts the real vendored hook and stages one file through its public entry
 * point, the way the landing composer's `+` does. */
async function stageOneFile(options: {
  authToken: string | null;
  bridge: boolean;
}): Promise<{
  items: Draft["fileItems"];
  blocks: readonly unknown[];
  calls: Handoff[];
}> {
  const calls: Handoff[] = [];
  const uninstall = options.bridge ? installBridge(calls) : () => {};
  const store = createStore();
  // `localMachineIdAtom` is derived from the probe, and the fast path needs it
  // to equal the selected machine — otherwise nothing under test is reached.
  store.set(localProbeResultAtom, { ok: true, machineId: MACHINE_ID });
  const seen: { draft: Draft | null } = { draft: null };

  function Host(): null {
    const draft: Draft = useChatLandingFileDraft({
      workspaceId: WORKSPACE_ID,
      authToken: options.authToken,
      machineId: MACHINE_ID,
      sessionId: SESSION_ID,
      ensureSessionId: () => SESSION_ID,
    });
    seen.draft = draft;
    const staged = useRef(false);
    useEffect(() => {
      if (staged.current) return;
      staged.current = true;
      draft.addFiles([new File(["hello"], "notes.md", { type: "text/plain" })]);
    }, [draft]);
    return null;
  }

  const view = await render(
    <I18nextProvider i18n={initLodyI18n()}>
      <JotaiProvider store={store}>
        <Host />
      </JotaiProvider>
    </I18nextProvider>,
  );
  await settle();
  await settle();
  const draft = seen.draft;
  if (!draft) throw new Error("the hook never rendered");
  const result = { items: draft.fileItems, blocks: draft.buildFileInputBlocks(), calls };
  await view.unmount();
  uninstall();
  return result;
}

afterEach(() => {
  delete window.ipc;
  delete window.__LODY_LOCAL_BRIDGE__;
});

describe("the landing composer stages a file without a cloud token", () => {
  it("hands the bytes to the local bridge instead of failing on the guard", async () => {
    const { items, blocks, calls } = await stageOneFile({ authToken: null, bridge: true });

    // The whole bug in one assertion: before seam patch 8 this list was empty.
    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, machineId: MACHINE_ID },
    ]);
    expect(items.map((item) => item.status)).toEqual(["uploaded"]);
    expect(items[0]?.error).toBeUndefined();
    // And the block it produced is the one the outgoing message carries.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "file",
      fileName: "notes.md",
      transport: "local",
      machineId: MACHINE_ID,
    });
  });

  it("still refuses, with the same message, when no local transport is there", async () => {
    // The guard is moved, not deleted. A browser with neither a token nor a
    // bridge has nowhere to put the bytes, and must say so.
    const { items, calls } = await stageOneFile({ authToken: null, bridge: false });
    expect(calls).toEqual([]);
    expect(items.map((item) => item.status)).toEqual(["failed"]);
    expect(items[0]?.error).toBe("Missing workspace or auth token");
  });

  it("leaves the local-first order untouched when a cloud token IS present", async () => {
    // Upstream's own behaviour: with a token the fast path already ran first,
    // and the reorder must not have changed that. If this ever reported a cloud
    // upload instead, the patch would have moved more than it declared.
    const { items, calls } = await stageOneFile({ authToken: "cloud-token", bridge: true });
    expect(calls).toHaveLength(1);
    expect(items.map((item) => item.status)).toEqual(["uploaded"]);
  });
});

describe("the in-session composer carries the same reorder", () => {
  const inputArea = read(
    "vendor/lody/packages/components/src/components/sessions/session-chat-input-area.tsx",
  );
  const slice = (from: string, to: string): string => {
    const start = inputArea.indexOf(from);
    const end = inputArea.indexOf(to, start);
    expect(start, `${from} is still in session-chat-input-area.tsx`).toBeGreaterThan(-1);
    expect(end, `${to} is still in session-chat-input-area.tsx`).toBeGreaterThan(start);
    return inputArea.slice(start, end);
  };

  it("reaches the local handoff before the cloud-credential guard", () => {
    const startFileUpload = slice(
      "const startFileUpload = useCallback(",
      "const enqueueFileAttachments = useCallback(",
    );
    const handoff = startFileUpload.indexOf("sendSessionFileToLocalRuntime(");
    const guard = startFileUpload.indexOf("if (!workspaceId || !authToken) {");
    expect(handoff, "the local handoff is still there").toBeGreaterThan(-1);
    expect(guard, "the guard is moved, not deleted").toBeGreaterThan(-1);
    expect(handoff, "the handoff runs first").toBeLessThan(guard);
    // The moved block answers for the id the handoff needs, since the guard no
    // longer stands in front of it.
    expect(startFileUpload).toContain(
      "if (canSendFileLocally && workspaceId && session.machineId) {",
    );
  });

  it("lets a tokenless image fall into the degrade-to-file path upstream wrote", () => {
    const startUpload = slice(
      "const startUpload = useCallback(",
      "const startFileUpload = useCallback(",
    );
    // Images have no local UPLOAD, only upstream's fallback that turns a failed
    // one into a pending file over the same transport. So the guard admits a
    // missing token when that transport is there, and the upload throws into it.
    expect(startUpload).toContain("if (!workspaceId || (!authToken && !canSendFileLocally)) {");
    expect(startUpload).toContain("throw new Error(imageUploadMissingAuthLabel);");
    expect(startUpload, "the fallback it falls into is still upstream's").toContain(
      "sessions.imageStoredAsLocalFile",
    );
  });
});

describe("seam patch 8 is declared where a merge agent reads it", () => {
  it("has a numbered entry naming both files and its upstream sketch", () => {
    const patches = read("vendor/lody/BLITZ-PATCHES.md");
    expect(patches).toContain("### 8. The cloud-token guard must not preempt the local transport");
    for (const file of [
      "components/sessions/session-chat-input-area.tsx",
      "hooks/use-chat-landing-file-draft.ts",
    ]) {
      expect(patches, `seam patch 8 declares ${file}`).toContain(file);
    }
    // The sketch is what makes this a patch we can drop rather than carry.
    expect(patches).toContain("plans/evidence/lody-attachment-guard-pr.md");
    expect(read("plans/evidence/lody-attachment-guard-pr.md")).toContain(
      "a missing cloud token disables the local file handoff",
    );
  });
});
