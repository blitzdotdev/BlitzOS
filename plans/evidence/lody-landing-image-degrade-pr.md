# Upstream PR: an image staged on the chat landing has no offline fallback

Drafted 2026-09-01 for `LodyAI/Lody`, against the vendored pin `f3474894`.
It is the contribution that lets BlitzOS drop seam patch 12 in
`vendor/lody/BLITZ-PATCHES.md`, and it is the follow-up seam patch 8's sketch
(`plans/evidence/lody-attachment-guard-pr.md`) said it was leaving alone.

It carries no BlitzOS-only flag and no host prop. The one new parameter is
optional, and the one new call site is upstream's own landing.

## Before it is opened

Their `.github/AGENTS.md` applies unchanged; the four costs seam patch 2's
sketch lists are the same here (`plans/evidence/lody-sidebar-props-pr.md`): an
Issue must exist and a maintainer must agree first, the Context handoff is
public, an invalid body is closed after seven days, and the body is validated
with `node .github/scripts/check-pr-body.mjs --body-file <file>`. Their commit
convention is `fix: …`, and AI commits end with `Model: <runtime-model-id>`.

Open it AFTER the guard-order fix, or with it: on a build that still has the
guard-order bug, the landing file draft cannot take the degraded bytes either.

## The defect, in one sentence

`session-chat-input-area.tsx` turns an image it cannot upload into a pending
file attachment over the local transport, but `use-chat-landing-image-draft.ts`
has no such fallback, so the SAME image fails on the landing and succeeds one
click later inside the session it creates.

## Repro without any host of ours

1. Run the OSS desktop entry (`pnpm start:local`), which composes `local` and,
   per the root `AGENTS.md`, "must not make authenticated product-cloud
   requests" — so `authTokenAtom` is null.
2. On the chat landing, select a machine that is this machine's local CLI.
3. Paste or drop an image into the composer.

The chip goes straight to `failed` with `sessions.imageUploadMissingAuth`
("Missing workspace or auth token"). Start the chat, drop the same image into
the session composer, and it lands as a pending file attachment with the toast
`sessions.imageStoredAsLocalFile`. A non-image file works in both places.

## Diff summary

Three files, and the new behaviour is a call, not a second transport.

`hooks/use-chat-landing-image-draft.ts`, `startUpload`:

```diff
+  degradeToFileAttachments?: (files: File[]) => void;
```

```diff
+      // With no cloud token there is no image upload to attempt, but the
+      // sibling FILE draft can still hand the bytes to the machine over its
+      // local transport. Runs BEFORE the cloud-credential guard, which owns
+      // the cloud path below it.
+      if (!authToken && workspaceId && degradeToFileAttachments) {
+        …drop the pending image, stage the File on the file draft, toast…
+        return;
+      }
+
       if (!workspaceId || !authToken) {
```

`hooks/use-chat-landing-file-draft.ts` returns the predicate it already
computes:

```diff
     canAddMoreFiles: pendingFiles.length < SESSION_FILE_MAX_COUNT,
+    canSendFileLocally,
```

`components/chat/chat-landing.tsx` declares the file draft first and wires it:

```diff
+    degradeToFileAttachments: canSendFileLocally ? addFileAttachments : undefined,
```

## The argument

The behaviour already exists and is already yours. `startUpload` in
`session-chat-input-area.tsx:1004-1066` catches a failed image upload, sends the
file through `sendSessionFileToLocalRuntime`, moves the entry from
`pendingImages` into `pendingFiles`, and toasts
`sessions.imageStoredAsLocalFile` ("Image upload is offline; added as a pending
file attachment"). In-session that is one component holding both state machines,
so the move is a `setState`. The landing splits them into two sibling hooks that
`chat-landing.tsx` mounts side by side and that already share one reserved
session id, so the same move is a call across that seam.

Handing the raw `File` to the file draft's own `addFiles` — the entry point the
`+` button uses — means no part of the local transport is restated in the image
hook. The bytes take the file draft's size and count limits, its chip, its
status and its Retry, and land on the same session id the image would have.

## Why it is safe where a token IS present

The inserted block's condition leads with `!authToken`, so with a token set it
is `false` and `startUpload` executes the same statements in the same order as
before. The other two files gain a returned field and an argument, and change no
existing expression.

The degrade is deliberately NOT extended to a genuine upload failure, although
the in-session path does degrade on any failure. Doing that here would change
what a token holder sees on a surface that never had a fallback, and this change
is about the case where there is no upload to attempt at all. A maintainer who
wants the wider behaviour can widen the condition in one place.

## What it does not do

It does not give the landing image draft a transport of its own, does not touch
`canUseElectronLocalFileSend`, `validateSessionImageFile`, the image size or
count limits, or the daemon side. It does not change the failure copy: a build
with neither a token nor a local transport still reports "Missing workspace or
auth token" from the unchanged guard, which is then true.
