# 25-native-safe-temp-paths: Native-safe cross-tool temp paths on Windows

Ticket: ArneDeutsch/PiCC#48

## What

Make a temp file written through the harness's shell (Bash tool) on Windows readable
by the harness's native file tools (`Read`/`Grep`/`Glob`) on the **first attempt**,
by giving the harness a documented, detection-driven contract for producing a path
string that both namespaces resolve to the same real file.

Observable behavior:

- A subagent that is handed a path to a temp file which the coordinator created via a
  Bash-tool redirect can `Read` it directly — no `ENOENT`, no drive-wide search, no
  recovery loop. This holds on Windows (where the Bash tool is a POSIX-emulation shell,
  Git Bash/MSYS) and continues to hold unchanged on Linux/macOS.
- The harness surfaces the contract to **every** project it runs — not just this repo. It
  mirrors Claude Code's own mechanism: a per-session native-safe scratch directory whose
  **literal resolved path** is injected into the system prompt with "use this instead of
  `/tmp`", on **all** platforms (this is what Claude Code does). The *Windows-specific*
  namespace note (the extra explanation of why a bare `/tmp` string fails there) appears
  only when the harness detects that its shell namespace differs from the native-tool
  namespace. PiCC *guides* every project this way and *guarantees* the Just-Works outcome
  for skills that adopt the recipe — the fix is honest guidance plus a fixed first
  consumer, not an automatic rewrite of paths a skill hard-codes.
- The `evaluate` skill — the first skill to hit this in a live dogfood — is **not
  modified**: once the harness injects the scratchpad, the model running evaluate uses that
  native-safe location instead of `/tmp`, exactly as it would under Claude Code. Treating
  our own skill as needing PiCC-specific adaptation would be the anti-pattern (a third-party
  skill would never get that adaptation); if guidance proves too weak for a skill, the fix
  is to strengthen the *harness guidance*, never the skill. Re-dogfooding evaluate on
  Windows is the acceptance witness.

### Non-goals (deferred / out of scope)

- **Session transcript retention** — tracked separately by #41. This feature concerns
  only the transient redirect/handoff files.
