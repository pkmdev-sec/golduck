#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# golduck — remote one-line installer
# ════════════════════════════════════════════════════════════════════════════
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/GOLDUCK_OWNER/golduck/main/scripts/remote-install.sh | bash
#
# What it does:
#   1. Clones (or updates) github.com/<owner>/golduck under ~/.golduck/repo.
#   2. Runs ./install.sh with the same env you invoked it with.
#
# Env overrides:
#   GOLDUCK_OWNER=<user-or-org>   pick a fork owner (default: golduck-org)
#   GOLDUCK_BRANCH=<ref>          branch/tag/commit to check out (default: main)
#   GOLDUCK_REPO_DIR=<path>       clone destination (default: ~/.golduck/repo)
# ════════════════════════════════════════════════════════════════════════════
set -eu

OWNER="${GOLDUCK_OWNER:-golduck-org}"
BRANCH="${GOLDUCK_BRANCH:-main}"
REPO_DIR="${GOLDUCK_REPO_DIR:-$HOME/.golduck/repo}"
REMOTE="https://github.com/${OWNER}/golduck.git"

say() { printf "[golduck:remote] %s\n" "$*"; }

command -v git >/dev/null || { echo "git is required"; exit 1; }
command -v node >/dev/null || { echo "node >=20 is required"; exit 1; }

mkdir -p "$(dirname "$REPO_DIR")"

if [ -d "$REPO_DIR/.git" ]; then
  say "updating existing checkout at $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
  git -C "$REPO_DIR" checkout --quiet "$BRANCH"
  git -C "$REPO_DIR" pull --quiet --ff-only origin "$BRANCH"
else
  say "cloning $REMOTE into $REPO_DIR"
  git clone --quiet --branch "$BRANCH" --depth 1 "$REMOTE" "$REPO_DIR"
fi

say "running ./install.sh"
exec "$REPO_DIR/install.sh"
