#!/usr/bin/env python3
"""golduck hooks — manage user hook scripts.

Hook script filenames determine when they run:
  pre_request_<name>     before sending to /v1/messages (stdin = request body)
  post_response_<name>   after a completed response (stdin = response body)
  on_tool_<name>         per tool call (stdin = {tool, args})

Scripts live in $GOLDUCK_HOME/hooks/ and must be executable. stdin→stdout
style; anything on stdout replaces/augments the request per the hook
contract (see droidx hooks README).

Subcommands:
  list                   list installed hooks
  run <event> <json>     pipe <json> to every matching hook, print stdout
  install <event> <file> copy <file> into hooks/ with a conforming name
"""
from __future__ import annotations
import json, os, sys, pathlib, subprocess, shutil

GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
HOOKS = GOLDUCK_HOME / "hooks"
HOOKS.mkdir(parents=True, exist_ok=True)

def list_hooks():
    for f in sorted(HOOKS.iterdir()):
        if f.is_file() and os.access(f, os.X_OK):
            print(f"  {f.name}")

def run_hooks(event, payload):
    prefix = {"pre_request":"pre_request_","post_response":"post_response_","on_tool":"on_tool_"}[event]
    ran = 0
    for f in sorted(HOOKS.iterdir()):
        if not f.name.startswith(prefix) or not os.access(f, os.X_OK): continue
        try:
            r = subprocess.run([str(f)], input=payload, capture_output=True, text=True, timeout=20)
            print(f"# {f.name} exit={r.returncode}")
            if r.stdout.strip(): print(r.stdout)
            if r.stderr.strip(): print(r.stderr, file=sys.stderr)
            ran += 1
        except Exception as e:
            print(f"# {f.name} ERROR: {e}", file=sys.stderr)
    print(f"# [{ran} hooks ran]")

def install(event, src_path):
    src = pathlib.Path(src_path)
    if not src.is_file(): print("not a file:", src); sys.exit(2)
    dst = HOOKS / f"{event}_{src.stem}"
    shutil.copy2(src, dst); os.chmod(dst, 0o755)
    print("installed", dst)

def main():
    if len(sys.argv) < 2: print(__doc__); sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "list": list_hooks()
    elif cmd == "run": run_hooks(sys.argv[2], sys.argv[3] if len(sys.argv)>3 else "{}")
    elif cmd == "install": install(sys.argv[2], sys.argv[3])
    else: print("unknown", cmd); sys.exit(2)

if __name__ == "__main__":
    main()
