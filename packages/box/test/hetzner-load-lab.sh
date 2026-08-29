#!/usr/bin/env bash
# hetzner-load-lab.sh — drive the memory-boundary load campaign on real
# Hetzner VMs, one subcommand per step, so an orchestrator can hold the API
# key while worker agents only ever touch the servers over SSH.
#
# THIS SCRIPT TOUCHES A SHARED PROJECT. The credential reaches the one Hetzner
# project canary and client prod both live in. Every destructive call is
# therefore constrained twice — by label AND by name prefix — and teardown
# proves what it removed against an inventory captured before the run. It
# never lists servers and deletes what it finds.
#
# Subcommands that call the Hetzner API (need HETZNER_API_KEY):
#   preflight            inventory + bounds + orphan sweep; run once, first
#   create <role>        make server <role> (s1, s2, ...), wait for ssh
#   reset <role>         power-cycle a wedged server
#   teardown <role>      delete that server
#   proof                diff inventory now vs preflight; print what changed
#
# Subcommands that only ssh (safe to hand to worker agents, no key needed):
#   prepare <role>       install docker+deps, ship image+scripts to the VM
#   zram <role> <pct>    set compressed swap; 0 disables all swap
#   box <role> <mode>    (re)start the box: mode = treatment | baseline
#   assert0 <role>       prove docker exec survives the delegated boundary
#   run <role> <tag> <scenario> <secs>   one memory-load.sh scenario
#   fetch <role> <dest>  tar the VM's /var/log/blitz-load back to <dest>
#
# State lives in $LAB_STATE (default /tmp/blitz-lab): <role>/{id,ip}, key,
# run-id, inventory-before.tsv. Deliberately NO trap-based teardown: worker
# agents run for an hour against these servers, and a dying orchestrator
# shell must not delete a VM mid-run. The backstops are the explicit
# teardown, the preflight orphan sweep (age > 4h), and the 2-server cap.
set -Eeuo pipefail

readonly API=https://api.hetzner.cloud/v1
readonly PREFIX=oomtest-
readonly LABEL_VALUE=oom
readonly MAX_OWN_SERVERS=2
readonly ORPHAN_MAX_AGE_HOURS=4

LAB_STATE=${LAB_STATE:-/tmp/blitz-lab}
server_type=${LAB_SERVER_TYPE:-cx23}
location=${LAB_LOCATION:-hel1}
image_archive=${LAB_IMAGE_ARCHIVE:-/tmp/blitz-box-memtest.tgz}
script_dir=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$LAB_STATE"
[ -s "$LAB_STATE/run-id" ] || date -u +%Y%m%d-%H%M%S >"$LAB_STATE/run-id"
run_id=$(cat "$LAB_STATE/run-id")

log() { printf '[lab %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '[lab] FATAL: %s\n' "$*" >&2; exit 1; }
need_key() { : "${HETZNER_API_KEY:?this subcommand needs HETZNER_API_KEY; read it into the environment, never print it}"; }

api() {
  local method=$1 path=$2
  shift 2
  curl --silent --show-error --fail-with-body \
    --header "Authorization: Bearer $HETZNER_API_KEY" \
    --header "Content-Type: application/json" \
    --request "$method" "$API$path" "$@"
}

# ---- rails ----------------------------------------------------------------

# Nothing is deleted unless it carries BOTH our label and our name prefix. A
# server matching only one is not ours; refuse rather than guess.
deletable() {
  local name=$1 label=$2
  [ "$label" = "$LABEL_VALUE" ] || return 1
  case "$name" in "$PREFIX"*) return 0 ;; *) return 1 ;; esac
}

inventory() {
  api GET "/servers?per_page=50" | python3 -c '
import json, sys
for s in json.load(sys.stdin)["servers"]:
    print(f'"'"'{s["id"]}\t{s["name"]}\t{s.get("labels",{}).get("blitz-test","")}\t{s["created"]}'"'"')
'
}

