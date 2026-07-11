#!/usr/bin/env bash
# Warn-only write guard (DemonMatrix pattern): reads the tool payload as JSON on stdin,
# allows the write, and injects additionalContext naming the file.
payload=$(cat)
file=$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"FS-WRITE-GUARD saw: %s"}}\n' "$file"
exit 0
