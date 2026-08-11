---
name: future-agent
description: Uses parser-normalized, runtime-deferred agent MCP declarations plus unknown features to prove graceful degradation.
memory: project
mcpServers:
  - fixture-session
  - fixture-inline:
      command: "picc-inert-mcp-fixture"
      args: ["--inert"]
hooks:
  PreToolUse:
    - hooks:
        - type: command
          command: "echo agent-scoped-hook"
unknownFutureAgentField: 42
---

Agent with bounded parser-only MCP evidence. Runtime MCP remains deferred; the agent must still be dispatchable.
