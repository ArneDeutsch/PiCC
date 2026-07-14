# F10 Review: Conservative-by-default memory writes

## Outcome
Shipped as planned in two commits. PiCC's injected memory-**write** guidance was flipped from
eager ("update memory whenever you learn something") to conservative — the model now writes or
updates memory only when explicitly asked to remember something, and otherwise leaves memory
alone. Memory **loading** is byte-for-byte unchanged. The two write-guidance strings (project
auto-memory and per-agent `memory:` scope) were unified behind one exported
`MEMORY_WRITE_POLICY` constant so they cannot drift, and that policy opens with a deference
clause so a project's `CLAUDE.md` can restore eager writes. The capability registry downgraded
the three memory entries `full → partial` with `PARTIAL:` disclosure, the generated matrix was
regenerated (79 full / 17 partial), and the user-guide, §7, and CHANGELOG describe the
divergence. No new setting was added. Only deviation from the first draft plan: the CLAUDE.md
opt-in needed a deference clause to actually work (see below) — added during plan review.

## Planning errors & spec gaps
- **The opt-in was almost shipped broken.** The initial plan flipped the guidance and
  documented "add a line to CLAUDE.md" — but the conservative policy is injected *after* the
  CLAUDE.md section, so without an explicit carve-out the conservative directive (last, and
  topic-scoped) would have won and the documented opt-in would silently fail. Plan review
  (generalist + user-experience, independently) caught it; fixed by mandating a deference clause
  in the shared constant, asserted deterministically. Lesson: when a feature relies on one
  injected instruction overriding another, prompt-section ORDER is a real seam — check it in
  planning.
- **A false-green test slipped into the first task draft.** Asserting `/remember/i` on the whole
  subagent dispatch prompt is satisfied by the co-injected `# Auto memory` section, so it proved
  nothing about the per-agent string. Caught in plan review and again in diff review; fixed with
  a unique-old-phrase negative plus an occurrence-count pin. Lesson: shared wording across two
  prompt sections makes positive-substring tests contaminated; prove a specific site with a
  section-scoped or count-based assertion.
- **Mid-plan review edits left two internal contradictions in the specs** (t01's blanket
  "don't use 'proactively'" vs. the added deference clause; t02's acceptance checklist saying
  "add a Changed entry" vs. its own guidance to reword the Added bullet). Both were caught by
  implementers/reviewers and reconciled. Lesson: when review injects a new MUST, re-scan the
  same spec's earlier constraints AND its acceptance checklist for fallout.

## Friction
- CHANGELOG shape: the auto-memory feature is still in `[Unreleased] ### Added`, so the correct
  move was to reword the existing bullet, not stack a `### Changed` entry — non-obvious and
  initially specced the wrong way.
- Two acceptance claims are enforced by no automated test: the behavioural "doesn't write on a
  normal task" (untestable against the scripted mock model) and "no registry note implies
  proactive writes" (matrix-sync only checks committed==rendered; tier-count only counts). Both
  were verified by wording assertions + manual grep. A registry-note lint could close the second.

## Bugs discovered
- Latent oddity resolved as a side effect: before F10, an agent that set `memory:` produced a
  `/doctor` finding rendered under `[full]`, contradicting the report's "not fully honored"
  header. The `full → partial` downgrade now groups it under `[partial]` — more honest.
- No pre-existing bugs found in the loader or injection paths; loading was cleanly separable.

## Improvement opportunities
- **Runtime disclosure for project-level memory (deferred by design).** A migrant whose project
  has a plain `MEMORY.md` gets no startup-notice / `/doctor` line about the flipped default —
  only docs disclose it. The maintainer chose docs-only (Option A) to match the feature's
  guidance-and-docs scope and to avoid a per-session notice on every project with a MEMORY.md.
  Candidate follow-up: a `setting.memory` compat finding gated on auto-memory being enabled.
  Tradeoff: charter faithfulness ("no silent surprises") vs. notice noise; and compat findings
  are designed for per-project misconfig, not global house defaults.
- **Registry-note lint**: assert no `partial`/`full` note contradicts itself (e.g. a memory note
  claiming proactive writes) — would have made one manual grep unnecessary.
- **Absent-`MEMORY.md` lead-in**: reworded during close review ("Any memory shown above…") so
  the framing reads correctly when no MEMORY.md exists yet.

## Proposed follow-ups
- **F-next (small): `setting.memory` compat finding** — surface the conservative-writes
  divergence in the startup notice / `/doctor` for projects that load auto-memory, so Claude
  Code migrants get a runtime signal, not just docs. Gated to avoid noise. (Option B from F10
  planning.)
- **F-next (tiny): registry-note truthfulness lint** — a unit check that flags notes whose
  disclosure contradicts their own tier/behaviour, closing the untested acceptance gap.
- **Housekeeping**: `doc/plan/picc-plan.md:407` still describes memory as "write conventions" —
  an internal historical artifact; refresh it if/when that plan doc is next revised.
