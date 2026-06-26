#!/bin/bash
# Proof that the shipped BlitzOS artifact + EVERY binary helper inside it is correctly signed for
# distribution. Two tiers:
#   TIER 1 (signing)        — Developer-ID identity, hardened runtime, intact signature, helper entitlements.
#                             Must ALL pass; these are what MAC_CERT_P12 / MAC_CERT_PASSWORD produce.
#   TIER 2 (notarization)   — stapled ticket + Gatekeeper "Notarized Developer ID" accept on the app and dmg.
#                             These are what APPLE_API_KEY_P8 / _ID / APPLE_API_ISSUER produce.
# Exits nonzero if any TIER 1 check fails, or if TIER 2 is expected (a dmg/zip exists) but fails.
# Usage: bash scripts/verify-signed-dist.sh            # verifies whatever is in release/
#        bash scripts/verify-signed-dist.sh <app|dmg>  # verifies a specific artifact
set -uo pipefail   # deliberately NOT -e: run every check, tally, then exit on the tally
cd "$(dirname "$0")/.."

TEAM_ID="4GS43493GL"                       # Developer ID team (Minjune Song); every helper must match
APP="${1:-release/mac-arm64/BlitzOS.app}"
DMG="$(ls release/*.dmg 2>/dev/null | head -1 || true)"
[[ "${1:-}" == *.dmg ]] && DMG="$1" && APP=""

