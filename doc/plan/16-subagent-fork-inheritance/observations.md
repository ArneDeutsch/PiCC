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
