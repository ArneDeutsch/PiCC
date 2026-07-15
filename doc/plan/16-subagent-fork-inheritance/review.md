# F16 Review: Task `subagent_type: "fork"` — parent-conversation inheritance

## Outcome

Shipped a real Task-tool `subagent_type: "fork"` that inherits the parent
conversation, resolving issue #28 via its option 1. A main-session fork is seeded
with the parent's full message history (native `SessionManager.forkFrom` into a
brand-new persisted child transcript — the parent transcript is never touched),
runs with the parent's model and tools and a same-context system-prompt
*reconstruction*, and keeps output isolation. The feature is gated by
`CLAUDE_CODE_FORK_SUBAGENT` (=1 on / =0 explicit degrade / unset ⇒ enabled), forks
are non-resumable, and a fork cannot spawn another fork (runtime-set marker).
Everything PiCC can't fully reach degrades **visibly** (fork-specific footer +
honest sync-path badge), never the old silent inversion. The capability registry
gains a truthful `tool.Agent.fork` entry at tier **partial**, with all divergences
disclosed in the registry, research §2.9, CHANGELOG, README, and the user guide.

Delivered in three tasks (t01 dispatch core, t02 fork-spawns-fork marker + a reorder
fix, t03 registry/docs) plus close-review polish. No deviation from the approved
scope; the deferred edges were disclosed up front and accepted by the maintainer.

## Planning errors & spec gaps

- **The `forkFrom` reorder trap was not seen at plan time.** t01 finalized the fork
  identity and built the child tools *before* attempting `forkFrom`, so a
  `forkFrom` throw left a stale `Agent(fork)` badge and (once t02 threaded the
  marker) would have fork-marked a degraded run. Caught in t01 review, resolved in
  t02 by moving the fork-session construction ahead of `customToolsFor`.
- **The eager-`forkFrom` disk write was invisible until the SDK was read.** The
  plan assumed `forkFrom` was cheap/lazy; it is eager + synchronous (writes a full
  copy of the parent conversation at construction). t02's first cut placed it at the
  interception point, ahead of the abort/SubagentStart-block gates, orphaning
  full-conversation copies on aborted/blocked forks. Fixed by relocating the call to
  after all gates (file never created for an aborted/blocked dispatch).
- **"Visible degrade" was initially model-only.** The first t01 spec surfaced the
  degrade via a diagnostic + prompt prefix — which reach the model and logs but not
  the developer's terminal. Corrected to a rendered footer + sync-path badge.
- **feature.md's "context:fork untouched" non-goal over-claimed.** A `context: fork`
  skill that also names its agent literally `fork` routes into this inheriting-fork
  path (reserved-name collision). Now disclosed (feature.md non-goal + §2.9).

## Friction

- The feature sits on a subtle, multi-stage dispatch method; each change (interception,
  session-manager branch, marker threading, reorder) needed careful placement relative
  to abort/hook/permission gates. Reading the Pi SDK source (`SessionManager.forkFrom`)
  was essential and not optional — the eager-write behavior is undocumented.
- CRLF warnings on every commit (Windows worktree) — cosmetic, `.gitattributes` handles
  the committed bytes.

## Bugs discovered

- **Pre-existing flaky test:** `test/hook-runner-parallel.test.ts` has a
  concurrency-timing assertion (`elapsed < 2300`) that fails only under full-suite
  load and passes in isolation. Unrelated to this feature; surfaced repeatedly during
  the many suite runs. Worth de-flaking (raise the bound or make it load-tolerant).
- No product bugs found in existing code.

## Improvement opportunities

- **Constant drift risk (fixed here):** `FORK_DEGRADE_PREFIX` was duplicated across
  `subagents.ts` and `subagent-render.ts` with only a "MUST match" comment; hoisted to
  the shared util at close.
- **Background-path result badge:** a degraded *backgrounded* fork badges `Agent(fork)`
  (the badge derives from the eagerly-captured requested type), while its footer
  correctly says it ran fresh. Documented as sync-path-only badge honesty; the footer
  is the reliable cross-surface discriminator. Making the background badge reflect the
  resolved agent is a small, isolated follow-up.
- **`CLAUDE_CODE_FORK_SUBAGENT=` (set but empty)** is treated as off, not unset —
  consistent with the "present-but-off value" wording, mildly surprising vs. the
  "unset ⇒ enabled" framing.

## Proposed follow-ups

1. **Live-model smoke test of fork inheritance + system-prompt reconciliation.**
   Inheritance is proven at the real on-disk `SessionManager.forkFrom` layer (child
   carries the parent history, parent file byte-identical), but not yet end-to-end
   against a live model — specifically whether Pi cleanly reconciles the reconstructed
   `systemPromptOverride` with a seeded transcript (no doubled/conflicting system
   prompt). This is the one residual risk behind fully trusting #28; recommend one live
   run before closing #28 (matches the F14/F15 "keep open pending a live smoke" pattern).
2. **Support `isolation: "worktree"` as an Agent/Task tool dispatch argument.** Broader
   than F16: PiCC's Agent tool has no per-dispatch `isolation` param at all, so *no*
   subagent (fork or not) can be worktree-isolated via a tool argument. A fork with
   `isolation:"worktree"` is therefore not honored (disclosed).
3. **Background-path fork degrade badge** — make a degraded backgrounded fork badge the
   resolved agent (`general-purpose`) instead of the requested `fork`, so the badge is
   honest on both surfaces (footer already is).
4. **Subagent-transcript retention/cleanup.** A fork persists a full on-disk copy of the
   parent conversation (same trust zone/lifecycle as existing subagent transcripts); the
   secrets-at-rest footprint grows one copy per honored fork. Broader than F16 — worth a
   retention/cleanup policy across all subagent transcripts.
5. **De-flake `hook-runner-parallel.test.ts`** (timing assertion under full-suite load).
6. **Verify Claude's `agent: fork` skill behavior** to confirm PiCC's reserved-name-wins
   resolution of the `context:fork`+`agent:fork` collision is faithful (currently
   INFERRED/disclosed).

## Process notes (for the workflow itself)

- Reading the third-party SDK source caught two real bugs (the reorder trap's
  consequences and the eager-`forkFrom` disk write) that no amount of black-box review
  would have. When a feature leans on an external primitive's side effects, read its
  implementation, not just its type signature.
- The multi-lens close review (adversarial generalist + coder + security + parity +
  tester) each found distinct, real issues; none was redundant. The security lens
  reading the SDK was the highest-value single pass.