cmd_preflight() {
  need_key
  log "reading the project inventory before touching anything"
  inventory >"$LAB_STATE/inventory-before.tsv" || die "cannot list servers"
  local total ours
  total=$(wc -l <"$LAB_STATE/inventory-before.tsv")
  ours=$(awk -F'\t' -v v="$LABEL_VALUE" '$3==v' "$LAB_STATE/inventory-before.tsv" | wc -l)
  log "project holds $total servers, $ours of them test servers"
  # Hetzner exposes no quota endpoint; this is a deliberate crowding heuristic,
  # not a real limit check. The default project quota is 25 servers; stopping
  # at 18 leaves at least 7 slots for production creates while tests run.
  [ "$total" -lt 18 ] || die "project already holds $total servers; refusing to add test load"
  # Orphans: anything of ours older than the age bound leaked from a dead run.
  local now cutoff
  now=$(date -u +%s)
  cutoff=$(( now - ORPHAN_MAX_AGE_HOURS * 3600 ))
  while IFS=$'\t' read -r id name label created; do
    deletable "$name" "$label" || continue
    local age
    age=$(date -u -d "$created" +%s 2>/dev/null || echo "$now")
    if [ "$age" -lt "$cutoff" ]; then
      log "orphan sweep: deleting $name ($id), created $created"
      api DELETE "/servers/$id" >/dev/null || log "could not delete $id"
    fi
  done <"$LAB_STATE/inventory-before.tsv"
  [ -f "$LAB_STATE/key" ] || ssh-keygen -q -t ed25519 -N '' -f "$LAB_STATE/key" -C blitz-load-lab
  log "preflight complete"
}

cmd_create() {
  need_key
  local role=${1:?create needs a role (s1, s2, ...)}
  [ -s "$LAB_STATE/inventory-before.tsv" ] || die "run preflight first"
  local existing
  existing=$(ls "$LAB_STATE" | grep -c '^s[0-9]*$' || true)
  [ "$existing" -lt "$MAX_OWN_SERVERS" ] || die "the cap is $MAX_OWN_SERVERS servers"
  local name="$PREFIX$run_id-$role"
  mkdir -p "$LAB_STATE/$role"
  python3 - "$name" "$server_type" "$location" "$(cat "$LAB_STATE/key.pub")" >"$LAB_STATE/$role/create.json" <<'BODY'
import json, sys
name, stype, loc, pubkey = sys.argv[1:5]
print(json.dumps({
    "name": name, "server_type": stype, "location": loc, "image": "ubuntu-24.04",
    "start_after_create": True,
    "labels": {"blitz-test": "oom", "blitz-run": name},
    # The chage line matters: this account enforces root password expiry, and
    # an expired password makes PAM refuse even key logins ("Password change
    # required but no TTY available"). Resetting the last-change date at boot
    # is the documented workaround for its snapshots and stock images alike.
    "user_data": "#cloud-config\ndisable_root: false\nssh_authorized_keys:\n  - " + pubkey
        + "\nruncmd:\n  - chage -d $(date +%F) root\n",
}))
BODY
  log "creating $name ($server_type @ $location)"
  api POST "/servers" --data @"$LAB_STATE/$role/create.json" >"$LAB_STATE/$role/created.json" \
    || die "server create failed; see $LAB_STATE/$role/created.json"
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]))["server"];print(d["id"])' \
    "$LAB_STATE/$role/created.json" >"$LAB_STATE/$role/id"
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]))["server"];print(d["public_net"]["ipv4"]["ip"])' \
    "$LAB_STATE/$role/created.json" >"$LAB_STATE/$role/ip"
  rm -f "$LAB_STATE/$role/create.json"
  log "created $role: id=$(cat "$LAB_STATE/$role/id") ip=$(cat "$LAB_STATE/$role/ip")"
  log "waiting for ssh on $role"
  local i
  for i in $(seq 1 60); do
    # `if`, not `&&`: under set -e a failed AND-OR list aborts the script, and
    # the first probes ALWAYS fail while the server is still booting.
    if vm "$role" true 2>/dev/null; then
      log "$role ssh is up"
      return 0
    fi
    sleep 5
  done
  die "$role never accepted ssh"
}

vm() {
  local role=$1
  shift
  ssh -i "$LAB_STATE/key" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=4 "root@$(cat "$LAB_STATE/$role/ip")" "$@"
}

cmd_prepare() {
  local role=${1:?prepare needs a role}
  [ -s "$image_archive" ] || die "no image archive at $image_archive"
  log "[$role] installing docker and deps"
  vm "$role" 'set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq docker.io python3 >/dev/null
systemctl enable --now docker >/dev/null 2>&1 || true
mkdir -p /var/lib/blitz/workspace /var/log/blitz-load /etc/blitz'
  log "[$role] shipping the box image ($(du -h "$image_archive" | cut -f1)) — no registry involved"
  vm "$role" 'gunzip | docker load >/dev/null' <"$image_archive"
  scp -q -i "$LAB_STATE/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$LAB_STATE/key" "root@$(cat "$LAB_STATE/$role/ip"):/root/box_key"
  scp -q -i "$LAB_STATE/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$script_dir/memory-load.sh" "root@$(cat "$LAB_STATE/$role/ip"):/root/memory-load.sh"
  vm "$role" 'chmod 600 /root/box_key
docker run --rm --entrypoint cat blitz-box:memtest /etc/blitz/env.defaults >/etc/blitz/env.defaults
cp /root/.ssh/authorized_keys /var/lib/blitz/authorized_key
echo prepared'
}

