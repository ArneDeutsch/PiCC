# t01: Flip the injected memory-write guidance to conservative

## Goal
The two memory-write guidance strings PiCC injects into the system prompt no longer
tell the model to write proactively. Instead they instruct it to **use** loaded memory
but write/update it **only when explicitly asked to remember something** — and the same
policy sentence is shared between the main-session (project) guidance and the per-agent
`memory:` guidance so they cannot drift. Memory **loading is completely untouched**. The
unit tests assert the new intent and prove loading still works.

## Context & seams
Two guidance strings exist and are the ONLY model-facing memory-write text (confirmed by
investigation — nothing else in `src/` emits write guidance):

1. `src/runtime/context-assembly.ts:109` — `AUTO_MEMORY_INSTRUCTIONS`, appended last inside
   the `# Auto memory` section (built at lines 124–130). Reaches the main session
   (`index.ts:570`) AND every subagent that receives project context (`skipProjectContext`
   agents like Explore/Plan are already excluded — do not change that).
2. `src/index.ts:540–542` — the inline per-agent `memory:` scope guidance, appended last
   inside the `# Agent memory` section (built at lines 536–543).

Both section builders are plain `parts.join("\n\n")` assembly with **no length/format/regex
coupling** to the guidance text — changing wording/length is safe; nothing downstream reads
it back.

**Shared-constant seam (required).** Extract the conservative write-*policy* sentence into a
single exported constant in `context-assembly.ts` (suggested name `MEMORY_WRITE_POLICY`).
`index.ts` already imports from `context-assembly.ts`, so import it there too. Each site keeps
its own short context-specific framing (project memory = "durable project knowledge"; agent
memory = "your durable knowledge for future runs") and then appends the shared policy
sentence. This is the mechanism that makes t01's "same guidance reaches subagents" guarantee
structural rather than a copy-paste that can rot. **Constant name and location are a seam with
t02's tests** — t02 does not touch these, so no cross-task name dependency beyond this file.

