# F14: context:fork failure handling — preserve partial output + Esc cancellation

## What

A `context: fork` skill — a skill that runs as a forked subagent — currently loses
information when it does not complete cleanly. This feature brings the fork path to
behavioural parity with the `Agent` tool (delivered in F02), on two observable fronts:

- **Failure preserves partial output and names the cause.** When a fork dies on a
  terminal error after producing some output, the caller sees a *loud* failure that
  names the cause **and** still carries whatever the fork produced before it died. No
  silent drop, and no bare crash that discards the partial text.
- **Esc cancels a fork and reports it as aborted.** Pressing Esc while a fork is running
  cancels the in-flight fork and surfaces it as **aborted** — distinct from both an empty
  success and a crash.

A `context: fork` reaches the runtime through two callers, and both must behave this way:

1. A `context: fork` skill invoked from **top-level user input** (e.g. typing
   `/some-forked-skill`).
2. A `context: fork` skill invoked via the **`Skill` tool from inside a subagent**.

**Observable outcomes (aligned to the ticket's acceptance):**

- A fork that fails after producing partial output → the caller receives a failure that
  names the cause *and* retains the partial output.
- Esc during a fork → the caller receives an **aborted** report (not an empty success,
  not a crash).

### Non-goals

- **Forks stay non-resumable.** F02 deliberately marked fork / `agentOverride` dispatches
  non-resumable (a synthetic `fork:<skill>` agent cannot be re-derived by name). This
  feature is about failure *reporting and preservation*, not resume.
- **No change to the `Agent`-tool path** — it already has this behaviour (F02).
- **No background-by-default, no `TaskOutput`/`TaskStop` scoping, no other F02 follow-up**
  is in scope here.
- **No new cancellation model and no "focus" concept.** A fork is a synchronous,
  foreground dispatch: only one foreground operation runs at a time, so Esc targets it
  unambiguously. Background agents (`run_in_background`) are unaffected and remain
  cancellable only via `TaskStop`.

## Why

F02 exists to kill exactly one class of defect: a subagent that does not complete cleanly
silently losing its work or masquerading as an empty success. F02 closed that on the
`Agent` tool but left it **open on the fork path** — a known, deferred gap recorded in
`doc/plan/02-subagent-lifecycle/review.md` (Proposed follow-up 3; "Bugs discovered —
Pre-existing, found and deferred"). A user who runs a `context: fork` skill today can lose
the fork's partial output on failure, or press Esc and get a crash or a misleading empty
success. Closing this makes the fork path trustworthy in the same way the `Agent` path
already is, and removes the last instance of the silent-loss class on the subagent
surface that F02 set out to eliminate.

## Acceptance

- Running a `context: fork` skill that fails partway through (after emitting some output)
  surfaces a failure message that both names the cause and includes the partial output —
  from **both** the top-level-input caller and the `Skill`-tool-from-subagent caller.
- Pressing Esc while a `context: fork` skill is running cancels it, and the caller reports
  the run as **aborted** rather than as an empty success or a crash. Model-invoked forks
  (`Skill`/`SlashCommand` tool) ride Pi's per-call signal; a typed top-level `/forked-skill`
  has no per-call signal, so in interactive mode the input hook watches raw terminal input
  and aborts on Esc (print/RPC modes have no Esc — a typed fork there runs to completion,
  named explicitly rather than silently degraded).
- Behaviour on the `Agent`-tool path, on non-forked skills, and on successful forks is
  unchanged.
- typecheck and the full test suite are green; new tests cover failure-with-partial-output
  and Esc-abort on the fork path.

## Tasks

- t01 Extract the shared dispatch-outcome presentation helper; refactor the `Agent`
  tool onto it (depends on: –)
- t02 Wire the fork path — thread the Esc signal into `forkDispatch` and map both fork
  consumers through the t01 helper (depends on: t01)
- t03 Make the capability registry, generated docs, and CHANGELOG truthful about fork
  failure/abort handling, with the scoped-Esc caveat (depends on: t02)
- t04 Make a typed top-level `/forked-skill` Esc-cancellable in interactive mode — the
  input hook watches raw terminal input (`ctx.ui.onTerminalInput`) and aborts on Esc;
  update docs to match (depends on: t02)
