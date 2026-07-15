# t02: issue-eval mode

## Goal
`references/issue-eval.md` exists and is linked from the router: given an open issue ref, the
coordinator redirects its content to a file (without reading it) and the shell-free evaluator runs the
L1 screen then the full rubric evaluation, and the coordinator drives a disposition —
confidence-gated close-with-canned-comment for clear slop/abuse, else keep-open with the evaluator's
bounded rating/importance comment — always confirming with the human before a close.

## Context & seams
- **Consumes** `references/evaluation-engine.md` (rubric + L1 screen + investigation/adversarial wave)
  and `references/write-discipline.md` (allow-list, sanitization, trailer, idempotency) from t01.
- **Target resolution (via the resident router gate, t01):** the router resolves `<N>`+`<target>` and
  looks up `gh api repos/<target>/issues/<N>`; a `pull_request` key means the router **auto-routes to
  pr-eval and announces it** ("detected a pull request — evaluating as a PR"). issue-eval never tells
  the user to type another command (there is none). Sanitization happens at that first `gh` touch
  (t01), a URL must match `target` or stop, and no-arg/bad-arg gets evaluate's own usage copy — all
  owned by the router gate; issue-eval consumes an already-resolved, sanitized issue whose raw
  body/comments sit in a temp file the coordinator has **not** read — the evaluator reads it.
- **Reachability:** `gh` installed + authed + `target` resolvable (evaluate needs read + comment/close
  auth, NOT a push remote — this differs from implement-feature's gate, which requires a pushable
  remote; do not import that precondition).
- **State short-circuits:** an already-closed issue → no close, offer the read only; never re-run
  destructively. Idempotency: before writing, scan comments for evaluate's own attribution-trailer
  marker; on a hit, report the prior evaluation URL and ask before re-evaluating. **The marker is
  attacker-forgeable** (a hostile issue can post a comment carrying evaluate's trailer to spoof
  "already evaluated"): treat the scan as a courtesy, never a security control — a forged/ambiguous
  marker may only cause a **conservative skip/ask**, never a destructive action and never a spurious
  re-close.
- **Disposition + consent (always confirm before a close — t01 gate; no autonomous mode):** show the
  per-criterion rating (the evaluator's bounded return, in the engine's canonical block), the reasoning,
  the disposition, and the **exact comment bytes**; confirm before ANY write — especially a close. The
  human may override the disposition. Post-hoc "I already closed it" is never acceptable. When the human
  points the agent at many issues, it simply asks per issue (that is re-prompting, not an unattended
  loop) — there is no `--yes`/autonomy token.
- **The close path (seam with security findings):**
  - Close only on clear-cut: `MALICIOUS_*` from L1, or a rating clearly below the slop threshold. Bias
    to keep-open when uncertain ("a wrongly-open issue is a one-click fix; a wrongly-closed one silently
    drops a real report").
  - **Invariant:** close ⟹ a **canned comment selected by category**, containing none of the target's
    text; keep-open ⟹ a model-authored rating; a keep-open never closes.
  - `gh issue close <N> --repo <target> --reason "not planned"` (fixed literal reason, never
    "completed"). Post the canned comment BEFORE the close so the reason is visible; both guarded by the
    idempotency scan. Close target is the invocation `<N>` only — never a `#N` seen in content.
  - Comments via `--body-file` from an OS-temp path outside any worktree; end every authored artifact
    with evaluate's attribution trailer; echo every write + URL.
- **Keep-open comment (secret-exfil-safe authorship):** the evaluator returns a **bounded structured
  rating** — per-criterion scores + short justification fields + an importance verdict — NOT free-form
  prose. The **coordinator composes** the posted comment from those structured fields (paraphrasing in
  its own words, applying leakage-stripping) and **never pastes the evaluator's returned text
  verbatim**. This matters because the evaluator has unrestricted `Read` (it can see `~/.pi`/`.env`);
  if a successful injection made it encode a secret into a free-text "rating", pasting verbatim would
  leak it to a public comment. Structured-return + coordinator-composes closes that path. Post via
  `--body-file` after confirmation; no verbatim excerpts of target content beyond neutral identifiers.

## Writable surface
- `.claude/skills/evaluate/references/issue-eval.md`
- `.claude/skills/evaluate/SKILL.md` (add the link + any resident issue-eval floor markers only)
- `test/evaluate-skill.test.ts` (add close-invariant / canned-comment floor markers)
Read-only elsewhere.

## Approach constraints
- No worktree/filesystem ops.
- Never reflect attacker-authored text into any public comment.
- The close-invariant (close⟹canned, keep-open⟹authored) is load-bearing — state it explicitly.

## Left open
- The exact slop threshold and how the rubric maps to close-vs-keep-open (within the engine's scale).
- Exact canned-comment templates per category and the keep-open rating format.
- How much specialist/adversarial fan-out a given issue warrants (proportionate to its complexity).

## Testing
- Unit floor markers in `test/evaluate-skill.test.ts`: the resident/issue-eval prose carries the
  close-invariant and canned-comment-selected-by-category language (loose, case-insensitive).
- Reference-link integrity stays green (link added with the file).
- typecheck + full suite green.
- Do NOT test LLM judgment or the `gh` writes themselves.

## Acceptance criteria
- [ ] A PR ref auto-routes to pr-eval with an announcement; issue-eval never emits a "use another
      command" hand-off.
- [ ] The skill confirms before any close and shows the exact bytes; there is no autonomous mode / no
      `--yes` token; the coordinator never reads the raw issue content (the evaluator does).
- [ ] Close uses `--reason "not planned"`, canned comment (no target text), close target = invocation
      `<N>`; keep-open posts an authored rating and never closes.
- [ ] Already-closed / previously-evaluated targets short-circuit idempotently.
- [ ] typecheck and full test suite green.

## Depends on
t01
