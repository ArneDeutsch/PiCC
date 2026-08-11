---
name: future-agent
description: Uses supported agent MCP declarations that stay intentionally inert when a reference is absent and an inline server is unapproved, plus unknown features.
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

Agent with a supported absent-reference and unapproved-inline MCP topology. The declarations remain intentionally inert in this fixture, and the agent must still be dispatchable.
