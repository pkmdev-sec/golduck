#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# golduck — installer
# ════════════════════════════════════════════════════════════════════════════
# One-shot installer for a freshly cloned golduck repo. Idempotent.
#
#   ./install.sh                  # local install from this checkout
#
# For the curl one-liner, see scripts/remote-install.sh.
#
# What it does:
#   1. Verify prerequisites (node>=20, python3, git; rg/curl warnings).
#   2. Install npm deps.
#   3. Create $GOLDUCK_HOME skeleton under ~/.golduck/.
#   4. Symlink `golduck` onto your $PATH at ~/.local/bin (or a dir you pick).
#   5. Install zsh/bash completions if available.
#   6. Run a quick sanity check (unit tests) unless GOLDUCK_SKIP_SELFTEST=1.
#
# Env overrides:
#   GOLDUCK_LINK_DIR=<dir>    where to put the `golduck` symlink
#                             (default: ~/.local/bin, falls back to /usr/local/bin)
#   GOLDUCK_SKIP_LINK=1       skip the symlink step
#   GOLDUCK_SKIP_SELFTEST=1   skip running the test suite at the end
#   NONINTERACTIVE=1          never prompt
# ════════════════════════════════════════════════════════════════════════════
set -eu
umask 077

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
GOLDUCK_ROOT="$(cd "$(dirname "$SOURCE")" && pwd)"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; MAG=$'\033[35m'; RST=$'\033[0m'
else BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; MAG=""; RST=""; fi
say()  { printf "%s[golduck]%s %s\n" "$MAG" "$RST" "$*"; }
ok()   { printf "%s[golduck]%s %s✓%s %s\n" "$MAG" "$RST" "$GRN" "$RST" "$*"; }
warn() { printf "%s[golduck]%s %s%s%s\n" "$MAG" "$RST" "$YLW" "$*" "$RST"; }
die()  { printf "%s[golduck]%s %sERROR:%s %s\n" "$MAG" "$RST" "$RED" "$RST" "$*" >&2; exit 1; }

say "installing from: $GOLDUCK_ROOT"

# 1. prerequisites
command -v node    >/dev/null || die "node >=20 required (brew install node)"
command -v python3 >/dev/null || die "python3 required (install from python.org)"
command -v git     >/dev/null || die "git required"
command -v rg      >/dev/null || warn "ripgrep not found — some tools degrade (brew install ripgrep)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then die "node >=20 required, found $NODE_MAJOR"; fi
ok "prerequisites ok (node $(node -v))"

# 2. install npm deps
if [ ! -d "$GOLDUCK_ROOT/node_modules" ] || [ "$GOLDUCK_ROOT/package.json" -nt "$GOLDUCK_ROOT/node_modules/.package-lock.json" ]; then
  say "installing npm deps (ink, react)…"
  (cd "$GOLDUCK_ROOT" && npm install --silent) || die "npm install failed"
fi
ok "npm deps present"

# 3. home skeleton
GOLDUCK_HOME="${GOLDUCK_HOME:-$HOME/.golduck}"
mkdir -p "$GOLDUCK_HOME"/{logs,state,memory,traces,skills,hooks,config,dags,trust,tmp}
MCP_CONFIG="$GOLDUCK_HOME/config/mcp.json"
if [ ! -f "$MCP_CONFIG" ]; then
  printf '{\n  "servers": {}\n}\n' > "$MCP_CONFIG"
  ok "wrote empty $MCP_CONFIG (add MCP servers here if you want)"
else
  ok "$MCP_CONFIG already present — preserved"
fi

# 3b. stage starter DAGs under $GOLDUCK_HOME/dags/ so /dag has examples.
DAGS_DIR="$GOLDUCK_HOME/dags"
mkdir -p "$DAGS_DIR"
if [ -d "$GOLDUCK_ROOT/dags" ]; then
  staged=0
  for src_dag in "$GOLDUCK_ROOT/dags"/*.json; do
    [ -f "$src_dag" ] || continue
    dst="$DAGS_DIR/$(basename "$src_dag")"
    if [ ! -f "$dst" ]; then
      cp "$src_dag" "$dst" && staged=$((staged + 1))
    fi
  done
  if [ "$staged" -gt 0 ]; then
    ok "staged $staged starter DAG(s) → $DAGS_DIR"
  fi
fi

# 4. symlink onto $PATH
if [ "${GOLDUCK_SKIP_LINK:-0}" != "1" ]; then
  LINK_DIR="${GOLDUCK_LINK_DIR:-}"
  if [ -z "$LINK_DIR" ]; then
    if [ -d "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin" 2>/dev/null; then
      LINK_DIR="$HOME/.local/bin"
    elif [ -w /usr/local/bin ]; then
      LINK_DIR="/usr/local/bin"
    else
      warn "couldn't find a writable PATH dir; skipping symlink"
      LINK_DIR=""
    fi
  fi
  if [ -n "$LINK_DIR" ]; then
    ln -sf "$GOLDUCK_ROOT/bin/golduck" "$LINK_DIR/golduck"
    ok "linked → $LINK_DIR/golduck"
    case ":$PATH:" in
      *":$LINK_DIR:"*) ;;
      *) warn "$LINK_DIR is not on your \$PATH — add it to your shell rc" ;;
    esac
  fi
fi

# 5. completions (best-effort)
if [ -d "$GOLDUCK_ROOT/completions" ]; then
  ZSH_COMPDIR="$HOME/.zsh/completions"
  BASH_COMPDIR="$HOME/.bash_completion.d"
  if [ -f "$GOLDUCK_ROOT/completions/_golduck" ]; then
    mkdir -p "$ZSH_COMPDIR" && cp -f "$GOLDUCK_ROOT/completions/_golduck" "$ZSH_COMPDIR/_golduck"
    ok "zsh completion → $ZSH_COMPDIR/_golduck"
  fi
  if [ -f "$GOLDUCK_ROOT/completions/golduck.bash" ]; then
    mkdir -p "$BASH_COMPDIR" && cp -f "$GOLDUCK_ROOT/completions/golduck.bash" "$BASH_COMPDIR/golduck"
    ok "bash completion → $BASH_COMPDIR/golduck"
  fi
fi

# 6. quick sanity check
if [ "${GOLDUCK_SKIP_SELFTEST:-0}" != "1" ]; then
  say "running unit tests…"
  (cd "$GOLDUCK_ROOT" && node tests/run_tests.mjs 2>&1 | tail -4) || warn "tests reported failures; see above"
fi

echo
ok "installation complete"
cat <<NEXT

${BOLD}quick start${RST}
  ${DIM}# set any one provider API key (or several):${RST}
  export ANTHROPIC_API_KEY=...       # Claude
  export OPENAI_API_KEY=...          # GPT / o1 / o3 / o4
  export GEMINI_API_KEY=...          # Gemini
  ${DIM}# see docs/providers.md for the full list${RST}

  golduck                             ${DIM}# interactive TUI${RST}
  golduck ask "your question"         ${DIM}# one-shot${RST}
  golduck run -- "task description"   ${DIM}# autonomous${RST}
  golduck doctor                      ${DIM}# health check${RST}

${BOLD}inside the TUI${RST}
  /providers                          ${DIM}# which providers have keys${RST}
  /model gpt-4o                       ${DIM}# switch model mid-session${RST}
  /help                               ${DIM}# all hotkeys + slash commands${RST}
NEXT
