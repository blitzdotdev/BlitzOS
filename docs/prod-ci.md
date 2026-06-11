# Prod builds, CI, and OTA updates (dead-simple edition)

The goal: push to GitHub → CI builds a real `.app` → download it once in a clean machine (a UTM
macOS VM) → the app self-updates over the air from then on. Dev on the main machine and prod in
the VM never share state.

## The pieces

- **`electron-builder.yml`** — packages `out/` + `widgets/` into `BlitzOS.app` (arm64 zip).
  The onboarding scan + its prompt `.md`s ship `asarUnpack`'d (the scan runs as a plain-node
  child, which can't read inside an asar); `onboarding.ts` resolves them via `app.asar.unpacked`.
- **`.github/workflows/release.yml`** — on every push to ANY branch: stamps version
  `0.0.1-<run_number>`, builds, packages, publishes a GitHub **prerelease** tagged
  `build-<branch>-<run_number>` with the zip attached, and bakes `{buildBranch, buildRun}`
  into the app (electron-builder extraMetadata). Every branch is its own update channel —
  push a `staging` branch and you get staging builds. Signing + notarization turn on
  automatically once the secrets exist (below); until then artifacts are unsigned.
- **`src/main/update.ts`** — in-app OTA: packaged builds poll the repo (boot + every 30 min)
  and follow ONLY their own branch channel — a newer run of the SAME branch downloads, stages,
  and offers **Restart Now**; a staging push can never hijack a master install. On restart a
  detached script swaps the `.app` in place and relaunches. Not Squirrel — works signed or
  unsigned (it re-strips quarantine after the swap; harmless when notarized).
- **The dev build picker (⌥⌘U)** — on developer machines only (hardware-UUID allowlist in
  `update.ts`, or touch `~/.blitzos/dev-machine` on any box), ⌥⌘U opens a hidden window listing
  EVERY CI build grouped by branch (newest first, your running build marked). Click **Install**
  on any of them — older, newer, another branch — and it downloads, stages, and swaps the .app
  on restart. This is how you flip one machine between master / staging / feature builds.
- **`npm run dist`** (`scripts/dist-mac.sh`) — the same build locally. Signed + notarized
  automatically from the `APPLE_*` exports already in `~/.zshrc`; unsigned without them.

## One-time: VM setup

1. In the VM, log into GitHub (or just mint a fine-grained PAT with **Contents: read** on the
   repo) and download the latest release zip from
   `https://github.com/blitzdotdev/BlitzOS/releases` → unzip → drag `BlitzOS.app` to
   `/Applications` → open it. Builds are signed + notarized (CI secrets are configured), so
   Gatekeeper is clean. If you ever grab a PRE-signing build ("BlitzOS is damaged"):
   `xattr -dr com.apple.quarantine /Applications/BlitzOS.app && codesign --force --deep -s - /Applications/BlitzOS.app`
2. Give the updater the token (private repo):
   `mkdir -p ~/.blitzos && echo '<PAT>' > ~/.blitzos/github-token`
   (or launch with `GH_TOKEN` exported). Without it the poll logs and skips.
3. **Brain prerequisites** (the AI in the chat): install the Claude Code CLI and tmux in the VM —
   `brew install tmux` and the `claude` CLI from claude.com/code (verify `claude` + `tmux` work in
   a terminal, then relaunch BlitzOS). Without them the app runs but the chat tells you exactly
   what's missing instead of answering.
4. That's it — every push to your branch produces a release; within 30 min (or on next launch)
   the VM offers the update.

## One-time: make CI builds signed + notarized (optional but Gatekeeper-clean)

Run on the dev machine (exports the Developer ID cert + uploads the four secrets):

```bash
# 1. export the cert (pick a one-off password when prompted)
security export -k login.keychain -t identities -f pkcs12 -o /tmp/devid.p12   # choose the "Developer ID Application" identity in the GUI prompt
# 2. upload secrets (gh CLI, run from the repo)
gh secret set MAC_CERT_P12 < <(base64 -i /tmp/devid.p12)
gh secret set MAC_CERT_PASSWORD --body '<the p12 password>'
gh secret set APPLE_API_KEY_P8 < "$APPLE_API_KEY_PATH"
gh secret set APPLE_API_KEY_ID --body "$APPLE_API_KEY"      # ~/.zshrc's APPLE_API_KEY is the KEY ID
gh secret set APPLE_API_ISSUER --body "$APPLE_API_ISSUER"
rm /tmp/devid.p12
```

## Env separation (running prod on the DEV machine)

The packaged app is already isolated from `npm run dev` for ports (the control server picks a
free port) and app state (`userData` is `BlitzOS`, dev's is `agent-os`, so the single-instance
locks don't collide). The one SHARED thing is the workspaces root `~/Blitz` — two hosts on one
root triggers the journal's loud dual-host warning. For true side-by-side on one machine:

```bash
BLITZ_WORKSPACES_ROOT=~/BlitzProd open -a BlitzOS   # or export it in the VM (unneeded there)
```

In the VM nothing is shared by construction — that's the point of the VM.

## Escape hatches

- `BLITZ_NO_UPDATE=1` disables the OTA poll.
- `BLITZ_UPDATE_REPO=owner/repo` points the updater elsewhere.
- Updates are whole-`.app` swaps; workspaces (`~/Blitz`) and tokens are untouched.