cmd_zram() {
  local role=${1:?zram needs a role} pct=${2:?zram needs a percent (0 disables)}
  log "[$role] zram at $pct%"
  vm "$role" "set -e
if [ '$pct' = 0 ]; then swapoff -a 2>/dev/null || true; echo 'swap off'; exit 0; fi
swapoff /dev/zram0 2>/dev/null || true
modprobe zram
kb=\$(awk '/^MemTotal:/{print \$2}' /proc/meminfo)
echo 1 >/sys/block/zram0/reset 2>/dev/null || true
echo lz4 >/sys/block/zram0/comp_algorithm 2>/dev/null || true
echo \$(( kb * 1024 / 100 * $pct )) >/sys/block/zram0/disksize
mkswap /dev/zram0 >/dev/null
swapon -p 100 /dev/zram0
sysctl -qw vm.swappiness=100 vm.page-cluster=0
free -m | sed -n '3p'"
}

# treatment = the shipped design: container ceiling + boundary + knob envs.
# baseline  = TODAY's fleet: no container limits, boundary off. The load the
# two arms run is byte-identical; only the protections differ.
cmd_box() {
  local role=${1:?box needs a role} mode=${2:?box needs treatment|baseline}
  local enable=1 limit_lines=""
  case "$mode" in
    treatment)
      limit_lines='--pids-limit 8192 --memory ${box_mem_mb}m --memory-swap $(( box_mem_mb + 2048 ))m'
      ;;
    baseline) enable=0 ;;
    *) die "mode must be treatment or baseline" ;;
  esac
  log "[$role] starting box: mode=$mode min=${LAB_SYSTEM_MIN:-384M} gap=${LAB_HIGH_GAP:-500M}"
  vm "$role" "set -e
docker rm -f blitz-box >/dev/null 2>&1 || true
mem_total_mb=\$(( \$(awk '/^MemTotal:/{print \$2}' /proc/meminfo) / 1024 ))
box_mem_mb=\$(( mem_total_mb - ${LAB_HOST_RESERVE_MB:-512} ))
docker run --detach --name blitz-box \
  --restart unless-stopped --privileged \
  $limit_lines \
  --env-file /etc/blitz/env.defaults \
  -e BLITZ_UID=1000 -e BLITZ_GID=1000 \
  -e BLITZ_CG_ENABLE=$enable \
  -e BLITZ_CG_SYSTEM_MIN=${LAB_SYSTEM_MIN:-384M} \
  -e BLITZ_CG_HIGH_GAP=${LAB_HIGH_GAP:-500M} \
  --mount type=bind,src=/var/lib/blitz,dst=/var/lib/blitz \
  --mount type=bind,src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly \
  --mount type=bind,src=/var/lib/blitz/workspace,dst=/workspace \
  -p 0.0.0.0:2222:22 blitz-box:memtest >/dev/null
echo \"box started, ceiling: \$([ '$mode' = treatment ] && echo \${box_mem_mb}m || echo none)\""
  log "[$role] waiting for the box to accept ssh"
  local i
  for i in $(seq 1 40); do
    if vm "$role" 'ssh -p 2222 -i /root/box_key -o BatchMode=yes -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null -o ConnectTimeout=4 blitz@127.0.0.1 true' 2>/dev/null; then
      log "[$role] box is up"
      return 0
    fi
    sleep 5
  done
  vm "$role" 'docker logs blitz-box 2>&1 | tail -30' || true
  die "[$role] the box never accepted ssh"
}

