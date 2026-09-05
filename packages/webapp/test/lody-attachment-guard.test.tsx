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
 * `use-chat-landing-image-draft.ts`, had no local path to move in front of and
 * was left alone — an image staged on the LANDING was then the one combination
 * that still failed on a box. SEAM PATCH 12 (`BLITZ-PATCHES.md` §12) closes
 * that, by degrading such an image into the sibling FILE draft, which is the
 * degrade `session-chat-input-area.tsx` already performs in-session. Both
 * patches are driven here, over the same three cases and the same stub bridge.
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { localProbeResultAtom } from "@lody/components/atoms/local-probe";
import { useChatLandingFileDraft } from "@lody/components/hooks/use-chat-landing-file-draft";
import { useChatLandingImageDraft } from "@lody/components/hooks/use-chat-landing-image-draft";
import { initLodyI18n } from "../src/lody/i18n.js";
import type { LodyIpcReply } from "../src/lody/wire-types.js";
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
type BridgeOutcome = "ok" | "session_not_found";

/** What this suite reads back off the vendored hook, and nothing more. The
 * hook itself arrives untyped for the reason above. */
type Draft = {
  fileItems: readonly { status: string; error?: string }[];
  buildFileInputBlocks: () => readonly unknown[];
  canSendFileLocally: boolean;
  addFiles: (files: File[]) => void;
};

/** The image half of the landing composer, read back the same way. */
type ImageDraft = {
  imageItems: readonly { status: string; error?: string }[];
  addFiles: (files: File[]) => void;
};

/**
 * The one channel this suite serves, and nothing else.
 *
 * `getIpcServices()` is a proxy that dispatches `group.method` by string
 * (`lib/electron-ipc-client.ts:22`), so a bridge is exactly an `invoke`. Any
 * other channel throws rather than answering `undefined`: a silent answer would
 * let a future caller pass this suite while doing something it never declared.
 * A success-only stub cannot catch a daemon that refuses a draft. The option
 * reproduces that response without changing the hooks.
 */
