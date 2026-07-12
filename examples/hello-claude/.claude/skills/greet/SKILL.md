---
name: greet
description: Greet a person by name and record the greeting. Use when the user asks to greet someone.
user-invocable: true
argument-hint: "<name>"
---

# Greet skill

The skill body canary is: GREET-SKILL-BODY

Greet the person named **$0** (full arguments were: $ARGUMENTS).

Steps:
1. Say hello to $0 in one friendly sentence.
2. Append the line `greeted: $0` to `greetings.log` in the project root.