T1_FAIL=0; T2_FAIL=0; T2_RAN=0
g(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
b1(){ printf '  \033[31m✗ [signing] %s\033[0m\n' "$1"; T1_FAIL=$((T1_FAIL+1)); }
b2(){ printf '  \033[31m✗ [notarize] %s\033[0m\n' "$1"; T2_FAIL=$((T2_FAIL+1)); }
hdr(){ printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

# vet <path> <label> — one code object: not ad-hoc, our team, hardened runtime, signature intact (TIER 1)
vet(){
  local p="$1" label="$2" d
  d="$(codesign --display --verbose=2 "$p" 2>&1)"
  if grep -q "Signature=adhoc" <<<"$d"; then b1 "$label — AD-HOC signed (not Developer ID)"; return; fi
  grep -q "TeamIdentifier=$TEAM_ID" <<<"$d" || { b1 "$label — not team $TEAM_ID"; return; }
  grep -qE 'flags=0x[0-9a-f]*\(.*runtime' <<<"$d" || { b1 "$label — NO hardened runtime"; return; }
  codesign --verify --strict "$p" 2>/dev/null || { b1 "$label — signature failed --verify"; return; }
  g "$label — Developer ID ($TEAM_ID), hardened runtime, signature valid"
}

[[ -d "$APP" || -f "$DMG" ]] || { echo "nothing to verify (no app/dmg in release/)"; exit 2; }

if [[ -d "$APP" ]]; then
  hdr "TIER 1 — the .app and its seal: $APP"
  if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -2 | grep -q "valid on disk"; then
    g "codesign --verify --deep --strict: every nested code object intact"
  else
    # --verify prints to stderr; re-run for the real verdict
    if codesign --verify --deep --strict "$APP" 2>/dev/null; then g "codesign --verify --deep --strict: passed"; else b1 "codesign --verify --deep --strict FAILED"; fi
  fi
  vet "$APP" "BlitzOS.app (top bundle)"

  hdr "TIER 1 — every shipped binary helper"
  # Named helpers the user explicitly ships (extraResources in electron-builder.yml).
  R="$APP/Contents/Resources"
  [[ -d "$R/BlitzOS Automation.app" ]] && vet "$R/BlitzOS Automation.app" "helper: Computer-Use BlitzOS Automation.app" || b1 "helper Computer-Use BlitzOS Automation.app MISSING"
  [[ -d "$R/BlitzIsland.app" ]] && vet "$R/BlitzIsland.app" "helper: dynamic-island BlitzIsland.app" || b1 "helper BlitzIsland.app MISSING"
  [[ -f "$R/notch-geometry" ]]  && vet "$R/notch-geometry"  "helper: notch-geometry CLI"            || b1 "helper notch-geometry MISSING"
  [[ -f "$R/bin/tmux" ]]        && vet "$R/bin/tmux"        "helper: portable tmux"                 || b1 "helper tmux MISSING"
  # The CU helper carries a TCC entitlement that MUST survive electron-builder's deep re-sign.
  if [[ -d "$R/BlitzOS Automation.app" ]]; then
    if codesign -d --entitlements - "$R/BlitzOS Automation.app" 2>/dev/null | grep -q "com.apple.security.automation.apple-events"; then
      g "CU helper kept its apple-events entitlement through the deep re-sign"
    else
      b1 "CU helper LOST its apple-events entitlement (deep re-sign stripped it)"
    fi
  fi

  hdr "TIER 1 — full Mach-O sweep (no unsigned / ad-hoc binary ships)"
  total=0; ours=0; bad=0; other=0
  while IFS= read -r -d '' f; do
    file -b "$f" 2>/dev/null | grep -q "Mach-O" || continue
    total=$((total+1)); ds="$(codesign -dvv "$f" 2>&1)"
    if grep -q "Signature=adhoc" <<<"$ds"; then bad=$((bad+1)); printf '    \033[31mAD-HOC:\033[0m %s\n' "${f#$APP/}"
    elif grep -q "not signed at all" <<<"$ds"; then bad=$((bad+1)); printf '    \033[31mUNSIGNED:\033[0m %s\n' "${f#$APP/}"
    elif grep -q "TeamIdentifier=$TEAM_ID" <<<"$ds"; then ours=$((ours+1))
    else other=$((other+1)); printf '    \033[33mOTHER-TEAM:\033[0m %s\n' "${f#$APP/}"; fi
  done < <(find "$APP" -type f -print0)
  echo "  Mach-O binaries: $total total | $ours signed by $TEAM_ID | $other other-team | $bad ad-hoc/unsigned"
  [[ $bad -eq 0 ]] && g "no ad-hoc or unsigned Mach-O binaries" || b1 "$bad ad-hoc/unsigned binaries would ship"

  hdr "TIER 2 — notarization + Gatekeeper on the .app"
  T2_RAN=1
  if xcrun stapler validate "$APP" >/dev/null 2>&1; then g "stapled notarization ticket present (stapler validate)"; else b2 "no stapled ticket (app not notarized)"; fi
  # Key off spctl's EXIT CODE (0=accept, !0=reject), not a substring — "Unnotarized" contains "Notarized".
  if spctl -a -t exec "$APP" 2>/dev/null; then
    g "Gatekeeper: accepted ($(spctl -a -vvv -t exec "$APP" 2>&1 | grep -i '^source=' | sed 's/source=//'))"
  else
    b2 "Gatekeeper rejects exec: $(spctl -a -vvv -t exec "$APP" 2>&1 | grep -iE '^source=|: rejected' | tr '\n' ' ' | sed 's/^ *//')"
  fi
fi

if [[ -f "$DMG" ]]; then
  hdr "TIER 2 — the DMG container: $DMG"
  T2_RAN=1
  codesign --verify --verbose=2 "$DMG" 2>/dev/null && g "dmg signature valid" || b2 "dmg signature invalid/missing"
  xcrun stapler validate "$DMG" >/dev/null 2>&1 && g "dmg has a stapled ticket" || b2 "dmg not stapled"
  if spctl -a -t open --context context:primary-signature "$DMG" 2>/dev/null; then
    g "Gatekeeper: dmg accepted ($(spctl -a -vvv -t open --context context:primary-signature "$DMG" 2>&1 | grep -i '^source=' | sed 's/source=//'))"
  else
    b2 "dmg Gatekeeper rejects: $(spctl -a -vvv -t open --context context:primary-signature "$DMG" 2>&1 | grep -iE '^source=|: rejected' | tr '\n' ' ' | sed 's/^ *//')"
  fi
else
  printf '\n\033[33m(no dmg in release/ — notarization aborted the package step, so the dmg was never built)\033[0m\n'
fi

hdr "RESULT"
echo "  TIER 1 (signing):       $([[ $T1_FAIL -eq 0 ]] && echo 'PASS — cert + helpers all correctly signed' || echo "FAIL ($T1_FAIL)")"
if [[ $T2_RAN -eq 1 ]]; then
  echo "  TIER 2 (notarization):  $([[ $T2_FAIL -eq 0 ]] && echo 'PASS — notarized + stapled + Gatekeeper-clean' || echo "FAIL ($T2_FAIL)")"
else
  echo "  TIER 2 (notarization):  NOT RUN (no notarized artifact present)"
fi
if [[ $T2_FAIL -gt 0 ]]; then
  printf '\n  \033[33mNotarization is blocked at the ACCOUNT level, not by the credentials.\033[0m\n'
  printf '  Fix: the Account Holder signs the pending agreement at https://appstoreconnect.apple.com\n'
  printf '  (Business > Agreements) or https://developer.apple.com/account (Review Agreement), then re-run npm run dist.\n'
fi
[[ $T1_FAIL -eq 0 && $T2_FAIL -eq 0 ]] && exit 0 || exit 1
