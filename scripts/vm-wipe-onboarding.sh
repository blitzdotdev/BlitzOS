#!/bin/sh
# BlitzOS — wipe state + RESET TCC + RELIABLY force onboarding, WITH diagnostics (packaged install).
# Works in a VM OR on your real Mac: the TCC reset is SCOPED to BlitzOS's own bundle ids
# (dev.blitz.os + helper dev.blitz.os.computeruse + island), so it NEVER clears other apps' grants.
# Run in a Terminal. If onboarding still doesn't show, PASTE THE WHOLE OUTPUT back.
# WARNING: deletes ALL BlitzOS state — every ~/Blitz workspace (docs, notes, chats) + the matching
# ~/.claude/projects/*-Blitz-* histories. Throwaway-test only.
set -u

# Hardcoded: mdfind kept resolving a stray ~/Downloads/BlitzOS.app (same bundle id) instead of the
# real install. Override with APP=/path ./vm-wipe-onboarding.sh if you ever need a different one.
APP="${APP:-/Applications/BlitzOS.app}"
PLIST="$APP/Contents/Info.plist"
ASAR="$APP/Contents/Resources/app.asar"

echo "===== DIAGNOSTICS ====="
echo "app path : $APP"
[ -d "$APP" ] || echo "  *** app NOT FOUND — set APP= to the real path and re-run ***"
echo "version  : $(defaults read "$PLIST" CFBundleShortVersionString 2>/dev/null) / build $(defaults read "$PLIST" CFBundleVersion 2>/dev/null)"
grep -aq "BLITZ_FORCE_ONBOARDING" "$ASAR" 2>/dev/null \
  && echo "force hook (BLITZ_FORCE_ONBOARDING) : PRESENT" \
  || echo "force hook (BLITZ_FORCE_ONBOARDING) : *** MISSING — build too old to force; needs a current-code build ***"
grep -aq "blitzos.onboarded" "$ASAR" 2>/dev/null \
  && echo "onboarding gate code               : PRESENT" \
  || echo "onboarding gate code               : *** MISSING — onboarding may be compiled OFF in this build ***"
echo

echo "===== QUIT (app + helper) ====="
osascript -e 'tell application "BlitzOS" to quit' 2>/dev/null || true
sleep 2
killall -9 BlitzOS 2>/dev/null || true        # the app AND the computer-use helper (both named BlitzOS)
pkill -f '\.blitzos/tmux' 2>/dev/null || true
sleep 2
pgrep -x BlitzOS >/dev/null 2>&1 && echo "WARNING: BlitzOS still alive — kill it manually then re-run" || echo "all BlitzOS processes stopped"

echo "===== RESET TCC (SCOPED to BlitzOS's bundle ids ONLY — never a blanket all-apps reset) ====="
# tccutil reset SERVICE <bundle-id> clears only that bundle's grants. With NO bundle id it would reset
# the service for EVERY app on the Mac — never do that here. AppleEvents=Automation, ScreenCapture=Screen
# Recording, SystemPolicyAllFiles=Full Disk Access, ListenEvent=Input Monitoring.
for BID in dev.blitz.os dev.blitz.os.computeruse dev.blitz.os.island; do
  for SVC in AppleEvents Accessibility ScreenCapture SystemPolicyAllFiles ListenEvent; do
    tccutil reset "$SVC" "$BID" >/dev/null 2>&1 || true
  done
  tccutil reset All "$BID" >/dev/null 2>&1 || true   # catch any service not named above
  echo "  reset AppleEvents + Accessibility + ScreenRecording + FullDisk + InputMonitoring (+All) for $BID"
done

echo "===== WIPE ====="
rm -rf "$HOME/Library/Application Support/BlitzOS" \
       "$HOME/Library/Application Support/agent-os" \
       "$HOME/Library/Application Support/dev.blitz.os" \
       "$HOME/.blitzos" "$HOME/Blitz" \
       "$HOME/Library/Saved Application State/dev.blitz.os.savedState" \
       "$HOME/Library/Caches/BlitzOS" "$HOME/Library/Caches/dev.blitz.os"
rm -f  "$HOME/Library/Preferences/dev.blitz.os.plist"
rm -rf "$HOME"/.claude/projects/*-Blitz-* 2>/dev/null || true
echo "state wiped"

echo "===== RELAUNCH (forced via launchctl env) ====="
launchctl setenv BLITZ_FORCE_ONBOARDING 1
open "$APP"
( sleep 12; launchctl unsetenv BLITZ_FORCE_ONBOARDING ) &   # one-shot: stop forcing after this launch
sleep 6
NEWPID="$(pgrep -f "$APP/Contents/MacOS/" | head -1)"
if [ -n "$NEWPID" ] && ps eww -p "$NEWPID" 2>/dev/null | tr ' ' '\n' | grep -q '^BLITZ_FORCE_ONBOARDING=1$'; then
  echo "RESULT: BlitzOS (pid $NEWPID) is running WITH the force env."
  echo "  → If onboarding STILL doesn't show, the build itself has it old/off (see DIAGNOSTICS above)."
else
  echo "RESULT: the new BlitzOS did NOT pick up the force env (pid='$NEWPID'). Paste this whole output back."
fi
