# t02: Make the capability registry and docs describe the conservative default

## Goal
Every place PiCC advertises its memory behaviour tells the truth after t01: the capability
registry, the generated capability matrix, the user guide, and the CHANGELOG describe memory
as loaded with full parity but written **conservatively by default** (only on explicit user
request), a deliberate documented divergence from Claude Code, with the eager-write opt-in via
`CLAUDE.md`. Loading-only descriptions are left accurate and unchanged.

## Context & seams
t01 has already flipped both guidance strings to conservative and shares one policy constant.
This task changes **only metadata and prose** — no `src/runtime` or `src/index.ts` behaviour.

**Capability registry** — `src/registry/capability-registry.ts` is the source of truth for the
generated matrix:
- Line 157 `setting.memory` — currently tier `full`, note "…with write-back conventions
  injected…". **Downgrade tier `full` → `partial`** and rewrite the note to disclose the
  divergence, matching the existing `PARTIAL:` convention used by `tool.Agent`/`tool.Task`
  (grep those lines for the exact house style). Keep the loading/truncation/gates facts.
  Recommended note:
  > `auto memory: MEMORY.md (first 200 lines / 25 KB) loads at session start with full parity; autoMemoryEnabled/autoMemoryDirectory + CLAUDE_CODE_DISABLE_AUTO_MEMORY honored. PARTIAL: injected write guidance is conservative by default — the model writes/updates memory only on an explicit user request to remember, whereas Claude Code also writes proactively; opt into eager writes via CLAUDE.md (§4.6)`
- Line 211 `agent.frontmatter.memory` — note "…injected with persistence guidance". This
  describes the per-agent string t01 flipped, so it advertises the same divergence.
  **Downgrade `full` → `partial`** and rewrite the note to disclose conservative writes.
- Line 241 `feature.agent-memory` — note "…injected with write-back conventions". Umbrella over
  both project auto-memory and per-agent scopes, both now conservative. **Downgrade
  `full` → `partial`** and rewrite the note the same way.

**Tier coherence is required (not optional).** All three entries (157, 211, 241) advertise the
identical conservative-write divergence; they MUST all be `partial` with a `PARTIAL:`-style
disclosure. Leaving any at `full` produces a registry that tags one behaviour at two tiers —
untruthful and internally incoherent. The tier-count test is dynamic and will NOT catch an
incoherent split, so this is a truthfulness judgement the task must make, not defer.

**Seam — tier-count test is self-consistent.** `test/registry.test.ts:819-824` computes tier
counts dynamically from `CAPABILITY_REGISTRY` and asserts the doctor report contains them, so a
`full`→`partial` shift updates both sides together and stays green. Confirm this still passes;
do not hardcode counts.

**Generated matrix** — `doc/supported-features.md` is generated (banner: "do not edit by
hand"). After editing the registry, run `npm run gen:capabilities` (package.json script →
`scripts/gen-capability-matrix.mjs`) and commit the regenerated file **unedited**. An in-suite
test asserts the committed file matches `renderCapabilityMatrix(registry)`, so skipping
regeneration fails the suite. Do not hand-edit lines 104/144/179.

**Hand-written docs** — `doc/user-guide.md`:
- Line 132 (Memory artifact-table row): the phrase "with write-back conventions" is misleading.
  Reword the write clause to conservative (e.g. "…with conservative write-back — memory is
  written only when you explicitly ask it to remember something; see note below"). Keep the
  200 lines / 25 KB, gates, and `memory:` scopes text.
- Insert a short callout immediately after the artifact table (around line 139–140) explaining
  the conservative default, why it diverges from Claude Code, and giving a copy-pasteable
  `CLAUDE.md` opt-in snippet, e.g.:
  > **Auto memory is conservative by default.** PiCC loads `MEMORY.md` every session but writes
  > to it only when you explicitly ask it to remember something. To restore Claude-Code-style
  > eager writes on a project, add to that project's `CLAUDE.md`:
  > ```markdown
  > ## Memory
  > Proactively record durable project facts to auto memory as you work — don't wait for me to
  > ask. Keep MEMORY.md as the index, one topic per file, and prune stale entries.
  > ```
- §7 "What is and isn't supported" (around line 315): today the **Full** paragraph lists
  "…`memory:` scopes, auto memory (`MEMORY.md`)…". After the tier downgrade this contradicts
  the registry, so **move** "auto memory (`MEMORY.md`)" and the `memory:` scopes mention OUT of
  the Full paragraph and INTO the Partial paragraph (~line 322, alongside the existing
  foreground-by-default divergence), phrased as "auto memory: loading full parity, writes
  conservative by default (opt into eager writes via CLAUDE.md)". §7 declares the registry its
  source of truth, so prose and registry must agree.
- Line 281 (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, loading-only) and line 15 (loading) stay
  unchanged.

**CHANGELOG.md** — the auto-memory feature is still UNRELEASED: its bullet ("…loads at session
start with **write-back conventions**") lives in the `## [Unreleased]` `### Added` section
(~lines 193-196), not in a shipped version. So do NOT add a separate `### Changed` entry — that
would leave `[Unreleased]` simultaneously "adding" proactive write-back and "changing" it away.
Instead **reword the existing `[Unreleased]` Added memory bullet** to describe conservative,
explicit-request writes (drop "write-back conventions"), note loading is unchanged and no
setting changed, and mention the CLAUDE.md opt-in. Verify by grep that no `[Unreleased]` bullet
still says "write-back conventions" after the edit.

**Do NOT change** `doc/architecture.md` or `README.md` — investigation confirmed their memory
passages are loading/support claims and remain accurate.

## Writable surface
- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (only via `npm run gen:capabilities` output)
- `doc/user-guide.md`
- `CHANGELOG.md`
- `doc/plan/10-conservative-memory-writes/log/t02.md` (execution log)

## Approach constraints
- Registry is the single source; never hand-edit the generated matrix.
- Keep loading-only descriptions accurate and unchanged.
- Prose must not contradict the shipped t01 wording (conservative, explicit-request-only).

## Left open
- Exact prose of the registry `PARTIAL:` notes, the user-guide callout, and the CHANGELOG
  reword (all three registry tiers are FIXED at `partial` — not open).

## Testing
- No new behavioural tests required; the change is metadata/docs.
- `npm run gen:capabilities` must have been run and its output committed (the matrix-sync test
  enforces this).
- Confirm `test/registry.test.ts` tier-count and doctor-report tests pass after the tier shift
  (counts are dynamic; when an agent sets `memory:`, the `/doctor` finding now renders under
  `[partial]` — a more honest grouping, still test-green).
- Note in the log: the acceptance "no registry note still implies proactive writes" is
  enforced by NO automated test (matrix-sync only checks committed==rendered; tier-count only
  counts) — it is human-verify-only, so grep the three notes yourself before committing.
- typecheck and full test suite green.
- Cross-platform: docs/registry only — no OS concerns.

## Acceptance criteria
- [ ] `setting.memory` (and coherently the agent-memory entries) describe conservative
      explicit-request writes with the `PARTIAL:`-style disclosure; no registry note still says
      "write-back conventions"/"persistence guidance" implying proactive writes.
- [ ] `doc/supported-features.md` regenerated from the registry and committed unedited.
- [ ] user-guide reworded row + opt-in callout (with CLAUDE.md snippet) + §7 divergence note;
      loading-only lines untouched.
- [ ] CHANGELOG `Changed` entry added.
- [ ] typecheck and full test suite green (incl. matrix-sync and tier-count tests).

## Depends on
t01
