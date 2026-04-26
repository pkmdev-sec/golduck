#!/usr/bin/env python3
"""golduck doctor — aggressive self-diagnosis.

Runs a comprehensive check over the whole stack and prints a friendly
human-readable report with remediation hints. Exit code = number of
failures.
"""
from __future__ import annotations
import json, os, sys, shutil, subprocess, socket, pathlib, textwrap, shutil

REPO_ROOT = pathlib.Path(os.environ.get("REPO_ROOT", pathlib.Path(__file__).resolve().parents[3]))
GOLDUCK_HOME = pathlib.Path(os.environ.get("GOLDUCK_HOME", pathlib.Path.home() / ".golduck"))
CXR_PROXY_PORT    = int(os.environ.get("CXR_PROXY_PORT", "8741"))
DROIDX_PROXY_PORT = int(os.environ.get("DROIDX_PROXY_PORT", "8752"))
DAEMON_PORT       = int(os.environ.get("GOLDUCK_DAEMON_PORT", "8787"))

GRN="\033[32m"; RED="\033[31m"; YLW="\033[33m"; DIM="\033[2m"; RST="\033[0m"

def probe(host, port, timeout=1.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False

def http_get(port, path, timeout=1.5):
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=timeout) as r:
            return r.status, r.read().decode("utf8", errors="replace")
    except Exception as e:
        return 0, str(e)

def check(name, ok, msg="", hint=""):
    mark = f"{GRN}✓{RST}" if ok else f"{RED}✗{RST}"
    hint_s = f"\n       {DIM}{hint}{RST}" if hint and not ok else ""
    print(f"  {mark} {name:35s} {msg}{hint_s}")
    return 0 if ok else 1

