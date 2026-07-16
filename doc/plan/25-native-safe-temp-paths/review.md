# 25-native-safe-temp-paths Review: Native-safe cross-tool temp paths on Windows

## Outcome

Shipped a harness-level fix for issue #48 (a Windows Git-Bash↔native-Read temp-path
mismatch that broke the first live `evaluate` dogfood). The harness now mirrors Claude
Code's per-session **scratchpad**: it creates one eager native-safe scratch dir
(`CLAUDE_CODE_TMPDIR || os.tmpdir()` → `mkdtempSync` → `realpathSync` →
`toNativeSafeTempForm`, the last converting to the forward-slash drive-letter form both
namespaces resolve identically on Windows) and injects its **literal path** into the
system prompt every turn — on all platforms, for the main session **and** subagents —
with Claude's emphatic "always use this instead of `/tmp`" directive plus, on the Windows
namespace split, a note pinning the safe recipe. No env var (Claude has none — a literal
path keeps a skill portable), no path rewriting, no skill changes.

Deviation from the original plan: substantial and deliberate. The plan **pivoted twice**
during Phase 6 under maintainer challenge — (1) from a fabricated `CLAUDE_SCRATCHPAD_DIR`
env var to Claude's literal-path contract; (2) the maintainer's portability challenge led
to investigating "approach B" (transparent MSYS→native path translation in the file
tools), which was then **rejected** as a Claude divergence + a permission-guard RCE/bypass
risk, landing on scratchpad-steering only (approach A). The `evaluate` skill, originally a
task (rewire + cleanup), was **dropped** entirely — the harness makes it work unmodified,
which is the more portable outcome. Final scope: 5 tasks, harness-only.

## Planning errors & spec gaps

- **Env-var-first design was wrong from the start.** The first plan minted
  `$CLAUDE_SCRATCHPAD_DIR` — a `CLAUDE_`-namespaced contract Claude doesn't define, a
  reverse-portability trap. Caught only at Phase 6 by the UX + parity reviewers observing
  Claude's actual (literal-path, no-env-var) section. Lesson: for a parity feature, verify
  the real Claude surface **before** designing the mechanism, not at plan review.
- **The "adapt our own skill" instinct (t05-original) was a design smell.** The maintainer
  named it: if our skill needs PiCC-specific adaptation, a third-party skill won't get it —
  so the fix belonged in the harness. This should have been the Phase-1 framing.
- **Close review found two seam gaps the per-task reviews missed** because each was
  whole-vs-parts: subagents weren't threaded the scratchpad (only the main session), and
  the index.ts computation/threading had no revert-catching test. Both are classic
  "the parts pass, the assembly doesn't" holes — argues for the adversarial whole-diff pass
  always being part of close.
- Two spec inaccuracies caught by implementers: the read tool's `execute` param is `path`,
  not `file_path` (t03); and a Linux-CI booted test cannot observe the win32-only
  realpath→transform order swap, so a pure helper test was also required (t05).

## Friction

- The feature took an unusually long planning arc (two full design pivots + a dedicated
  approach-B investigation) before any code. That was the *right* cost — each pivot removed
  real risk (a portability trap, then an RCE surface) — but it shows how much a
  faithful-parity fix depends on getting the "what does Claude actually do" fact nailed
  early.
- `os.tmpdir()` / `CLAUDE_CODE_TMPDIR` are harness-trusted (settings.json can't reach
  `process.env`), which was load-bearing for dropping the env-var-poisoning concern — worth
  a standing note that project `settings.env` never mutates the harness process env.

## Bugs discovered

- The #48 root cause itself: a string-interpretation mismatch (native Read resolves
  `/tmp/x` drive-relative to `F:\tmp\x`), reproduced live during planning and now guarded
  by t03 (real Windows mixed-tool route) + t01's deterministic pure table.
- No pre-existing code bugs fixed here; the fix is additive harness guidance.

## Improvement opportunities

- **`examples/full-surface` has no scratchpad-consuming skill.** A fixture that writes to and
  reads back the injected scratch path would lock this parity surface against regression
  end-to-end (flagged by parity + tester).
- The per-session scratch dir is **never cleaned up** and now accrues one `picc-scratch-*`
  dir per activation on **every** platform (incl. per print-mode run). Claude leaves its
  scratchpad too (retention is #41), so deferred — but it's now cross-platform disk hygiene,
  worth folding into #41's scope or a best-effort exit sweep.
- The `!`cmd`` shell-injection env (`shell-inject.ts`) isn't covered by the scratchpad
  contract; a future skill writing temp via `!`cmd`` on Windows would still hit `/tmp`. Safe
  for evaluate (zero `!`cmd`` uses) but an unassigned coverage edge.

## Proposed follow-ups

1. **Stale "OS-temp path" phrasing in `implement-feature`'s own docs**
   (`SKILL.md:71`, `references/ticket-creation.md:129`, `references/ticket-integration.md:46`)
   — the same vague recipe this feature warns against, which can reproduce #48 in the very
   coordinator skill. Runtime guidance now saves it, but the written recipes should be
   updated to reference the scratchpad. *Small doc fix; good first follow-up ticket.*
2. **Live `evaluate` re-dogfood on Windows (post-merge smoke)** — the one end-to-end proof
   not runnable in a Claude-Code session; confirms a GPT model under PiCC actually follows
   the scratchpad steering.
3. **`Read`/`Grep`/`Glob` `file_path` alias parity** — the Pi read `execute` takes `path`
   and throws on `file_path`-only; verify a Claude-authored skill that instructs `file_path`
   still works (likely a non-issue since the model follows the Pi tool schema, but unverified).
4. **A `/doctor` / startup hint when `shellNamespaceDiffersFromNative()` fires** — the human
   who'd trip the trap currently gets no proactive signal (the scratchpad reaches the model,
   not the maintainer). Cheap, detection already exists.
5. **Scratchpad-dir cleanup / retention** — fold the cross-platform accrual into #41.
6. **A `full-surface` fixture exercising the shell-write → native-read handoff** (see above).

*The approach-B (transparent path translation) investigation is preserved in
`observations.md` should it ever be reconsidered as a separate, deliberate, permission-safe
feature — it is out of scope here by decision, not oversight.*
