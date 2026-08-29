#!/usr/bin/env bash
# memory-load.sh — squeeze a running box and record whether it stayed reachable.
#
# Runs ON the VM that hosts the box container, not inside it. Three reasons
# that matters, and each one is a measurement the previous investigation could
# not make:
#
#   1. THE ORACLE MUST NOT BE A VICTIM. A probe inside the box competes for the
#      memory it is measuring, so a stalled probe cannot be told apart from a
#      stalled box. The probe here opens the box's published SSH port from the
#      host every 250 ms and records the latency.
#   2. cgroup STATE IS READ FROM THE HOST cgroupfs, never through `docker
#      exec`. An exec allocates, and it may itself be refused once the boundary
#      is up — the sampler must not depend on the thing under test.
#   3. LOAD ARRIVES OVER SSH, which is the real path a member's build takes,
#      and which lands in the per-session leaf the boundary creates.
#
# The load generators use python3 and dd only, both already in the box image.
# That is deliberate: the baseline run and the treatment run must execute
# byte-identical load, and the baseline is the SAME image with the boundary
# switched off (BLITZ_CG_ENABLE=0) rather than an older build. Comparing two
# images would confuse a cgroup effect with a build difference.
set -Eeuo pipefail

container=${BOX_CONTAINER:-blitz-box}
ssh_key=${BOX_SSH_KEY:-/root/box_key}
# The box's sshd, as published on the VM. The lab maps it to 2222 because the
# VM's own root sshd keeps 22 (production does the inverse: host to 2222).
box_port=${BOX_SSH_PORT:-2222}
out_dir=${OUT_DIR:-/var/log/blitz-load}
scenario=${1:?usage: memory-load.sh <l1|l2|l3|l4|l5|l6|l7|l8|all> [seconds]}
duration=${2:-120}

mkdir -p "$out_dir"

box_ssh() {
  ssh -p "$box_port" -i "$ssh_key" -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 blitz@127.0.0.1 "$@"
}

# ---- where the box's cgroups live on this host --------------------------
box_cgroup_root() {
  local id
  id=$(docker inspect --format '{{.Id}}' "$container")
  for candidate in \
    "/sys/fs/cgroup/system.slice/docker-$id.scope" \
    "/sys/fs/cgroup/docker/$id"; do
    [ -d "$candidate" ] && { printf '%s' "$candidate"; return 0; }
  done
  # Last resort: ask the kernel where PID 1 of the container actually is.
  local pid rel
  pid=$(docker inspect --format '{{.State.Pid}}' "$container")
  rel=$(sed -n 's|^0::||p' "/proc/$pid/cgroup")
  printf '/sys/fs/cgroup%s' "$rel"
}

# ---- the oracle: can a user still reach this box? -----------------------
start_probe() {
  local log=$1
  python3 - "$log" "$box_port" <<'PROBE' >/dev/null 2>&1 &
import socket, sys, time
log = open(sys.argv[1], "w", buffering=1)
log.write("epoch_ms\tok\tlatency_ms\n")
while True:
    start = time.time()
    ok = 0
    try:
        s = socket.create_connection(("127.0.0.1", int(sys.argv[2])), timeout=2.0)
        s.recv(64)          # the SSH banner proves sshd is scheduled, not just bound
        ok = 1
        s.close()
    except Exception:
        ok = 0
    now = time.time()
    log.write(f"{int(now*1000)}\t{ok}\t{int((now-start)*1000)}\n")
    time.sleep(max(0.0, 0.25 - (now - start)))
PROBE
  printf '%s' $!
}

