#!/usr/bin/env python3
"""golduck verify runner.

Driven by runtime/verify/schedule.mjs. Calls droidx-rlm MCP's rlm_verify
tool via a single-shot stdio client, captures the verdict, and writes:

  - an `verify.result` trace event with {verdict, confidence, issues[]}
  - a `lessons/<date>.md` entry in memory when verdict=="revise"
  - a session pin if the same issue recurs (recurring-issue detection)

Outputs the JSON verdict to stdout on success.
"""
from __future__ import annotations
import json, os, sys, argparse, subprocess, pathlib, time, uuid

GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
RLM_SERVER = pathlib.Path(os.environ.get("DROIDX_RLM_DIR", "")) / "server.mjs" if os.environ.get("DROIDX_RLM_DIR") else None
NODE = os.environ.get("NODE_BIN", "node")

def call_mcp(tool, args, wait_sec=60):
    """Tiny stdio MCP client: initialize → tools/call → read response."""
    if not RLM_SERVER or not RLM_SERVER.exists():
        return {"error": "rlm_server_missing"}
    proc = subprocess.Popen(
        [NODE, str(RLM_SERVER)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1, env=dict(os.environ),
    )
    frames = [
        {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"golduck-verify","version":"1"}}},
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":args}},
    ]
    for f in frames:
        proc.stdin.write(json.dumps(f) + "\n"); proc.stdin.flush(); time.sleep(0.05)
    time.sleep(wait_sec)
    proc.stdin.close()
    try: out, _ = proc.communicate(timeout=15)
    except Exception: out = ""
    for line in (out or "").splitlines():
        try: o = json.loads(line)
        except Exception: continue
        if o.get("id") == 2:
            r = o.get("result") or {}
            txt = (r.get("content") or [{}])[0].get("text", "")
            try: return json.loads(txt)
            except Exception: return {"raw": txt, "isError": r.get("isError", False)}
    return {"error": "no_result"}

def extract_last_assistant(trace_file):
    """Pull the last assistant_text event from a trace.jsonl."""
    if not trace_file or not pathlib.Path(trace_file).exists(): return None
    for line in reversed(pathlib.Path(trace_file).read_text().splitlines()):
        try: ev = json.loads(line)
        except: continue
        if ev.get("kind") == "assistant_text" or ev.get("name") == "assistant.final":
            return ev.get("text") or ev.get("content")
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--answer-file", required=True)
    ap.add_argument("--question", required=True)
    a = ap.parse_args()

    answer = extract_last_assistant(a.answer_file)
    if not answer:
        print(json.dumps({"skipped": True, "reason": "no_assistant_text"}))
        return

    verdict = call_mcp("rlm_verify", {
        "question": a.question[:1500],
        "answer":   answer[:12000],
    })

    # Trace event.
    trace_line = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": "event",
        "name": "verify.result",
        "run_id": os.environ.get("GOLDUCK_RUN_ID"),
        "verdict": verdict.get("verdict", "unknown"),
        "confidence": verdict.get("confidence"),
        "issues": (verdict.get("issues") or [])[:5],
    }
    try:
        tf = os.environ.get("GOLDUCK_TRACE_FILE") or a.answer_file
        pathlib.Path(tf).parent.mkdir(parents=True, exist_ok=True)
        with open(tf, "a") as f: f.write(json.dumps(trace_line) + "\n")
    except Exception: pass

    # Record lessons if revision requested.
    if verdict.get("verdict") == "revise":
        lessons = GOLDUCK_HOME / "memory" / "lessons.jsonl"
        lessons.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts": trace_line["ts"],
            "question": a.question[:500],
            "issues": verdict.get("issues", [])[:5],
            "suggested_fix": verdict.get("suggested_fix", "")[:2000],
        }
        with open(lessons, "a") as f: f.write(json.dumps(entry) + "\n")

    print(json.dumps(verdict))

if __name__ == "__main__":
    main()
