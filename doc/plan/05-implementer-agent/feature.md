# F05: Non-dispatching implementer & generalist agents

## What

The `implement-feature` workflow gains two dedicated project subagents so that **no agent the
coordinator dispatches can itself spawn further subagents** — the coordinator (main session)
becomes the only holder of the subagent-dispatch tool.

- An **implementer** agent performs all *writing* work — task implementation and fixes. It can
  create/modify files and run the build and tests, but it cannot dispatch other subagents.
- A **generalist** agent performs *read-only* broad and adversarial review (the whole-plan/whole-diff
  skeptic, and generic cross-surface investigation). It cannot modify files and cannot dispatch other
  subagents.

The six read-only specialists (`coder`, `tester`, `docs`, `security`, `user-experience`,
`claude-parity`) keep reviewing implementer output exactly as before — now judging an independent
writer. The end-user walkthrough routes to `user-experience`.

**Non-goals:**
- No change to PiCC's nested-subagent capability, the depth cap, or the built-in agents
  (`general-purpose`/`Explore`/`Plan`). Nested dispatch stays available and Claude-faithful; this
  feature only changes which agents *this skill* hands work to.
- Not a harness behavior change: the fix is per-agent tool scoping, the same lever Claude Code
  documents ("omit `Agent` from an agent's tools").

## Why

Forensics on a canceled run showed the skill's `general-purpose` implementers inherit the `Agent`
tool and, seeing the specialist roster in their catalog, spontaneously dispatched reviewers "one
level down": 7 `general-purpose` agents produced 34 nested review dispatches, 89 subagents total.
The adversarial-review role (also `general-purpose`) nested the same way. This is not a bug — it is
faithful Claude Code behavior — but for this workflow it produces uncontrolled fan-out, redundant
review, and an over-invasive process that is hard to follow and reason about.

Removing the `Agent` tool from every dispatched role makes "the coordinator is the sole
orchestrator" a *structural* property, independent of model restraint, while preserving the
implement→independent-review separation that gives the workflow its quality.

## Acceptance

- The skill dispatches `implementer` for implementation/fix work and `generalist` for
  adversarial/broad read-only review; it no longer routes writing *or* review to `general-purpose`.
- `implementer` can edit files and run the build/tests but exposes no `Agent`/`Task`/`Skill` tool;
  `generalist` cannot modify the repository and exposes no `Agent`/`Task`/`Skill` tool.
- When the workflow runs, a dispatched agent cannot spawn a further subagent **via the in-harness
  Agent tool** (only the coordinator can) — verifiable from the empty agent catalog it receives and
  from its available tools. (This governs the harness dispatch mechanism; it does not sandbox `Bash`,
  exactly as for the existing Bash-wielding specialists.)
- README/CHANGELOG/docs and any capability records that describe the workflow's agent usage remain
  accurate.

## Tasks

- t01 Implementer & generalist agent definitions (depends on: –)
- t02 Rewire implement-feature skill to the new agents (depends on: t01)
