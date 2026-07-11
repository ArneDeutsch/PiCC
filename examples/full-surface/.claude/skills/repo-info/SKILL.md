---
name: repo-info
description: Summarize live repository state using injected shell output. Use when asked for repo info.
---

Current branch (injected at activation time):

!`git rev-parse --abbrev-ref HEAD`

Recent commits:

```!
git log --oneline -3
```

Skill dir: ${CLAUDE_SKILL_DIR}
Project dir: ${CLAUDE_PROJECT_DIR}

Canary: FS-SKILL-SHELL-BODY
