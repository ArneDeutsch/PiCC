# t02: Rewire implement-feature skill to the new agents

## Goal

The `implement-feature` skill dispatches `implementer` for all writing/fix work and `generalist`
for adversarial/broad read-only review, and no longer routes writing or review to
`general-purpose`. A CHANGELOG entry records the change. Reading the skill, the coordinator is
clearly the sole holder of the dispatch tool.

## Context & seams

- Consumes t01's agents by exact name: `implementer`, `generalist` (dispatch via `subagent_type`).
- Target file: `.claude/skills/implement-feature/SKILL.md`. Edits (surgical — preserve everything
  else, especially altitude/commit/escalation principles):
  - **Roster section (currently ~line 35)**: replace the "Writing work … is always done by generic
    (general-purpose) subagents …" note. New content must (a) name `implementer` as the writer for
    implementation and fixes, (b) name `generalist` as the read-only adversarial/broad reviewer,
    (c) keep "never dispatch a read-only specialist to implement", and (d) state the invariant:
    every dispatched agent is non-dispatching, so the coordinator is the only orchestrator. Update
    the roster framing so it distinguishes the three kinds: read-only specialists (6), the
    write-capable `implementer`, and the read-only `generalist`.
  - **Phase 6**: "An adversarial reviewer (generic subagent)" → "An adversarial reviewer
    (`generalist`)"; "An end-user walkthrough (`user-experience` or generic)" → drop the "or
    generic" so it routes to `user-experience`.
  - **Phase 7.1**: "Dispatch a fresh generic implementer subagent" → "Dispatch a fresh
    `implementer` subagent".
  - **Phase 7.4**: "dispatch a generic fix subagent" → "dispatch an `implementer` (fix) subagent".
  - **Phase 8**: the "adversarial completeness check" → performed by `generalist`.
  - **Phases 1 & 4 (investigate)**: these currently say "spawn specialists in investigate mode."
    Add `generalist` as the option for broad/cross-surface investigation that no single specialist
    owns — otherwise `generalist`'s investigate mode (promised in its definition) is unreachable
    from the skill.
  - Scan the whole file for any remaining "generic"/"general-purpose" reference tied to a
    writing/review role and update it; leave references that are genuinely about Claude Code's
    built-ins (if any) intact.
- **CHANGELOG.md**: add an entry under the appropriate heading noting the two new project agents
  and that the skill now dispatches non-dispatching implementer/generalist agents (coordinator is
  sole orchestrator).

## Writable surface

- `.claude/skills/implement-feature/SKILL.md`
- `CHANGELOG.md`
- `doc/plan/05-implementer-agent/log/t02.md`

## Approach constraints

- Editing only. Do not restructure the skill or touch phases/principles unrelated to agent routing.
- Keep the skill portable (it also runs under PiCC/GPT): plain-prose instructions, standard Agent
  dispatch — no new tool assumptions.
- Do not weaken the existing "coordinator owns every commit" and escalation rules.
- **Roster clarity (resolve the `coder`/`implementer` overlap):** state plainly that the six
  read-only specialists — *including `coder`* — only ever *review*; `implementer` is the sole
  *builder*. Give `implementer` and `generalist` their own "Involve when…" guidance in the roster
  (table row or equivalent): `implementer` = execute a task spec / apply an accepted fix;
  `generalist` = whole-plan/whole-diff adversarial pass and cross-surface questions no single
  specialist owns.
- **Preserve the escape hatches.** The old note scoped writing as "implementation, fixes, doc
  edits … or by you directly for trivial changes." Keep both: `implementer` does substantive
  writing *including ad-hoc doc/CHANGELOG edits*, and the coordinator may still make *trivial* edits
  directly. Don't leave the coordinator unsure whether a one-line CHANGELOG bump needs a full
  dispatch.
- **Make the invariant's consequence concrete**, not just structural: e.g. "every agent you
  dispatch is non-dispatching — so you run every review and every fix yourself; an `implementer`
  cannot arrange its own review."

## Left open

- Exact prose of the rewritten roster note and the one-line CHANGELOG wording.

## Testing

- No code path changes, so no unit test here. Verify by re-reading the edited SKILL.md end-to-end:
  every writing/fix dispatch says `implementer`, every adversarial/broad review says `generalist`,
  the walkthrough says `user-experience`, and no writing/review role still says general-purpose.
- **Grep-verify the negative claim:** run `grep -n "general-purpose\|generic" SKILL.md` and confirm
  each remaining hit is a genuine Claude Code built-in reference, not a writing/review role (don't
  rely on eyeballing).
- `npm run typecheck` and full `npm test` green (docs/skill edits must not perturb the suite).

## Acceptance criteria
- [ ] SKILL.md dispatches `implementer` (write) and `generalist` (read-only review); no
      writing/review role references `general-purpose`/"generic".
- [ ] End-user walkthrough routes to `user-experience`.
- [ ] CHANGELOG entry added.
- [ ] typecheck and full test suite green.

## Depends on
t01
