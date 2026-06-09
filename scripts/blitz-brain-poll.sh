#!/usr/bin/env bash
# BlitzOS brain event poller (chat-responder session).
#
# Long-polls $BASE/events FOREVER. This session's ONLY job is to answer chat
# messages, so stdout carries a wake line ONLY for trigger:'message' moments;
# every other moment (nav/idle/batch/select/action) just advances the cursor
# and is ignored. A persistent Monitor watches stdout and re-invokes the brain
# on each "MSG ..." line; on wake the brain replies via $BASE/say.
#
# stdout lines:
#   MSG seq=<n> msg=<text>   one per user chat message  -> WAKE the brain
#   OFFLINE / ONLINE         relay session drop/reconnect (info only)
#   ERROR ...                surfaced relay error        (info only)
# Idle polls print nothing -> no wake. Full message moments also land in $LOG.
#
# State (since cursor) persists in $SINCE_FILE so the loop survives relaunch.
set -uo pipefail

# The agent-socket tool base ($BASE/events, $BASE/say). The relay token rotates per session, so we
# NEVER hardcode it — resolve it live from the running backend's agent-url endpoint (strip the trailing
# /agents.md to get the tool base). Override with BLITZ_BASE for an out-of-band relay.
BASE="${BLITZ_BASE:-}"
if [ -z "$BASE" ]; then
  BASE="$(curl -s --max-time 4 "http://127.0.0.1:${BACKEND_PORT:-8799}/api/os/agent-url" \
    | sed -n 's#.*"url":"\(.*\)/agents.md".*#\1#p')"
fi
[ -n "$BASE" ] || { echo "blitz-brain-poll: could not resolve agent-socket base — start the backend or set BLITZ_BASE" >&2; exit 1; }
LOG="/tmp/blitz-brain-msgs.jsonl"
SINCE_FILE="/tmp/blitz-brain-since"
ONLINE_FILE="/tmp/blitz-brain-online"
HEARTBEAT="/tmp/blitz-brain-heartbeat"

since="$(cat "$SINCE_FILE" 2>/dev/null || echo 1)"
[ -z "$since" ] && since=1
prev_online="$(cat "$ONLINE_FILE" 2>/dev/null || echo 1)"
[ -z "$prev_online" ] && prev_online=1

touch "$LOG"

while true; do
  date +%s > "$HEARTBEAT"

  resp="$(curl -sS --max-time 40 -X POST "$BASE/events" \
    -H 'content-type: application/json' \
    -d "{\"since\":$since,\"wait\":25}" 2>/dev/null)" || resp=""

  # Empty or non-JSON (relay/WAF hiccup): brief back off, retry.
  if [ -z "$resp" ] || ! echo "$resp" | jq -e . >/dev/null 2>&1; then
    sleep 3
    continue
  fi

  # App offline on the relay: back off, announce the drop once, don't advance.
  if echo "$resp" | jq -e 'has("error") and (.error.code // "") == "app_offline"' >/dev/null 2>&1; then
    if [ "$prev_online" = "1" ]; then
      echo "OFFLINE relay session dropped (since=$since)"
      prev_online=0; echo 0 > "$ONLINE_FILE"
    fi
    sleep 5
    continue
  fi

  # Any other error object: surface it, back off, don't spin.
  if echo "$resp" | jq -e 'has("error")' >/dev/null 2>&1; then
    echo "ERROR events: $(echo "$resp" | jq -c '.error')"
    sleep 5
    continue
  fi

  # Online. Announce a reconnect once (info only; no action required).
  if [ "$prev_online" != "1" ]; then
    echo "ONLINE relay session reconnected (since=$since)"
    prev_online=1; echo 1 > "$ONLINE_FILE"
  fi

  latest="$(echo "$resp" | jq -r '.latest // empty')"
  n="$(echo "$resp" | jq -r '(.events // []) | length')"

  if [ -n "$n" ] && [ "$n" != "0" ]; then
    # Persist full message moments for deeper context...
    echo "$resp" | jq -c '.events[] | select(.trigger == "message")' >> "$LOG"
    # ...and emit ONE wake line per chat message. Non-message moments: silent.
    echo "$resp" | jq -r '.events[] | select(.trigger == "message")
      | "MSG seq=\(.seq) msg=\((.message // "")|gsub("\n";" "))"'
  fi

  if [ -n "$latest" ]; then
    since="$latest"
    echo "$since" > "$SINCE_FILE"
  fi
done
