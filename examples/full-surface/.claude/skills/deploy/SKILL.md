---
name: deploy
description: Deploy the app to an environment with a version tag. Use when asked to deploy.
argument-hint: "<environment> <version>"
arguments:
  - name: environment
    description: Target environment
    required: true
  - name: version
    description: Version tag
    default: latest
---

Deploy to environment **$1** at version **$2**.

Named form: environment=$environment version=$version

Canary: FS-SKILL-ARGS-BODY
