#!/usr/bin/env bash
set -euo pipefail

REMOTE=${BLITZ_AGENT_REMOTE:-minjune@192.168.5.25}
HOST=${BLITZ_AGENT_HOST:-192.168.5.25}
API_PORT=${BLITZ_AGENT_PORT:-8086}
TOKEN_FILE=${BLITZ_AGENT_TOKEN_FILE:?set BLITZ_AGENT_TOKEN_FILE to a local mode-0600 token copy}
REMOTE_LAB=${BLITZ_REMOTE_LAB:-/home/minjune/blitz-microvm-lab}
RECEIVER_PORT=${BLITZ_RECEIVER_PORT:-39123}
CP_ORIGIN=${BLITZ_TEST_CP_ORIGIN:-https://cp.m2.invalid}
RESULT_DIR=${BLITZ_RESULT_DIR:-integration/results}

TOKEN=$(tr -d '\r\n' <"$TOKEN_FILE")
[[ ${#TOKEN} -ge 32 ]] || { echo "token file is invalid" >&2; exit 1; }
mkdir -p "$RESULT_DIR"
TMP=$(mktemp -d)
VM_ID=
RECEIVER_STARTED=0

cleanup() {
  if [[ -n "$VM_ID" ]]; then
    curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "http://$HOST:$API_PORT/v1/vms/$VM_ID" || true
  fi
  if (( RECEIVER_STARTED )); then
    ssh -o BatchMode=yes "$REMOTE" "if test -s '$REMOTE_LAB/agent/integration/receiver.pid'; then kill \$(cat '$REMOTE_LAB/agent/integration/receiver.pid') 2>/dev/null || true; fi" || true
  fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
auth_curl() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }
ssh_opts=(-i "$TMP/id_ed25519" -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

ssh-keygen -q -t ed25519 -N '' -C microvm-m2-integration -f "$TMP/id_ed25519"
PUBKEY=$(tr -d '\r\n' <"$TMP/id_ed25519.pub")

ssh -o BatchMode=yes "$REMOTE" "cd '$REMOTE_LAB/agent/integration'
nohup node receiver.js '$RECEIVER_PORT' receiver-events.jsonl >receiver.stdout 2>&1 </dev/null &
echo \$! >receiver.pid"
RECEIVER_STARTED=1
for _ in $(seq 1 100); do
  if ssh -o BatchMode=yes "$REMOTE" "nc -z -w 1 127.0.0.1 '$RECEIVER_PORT'" >/dev/null 2>&1; then break; fi
  sleep 0.05
done
ssh -o BatchMode=yes "$REMOTE" "nc -z -w 1 127.0.0.1 '$RECEIVER_PORT'"

health=$(auth_curl -w $'\n%{http_code}' "http://$HOST:$API_PORT/v1/healthz")
health_status=${health##*$'\n'}
health_body=${health%$'\n'*}
echo "healthz status=$health_status body=$health_body"
[[ "$health_status" == 200 ]] && jq -e '.ok == true' <<<"$health_body" >/dev/null

capacity=$(auth_curl -w $'\n%{http_code}' "http://$HOST:$API_PORT/v1/capacity")
capacity_status=${capacity##*$'\n'}
capacity_body=${capacity%$'\n'*}
echo "capacity status=$capacity_status body=$capacity_body"
[[ "$capacity_status" == 200 ]] && jq -e '.vm_count == 0' <<<"$capacity_body" >/dev/null

create_vm() {
  local workspace=$1 output=$2 start code
  local payload
  payload=$(jq -cn --arg workspace "$workspace" --arg key "$PUBKEY" \
    --arg phone "http://$HOST:$RECEIVER_PORT/enroll" --arg origin "$CP_ORIGIN" \
    '{workspace_id:$workspace,cpu:2,mem_mb:1024,ssh_authorized_key:$key,phone_home_url:$phone,cp_origin:$origin}')
  start=$(now_ms)
  code=$(curl -sS -o "$output" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data "$payload" "http://$HOST:$API_PORT/v1/vms")
  [[ "$code" == 201 ]] || { echo "create status=$code" >&2; return 1; }
  VM_ID=$(jq -er '.vm_id' "$output")
  VM_HOST=$(jq -er '.host_ip' "$output")
  VM_PORT=$(jq -er '.ssh_port' "$output")
  REQUEST_START=$start
}

wait_ready() {
  local deadline=$(( $(now_ms) + 60000 ))
  while ! ssh "${ssh_opts[@]}" -p "$VM_PORT" "blitz@$VM_HOST" true >/dev/null 2>&1; do
    (( $(now_ms) < deadline )) || { echo "timeout waiting for SSH" >&2; return 1; }
    sleep 0.01
  done
  SSH_MS=$(( $(now_ms) - REQUEST_START ))
  while ! ssh "${ssh_opts[@]}" -p "$VM_PORT" "blitz@$VM_HOST" \
    'for p in 7443 7444 7445; do ss -ltnH "sport = :$p" | grep -q LISTEN || exit 1; done' >/dev/null 2>&1; do
    (( $(now_ms) < deadline )) || { echo "timeout waiting for surfaces" >&2; return 1; }
    sleep 0.02
  done
  SURFACES_MS=$(( $(now_ms) - REQUEST_START ))
}

assert_enrollment() {
  local deadline=$(( $(now_ms) + 30000 ))
  while ! ssh "${ssh_opts[@]}" -p "$VM_PORT" "blitz@$VM_HOST" \
    "test -s /var/lib/blitz/box-credential.json && test -s /var/lib/blitz/origin" >/dev/null 2>&1; do
    (( $(now_ms) < deadline )) || { echo "timeout waiting for enrollment files" >&2; return 1; }
    sleep 0.02
  done
  ssh "${ssh_opts[@]}" -p "$VM_PORT" "blitz@$VM_HOST" \
    "test \"\$(stat -c %a /var/lib/blitz/box-credential.json)\" = 600 && test \"\$(cat /var/lib/blitz/origin)\" = '$CP_ORIGIN' && node -e \"const c=require('/var/lib/blitz/box-credential.json'); for (const k of ['box_id','access_token','refresh_token']) if (!c[k]) process.exit(1)\""
}

delete_vm() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" "http://$HOST:$API_PORT/v1/vms/$VM_ID")
  [[ "$code" == 204 ]] || { echo "delete status=$code" >&2; return 1; }
  DELETE_STATUS=$code
}

assert_no_leak() {
  local slot=$(( VM_PORT - 22000 )) tag="blitz-microvm:slot-$(( VM_PORT - 22000 ))"
  ssh -o BatchMode=yes "$REMOTE" \
    "test ! -e '$REMOTE_LAB/agent/state/runtime/$VM_ID' && test ! -e '$REMOTE_LAB/agent/state/vms/$VM_ID.json' && test ! -e '/sys/class/net/blitz-tap$slot' && ! ps -eo args | grep -F '$REMOTE_LAB/agent/state/runtime/$VM_ID/firecracker.sock' | grep -v grep >/dev/null && ! '$REMOTE_LAB/bin/sudo-run.sh' iptables-save | grep -F '$tag' >/dev/null"
}

create_vm "m2-integration-main" "$TMP/create-main.json"
wait_ready
assert_enrollment
echo "create status=201 vm_id=$VM_ID host=$VM_HOST ssh_port=$VM_PORT request_to_ssh_ms=$SSH_MS request_to_surfaces_ms=$SURFACES_MS"
ssh "${ssh_opts[@]}" -p "$VM_PORT" "blitz@$VM_HOST" \
  'printf "credential="; stat -c "%a %U:%G" /var/lib/blitz/box-credential.json; printf "origin="; stat -c "%a %U:%G" /var/lib/blitz/origin; node -e "const c=require(\"/var/lib/blitz/box-credential.json\"); console.log(\"credential_fields=\"+Object.keys(c).sort().join(\",\"))"; printf "origin_value="; cat /var/lib/blitz/origin; printf "surfaces="; for p in 7443 7444 7445; do ss -ltnH "sport = :$p" | grep -q LISTEN && printf "%s " "$p"; done; echo'
ssh -o BatchMode=yes "$REMOTE" "head -n 1 '$REMOTE_LAB/agent/integration/receiver-events.jsonl'"
delete_vm
first_vm=$VM_ID
assert_no_leak
VM_ID=
idempotent=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" "http://$HOST:$API_PORT/v1/vms/$first_vm")
echo "delete status=$DELETE_STATUS idempotent_delete_status=$idempotent leak_audit=clean"
[[ "$idempotent" == 204 ]]

TIMINGS="$RESULT_DIR/timings.tsv"
printf 'cycle\trequest_ssh_ms\trequest_surfaces_ms\n' >"$TIMINGS"
for cycle in $(seq 1 10); do
  create_vm "m2-benchmark-$cycle" "$TMP/create-$cycle.json"
  wait_ready
  printf '%s\t%s\t%s\n' "$cycle" "$SSH_MS" "$SURFACES_MS" | tee -a "$TIMINGS"
  delete_vm
  assert_no_leak
  VM_ID=
done

node - "$TIMINGS" <<'NODE'
const fs = require('fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').slice(1).map((line) => line.split('\t').map(Number));
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
}
const ssh = rows.map((row) => row[1]);
const surfaces = rows.map((row) => row[2]);
console.log(`percentiles request_to_ssh_ms p50=${percentile(ssh, .5)} p95=${percentile(ssh, .95)} max=${Math.max(...ssh)}`);
console.log(`percentiles request_to_surfaces_ms p50=${percentile(surfaces, .5)} p95=${percentile(surfaces, .95)} max=${Math.max(...surfaces)}`);
NODE

final_capacity=$(auth_curl "http://$HOST:$API_PORT/v1/capacity")
final_vms=$(auth_curl "http://$HOST:$API_PORT/v1/vms")
echo "final_capacity=$final_capacity"
echo "final_vms=$final_vms"
jq -e '.vm_count == 0 and .used_cpu == 0 and .used_mem_mb == 0' <<<"$final_capacity" >/dev/null
jq -e 'length == 0' <<<"$final_vms" >/dev/null
echo "ten_cycle_leak_audit=clean"
