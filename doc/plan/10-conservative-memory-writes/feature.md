# F10: Conservative-by-default memory writes

## What

Change the **default behaviour** of the auto-memory subsystem so that a model running
under PiCC **loads** memory as it does today but **writes** to it only in specific,
user-signalled circumstances — not proactively "whenever it learns something".

Observable behaviour after this feature:

- Memory **loading is unchanged**: `MEMORY.md` and per-agent `memory:` scopes still load
  at session start and inject into the main session and subagent prompts exactly as
  before (same truncation, same gates, same directory layout).
- The **write guidance** injected into the system prompt (and subagent prompts) instructs
  the model to write/update memory **only when the user explicitly asks it to remember
  something** — e.g. "remember to…", "in future don't…", "make a note that…" — and
  otherwise to leave memory untouched. The goal is to stop memory files from accreting
  low-value entries that pollute the loaded context over time.
- A project that *wants* eager, proactive memory writing can opt back in by adding an
  instruction to its own `CLAUDE.md` (which composes into the same prompt). This override
  path is **documented**, not a new configuration knob.

Explicit **non-goals** (out of scope):

- No change to memory **storage**: format, directory layout, `MEMORY.md` index
  convention, truncation (200 lines / 25 KB), or the on-disk write mechanism (still the
  ordinary Write/Edit tools).
- No change to the memory **loader** or to which prompts memory is injected into.
- No change to the existing gates/settings: `autoMemoryEnabled`, `autoMemoryDirectory`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.
- **No new settings knob** for write-eagerness. The override is CLAUDE.md-plus-docs only.
- Memory writing is **not removed** — the explicit-request path stays fully functional.
- No change to how `CLAUDE.md` files themselves are authored or discovered.

## Why

PiCC injects a write-first instruction ("update memory whenever you learn something worth
keeping across sessions"). In practice this makes models — especially the GPT models PiCC
targets — write memory entries far too eagerly. Every marginal "learning" becomes a file,
`MEMORY.md` grows, and because `MEMORY.md` is loaded into context every session, the
accumulated low-value entries actively **pollute the context** the feature was meant to
help. The maintainer wants the house default flipped to conservative: keep the benefit of
loading curated memory, but make *writing* a deliberate, user-driven act. Users who value
eager memory can opt in per project, so the conservative default costs them only one line
of `CLAUDE.md`.

This is a deliberate, small divergence from strict Claude Code parity (Claude Code writes
memory proactively). It is a maintainer-chosen house default consistent with PiCC's
charter of "just enough fidelity" rather than 100% parity, and the divergence is confined
to guidance wording — the mechanism stays Claude-compatible.

## Acceptance

- Running picc on a project with an existing `MEMORY.md` still shows that memory in the
  assembled system prompt, unchanged from today.
- The system prompt's memory section no longer tells the model to write proactively;
  instead it tells the model to write memory only on an explicit user request to remember
  something, and to otherwise refrain.
- The same conservative write guidance reaches subagents that receive project context
  (the ones that get memory today), so a dispatched subagent does not write eagerly
  either.
- A model given a normal task with no "remember"-style instruction does not create or
  edit memory files as a side effect; a model told "remember X for next time" does.
- Docs (user-guide, supported-features / capability matrix as applicable) describe the
  conservative default and the CLAUDE.md opt-in for eager writing; CHANGELOG records the
  behaviour change.
- typecheck and the full test suite are green, with tests asserting the new guidance
  wording and that loading behaviour is untouched.

## Tasks

- t01 Flip the injected memory-write guidance to conservative (code + unit tests;
  shared `MEMORY_WRITE_POLICY` constant across the project and per-agent strings) (depends on: –)
- t02 Make the capability registry and docs describe the conservative default
  (registry tier/notes, regenerated capability matrix, user-guide, CHANGELOG) (depends on: t01)
