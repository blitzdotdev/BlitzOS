# Upstream PR: a missing cloud token disables the local file handoff

Drafted 2026-09-01 for `LodyAI/Lody`, against the vendored pin `f3474894`.
It is the contribution that lets BlitzOS drop seam patch 8 in
`vendor/lody/BLITZ-PATCHES.md`.

It is a straight bug fix, not a host prop, so nothing is left behind when it
merges: there is no BlitzOS-only flag in it and no call site to update.

## Before it is opened

Their `.github/AGENTS.md` applies unchanged; the four costs seam patch 2's
sketch lists are the same here (`plans/evidence/lody-sidebar-props-pr.md`): an
Issue must exist and a maintainer must agree first, the Context handoff is
public, an invalid body is closed after seven days, and the body is validated
with `node .github/scripts/check-pr-body.mjs --body-file <file>`. Their commit
convention is `fix: …`, and AI commits end with `Model: <runtime-model-id>`.

This one is small enough that the oversize rule does not bite; the Issue URL is
still required by the template.

## The defect, in one sentence

At all three attachment entry points a cloud-credential guard runs BEFORE the
local-transport fast path, so a composition with no cloud token cannot attach a
file even when the session's runtime is the local CLI on this very machine.

## Repro without any host of ours

1. Run the OSS desktop entry (`pnpm start:local`), which composes `local` and,
   per the root `AGENTS.md`, "must not make authenticated product-cloud
   requests" — so `authTokenAtom` is null.
2. Open a session whose `machineId` is the local CLI's.
3. Press `+` and pick any file.

The chip goes straight to `failed` with `sessions.fileUploadMissingAuth`
("Missing workspace or auth token"). No handoff is attempted; `Retry upload`
re-enters the same guard and is therefore inert too.

## Diff summary

Two files, and the file half is a MOVE rather than a rewrite.

`components/sessions/session-chat-input-area.tsx`, `startFileUpload` — and the
same shape in `hooks/use-chat-landing-file-draft.ts`, `startUpload`:

```diff
-      if (!workspaceId || !authToken) {
-        updatePendingFile(targetSessionId, localId, (entry) => ({ …failed… }));
-        return;
-      }
-
       // Desktop local-transport fast path: …
-      if (canSendFileLocally && session.machineId) {
+      // It runs BEFORE the cloud-credential guard below, because the handoff
+      // needs no cloud token: a local-only build has none and would otherwise
+      // never reach it.
+      if (canSendFileLocally && workspaceId && session.machineId) {
         …
       }
+
+      if (!workspaceId || !authToken) {
+        updatePendingFile(targetSessionId, localId, (entry) => ({ …failed… }));
+        return;
+      }
```

`components/sessions/session-chat-input-area.tsx`, `startUpload` (images):

```diff
-        if (!workspaceId || !authToken) {
+        if (!workspaceId || (!authToken && !canSendFileLocally)) {
```

```diff
+          if (!authToken) {
+            throw new Error(imageUploadMissingAuthLabel);
+          }
           const uploaded = await uploadSessionImage({
```

## The argument

`sendSessionFileToLocalRuntime` hands bytes to the machine that runs the
session. It calls `localProjects.sendSessionFileLocal` and nothing else: no
`API_BASE_URL`, no bearer token, no relay. The token in that guard belongs to
`uploadSessionFile` / `uploadSessionImage`, which are the SECOND path in the
same function. Guarding both on the first path's credentials makes the fallback
gate the fast path.

The image half needs no new fallback, only the same ordering. `startUpload`
already degrades a failed image upload to a pending FILE attachment over the
local transport, with its own toast (`sessions.imageStoredAsLocalFile`,
"Image upload is offline; added as a pending file attachment"). "There is no
token" is exactly "there is no cloud upload to attempt", so the fix routes it
into that existing `catch` rather than adding a second fallback beside it.

## Why it is safe where a token IS present

Every hunk is inert with `authToken` set, and by construction rather than by
inspection:

- The moved block's only reachable predecessor was the guard, so with a token
  the order of operations is unchanged: guard passes, local path first, cloud
  path second.
- `(!authToken && !canSendFileLocally)` is `false` whenever `authToken` is set,
  so the image guard's condition is unchanged there.
- The `throw` is unreachable with a token, and unreachable without one unless
  the local transport is available — the guard above it returns first.

So no build that has a token can reach a line it did not reach before, and no
build can lose the cloud path: it still runs whenever the local handoff declines
or throws.

## What it does not do

It does not touch `hooks/use-chat-landing-image-draft.ts`, which carries the same
guard and has no local path at all — no handoff and no degrade-to-file fallback.
There is nothing there to move in front of the guard, and adding a fallback that
does not exist yet is a product decision for the maintainers, not a bug fix.
Worth naming in the PR body so a reviewer does not read the omission as an
oversight.

It does not make the local path preferred over the cloud one — that order was
already upstream's, and the fix only stops a credential check from standing in
front of it. It does not touch `canUseElectronLocalFileSend`, `validateSessionFile`,
the size limits, or the daemon side. And it leaves the failure copy exactly as
it is: a build with neither a token nor a local transport still reports
"Missing workspace or auth token", which is then true.
