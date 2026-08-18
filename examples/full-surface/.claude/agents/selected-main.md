---
name: selected-main
description: Representative selected main-session identity
tools:
  - Read
  - Grep
  - Bash
  - Skill
  - Agent(reviewer)
disallowedTools:
  - Read(**/.env)
model: inherit
effort: medium
permissionMode: plan
skills:
  - deploy
memory: project
initialPrompt: "FS-SELECTED-MAIN-INITIAL: inspect the selected identity before the ordinary request."
maxTurns: 7
background: false
isolation: none
color: blue
---

You are the full-surface selected main-session identity.
Canary: FS-SELECTED-MAIN-BODY
