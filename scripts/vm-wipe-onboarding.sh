#!/bin/sh
# BlitzOS — wipe + RELIABLY force onboarding, WITH diagnostics (packaged install / VM).
# Run in a Terminal INSIDE the VM. If onboarding still doesn't show, PASTE THE WHOLE OUTPUT back.
# WARNING: deletes ALL BlitzOS state, including every ~/Blitz workspace (docs, notes, chats).
set -u

APP="$(mdfind 'kMDItemCFBundleIdentifier == dev.blitz.os' 2>/dev/null | head -1)"
[ -d "$APP" ] || APP="/Applications/BlitzOS.app"
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
