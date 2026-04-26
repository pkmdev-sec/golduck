#!/usr/bin/env python3
"""golduck skill — list / run skills.

Skills live in $GOLDUCK_HOME/skills/<name>.json (same JSON shape as droidx skills).

Usage:
  golduck skill list
  golduck skill run <name> [-k=v ...]
  golduck skill show <name>
"""
from __future__ import annotations
import json, os, sys, argparse, pathlib, subprocess, time

GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
SKILLS = GOLDUCK_HOME / "skills"
RLM_SERVER = pathlib.Path(os.environ.get("DROIDX_RLM_DIR", "")) / "server.mjs" if os.environ.get("DROIDX_RLM_DIR") else None
NODE = os.environ.get("NODE_BIN","node")

def list_skills():
    out = []
    if SKILLS.exists():
        for f in sorted(SKILLS.glob("*.json")):
            try: out.append({"name": f.stem, "path": str(f)})
            except: pass
    # also list droidx builtin skills via MCP (best effort)
    return out

def show_skill(name):
    p = SKILLS / f"{name}.json"
    if not p.exists(): print(f"skill not found: {name}", file=sys.stderr); sys.exit(2)
    print(p.read_text())

def run_skill(name, kv):
    args = {"name": name, "arguments": dict(kv)}
    # reuse MCP client
    if not RLM_SERVER or not RLM_SERVER.exists():
        print(json.dumps({"error": "rlm_server_missing"})); return
    proc = subprocess.Popen(
        [NODE, str(RLM_SERVER)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1, env=dict(os.environ),
    )
    frames = [
        {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"golduck-skill","version":"1"}}},
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"skill_invoke","arguments":args}},
    ]
    for f in frames:
        proc.stdin.write(json.dumps(f) + "\n"); proc.stdin.flush(); time.sleep(0.05)
    time.sleep(60)
    proc.stdin.close()
    try: out, _ = proc.communicate(timeout=15)
    except: out = ""
    for line in (out or "").splitlines():
        try: o = json.loads(line)
        except: continue
        if o.get("id") == 2:
            r = o.get("result") or {}
            txt = (r.get("content") or [{}])[0].get("text", "")
            print(txt)
            return
    print(json.dumps({"error": "no_result"}))

def main():
    if len(sys.argv) < 2: print("usage: golduck skill list|run|show"); sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "list":
        for s in list_skills(): print(s["name"])
    elif cmd == "show":
        show_skill(sys.argv[2])
    elif cmd == "run":
        name = sys.argv[2]
        kv = {}
        for arg in sys.argv[3:]:
            if "=" in arg:
                k,v = arg.split("=",1); kv[k.lstrip("-")] = v
        run_skill(name, kv)
    else:
        print("unknown subcommand", cmd); sys.exit(2)

if __name__ == "__main__":
    main()
