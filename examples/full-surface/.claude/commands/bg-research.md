---
description: Dispatch the async-researcher in the background and retrieve it with TaskOutput.
argument-hint: "<topic>"
---

Research this topic without blocking: $ARGUMENTS — canary FS-BG-TASKOUTPUT

1. Dispatch the `async-researcher` subagent via the **Agent** tool with `run_in_background: true`
   (it also carries `background: true` frontmatter), passing the topic above as its prompt.
2. Keep working while it runs; the background task is named `task-N` and its dispatched agent
   (type + `agent-<id>`) is shown at every surface.
3. Retrieve the result with the **TaskOutput** tool — `TaskOutput(task_id: "task-1")` — which
   streams the subagent's live activity while it is still running and resolves to the finished
   outcome badge + transcript + usage when it settles. A running poll keeps the task eligible for
   one bounded next-turn settlement notice; a terminal return is already delivery and suppresses
   that redundant notice, so do not call TaskOutput again expecting a missing continuation.
