---
name: future-agent
description: Uses deferred/unknown features (memory, mcpServers, unknown keys) to prove graceful degradation.
memory: project
mcpServers:
  some-server:
    command: "npx some-mcp"
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: "echo agent-scoped-hook"
unknownFutureAgentField: 42
---

Agent that declares deferred features. It must still be dispatchable.
