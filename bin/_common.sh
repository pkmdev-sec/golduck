# shellcheck shell=bash
# Shared env for every golduck-* launcher. Sourced, not executed.
set -eu

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
GOLDUCK_BIN="$(cd "$(dirname "$SOURCE")" && pwd)"
GOLDUCK_ROOT="$(cd "$GOLDUCK_BIN/.." && pwd)"
REPO_ROOT="$(cd "$GOLDUCK_ROOT/.." && pwd)"
export GOLDUCK_ROOT REPO_ROOT

export GOLDUCK_HOME="${GOLDUCK_HOME:-$HOME/.golduck}"
mkdir -p "$GOLDUCK_HOME"/{logs,state,memory,traces,skills,hooks,dags,trust,tmp}

export GOLDUCK_DAEMON_PORT="${GOLDUCK_DAEMON_PORT:-8787}"
export GOLDUCK_DAEMON_PID_FILE="$GOLDUCK_HOME/state/daemon.pid"
export GOLDUCK_DAEMON_LOG_FILE="$GOLDUCK_HOME/logs/daemon.log"
export GOLDUCK_DAEMON_SOCK="$GOLDUCK_HOME/state/daemon.sock"
export GOLDUCK_TRACE_FILE="$GOLDUCK_HOME/traces/current.jsonl"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PY_BIN="${PY_BIN:-$(command -v python3 || command -v python || true)}"
[ -z "$NODE_BIN" ] && { echo "[golduck] ERROR: node not found" >&2; exit 1; }
[ -z "$PY_BIN"  ] && { echo "[golduck] ERROR: python3 not found" >&2; exit 1; }
export NODE_BIN PY_BIN

CXR_BIN="${CXR_BIN:-$REPO_ROOT/cxr}"
DROIDX_BIN="${DROIDX_BIN:-$REPO_ROOT/droid-reverse-engineered/droidx}"
CXR_PROXY_DIR="$REPO_ROOT/anthropic-proxy"
DROIDX_PROXY_DIR="$REPO_ROOT/droid-reverse-engineered/droidx-runtime/proxy"
DROIDX_RLM_DIR="$REPO_ROOT/droid-reverse-engineered/droidx-runtime/rlm"
OBSCURA_MCP_HOME="${OBSCURA_MCP_HOME:-$HOME/cxr-obscura}"
export CXR_BIN DROIDX_BIN CXR_PROXY_DIR DROIDX_PROXY_DIR DROIDX_RLM_DIR
export OBSCURA_MCP_HOME

say()  { printf "\033[35m[golduck]\033[0m %s\n" "$*"; }
ok()   { printf "\033[35m[golduck]\033[0m \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[35m[golduck]\033[0m \033[33m%s\033[0m\n" "$*"; }
die()  { printf "\033[35m[golduck]\033[0m \033[31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }
