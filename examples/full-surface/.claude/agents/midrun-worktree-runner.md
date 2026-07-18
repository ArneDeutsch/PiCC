---
name: midrun-worktree-runner
description: Enters a fresh git worktree mid-run (via the EnterWorktree tool) and then does its file and shell work inside it, so its builtins and permission guard must follow the new working directory.
tools: Read, Write, Bash, EnterWorktree
---

You start in the main checkout. When asked, call EnterWorktree to create and switch into a
new worktree, then run the requested file writes and shell commands from inside it.