def main():
    import argparse
    ap = argparse.ArgumentParser(prog="golduck doctor")
    ap.add_argument("--fix", action="store_true", help="auto-create missing home dirs + stage starter skills")
    args = ap.parse_args()
    print(f"{DIM}GOLDUCK_HOME = {GOLDUCK_HOME}{RST}")
    print(f"{DIM}REPO_ROOT    = {REPO_ROOT}{RST}")
    fails = 0

    if args.fix:
        print(f"{DIM}▶ fix mode: creating missing dirs + staging skills{RST}")
        for d in ["traces", "state", "memory", "logs", "skills", "hooks", "config", "dags", "trust", "tmp"]:
            (GOLDUCK_HOME / d).mkdir(parents=True, exist_ok=True)
        starters = REPO_ROOT / "golduck" / "prompts" / "starter-skills"
        if starters.exists():
            for f in starters.glob("*.json"):
                dst = GOLDUCK_HOME / "skills" / f.name
                if not dst.exists():
                    shutil.copy2(f, dst)
                    print(f"  staged {dst.name}")
        print()

    # Tooling
    fails += check("node",     shutil.which("node")    is not None, hint="install Node >=20 (brew install node)")
    fails += check("python3",  shutil.which("python3") is not None)
    fails += check("git",      shutil.which("git")     is not None)
    fails += check("curl",     shutil.which("curl")    is not None)
    fails += check("rg/ripgrep", shutil.which("rg")    is not None, hint="brew install ripgrep", msg="(optional)")

    # Binaries
    cxr = REPO_ROOT / "cxr"
    drx = REPO_ROOT / "droid-reverse-engineered" / "droidx"
    fails += check("cxr binary",    cxr.is_file()    and os.access(cxr, os.X_OK), hint="./install.sh from repo root")
    fails += check("droidx binary", drx.is_file()    and os.access(drx, os.X_OK), hint="droid-reverse-engineered/install.sh")
    codex = REPO_ROOT / "codex-rs" / "target" / "release" / "codex"
    fails += check("codex release", codex.is_file() and os.access(codex, os.X_OK), hint="cd codex-rs && cargo build --release --package codex-cli")

    # Proxies
    hz_c = http_get(CXR_PROXY_PORT, "/healthz")[0] == 200
    check("cxr-proxy healthz", hz_c, msg=f"port={CXR_PROXY_PORT}", hint=f"golduck up  (or: cxr status)")
    hz_d = http_get(DROIDX_PROXY_PORT, "/healthz")[0] == 200
    check("droidx-proxy healthz (optional)", hz_d, msg=f"port={DROIDX_PROXY_PORT}", hint="GOLDUCK_BOOT_ALL=1 golduck up")

    # Daemon
    hz_x = http_get(DAEMON_PORT, "/healthz")[0] == 200
    check("golduck daemon", hz_x, msg=f"port={DAEMON_PORT}", hint="golduck up")

    # MCP
    rlm = REPO_ROOT / "droid-reverse-engineered" / "droidx-runtime" / "rlm" / "server.mjs"
    r = subprocess.run(["node", "--check", str(rlm)], capture_output=True) if rlm.exists() else None
    fails += check("droidx-rlm MCP ok", r is not None and r.returncode == 0, hint="node --check " + str(rlm))
    obs = pathlib.Path.home() / "cxr-obscura" / "bin" / "obscura-mcp"
    check("obscura MCP launcher", obs.exists(), hint="cxr-extras/obscura/install.sh")

    # Home tree
    for d in ["traces", "state", "memory", "logs", "skills", "hooks", "dags"]:
        fails += check(f"$GOLDUCK_HOME/{d}", (GOLDUCK_HOME / d).exists(), hint="golduck up / install.sh creates these")

    # Daemon auth token (only if daemon appeared healthy above).
    tok = GOLDUCK_HOME / "state" / "daemon.token"
    if hz_x:
        check("daemon auth token", tok.exists() and tok.stat().st_size >= 16, hint="the daemon re-creates this on start")
    else:
        check("daemon auth token", True, msg="(daemon down, skipped)")

    # Starter DAGs staged under home.
    staged_dags = list((GOLDUCK_HOME / "dags").glob("*.json")) if (GOLDUCK_HOME / "dags").exists() else []
    check(f"$GOLDUCK_HOME/dags has examples", len(staged_dags) > 0, msg=f"{len(staged_dags)} staged", hint="./install.sh to stage starter DAGs")

    # New env-var hints (informational only).
    print(f"{DIM}  env: GOLDUCK_SAFETY_BUDGET_USD={os.environ.get('GOLDUCK_SAFETY_BUDGET_USD', '(default 10)')}  GOLDUCK_MAX_AUTO_REVISIONS={os.environ.get('GOLDUCK_MAX_AUTO_REVISIONS', '(default 2)')}  GOLDUCK_RLM_BUDGET_USD={os.environ.get('GOLDUCK_RLM_BUDGET_USD', '(default 5)')}{RST}")

    # AWS creds (soft)
    if os.environ.get("AWS_PROFILE"):
        check("AWS_PROFILE", True, msg=os.environ.get("AWS_PROFILE"))
    else:
        check("AWS_PROFILE", False, hint="export AWS_PROFILE=... for Bedrock mode")

    # ---- provider API keys (informational) ------------------------------
    providers = [
        ("anthropic",  ["ANTHROPIC_API_KEY"]),
        ("openai",     ["OPENAI_API_KEY"]),
        ("glm",        ["ZHIPUAI_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"]),
        ("gemini",     ["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        ("deepseek",   ["DEEPSEEK_API_KEY"]),
        ("xai",        ["XAI_API_KEY", "GROK_API_KEY"]),
        ("mistral",    ["MISTRAL_API_KEY"]),
        ("groq",       ["GROQ_API_KEY"]),
        ("openrouter", ["OPENROUTER_API_KEY"]),
        ("custom",     ["GOLDUCK_CUSTOM_API_KEY"]),
    ]
    present = [p for (p, envs) in providers if any(os.environ.get(e) for e in envs)]
    # anthropic also counts when cxr proxy is reachable (no key needed).
    if "anthropic" not in present and hz_x:
        present.append("anthropic(via cxr)")
    present_str = ", ".join(present) if present else "(none — Anthropic via cxr proxy will be used by default)"
    print(f"{DIM}  providers with keys: {present_str}{RST}")

    # Summary
    print()
    if fails == 0:
        print(f"{GRN}✓ All hard checks passed.{RST}")
    else:
        print(f"{RED}✗ {fails} issue(s). See above for hints.{RST}")
    sys.exit(min(fails, 125))

if __name__ == "__main__":
    main()
