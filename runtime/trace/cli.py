#!/usr/bin/env python3
"""golduck trace — render the JSONL trace in a human-readable stream.

Usage:
  golduck trace                 # print current trace
  golduck trace --follow        # tail -f
  golduck trace --since 60s     # show only events newer than 60s
  golduck trace --runs          # list recent run_ids
"""
from __future__ import annotations
import json, os, sys, time, pathlib, argparse

GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
TRACES = GOLDUCK_HOME / "traces"

GRN="\033[32m"; RED="\033[31m"; YLW="\033[33m"; BLU="\033[34m"; CYN="\033[36m"; MAG="\033[35m"; DIM="\033[2m"; RST="\033[0m"; BOLD="\033[1m"

EVENT_COLORS = {
    "trace.open":   DIM,
    "trace.close":  DIM,
    "run.start":    BOLD + MAG,
    "run.exit":     BOLD,
    "route.decision": BLU,
    "gate.blocked": RED,
    "gate.prelude.ok": GRN,
    "verify.start": CYN,
    "verify.exit":  CYN,
    "verify.issue": YLW,
    "reflect.start": MAG,
    "reflect.exit":  MAG,
    "span.enter":   DIM,
    "span.exit":    DIM,
}

def fmt(ev):
    name = ev.get("name") or ev.get("kind") or "?"
    ts = ev.get("ts","").replace("T"," ").split(".")[0]
    color = EVENT_COLORS.get(name, "")
    extra_keys = [k for k in ev.keys() if k not in ("ts","run_id","kind","name")]
    extra = " ".join(f"{DIM}{k}={RST}{_trunc(ev[k])}" for k in extra_keys[:8])
    rid = (ev.get("run_id") or "-")[:8]
    return f"{DIM}{ts}{RST} {CYN}{rid}{RST} {color}{name:22s}{RST} {extra}"

def _trunc(v, n=80):
    s = json.dumps(v, default=str) if not isinstance(v, str) else v
    if len(s) > n: return s[:n-3] + "..."
    return s

def resolve_trace_file(explicit=None):
    if explicit: return pathlib.Path(explicit)
    cur = TRACES / "current.jsonl"
    if cur.exists(): return cur
    # newest jsonl
    files = sorted(TRACES.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True) if TRACES.exists() else []
    return files[0] if files else None

def main():
    ap = argparse.ArgumentParser(prog="golduck trace")
    ap.add_argument("--follow","-f", action="store_true")
    ap.add_argument("--since", type=str, default=None, help="e.g. 60s, 5m, 1h")
    ap.add_argument("--file", type=str, default=None)
    ap.add_argument("--runs", action="store_true")
    ap.add_argument("--json", action="store_true", help="raw JSON passthrough")
    ap.add_argument("--tail", type=int, default=0, help="only show last N events")
    ap.add_argument("--quiet", action="store_true", help="hide span.enter/exit")
    a = ap.parse_args()

    if a.runs:
        if TRACES.exists():
            for f in sorted(TRACES.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
                print(f"{DIM}{f.name}{RST}  {f.stat().st_size} bytes  {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(f.stat().st_mtime))}")
        return

    f = resolve_trace_file(a.file)
    if not f or not f.exists():
        print(f"{YLW}no trace file found ({f}){RST}", file=sys.stderr); return
    def should_show(ev):
        if a.quiet and ev.get("name") in ("span.enter", "span.exit"):
            return False
        return True
    try:
        if a.tail and not a.follow:
            lines = open(f, "r").read().splitlines()
            shown = []
            for line in lines:
                line = line.strip()
                if not line: continue
                try: ev = json.loads(line)
                except: ev = None
                if ev and not should_show(ev): continue
                shown.append((ev, line))
            for ev, line in shown[-a.tail:]:
                if a.json: print(line)
                elif ev: print(fmt(ev))
                else: print(line)
            return
        with open(f, "r") as fh:
            if a.follow: fh.seek(0, 2)
            while True:
                line = fh.readline()
                if not line:
                    if a.follow: time.sleep(0.2); continue
                    break
                line = line.strip()
                if not line: continue
                if a.json: print(line); continue
                try: ev = json.loads(line)
                except Exception: print(line); continue
                if not should_show(ev): continue
                print(fmt(ev))
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
