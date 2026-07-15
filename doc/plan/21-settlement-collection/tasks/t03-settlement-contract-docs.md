# t03: Truthful settlement-delivery contract

## Goal

User-facing documentation, model-facing tool guidance, architecture records, capability claims, examples, and release notes accurately explain collection-aware settlement delivery and its relationship to observed Claude Code behavior.

## Context & seams

The capability source is `src/registry/capability-registry.ts`; `doc/supported-features.md` is generated from it. Settlement behavior is also described in the root README, `doc/user-guide.md`, `doc/architecture.md`, the Agent/Task tool descriptions in `src/runtime/subagents.ts`, full-surface examples, and `CHANGELOG.md`.

The shipped contract is directional: PiCC intentionally treats a successfully returned terminal TaskOutput record as delivery and omits a not-yet-sent redundant next-turn notice; running polls preserve notice eligibility; eligible uncollected current tasks still receive one bounded notice in an interactive session. Explicit TaskOutput retrieval remains available after notification. An uncollected stopped task receives an outcome-only notice that does not direct the coordinator to retrieve its deliberately discarded result. Older resumed generations remain subject to the existing newest-generation supersession rule, and one-shot print mode still has the separately tracked uncollected-work limitation.

Reporter-observed Claude Code 2.1.x background-task behavior can enqueue a redundant notification after TaskOutput retrieval. Public documentation does not specify notification-consumption semantics, and available reports do not establish an exact normative background-subagent contract. PiCC suppression is therefore an intentional UX hardening, not verified parity; do not say Claude consumes notifications or that this matches Claude's intended behavior.

Keep `tool.TaskOutput` at `full`: every documented input and terminal return remains functional, and collection-aware suppression is an explicitly disclosed PiCC-defined lifecycle hardening rather than a missing tool field. Keep `feature.background-agents` at `partial`, documenting both next-turn timing divergence and collection-aware suppression. Audit every settlement-push registry entry (`tool.Agent`, `tool.Task`, `tool.TaskOutput`, `tool.SendMessage`, `hook.event.Notification`, and `feature.background-agents`) so no unconditional or contradictory promise remains.

## Writable surface

- `README.md`
- `src/runtime/subagents.ts`
- `src/registry/capability-registry.ts`
- `test/background-tasks.test.ts` and/or the existing tool-description assertion file
- `test/registry.test.ts`
- `doc/supported-features.md` through `npm run gen:capabilities`
- `doc/user-guide.md`
- `doc/architecture.md`
- `examples/full-surface/README.md`
- `examples/full-surface/.claude/commands/bg-research.md`
- `CHANGELOG.md`

## Approach constraints

- Describe observable directional ordering, not internal flags or impossible global single-delivery claims.
- Qualify settlement pushes as applying to eligible/uncollected current tasks; do not promise every historical generation is pushed.
- Preserve and clearly distinguish the documented next-turn timing limitation, print-mode loss tracked separately, newest-generation supersession, bounded/untrusted notice framing, no idle-parent wake-up, and no `agent_completed` Notification hook.
- Update model-facing Agent/Task descriptions so they no longer promise a later notice after terminal collection; pin that conditional wording in tests.
- Treat cut-off terminal TaskOutput as delivery of all output available for that run; do not direct the model to repeat TaskOutput as though it could recover missing continuation. Likewise, describe uncollected stopped notices as outcome-only because no result is retained.
- Regenerate, never hand-edit, `doc/supported-features.md`.
- Add a concise `[Unreleased]` **Fixed** entry covering suppression plus preserved notices for running polls and eligible uncollected tasks.
- Update both full-surface background-task artifacts; deterministic behavioral proof remains in tests.

## Left open

- Exact wording and placement of the Claude divergence note.
- Exact concise phrasing for the root README and example command.

## Testing

- Update tool-description assertions to require conditional settlement-notice wording.
- Update registry assertions to pin `tool.TaskOutput: full`, `feature.background-agents: partial`, collection-aware hardening language, truthful Claude-evidence scope, unchanged next-turn/print-mode limitations, and unchanged Notification-hook status.
- Grep/audit all registry settlement-notice claims for consistency.
- Run `npm run gen:capabilities` twice and verify the second run is clean.
- Run typecheck and the full test suite.

## Acceptance criteria

- [ ] Users and coordinating models can tell when terminal TaskOutput suppresses a later notice and when it does not.
- [ ] Capability records identify PiCC's intentional hardening without overstating Claude parity; `tool.TaskOutput` remains full and background agents remain partial.
- [ ] README, runtime tool guidance, architecture, user guide, examples, CHANGELOG, registry tests, and generated matrix are consistent.
- [ ] Next-turn, print-mode, newest-generation, cut-off, stopped-result, and Notification-hook limitations remain truthful.
- [ ] Generated capability documentation is fresh and deterministic.
- [ ] typecheck and full test suite green

## Depends on

t02