# ASSERTION ZERO. The boundary enables controllers on the container's own
# cgroup, and cgroup v2 forbids a cgroup that distributes controllers from
# also holding processes. `docker exec` attaches its process to some cgroup —
# WHERE decides everything: the bootstrap health loop, the box updater, and
# the smoke suite all run through exec. A nested-DinD probe could not answer
# this (its container cgroup was threaded, different semantics), so it is
# settled here on the real target before any load runs.
cmd_assert0() {
  local role=${1:?assert0 needs a role}
  log "[$role] ASSERTION 0: docker exec vs the delegated boundary"
  local out rc=0 where subtree
  # stderr stays OUT of the capture: ssh prints host-key warnings there, and a
  # warning is not a verdict.
  out=$(vm "$role" 'docker exec blitz-box echo exec-ok' 2>/dev/null) || rc=$?
  where=$(vm "$role" 'docker exec blitz-box sh -c "sed -n \"s|^0::||p\" /proc/self/cgroup"' 2>/dev/null || echo unavailable)
  subtree=$(vm "$role" 'docker exec blitz-box cat /sys/fs/cgroup/cgroup.subtree_control' 2>/dev/null || echo unavailable)
  printf '  exec rc=%s out=[%s]\n  exec lands in: [%s]\n  container-root subtree_control: [%s]\n' \
    "$rc" "$out" "$where" "$subtree"
  if [ "$rc" -ne 0 ] || [ "$out" != exec-ok ]; then
    log "ASSERTION 0 FAILED — the boundary breaks docker exec. Stop; do not run load."
    return 1
  fi
  vm "$role" 'docker exec blitz-box /usr/local/bin/blitz-cgroup report' | sed 's/^/  /'
  log "ASSERTION 0 PASSED"
}

cmd_run() {
  local role=${1:?run needs a role} tag=${2:?run needs a tag} scenario=${3:?run needs a scenario} secs=${4:-120}
  vm "$role" "mkdir -p /var/log/blitz-load/$tag
OUT_DIR=/var/log/blitz-load/$tag BOX_SSH_KEY=/root/box_key bash /root/memory-load.sh $scenario $secs" \
    2>&1 | sed "s/^/[$role:$tag] /"
}

cmd_fetch() {
  local role=${1:?fetch needs a role} dest=${2:?fetch needs a destination dir}
  mkdir -p "$dest"
  vm "$role" 'tar -C /var/log -czf - blitz-load' >"$dest/$role-results.tgz"
  tar -C "$dest" -xzf "$dest/$role-results.tgz"
  log "[$role] results under $dest/blitz-load"
}

cmd_reset() {
  need_key
  local role=${1:?reset needs a role}
  local id
  id=$(cat "$LAB_STATE/$role/id")
  log "[$role] power reset (id $id)"
  api POST "/servers/$id/actions/reset" >/dev/null
}

cmd_teardown() {
  need_key
  local role=${1:?teardown needs a role}
  local id
  id=$(cat "$LAB_STATE/$role/id" 2>/dev/null) || die "no state for $role"
  # Re-verify against the live API before deleting: the id must still name a
  # server that carries our label AND prefix. State files are not trusted.
  local live name label
  live=$(api GET "/servers/$id" 2>/dev/null) || { log "[$role] $id is already gone"; rm -rf "${LAB_STATE:?}/$role"; return 0; }
  name=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["server"]["name"])' "$live")
  label=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["server"].get("labels",{}).get("blitz-test",""))' "$live")
  deletable "$name" "$label" || die "server $id ($name) does not match the test label+prefix; NOT deleting"
  log "[$role] deleting $name ($id)"
  api DELETE "/servers/$id" >/dev/null
  rm -rf "${LAB_STATE:?}/$role"
}

cmd_proof() {
  need_key
  [ -s "$LAB_STATE/inventory-before.tsv" ] || die "no pre-run inventory"
  inventory >"$LAB_STATE/inventory-after.tsv"
  local removed added
  removed=$(comm -23 <(cut -f1 "$LAB_STATE/inventory-before.tsv" | sort) \
                    <(cut -f1 "$LAB_STATE/inventory-after.tsv" | sort))
  added=$(comm -13 <(cut -f1 "$LAB_STATE/inventory-before.tsv" | sort) \
                   <(cut -f1 "$LAB_STATE/inventory-after.tsv" | sort))
  if [ -n "$removed" ]; then
    log "ALERT: servers that predate the run are GONE: $removed"
    return 1
  fi
  log "proof: every pre-existing server is still present"
  [ -z "$added" ] || log "servers added by (or during) the run and still up: $added"
}

cmd=${1:-}
shift || true
case "$cmd" in
  preflight) cmd_preflight "$@" ;;
  create) cmd_create "$@" ;;
  prepare) cmd_prepare "$@" ;;
  zram) cmd_zram "$@" ;;
  box) cmd_box "$@" ;;
  assert0) cmd_assert0 "$@" ;;
  run) cmd_run "$@" ;;
  fetch) cmd_fetch "$@" ;;
  reset) cmd_reset "$@" ;;
  teardown) cmd_teardown "$@" ;;
  proof) cmd_proof "$@" ;;
  vm) role=$1; shift; vm "$role" "$@" ;;
  *) sed -n '2,40p' "$0"; exit 2 ;;
esac
