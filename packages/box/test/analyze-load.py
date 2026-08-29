#!/usr/bin/env python3
"""Turn a load-campaign results tree into one verdict table.

Inputs: <results-dir> holding blitz-load/<tag>/<scenario>.{probe.tsv,cgroup.tsv,dmesg.log}
and optionally a tunnel poll TSV with campaign-wide timestamps plus a windows
TSV (tag, scenario, start_ms, end_ms) mapping scenarios to time ranges.

The probe gap is the primary signal: the probe loop runs at 4 Hz from the VM
host, so a gap far above 250 ms means the HOST stalled; a failed connect with
no gap means only the box stalled. The two together separate "VM in reclaim"
from "box killed" without guessing.
"""
import json
import pathlib
import sys

SCENARIOS = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"]


def read_tsv(path, header=True):
    """header=True skips line one. The windows file carries no header row —
    reading it with the default silently ate the first scenario's window."""
    rows = []
    try:
        lines = path.read_text().splitlines()
        for line in lines[1:] if header else lines:
            if line:
                rows.append(line.split("\t"))
    except OSError:
        pass
    return rows


def analyze_one(tag_dir, scenario):
    out = {"scenario": scenario}
    probe = read_tsv(tag_dir / f"{scenario}.probe.tsv")
    if probe:
        stamps = [int(r[0]) for r in probe]
        oks = [int(r[1]) for r in probe]
        lats = sorted(int(r[2]) for r in probe if r[1] == "1")
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        out["samples"] = len(probe)
        out["worst_gap_ms"] = max(gaps) if gaps else 0
        out["unreachable"] = len(oks) - sum(oks)
        out["p99_ms"] = lats[int(len(lats) * 0.99)] if lats else -1
    kills = {"system": 0, "user": 0, "high_throttles": 0}
    for f in read_tsv(tag_dir / f"{scenario}.cgroup.tsv"):
        if len(f) < 8 or f[7] in ("-", ""):
            continue
        if f[1] == "/blitz-system.slice":
            kills["system"] = max(kills["system"], int(f[7]))
        elif f[1].startswith("/blitz-user.slice"):
            kills["user"] = max(kills["user"], int(f[7]))
            if f[4] not in ("-", ""):
                kills["high_throttles"] = max(kills["high_throttles"], int(f[4]))
    out.update(kills)
    dmesg = tag_dir / f"{scenario}.dmesg.log"
    out["kernel_oom_lines"] = (
        len(dmesg.read_text().splitlines()) if dmesg.exists() else 0
    )
    if "worst_gap_ms" in out:
        out["P1_no_stall"] = out["worst_gap_ms"] < 2000
        out["P2_system_intact"] = out["system"] == 0
        out["P6_reachable"] = out["unreachable"] / max(1, out["samples"]) < 0.01
    return out


def tunnel_slice(poll_rows, start_ms, end_ms):
    inside = [r for r in poll_rows if start_ms <= int(r[0]) <= end_ms]
    if not inside:
        return None
    dead = [r for r in inside if r[1] == "000"]
    stamps = [int(r[0]) for r in inside]
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    return {
        "polls": len(inside),
        "dead": len(dead),
        "dead_pct": round(100 * len(dead) / len(inside), 2),
        "worst_poll_gap_ms": max(gaps) if gaps else 0,
    }


def main():
    root = pathlib.Path(sys.argv[1])
    poll_rows = []
    windows = []
    if len(sys.argv) > 2:
        poll_rows = read_tsv(pathlib.Path(sys.argv[2]))
    if len(sys.argv) > 3:
        windows = read_tsv(pathlib.Path(sys.argv[3]), header=False)
    report = {}
    for tag_dir in sorted((root / "blitz-load").iterdir()):
        if not tag_dir.is_dir():
            continue
        rows = []
        for scenario in SCENARIOS:
            if (tag_dir / f"{scenario}.probe.tsv").exists():
                rows.append(analyze_one(tag_dir, scenario))
        report[tag_dir.name] = rows
    for w in windows:
        tag, scenario, start_ms, end_ms = w[0], w[1], int(w[2]), int(w[3])
        t = tunnel_slice(poll_rows, start_ms, end_ms)
        if t is None:
            continue
        for row in report.get(tag, []):
            if row["scenario"] == scenario:
                row["tunnel"] = t
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
