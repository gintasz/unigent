#!/usr/bin/env bash
# Claude Code `WorktreeCreate` hook — bootstrap a freshly created git worktree.
#
# A new worktree is a separate checkout that shares no node_modules with the main
# one, so dependencies must be installed once before work can start. This script
# is the reusable body; .claude/settings.json just points the WorktreeCreate hook
# at it (so the logic lives here, versioned, not inlined in JSON).
#
# Claude Code passes the hook payload as JSON on stdin (fields: worktree_path, cwd,
# session_id, hook_event_name). Contract we honour: stdout is reserved for the
# worktree path (some WorktreeCreate flows consume it); every diagnostic goes to
# stderr; and an install failure never fails the hook — that would abort worktree
# creation. Re-running is safe: it no-ops once node_modules exists.
set -uo pipefail

payload="$(cat)"

# Resolve the directory to install into: the new worktree, else the event's cwd,
# else the current directory. Parsed with node (always present in this repo).
dir="$(
  printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{let o={};try{o=JSON.parse(s)}catch{}process.stdout.write(String(o.worktree_path||o.cwd||""))})'
)"
[[ -n "$dir" && -d "$dir" ]] || dir="$PWD"

# Diagnostics to stderr; stdout stays clean for the path contract below.
{
  if cd "$dir" && [[ -f pnpm-lock.yaml && ! -d node_modules ]]; then
    echo "[worktree bootstrap] installing deps in $dir"
    if corepack pnpm install --frozen-lockfile; then
      echo "[worktree bootstrap] done"
    else
      echo "[worktree bootstrap] pnpm install failed — open the worktree and run it manually"
    fi
  fi
} 1>&2

# Hand the worktree path back on stdout (required by some WorktreeCreate flows,
# harmless otherwise) and always succeed so worktree creation is never blocked.
printf '%s\n' "$dir"
exit 0
