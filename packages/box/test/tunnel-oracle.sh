#!/usr/bin/env bash
# tunnel-oracle.sh — put a REAL Cloudflare tunnel through the box under test,
# and measure its liveness from outside while the load matrix runs.
#
# WHY: the failure that started this work was a workspace stuck "connecting" —
# cloudflared alive but stalled, invisible to every in-box probe. The only
# honest oracle for that failure is an HTTP request that enters through the
# Cloudflare edge and exits through the box's own cloudflared into its
# gateway, measured from a machine that is not under load. Any response code
# proves the path (a 401 from the gateway is still a live tunnel); only a
# timeout or a transport error is a dead one.
#
# Resources touched: ONE cfd_tunnel and ONE DNS record, both named
# oomtest-<run-id>, on the canary Cloudflare account — never the client prod
# account. `teardown` removes both; both are also safe to remove by name.
#
#   create <role>   make tunnel+DNS, install tokens into the box on <role>
#   poll <log>      2 Hz liveness probe, appends TSV until killed
#   teardown        delete the DNS record and the tunnel
set -Eeuo pipefail

readonly ACCOUNT=53a144fad4e15ca51c32da9b9fe25d4a  # canary; prod is out of reach by design
readonly CF=https://api.cloudflare.com/client/v4
LAB_STATE=${LAB_STATE:-/tmp/blitz-lab}
state="$LAB_STATE/tunnel"

log() { printf '[oracle %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[oracle] FATAL: %s\n' "$*" >&2; exit 1; }

cf() {
  local method=$1 path=$2
  shift 2
  curl --silent --show-error --fail-with-body \
    --header "Authorization: Bearer $CF_TUNNEL_API_TOKEN" \
    --header "Content-Type: application/json" \
    --request "$method" "$CF$path" "$@"
}

cmd_create() {
  local role=${1:?create needs a lab role}
  : "${CF_TUNNEL_API_TOKEN:?}" "${CF_TUNNEL_ZONE:?}" "${CF_TUNNEL_ZONE_ID:?}"
  mkdir -p "$state"
  local run_id name hostname
  run_id=$(cat "$LAB_STATE/run-id")
  name="oomtest-$run_id"
  hostname="$name.$CF_TUNNEL_ZONE"

  log "creating tunnel $name"
  cf POST "/accounts/$ACCOUNT/cfd_tunnel" \
    --data "{\"name\":\"$name\",\"config_src\":\"cloudflare\"}" >"$state/create.json"
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"]["id"])' \
    "$state/create.json" >"$state/id"
  local tunnel_id
  tunnel_id=$(cat "$state/id")

  log "ingress -> http://127.0.0.1:7445 (the box gateway)"
  cf PUT "/accounts/$ACCOUNT/cfd_tunnel/$tunnel_id/configurations" \
    --data "{\"config\":{\"ingress\":[{\"hostname\":\"$hostname\",\"service\":\"http://127.0.0.1:7445\"},{\"service\":\"http_status:404\"}]}}" >/dev/null

  log "DNS $hostname -> $tunnel_id.cfargotunnel.com"
  cf POST "/zones/$CF_TUNNEL_ZONE_ID/dns_records" \
    --data "{\"type\":\"CNAME\",\"name\":\"$hostname\",\"content\":\"$tunnel_id.cfargotunnel.com\",\"proxied\":true}" >"$state/dns.json"
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["result"]["id"])' \
    "$state/dns.json" >"$state/dns"
  printf '%s\n' "$hostname" >"$state/hostname"

  # The box's cloudflared service waits for BOTH files, then runs. The webapp
  # token only feeds gateway ticket auth; a placeholder yields 401s, and a 401
  # is a full round trip through edge, tunnel, and gateway — exactly the
  # liveness signal this oracle wants.
  local token
  token=$(cf GET "/accounts/$ACCOUNT/cfd_tunnel/$tunnel_id/token" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])')
  "$(dirname "$0")/hetzner-load-lab.sh" vm "$role" \
    "printf '%s' '$token' >/var/lib/blitz/tunnel-token
printf 'oracle-placeholder' >/var/lib/blitz/webapp-token
chown 1000:1000 /var/lib/blitz/tunnel-token /var/lib/blitz/webapp-token
chmod 0600 /var/lib/blitz/tunnel-token /var/lib/blitz/webapp-token
echo tokens installed"
  rm -f "$state/create.json" "$state/dns.json"

  log "waiting for the tunnel to answer"
  local i code
  for i in $(seq 1 36); do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "https://$hostname/" 2>/dev/null) || code=000
    case "$code" in
      000 | "") sleep 5 ;;
      *)
        log "tunnel is live (HTTP $code)"
        return 0
        ;;
    esac
  done
  die "the tunnel never answered"
}

cmd_poll() {
  local out=${1:?poll needs an output file}
  local hostname
  hostname=$(cat "$state/hostname")
  [ -f "$out" ] || printf 'epoch_ms\thttp_code\ttotal_s\n' >"$out"
  log "polling https://$hostname/ at 2 Hz into $out"
  while true; do
    local now code
    now=$(date +%s%3N)
    if ! code=$(curl -s -o /dev/null -m 4 -w '%{http_code}\t%{time_total}' "https://$hostname/" 2>/dev/null); then
      code=$(printf '000\t-')
    fi
    printf '%s\t%s\n' "$now" "$code" >>"$out"
    sleep 0.5
  done
}

cmd_teardown() {
  : "${CF_TUNNEL_API_TOKEN:?}" "${CF_TUNNEL_ZONE_ID:?}"
  if [ -s "$state/dns" ]; then
    log "deleting DNS record $(cat "$state/dns")"
    cf DELETE "/zones/$CF_TUNNEL_ZONE_ID/dns_records/$(cat "$state/dns")" >/dev/null || log "dns delete failed"
  fi
  if [ -s "$state/id" ]; then
    log "deleting tunnel $(cat "$state/id")"
    cf DELETE "/accounts/$ACCOUNT/cfd_tunnel/$(cat "$state/id")?cascade=true" >/dev/null || log "tunnel delete failed"
  fi
  rm -rf "$state"
  log "tunnel teardown complete"
}

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  poll) shift; cmd_poll "$@" ;;
  teardown) cmd_teardown ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