### Recommended wording (draft — final prose is Left open, but it MUST satisfy the assertions below)
Shared `MEMORY_WRITE_POLICY` (works for both "asked by the user" and "asked by the
dispatching task"). **It MUST open with a deference clause** so a project's own CLAUDE.md
opt-in wins — see the deference-clause requirement below. Draft (a single-line string —
the blockquote wrapping here is for readability only; do NOT embed newlines mid-sentence):
> Unless this project's own instructions tell you to record memory proactively, do not write
> to memory on your own initiative — routine facts you pick up while working do not belong
> here, and low-value entries only crowd out what matters. Add or update an entry only when you
> are explicitly asked to remember something for the future (for example "remember to…", "from
> now on…", "in future don't…", or "make a note that…"). When you do, use the Write/Edit tools
> with one topic per file and MEMORY.md as the index (only MEMORY.md is loaded automatically —
> keep it under ~200 lines). Remove or correct an entry only when you are told it is wrong or
> obsolete.

### Deference-clause requirement (MUST — this is why the feature's opt-in works)
`buildSystemPromptSuffix` emits the `## Project instructions (CLAUDE.md)` section BEFORE the
`# Auto memory` section (context-assembly.ts:121 then :129), and for a subagent the
`# Agent memory` section is pushed before the CLAUDE.md-bearing suffix (index.ts:543 vs :577).
So a project's documented eager-write opt-in (a CLAUDE.md line like "record proactively…")
sits in a different, non-adjacent section from the conservative policy. Without an explicit
carve-out the model faces a bare contradiction with the conservative directive positioned to
win, and the feature's headline promise ("opt back in with one line of CLAUDE.md") would be a
coin-flip — shipped unverified because behaviour can't be tested deterministically. Therefore
`MEMORY_WRITE_POLICY` MUST contain a clause deferring to the project's own instructions (e.g.
"Unless this project's own instructions tell you to record proactively, …"). This clause is
asserted deterministically (see Testing).

Project framing (`AUTO_MEMORY_INSTRUCTIONS`): a lead-in that keeps the load/use framing, e.g.
"The memory above is loaded every session — treat it as durable project knowledge and use
it." + the shared policy.

Agent framing (`index.ts`): "The memory above is loaded for you each run — use it." + the
shared policy.

Do NOT retain the phrase "whenever you learn" — the negative test asserts it is gone. (The
word "proactively" MAY appear, but only inside the deference clause — "record proactively"; it
must not describe the default write behaviour. Accordingly the auto-memory test does NOT assert
`not.toMatch(/proactively/i)`.)

## Writable surface
- `src/runtime/context-assembly.ts`
- `src/index.ts`
- `test/memory.test.ts`
- `test/builtin-agents.test.ts`
- `doc/plan/10-conservative-memory-writes/log/t01.md` (execution log)

Everything else is read-only. In particular: do NOT touch `src/claude/memory.ts` (loader),
the capability registry, or any doc — those are t02.

## Approach constraints
- Loading, truncation, gates, directory resolution, and which prompts memory is injected into
  MUST be unchanged. This task is guidance-text only, plus the shared-constant extraction.
- Keep the `# Auto memory` / `# Agent memory` section structure and headers exactly as they
  are (other tests assert the headers).
- Both flipped strings must share the one policy constant — no second copy of the policy
  sentence — and both therefore inherit the deference clause.
- `MEMORY_WRITE_POLICY` is a single-line string (no newlines mid-sentence). At each site, push
  the context framing lead-in and the shared policy as SEPARATE `parts` array entries so the
  existing `parts.join("\n\n")` supplies the separator (matches the current idiom at both
  sites); do not string-concatenate lead-in + policy without a separator.

## Left open
- Exact final prose of the framing lead-ins and the shared policy sentence, provided it
  satisfies every assertion in Testing.
- Whether to keep the framing lead-ins as separate string literals or inline template
  expressions.

## Testing
Follow an **intent-not-prose** strategy so the tests verify behaviour without rotting on a
comma-level reword. In `test/memory.test.ts` (`buildSystemPromptSuffix — Auto memory section`)
**replace** (do not merely add beside) the brittle wording assertions — the recommended
wording still contains "MEMORY.md as the index" and "one topic per file", so a leftover
`toContain("MEMORY.md as the index")`/`toContain("one topic per file")` would keep passing and
prove nothing; delete those exact lines and use:
- Positive trigger present: `expect(out).toMatch(/remember/i)`.
- Deference clause present (deterministic proof the opt-in carve-out shipped): a match for the
  deference intent, e.g. `expect(out).toMatch(/unless[^.]*instructions/i)` (tune to the final
  prose, but assert the "unless … instructions" carve-out exists).
- Negative (regression guard for the flip): `expect(out).not.toMatch(/whenever you learn/i)`.
  (The old auto-memory string literally contains "whenever you learn", so this genuinely fails
  if the flip is reverted. `not.toMatch(/proactively/i)` is only a reintroduction guard — the
  deference clause itself may legitimately contain "proactively", so do NOT assert its absence
  on the auto-memory `out`; drop that negative here.)
- Index convention preserved but loosened: `expect(out).toMatch(/MEMORY\.md/)` and
  `expect(out).toMatch(/index/i)`.
- Mechanism preserved: keep `expect(out).toContain("Write/Edit")`.
- Keep ALL existing loading/structure assertions green untouched (header `# Auto memory`,
  `Memory directory:`, content injection, absent-content case, disabled→omitted case). These
  are the proof that loading is unchanged — do not weaken them.

In `test/builtin-agents.test.ts` the per-agent string is only observable inside the full
dispatch prompt, which ALSO carries the `# Auto memory` section — so a whole-prompt
`toMatch(/remember/i)` is a FALSE GREEN (satisfied by the auto-memory section even if the
per-agent string was not flipped). To actually prove the per-agent flip, assert on a phrase
UNIQUE to the old per-agent string that no other section contains:
`expect(prompt).not.toContain("You may persist")` (the current per-agent string is "You may
persist durable knowledge…"; it fails pre-flip, passes post-flip, and cannot be satisfied by
the auto-memory section). Update the existing case around line 198 (currently
`toContain("MEMORY.md as the index")`) accordingly rather than adding beside it. Keep the
`# Agent memory` presence/absence and `skipProjectContext` (Plan omits `# Auto memory`) tests
green untouched.

Layer: pure unit for the auto-memory string; offline-integration dispatch-prompt layer for the
per-agent string (it is assembled inside dispatch, not exported). No e2e/live change — do NOT
add wording assertions to `test/e2e-live-pi.test.ts` (its `# Auto memory` check is a
loading proof and stays as-is). There is no deterministic way to test "model refrains from
writing on a normal task" (the e2e mock model only emits scripted tool calls); do not attempt
a behavioural test for it.

Cross-platform: assertions are on prompt strings only — no path/OS concerns.

## Acceptance criteria
- [ ] Both guidance strings instruct conservative, explicit-request-only writes and share one
      `MEMORY_WRITE_POLICY` constant; the auto-memory guidance no longer contains "whenever you
      learn".
- [ ] `MEMORY_WRITE_POLICY` contains a deference clause so a project's CLAUDE.md eager-write
      instruction overrides the conservative default; this clause is asserted deterministically.
- [ ] The per-agent flip is proven by a UNIQUE-phrase assertion (old "You may persist" gone),
      not a whole-prompt `/remember/i` that the co-injected auto-memory section satisfies.
- [ ] Memory loading/injection behaviour is byte-for-byte unchanged (all existing loading
      tests green).
- [ ] Brittle wording assertions in `memory.test.ts` / `builtin-agents.test.ts` are replaced
      (not supplemented) by the intent-level assertions.
- [ ] typecheck and full test suite green.

## Depends on
–
