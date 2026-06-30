#!/usr/bin/env bash
# SessionStart hook — install deps the first time a session opens in a checkout
# that has none. A fresh git worktree shares no node_modules with the main
# checkout, so the first session there installs them; every later session no-ops.
#
# Idempotent (guards on node_modules), so it is safe to run on EVERY session start
# — that is why SessionStart works even though it is not worktree-specific. Used by
# both Claude Code (.claude/settings.json) and Codex (.codex/config.toml); each
# passes the event payload as JSON on stdin with a `cwd` field.
#
# Nothing is written to stdout (SessionStart stdout is injected into the agent's
# context); all diagnostics go to stderr, and the hook always exits 0.
set -uo pipefail

payload="$(cat)"

# The session's working directory — the worktree for a worktree session. Parsed
# with node (always present in this repo); falls back to $PWD if absent.
dir="$(
  printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{let o={};try{o=JSON.parse(s)}catch{}process.stdout.write(String(o.cwd||""))})'
)"
[[ -n "$dir" && -d "$dir" ]] || dir="$PWD"

cd "$dir" || exit 0
# Fire only in a fresh LINKED WORKTREE: git makes a linked worktree's `.git` a
# file (a `gitdir:` pointer), while the main checkout's `.git` is a directory — so
# `-f .git` means "this is a worktree". Combined with the node_modules guard, a
# normal new session in the main checkout (or a reopened worktree) is a no-op.
[[ -f .git && -f pnpm-lock.yaml && ! -d node_modules ]] || exit 0

echo "[worktree bootstrap] installing deps in $dir" >&2
corepack pnpm install --frozen-lockfile 1>&2 ||
  echo "[worktree bootstrap] pnpm install failed — run it manually in $dir" >&2
exit 0