- **The UTF-8 vs UTF-16 redirect-encoding discipline** — already established (PowerShell
  `>` writes UTF-16LE the Read tool can't decode; the Bash-tool redirect writes UTF-8).
  Only the *path* handoff changes here; the encoding rule is untouched.
- **Automatic rewriting of arbitrary tool-input paths** (intercepting `Read`/`Grep`/`Glob`
  to translate `/tmp/...` → native — "approach B"). **Investigated in depth and deliberately
  rejected.** It is a divergence from Claude Code (whose file tools do *not* translate
  model-chosen paths — that seam is a known Claude bug it routes around via the scratchpad +
  a native PowerShell tool), and it adds real surface to the permission-critical guard:
  an MSYS path form can dodge a native deny rule unless translation runs before the check,
  and translating write paths into the pinned Git Bash install tree (`/usr/bin/…`) is an RCE
  primitive. The faithful, safe fix is scratchpad steering (this feature), not silent path
  rewriting. (If a narrowly-scoped, permission-safe translation is ever wanted, it is a
  separate, deliberate decision — not this feature.)
- **Non-Windows platforms and native Windows shells** need no path *fix*: on Linux/macOS
  the shell and native tools share one namespace, and a PowerShell redirect already
  writes native paths (its only issue is encoding, above). They still receive the faithful
  cross-platform scratchpad line (Claude injects it everywhere), but no Windows-specific
  namespace guidance and no path transformation.
- **Inventing a `CLAUDE_`-namespaced env var.** Claude Code delivers the scratchpad as a
  literal path in the system prompt, not an exported env var; PiCC mirrors that literal-path
  contract so a skill authored against it stays portable back to Claude Code, rather than
  minting a `$CLAUDE_SCRATCHPAD_DIR` that would be undefined there.

## Why

The first live dogfood of the `evaluate` skill on Windows failed exactly here. The
coordinator redirected an issue payload through Git Bash to a `/tmp/...` path; the file
was written correctly (UTF-8), but every evaluator subagent's first `Read` resolved the
literal string `/tmp/...` as a **drive-relative** path (`F:\tmp\...`) instead of the
shell's mount, so all five dispatches failed with `ENOENT`. The agents recovered only by
searching the drive for the file — burning context and tokens, producing tool errors and
empty results, with the workflow lens especially costly.

The root cause is a **string-interpretation** mismatch between the harness's pinned
POSIX-emulation shell and its native Node file tools: the same path string denotes two
different real files. Because PiCC is a harness meant to run *arbitrary* Claude-format
projects unchanged, this trap is latent for any project whose skills redirect via the
shell and then Read the file on Windows — so the fix belongs in the harness, reachable by
every project, not in one skill's local documentation. The `evaluate` skill is fixed as
the first consumer and the regression witness.

## Acceptance

- On Windows, a temp file written via the harness Bash tool (pinned Git Bash) and then
  read by a subagent `Read` using the path the contract prescribes succeeds on the first
  attempt — demonstrated by an integration test that exercises the real mixed-tool route
  (shell redirect → native read), not either side alone.
- The path the contract produces is unique and native-safe: no reliance on a drive-wide
  search and no hard-coded predictable filename.
- The harness delivers the contract to every project through a harness channel (guidance
  and/or a harness-provided native-safe temp location), and the Windows-specific guidance
  is injected only when the harness detects the shell↔native namespace mismatch.
- `evaluate` works on Windows **without modification**: the injected scratchpad steers it
  off `/tmp`, so its redirected bodies/comments/diffs land in the native-safe scratch dir
  and evaluators read them first attempt. Evidence: the mechanics are reproduced and the fix
  proven at the tool layer (t03 exercises the real Git-Bash-write → native-Read handoff on
  Windows, and the bug↔fix were manually reproduced during planning); a full live
  `evaluate` re-dogfood on Windows is a **post-merge smoke** (not run in this session, which
  runs under Claude Code, not the PiCC/GPT harness). (Reframing #48's
  skill-specific acceptance criteria: rather than adapt the skill to use a "safe path,"
  the harness makes the unmodified skill work — the more portable outcome. The ticket's
  temp-file *cleanup* criterion is handled at the harness/retention layer, deferred to #41,
  not added to the skill.)
- Unix (Linux/macOS) **path resolution** is unchanged: no path transformation and no
  regression in the existing suite. The only Unix-visible change is the faithful
  cross-platform scratchpad line that Claude Code also injects; there is no
  Windows-specific namespace guidance on Unix.
- The contract is documented where future skills and harness contributors will find it —
  primarily via the injected system-prompt scratchpad guidance that reaches every project
  (skill-author-facing), and secondarily in `doc/` for harness contributors — so the
  mismatch is not reproduced.

## Tasks

- t01 Harness scratchpad primitive — pure `toNativeSafeTempForm` helper + eager per-session
  scratch dir (literal native-safe path held for injection; no env var) (depends on: –)
- t02 System-prompt scratchpad injection — all-platform literal-path scratchpad section +
  Windows namespace note gated on detection (depends on: t01)
- t03 Windows mixed-tool integration test — real Git Bash redirect → native Read, first
  attempt (the #48 acceptance witness) (depends on: t01)
- t04 Capability registry scratchpad entry + `gen:capabilities` regen + contract docs +
  CHANGELOG (depends on: t02)
- t05 Close-review gap closure — subagent scratchpad injection + index.ts wiring-seam test +
  registry id/gap polish (depends on: t01, t02, t04)

(The evaluate skill is intentionally **not** modified — see What/Acceptance. Transparent
path translation, "approach B", was investigated and rejected — see Non-goals.)
