#!/usr/bin/env bash
# Mode detection via standard git plumbing (DemonMatrix pattern).
# Prints mode=worktree when cwd is inside a linked worktree, mode=main otherwise.
# This is the load-bearing probe for the harness's cwd swap on EnterWorktree.
set -euo pipefail
git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")
common_dir=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
if [ -n "$git_dir" ] && [ "$git_dir" != "$common_dir" ]; then
  echo "mode=worktree"
else
  echo "mode=main"
fi
echo "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo none)"
