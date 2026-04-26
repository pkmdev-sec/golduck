#!/usr/bin/env python3
"""golduck memory — shared memory operations (pins, facts, journal).

Usage:
  golduck memory list
  golduck memory get <key>
  golduck memory set <key> <value>
  golduck memory search <pattern>
  golduck memory journal [--tail N]
  golduck memory lessons [--tail N]
"""
from __future__ import annotations
import json, os, sys, argparse, pathlib, time, re

GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
MEM = GOLDUCK_HOME / "memory"
MEM.mkdir(parents=True, exist_ok=True)

PINS = MEM / "pins.json"
FACTS = MEM / "facts.jsonl"
JOURNAL = MEM / "journal.jsonl"
LESSONS = MEM / "lessons.jsonl"

def load_pins():
    if PINS.exists():
        try: return json.loads(PINS.read_text())
        except: return []
    return []

def save_pins(p): PINS.write_text(json.dumps(p, indent=2))

def cmd_list():
    pins = load_pins()
    for p in pins: print(f"{p['key']:40s} {p['value'][:80]}")
    print(f"\n[total pins: {len(pins)}]")

def cmd_get(key):
    for p in load_pins():
        if p["key"] == key: print(p["value"]); return
    sys.exit(1)

def cmd_set(key, value):
    pins = [p for p in load_pins() if p["key"] != key]
    pins.append({"key": key, "value": value, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    save_pins(pins)
    print(f"pinned: {key}")

def cmd_search(pattern):
    pat = re.compile(pattern, re.IGNORECASE)
    for p in load_pins():
        if pat.search(p["key"]) or pat.search(p["value"]):
            print(f"{p['key']:40s} {p['value'][:120]}")

def _tail(path, n):
    if not path.exists(): return
    lines = path.read_text().splitlines()[-n:]
    for l in lines:
        try: print(json.dumps(json.loads(l), indent=2))
        except: print(l)

def main():
    if len(sys.argv) < 2: print(__doc__); sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "list": cmd_list()
    elif cmd == "get": cmd_get(sys.argv[2])
    elif cmd == "set": cmd_set(sys.argv[2], " ".join(sys.argv[3:]))
    elif cmd == "search": cmd_search(sys.argv[2])
    elif cmd == "journal":
        n = 10
        if "--tail" in sys.argv: n = int(sys.argv[sys.argv.index("--tail")+1])
        _tail(JOURNAL, n)
    elif cmd == "lessons":
        n = 10
        if "--tail" in sys.argv: n = int(sys.argv[sys.argv.index("--tail")+1])
        _tail(LESSONS, n)
    else: print("unknown", cmd); sys.exit(2)

if __name__ == "__main__":
    main()