# ---- the sampler: cgroup accounting, straight from the host -------------
start_sampler() {
  local root=$1 log=$2
  # Same stdout-detach as start_probe: the subshell must not hold the
  # command-substitution pipe open, or the caller blocks forever.
  (
    printf 'epoch_ms\tcgroup\tcurrent\tswap\thigh_events\tmax_events\toom\toom_kill\n' >"$log"
    while true; do
      local now
      now=$(date +%s%3N)
      for cg in "$root" "$root/blitz-system.slice" "$root/blitz-user.slice" "$root"/blitz-user.slice/*; do
        [ -r "$cg/memory.current" ] || continue
        local name cur swap ev
        name=${cg#"$root"}
        cur=$(cat "$cg/memory.current" 2>/dev/null || echo 0)
        swap=$(cat "$cg/memory.swap.current" 2>/dev/null || echo 0)
        ev=$(cat "$cg/memory.events" 2>/dev/null || echo "")
        printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "${name:-/}" "$cur" "$swap" \
          "$(awk '/^high /{print $2}' <<<"$ev")" \
          "$(awk '/^max /{print $2}' <<<"$ev")" \
          "$(awk '/^oom /{print $2}' <<<"$ev")" \
          "$(awk '/^oom_kill /{print $2}' <<<"$ev")" >>"$log"
      done
      printf '%s\tHOST_PSI\t%s\t-\t-\t-\t-\t-\n' "$now" \
        "$(awk '/^full/{print $2}' /proc/pressure/memory | tr -d 'avg10=')" >>"$log"
      sleep 1
    done
  ) >/dev/null 2>&1 &
  printf '%s' $!
}

# ---- load generators ----------------------------------------------------
# One python allocator covers every anonymous-memory shape. It touches each
# page so the kernel cannot account it lazily, which a naive bytearray does.
allocator() {
  cat <<'ALLOC'
import sys, time
target_mb, rate_mb_s, hold_s = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
chunks, held = [], 0
step = max(1, rate_mb_s // 10)
while held < target_mb:
    block = bytearray(step * 1024 * 1024)
    for off in range(0, len(block), 4096):
        block[off] = 1
    chunks.append(block)
    held += step
    time.sleep(0.1)
print(f"held {held} MB", flush=True)
time.sleep(hold_s)
ALLOC
}

run_load() {
  case "$1" in
    l1) box_ssh "python3 - 6000 500 30" <<<"$(allocator)" ;;
    l2) for i in $(seq 1 8); do box_ssh "python3 - 900 300 20" <<<"$(allocator)" & done; wait ;;
    l3) box_ssh "docker run --rm python:3-slim python -c \"
b=[]
while True: b.append(bytearray(64*1024*1024))\"" ;;
    l4) box_ssh "dd if=/dev/zero of=/workspace/.loadtest bs=1M count=20000 conv=fsync; rm -f /workspace/.loadtest" ;;
    l5) box_ssh "python3 -c \"
import os
for _ in range(5000):
    try:
        if os.fork()==0: __import__('time').sleep(60); os._exit(0)
    except OSError: break
\"" ;;
    l6) box_ssh "python3 - 4000 5 60" <<<"$(allocator)" ;;
    l7)
      box_ssh "python3 - 3000 400 40" <<<"$(allocator)" &
      for i in $(seq 1 4); do box_ssh "python3 - 700 200 30" <<<"$(allocator)" & done
      run_load l3 &
      wait
      ;;
    # THE CASE THAT KILLED THE REAL WORKSPACE. Ramp to just under the ceiling
    # and hold. No OOM fires; the box either keeps answering or it stalls.
    l8) box_ssh "python3 - $(( $(free -m | awk '/^Mem:/{print $2}') * 95 / 100 )) 200 600" <<<"$(allocator)" ;;
    # l8 with a fixed target can overshoot real availability and resolve into
    # a quick kill (measured on cx23: MemTotal*95% crosses MemAvailable and
    # the kernel kills in seconds). l9 hunts the SUSTAINED stall instead: size
    # from MemAvailable at launch, stop a sliver short, keep every page hot so
    # reclaim cannot age the set out, and creep upward slowly while a dd
    # stream keeps cache pressure on. The kill line is never quite crossed;
    # the box either keeps answering or it sits in reclaim — the state that
    # reads "connecting" in production.
    l9)
      box_ssh "nohup sh -c 'while :; do dd if=/dev/zero of=/workspace/.l9cache bs=1M count=6000 conv=fsync 2>/dev/null; rm -f /workspace/.l9cache; done' >/dev/null 2>&1 &
python3 -" <<'L9HOLD'
import time
avail_kb = 0
with open("/proc/meminfo") as f:
    for line in f:
        if line.startswith("MemAvailable:"):
            avail_kb = int(line.split()[1])
            break
target_mb = max(256, avail_kb // 1024 - 150)
chunks = []
held = 0
while held < target_mb:
    block = bytearray(32 * 1024 * 1024)
    for off in range(0, len(block), 4096):
        block[off] = 1
    chunks.append(block)
    held += 32
print(f"holding {held} MB of {avail_kb//1024} MB available", flush=True)
i = 0
while True:
    hot = chunks[i % len(chunks)]
    for off in range(0, len(hot), 4096):
        hot[off] = (hot[off] + 1) % 250
    i += 1
    if i % 24 == 0:
        creep = bytearray(4 * 1024 * 1024)
        for off in range(0, len(creep), 4096):
            creep[off] = 1
        chunks.append(creep)
    time.sleep(0.05)
L9HOLD
      ;;
    *) echo "unknown scenario: $1" >&2; return 2 ;;
  esac
}

# ---- verdict ------------------------------------------------------------
verdict() {
  local probe=$1 sample=$2 name=$3
  python3 - "$probe" "$sample" "$name" <<'VERDICT'
import sys
probe, sample, name = sys.argv[1], sys.argv[2], sys.argv[3]
rows = [l.split("\t") for l in open(probe).read().splitlines()[1:] if l]
if not rows:
    print(f"{name}\tNO DATA"); raise SystemExit(1)
stamps = [int(r[0]) for r in rows]
oks = [int(r[1]) for r in rows]
lat = [int(r[2]) for r in rows if int(r[1]) == 1]
# The stall signature: the probe loop itself stops being scheduled, so the gap
# between consecutive samples grows far beyond its 250 ms period.
gaps = [b - a for a, b in zip(stamps, stamps[1:])]
worst_gap = max(gaps) if gaps else 0
fails = len(oks) - sum(oks)
sys_kills = user_kills = 0
for line in open(sample).read().splitlines()[1:]:
    f = line.split("\t")
    if len(f) < 8 or f[7] in ("-", ""):
        continue
    if f[1] == "/blitz-system.slice":
        sys_kills = max(sys_kills, int(f[7]))
    elif f[1].startswith("/blitz-user.slice"):
        user_kills = max(user_kills, int(f[7]))
p1 = worst_gap < 2000
p2 = sys_kills == 0
p6 = fails / max(1, len(oks)) < 0.01
print(f"{name}\tworst_gap_ms={worst_gap}\tunreachable={fails}/{len(oks)}"
      f"\tp99_latency_ms={sorted(lat)[int(len(lat)*0.99)] if lat else -1}"
      f"\tsystem_oom_kills={sys_kills}\tuser_oom_kills={user_kills}"
      f"\tP1={'pass' if p1 else 'FAIL'}\tP2={'pass' if p2 else 'FAIL'}"
      f"\tP6={'pass' if p6 else 'FAIL'}")
raise SystemExit(0 if (p1 and p2 and p6) else 1)
VERDICT
}

# ---- one scenario, end to end -------------------------------------------
run_one() {
  local name=$1
  local root probe_log sample_log probe_pid sample_pid
  root=$(box_cgroup_root)
  probe_log="$out_dir/$name.probe.tsv"
  sample_log="$out_dir/$name.cgroup.tsv"
  echo "== $name : box cgroup root $root"
  probe_pid=$(start_probe "$probe_log")
  sample_pid=$(start_sampler "$root" "$sample_log")
  dmesg -C 2>/dev/null || true
  sleep 3
  timeout "$duration" bash -c "$(declare -f box_ssh allocator run_load); \
    ssh_key='$ssh_key'; box_port='$box_port'; run_load $name" >"$out_dir/$name.load.log" 2>&1 || true
  sleep 5
  kill "$probe_pid" "$sample_pid" 2>/dev/null || true
  wait "$probe_pid" "$sample_pid" 2>/dev/null || true
  # Recovery: a box that survives the squeeze must accept a NEW session.
  local recovered=no
  for _ in $(seq 1 15); do
    if box_ssh true 2>/dev/null; then recovered=yes; break; fi
    sleep 2
  done
  dmesg 2>/dev/null | grep -iE "killed process|out of memory|oom" >"$out_dir/$name.dmesg.log" || true
  printf '%s\tkernel_oom_lines=%s\n' "$name" "$(wc -l <"$out_dir/$name.dmesg.log")"
  verdict "$probe_log" "$sample_log" "$name" || true
  echo -e "$name\tP5_new_session_after=$recovered"
  # Leave the box clean for the next scenario.
  box_ssh 'pkill -u blitz -f "python3 -" || true; pkill -u blitz -f ".l9cache" || true; rm -f /workspace/.l9cache; docker rm -f $(docker ps -aq) 2>/dev/null || true' >/dev/null 2>&1 || true
  sleep 10
}

if [ "$scenario" = all ]; then
  for s in l1 l2 l3 l4 l5 l6 l7 l8; do run_one "$s"; done
else
  run_one "$scenario"
fi
