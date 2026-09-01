# Upstream PR: let a non-Electron local bridge send session files

Drafted 2026-08-30 for `LodyAI/Lody`, against the vendored pin `966623d0`.
It is the contribution that lets BlitzOS drop seam patch 3 in
`vendor/lody/BLITZ-PATCHES.md` (`plans/LODY-SESSIONS.md` §0.7,
`plans/LODY-RUNTIME-DESIGN.md` §10.4).

It is the same idea as seam patch 1 in a third file, so if seam patch 1 is
opened upstream first, this belongs in that PR rather than in its own.

## Before it is opened

Their `.github/AGENTS.md` applies unchanged; the four costs seam patch 2's
sketch lists are the same here (`plans/evidence/lody-sidebar-props-pr.md`):
an Issue must exist and a maintainer must agree first, the Context handoff is
public, an invalid body is closed after seven days, and the body is validated
with `node .github/scripts/check-pr-body.mjs --body-file <file>`. Their commit
convention is `feat: …`, and AI commits end with `Model: <runtime-model-id>`.

This one is three lines, so the oversize rule does not bite; the Issue URL is
still required by the template.

## Diff summary

One file, one predicate:

```diff
 export const canUseElectronLocalFileSend = (): boolean =>
-  isElectronRenderer() && Boolean(getIpcServices());
+  (isElectronRenderer() ||
+    (typeof window !== 'undefined' && window.__LODY_LOCAL_BRIDGE__ === true)) &&
+  Boolean(getIpcServices());
```

`window.__LODY_LOCAL_BRIDGE__` is already declared in
`packages/components/src/window-globals.d.ts` by seam patch 1's hunk 6; if this
PR goes up alone, that one-line declaration comes with it.

## The argument

`canUseElectronLocalFileSend` guards a path that has nothing Electron-specific
in it. What it actually needs is a host that implements
`localProjects.sendSessionFileLocal` — and `getIpcServices()` is a generic proxy
over `window.ipc` (`lib/electron-ipc-client.ts:22`), so that half of the
predicate already asks the right question. The other half asks who installed the
bridge, and answers "only Electron may have".

Two call sites read it — `hooks/use-chat-landing-file-draft.ts:104` and
`components/sessions/session-chat-input-area.tsx:524` — and both fall through to
`uploadSessionFile`, whose every URL is built from `API_BASE_URL`. A local-only
composition with no cloud account therefore has no working `+` button at all,
which is the one composer control it cannot serve.

The change is strictly additive: the predicate can only become true where it was
false, and no upstream build sets `__LODY_LOCAL_BRIDGE__`, so Electron and cloud
behaviour are unchanged by construction.

## What a host takes on

The channel's contract is `SendSessionFileLocal`
(`packages/shared/src/electron-ipc.ts:530`): given `{workspaceId, sessionId,
machineId, files:[{fileName, bytes}]}`, put the bytes somewhere the MACHINE can
read them, issue `session/file-send-local` with those paths, and return the
`SessionFilePayload[]` from the response. Electron's implementation
(`apps/electron/src/main/ipc/services/local-projects-ipc.ts:79`) writes a temp
directory and deletes it afterwards; BlitzOS's writes the bytes over the box's
own WebDAV surface and deletes them afterwards
(`packages/webapp/src/lody/session-attachments.ts`). Nothing about the daemon
side changes: it copies each path into its blob store and answers with
`transport: 'local'` blocks either way.

Worth saying in the PR body, because it is the reviewer's first question: the
predicate does not decide whether the bytes are SAFE to read, only whether the
host claims to serve the channel. The daemon already validates the request
(`SessionFileSendLocalRequestSchema` is `.strict()`) and already refuses a
session it does not hold (`session_not_found`).

## Alternative the PR should mention and reject

Replacing the flag test with a capability probe — "does `window.ipc` answer
`localProjects.sendSessionFileLocal`?" — is the cleaner long-term shape, and it
would delete the flag from this file entirely. It is not what this PR does,
because the proxy dispatches by string and has no way to enumerate what the host
implements, so the probe would have to be an async call with a sentinel payload.
That is a bigger change than the problem justifies and it belongs to whoever
reworks `createLodyIpcProxy`.
