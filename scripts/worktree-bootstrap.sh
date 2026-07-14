#!/usr/bin/env bash
# Bootstrap dependencies in a freshly created worktree / environment.
#
# A new worktree shares no node_modules with the main checkout, so the first time
# work starts there the deps must be installed. Idempotent (guards on node_modules)
# and reused by two callers, so it accepts the target directory two ways:
#
#   • Claude Code SessionStart hook → NO argument. The event payload arrives as
#     JSON on stdin and we read `cwd` from it. SessionStart fires on EVERY session,
#     so this path also gates on `-f .git` (a linked worktree's .git is a file, the
#     main checkout's is a directory) to act only inside a worktree.
#
#   • Codex environment [setup] script → pass the path as $1 (e.g.
#     "$CODEX_WORKTREE_PATH"). Setup runs ONCE at environment creation, so it skips
#     the .git gate and NEVER reads stdin — reading stdin there would block (no
#     payload is piped) and hang setup.
#
# Writes nothing to stdout (SessionStart stdout is injected into the agent context);
# diagnostics go to stderr; always exits 0.
set -uo pipefail

dir="${1:-}"
from_arg=1
if [[ -z "$dir" ]]; then
  from_arg=0
  # Hook path: read the JSON payload from stdin — but only when stdin is actually
  # piped, never from a terminal, so we can't block.
  payload=""
  [[ -t 0 ]] || payload="$(cat)"
  dir="$(
    printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{let o={};try{o=JSON.parse(s)}catch{}process.stdout.write(String(o.cwd||""))})'
  )"
fi
[[ -n "$dir" && -d "$dir" ]] || dir="$PWD"

cd "$dir" || exit 0

# The hook path (no explicit arg) fires on every session — restrict it to a linked
# worktree. An explicit-arg caller (Codex setup) already runs only at creation.
if [[ "$from_arg" -eq 0 && ! -f .git ]]; then
  exit 0
fi

[[ -f pnpm-lock.yaml && ! -d node_modules ]] || exit 0   # already installed / not a pnpm root

echo "[worktree bootstrap] installing deps in $dir" >&2
corepack pnpm install --frozen-lockfile 1>&2 ||
  echo "[worktree bootstrap] pnpm install failed — run it manually in $dir" >&2
exit 0
