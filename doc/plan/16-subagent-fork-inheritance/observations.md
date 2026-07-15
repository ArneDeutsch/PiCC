# F16 observations

Running record of friction, planning errors, bugs, and opportunities. Raw material
for review.md. Dated bullets, one line each.

## Planning (Phase 4–6)

- 2026-07-15: Pi SDK already ships `SessionManager.forkFrom(sourcePath, cwd, sessionDir?, {id})` — a native fork-from-transcript primitive; no need to hand-roll copy-then-reopen. The whole feature hinges on it.
- 2026-07-15: Security review caught a real exfiltration path — `getMainSessionFile()` always returns the ROOT transcript, so a nested-subagent fork would inherit the root conversation. Fixed at plan time by restricting inheritance to main-session (depth-1) dispatches. Both security and generalist and coder converged on this independently.
- 2026-07-15: "Visible degrade" was initially specced as diagnostic-in-details + prompt-prefix, which reach only the model and logs — `renderAgentResult` never reads `.diagnostics`/`.note`. UX review caught that "visible to the developer" was aspirational; plan now requires a result footer + honest badge. (Same details-only limitation may apply to F15's degrade note — flagged for review.md.)
- 2026-07-15: System prompt can only be a same-context reconstruction (PiCC doesn't own Pi's assembled base prompt) → registry tier `partial`, not `full`. Consequence: fork loses the prompt-cache cost saving a byte-identical fork gets.
- 2026-07-15: Fork-mode's documented `run_in_background`-removal side effect deliberately NOT adopted (F15 already delivers background-by-default; `run_in_background:false` retained as a sync selector) — disclosed, not silently dropped.

## t01 implementation & review (Phase 7)

- 2026-07-15: t01 landed green (full suite 1106/16, +19 tests). Genuine inheritance proven at the REAL `SessionManager.forkFrom` layer (not a stub), incl. parent-transcript byte-identical before/after and child-file token presence. All 5 reviewers (coder/security/tester/ux/parity) PASS.
- 2026-07-15: **Ordering trap** — `customToolsFor` + fork identity are finalized *before* `forkFrom` is attempted, so a `forkFrom` throw leaves stale `isFork=true` tools + `Agent(fork)` badge on a run that degraded. Cosmetic-only in t01 (footer stays honest; isFork not yet threaded into customToolsFor); becomes a real marker bug once t02 threads it. Deferred to t02 with an explicit reorder requirement added to its spec.
- 2026-07-15: **Background badge can't distinguish success/degrade** — the backgrounded result badge derives from the raw requested `subagent_type` ("fork"), so both success and degrade badge `Agent(fork)`; the FOOTER line is the reliable cross-surface discriminator. feature.md/log wording corrected (didn't expand into read-only background-tasks.ts).
- 2026-07-15: **Path-to-model leak** — forkFrom-throw reason (with a possibly-absolute session path) was injected into the model-facing prompt; fixed to keep the raw detail in the developer diagnostic only. (Developer-facing footer paths are local output, not a public write — acceptable.)
- 2026-07-15: Minor parity notes for t03 registry truthfulness: a per-call `model` arg (not just `CLAUDE_CODE_SUBAGENT_MODEL`) also overrides a fork's inherited model; the degenerate `context:fork` skill with `forkAgentType:"fork"` would route into the F16 path (flagged for t02's guard design).
- 2026-07-15: Deferred/accepted: offline real-`picc()` proof of system-prompt reconstruction (spec permitted the t03 caveat instead); a backgrounded-fork-degrade end-to-end TaskOutput render test (generic diagnostics→TaskOutput plumbing is pre-existing/covered).

## t02 implementation & review (Phase 7)

- 2026-07-15: t02 (fork-spawns-fork guard via runtime-set `dispatcherIsFork` marker + resolution of t01's forkFrom-throw trap) landed green. Marker anti-spoofing, per-dispatch scoping, guard non-bypassability all PASS (coder/security/tester).
- 2026-07-15: **Real bug caught by security (SDK source read):** `SessionManager.forkFrom` is EAGER+SYNCHRONOUS — it writes a full copy of the parent conversation to disk at construction. t02's first cut moved that construction to the interception point, ahead of the abort/SubagentStart-block/abort-after-worktree gates → an aborted/blocked fork orphaned a full-conversation transcript on disk, and a SubagentStart hook meant to block the fork no longer stopped the seed from hitting disk. Fixed by RELOCATING the forkFrom call to just before `customToolsFor` (after all three gates) so the file is never created for an aborted/blocked dispatch — strictly safer than dispose-on-early-return (no Windows unlink/partial-write edge cases). Accepted cosmetic: a rare forkFrom-throw reports "fork" in the SubagentStart payload (result badge stays honest).
- 2026-07-15: **PROCESS/latent-bug note for review.md:** the eager-forkFrom-before-gates class of bug is subtle — it only surfaces by reading the SDK's forkFrom impl. Worth a capability/architecture note that Pi's `SessionManager.forkFrom` writes eagerly, so any future caller must place it after all abort/permission/hook gates.
- 2026-07-15: tester SHOULD added: a genuine-fork→normal-child→fork-grandchild scoping regression test now guards the load-bearing call-site line (recomputed `isFork`, not `opts.dispatcherIsFork`, into `customToolsFor`) — a plausible "simplification" would have mis-refused a fork's normal grandchild's own fork.
- 2026-07-15: minor: the fixture caps `subagents.maxDepth` at 2; the depth-3 scoping test raises/restores it via a temp-dir copy (examples/ untouched).

## t03 registry/docs & review (Phase 7)

- 2026-07-15: t03 (registry tier `partial` + research §2.9 + stale-doc sweep + CHANGELOG + matrix regen) landed green (1113/16/0). docs + claude-parity reviews PASS; registry note verified truthful against shipped code and Claude docs, single-line, tier correct.
- 2026-07-15: docs caught one residual stale claim t03 missed — `doc/design/pi-integration.md:82` (§3.4) "each subagent: fresh in-memory session" (the same file's :39 was fixed). Coordinator fixed directly. Also reflowed a user-guide sentence (capitalized orphaned "dispatch") and tightened the CHANGELOG "silently" wording (a generic unknown-type warning DID fire pre-F16; only the fork-semantics loss was unsignalled).
- 2026-07-15: **FOLLOW-UP candidate (review.md):** claude-parity flagged that `isolation:"worktree"` on a fork isn't honored — but this is a BROADER gap: PiCC's Agent tool has no per-dispatch `isolation` parameter at all (worktree isolation is an agent-frontmatter feature), so NO subagent (fork or not) can be worktree-isolated via a Task/Agent tool argument. Out of F16 scope; worth a ticket ("support `isolation` as an Agent-tool dispatch argument").
- 2026-07-15: minor accepted (disclosed in code + registry): rare `forkFrom`-throw fires SubagentStart with `subagent_type:"fork"` before re-resolving to general-purpose; result badge stays honest. Model-model-override parity (whether Claude applies CLAUDE_CODE_SUBAGENT_MODEL on top of a fork's inherited model) is under-specified in Claude docs; PiCC applies its normal resolution chain and discloses it.
