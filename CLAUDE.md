# PiClauDex

PiClauDex is an agentic harness that lets **GPT/Codex models run on projects built for Claude Code — unchanged**.

## The vision

Many projects are authored and tuned for Claude Code: they carry `CLAUDE.md` files, skills in `.claude/skills/`, subagents in `.claude/agents/`, `settings.json` permissions and hooks, and rely on Claude Code runtime features like worktree-based workspace isolation (`EnterWorktree`/`ExitWorktree`) and parallel sessions on one repo.

The goal is a harness where GPT models - driven from a personal ChatGPT/Codex subscription - read and use those Claude-format artifacts and behaviors natively, with **no changes to the target project**. The GPT models should honor the project's skills, subagents, hooks, permissions, git handling, and worktree/parallel-session workflows just as Claude Code would.

We don't need 100% Claude Code parity - just enough fidelity that real Claude Code projects run on GPT models without friction or adaptation. The harness is meant to be minimal and adaptable, so it can be further tuned per project when needed.

## Approach

Build on a minimal, model-agnostic base harness (Pi) that already supports OpenAI models and ChatGPT-subscription auth, and extend it with the missing Claude Code compatibility: loaders for Claude skills/agents, a subagent dispatch tool, worktree isolation, a permission engine, and hook support.
