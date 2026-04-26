#!/usr/bin/env python3
"""golduck reflect runner — post-run introspection that feeds memory.

Extracts concrete wins from the completed run (files touched, commands
run, error→success transitions) and writes a dense one-paragraph entry
to $GOLDUCK_HOME/memory/journal.jsonl. If the same pattern appears N≥3
times, it mints a candidate skill (requires user confirmation later).
"""
from __future__ import annotations
import json, os, pathlib, argparse, time

GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
JOURNAL = GOLDUCK_HOME / "memory" / "journal.jsonl"
TRACES  = GOLDUCK_HOME / "traces"

def load_trace(rid=None):
    # Newest trace if no run id given.
    files = sorted(TRACES.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True) if TRACES.exists() else []
    if not files: return []
    return [json.loads(l) for l in files[0].read_text().splitlines() if l.strip()]

def summarize(events):
    files_touched = set()
    tools_used = []
    errors = []
    for ev in events:
        if ev.get("name") == "tool.call":
            tools_used.append(ev.get("tool"))
            if "path" in ev: files_touched.add(ev["path"])
        if ev.get("kind") == "error" or ev.get("name","").endswith(".error"):
            errors.append(ev.get("message") or ev.get("error") or "unknown")
    return {
        "files_touched": sorted(files_touched),
        "tools_used": list({t for t in tools_used if t}),
        "errors": errors[:5],
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--depth", default="shallow")
    a = ap.parse_args()

    events = load_trace()
    if not events:
        print(json.dumps({"skipped": True, "reason": "no_trace"}))
        return

    summary = summarize(events)
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "run_id": os.environ.get("GOLDUCK_RUN_ID"),
        "depth": a.depth,
        "files_touched": summary["files_touched"][:10],
        "tools_used": summary["tools_used"],
        "errors": summary["errors"],
    }
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    with open(JOURNAL, "a") as f: f.write(json.dumps(entry) + "\n")

    # Trace event.
    try:
        tf = os.environ.get("GOLDUCK_TRACE_FILE")
        if tf:
            with open(tf, "a") as f:
                f.write(json.dumps({
                    "ts": entry["ts"], "kind": "event", "name": "reflect.summary",
                    "run_id": entry["run_id"], **summary,
                }) + "\n")
    except Exception:
        pass

    print(json.dumps(entry))

if __name__ == "__main__":
    main()