function installBridge(
  calls: Handoff[],
  options: { outcome: BridgeOutcome } = { outcome: "ok" },
): () => void {
  window.ipc = {
    invoke: async (channel: string, ...args: unknown[]): Promise<LodyIpcReply> => {
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
      if (options.outcome === "session_not_found") {
        return { ok: false, error: "session_not_found" };
      }
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
  bridgeOutcome?: BridgeOutcome;
}): Promise<{
  items: Draft["fileItems"];
  blocks: readonly unknown[];
  calls: Handoff[];
}> {
  const calls: Handoff[] = [];
  const uninstall = options.bridge
    ? installBridge(calls, { outcome: options.bridgeOutcome ?? "ok" })
    : () => {};
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

/**
 * Mounts BOTH real vendored landing hooks the way `chat-landing.tsx` does — the
 * file draft first, the image draft handed its `addFiles` while the local
 * transport is there — and stages one image through the image draft's public
 * entry point, the way a paste or a drop does.
 *
 * Both hooks are driven, and that is the point: seam patch 12's whole mechanism
 * is the move ACROSS them, so a harness that mounted the image hook over a
 * hand-written callback would prove nothing about where the bytes go.
 */
async function stageOneImage(options: {
  authToken: string | null;
  bridge: boolean;
  bridgeOutcome?: BridgeOutcome;
}): Promise<{
  images: ImageDraft["imageItems"];
  files: Draft["fileItems"];
  blocks: readonly unknown[];
  calls: Handoff[];
}> {
  const calls: Handoff[] = [];
  const uninstall = options.bridge
    ? installBridge(calls, { outcome: options.bridgeOutcome ?? "ok" })
    : () => {};
  const store = createStore();
  store.set(localProbeResultAtom, { ok: true, machineId: MACHINE_ID });
  const seen: { file: Draft | null; image: ImageDraft | null } = { file: null, image: null };

  function Host(): null {
    const fileDraft: Draft = useChatLandingFileDraft({
      workspaceId: WORKSPACE_ID,
      authToken: options.authToken,
      machineId: MACHINE_ID,
      sessionId: SESSION_ID,
      ensureSessionId: () => SESSION_ID,
    });
    const imageDraft: ImageDraft = useChatLandingImageDraft({
      workspaceId: WORKSPACE_ID,
      authToken: options.authToken,
      isMobile: false,
      projectKind: "local",
      sessionId: SESSION_ID,
      ensureSessionId: () => SESSION_ID,
      degradeToFileAttachments: fileDraft.canSendFileLocally ? fileDraft.addFiles : undefined,
    });
    seen.file = fileDraft;
    seen.image = imageDraft;
    const staged = useRef(false);
    useEffect(() => {
      if (staged.current) return;
      staged.current = true;
      imageDraft.addFiles([new File(["png-bytes"], "shot.png", { type: "image/png" })]);
    }, [imageDraft]);
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
  const { file, image } = seen;
  if (!file || !image) throw new Error("the hooks never rendered");
  const result = {
    images: image.imageItems,
    files: file.fileItems,
    blocks: file.buildFileInputBlocks(),
    calls,
  };
  await view.unmount();
  uninstall();
  return result;
}

// jsdom implements neither, and the image draft holds a preview URL per pending
// image. Object URLs are opaque by contract, so a counter is a faithful stand-in.
const objectUrls = { created: 0, revoked: 0 };
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
beforeAll(() => {
  URL.createObjectURL = () => `blob:guard/${(objectUrls.created += 1)}`;
  URL.revokeObjectURL = () => {
    objectUrls.revoked += 1;
  };
});
afterAll(() => {
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

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

  /**
   * WHAT THE COMPOSER SAYS WHEN THE DAEMON REFUSES, AND IT IS NOT TRUE.
   *
   * `use-chat-landing-file-draft.ts` drops the local-send error and falls into
   * the cloud-credential branch, so every refusal reads as a missing token. That
   * wrong message is what made seam patches 8 and 12 look finished while a
   * landing attachment still failed on a box. Seam patch 25 removes the refusal
   * this case feeds; the message stays pinned so a later fix to it is deliberate.
   */
  it("reports the current error when the daemon refuses a landing file draft", async () => {
    const { items, blocks, calls } = await stageOneFile({
      authToken: null,
      bridge: true,
      bridgeOutcome: "session_not_found",
    });
    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, machineId: MACHINE_ID },
    ]);
    expect(items.map((item) => item.status)).toEqual(["failed"]);
    expect(items[0]?.error).toBe("Missing workspace or auth token");
    expect(blocks).toHaveLength(0);
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

describe("the landing composer stages an image without a cloud token", () => {
  it("degrades it into the file draft, which hands the bytes to the local bridge", async () => {
    const { images, files, blocks, calls } = await stageOneImage({
      authToken: null,
      bridge: true,
    });

    // The remaining half of COMPB-1 in one assertion: before seam patch 12 this
    // list was empty and the image chip read "Missing workspace or auth token".
    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, machineId: MACHINE_ID },
    ]);
    // The image is gone from the image draft and present in the file draft —
    // the same move `session-chat-input-area.tsx` makes inside a session.
    expect(images).toHaveLength(0);
    expect(files.map((item) => item.status)).toEqual(["uploaded"]);
    expect(files[0]?.error).toBeUndefined();
    // And it is a FILE block on the outgoing message, carried over the local
    // transport rather than an image id the box could never have minted.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "file",
      fileName: "shot.png",
      transport: "local",
      machineId: MACHINE_ID,
    });
  });

  /** The image twin of the case above: the degrade lands in the file draft, so
   * the same wrong message is what a refused IMAGE reports too. */
  it("reports the current error when the daemon refuses a landing image draft", async () => {
    const { images, files, blocks, calls } = await stageOneImage({
      authToken: null,
      bridge: true,
      bridgeOutcome: "session_not_found",
    });
    expect(calls).toEqual([
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, machineId: MACHINE_ID },
    ]);
    expect(images).toHaveLength(0);
    expect(files.map((item) => item.status)).toEqual(["failed"]);
    expect(files[0]?.error).toBe("Missing workspace or auth token");
    expect(blocks).toHaveLength(0);
  });

  it("still refuses, with the same message, when no local transport is there", async () => {
    // With no bridge there is no draft to degrade into, so the unchanged guard
    // owns the case and reports exactly what it always did.
    const { images, files, calls } = await stageOneImage({ authToken: null, bridge: false });
    expect(calls).toEqual([]);
    expect(files).toHaveLength(0);
    expect(images.map((item) => item.status)).toEqual(["failed"]);
    expect(images[0]?.error).toBe("Missing workspace or auth token");
  });

  it("leaves the cloud image upload untouched when a cloud token IS present", async () => {
    // With a token the inserted block's leading `!authToken` is false, so the
    // image takes upstream's cloud path and stays the image draft's. If this
    // ever reported a handoff, the patch would have widened the degrade past
    // the tokenless case it declared. The upload's own OUTCOME is deliberately
    // not pinned: there is no image server here, and how a jsdom XHR to an
    // absent host ends is not what this patch changed.
    const { images, files, calls } = await stageOneImage({
      authToken: "cloud-token",
      bridge: true,
    });
    expect(calls).toEqual([]);
    expect(files).toHaveLength(0);
    expect(images).toHaveLength(1);
    expect(images[0]?.error).not.toBe("Missing workspace or auth token");
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

describe("seam patch 12 is declared where a merge agent reads it", () => {
  it("has a numbered entry naming all three files and its upstream sketch", () => {
    const patches = read("vendor/lody/BLITZ-PATCHES.md");
    expect(patches).toContain("### 12. A landing image has no offline fallback");
    for (const file of [
      "hooks/use-chat-landing-image-draft.ts",
      "hooks/use-chat-landing-file-draft.ts",
      "components/chat/chat-landing.tsx",
    ]) {
      expect(patches, `seam patch 12 declares ${file}`).toContain(file);
    }
    expect(patches).toContain("plans/evidence/lody-landing-image-degrade-pr.md");
    expect(read("plans/evidence/lody-landing-image-degrade-pr.md")).toContain(
      "an image staged on the chat landing has no offline fallback",
    );
  });
});
