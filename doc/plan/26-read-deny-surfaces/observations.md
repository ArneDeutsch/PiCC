# F26 observations

- 2026-07-16 **Planning assumption corrected empirically (t01).** The plan (and two
  reviewers) hypothesized that a `Glob/Grep {path:"secrets"}` (bare protected directory,
  no subsegment) might slip a `deny: Read(secrets/**)` because `**` "needs a segment
  under secrets/". WRONG: the glob engine treats `secrets/**` as covering the bare
  directory node, so `{path:"secrets"}` IS blocked (both Glob and Grep, deny + non-deny
  directions). The genuine residual gap is a read call with **no path** or `path:"."`
  (`Grep {}` / `Grep {path:"."}` → `default`) — no path to match, so best-effort can't
  fire; only a bare `deny: Read` (context removal) forecloses that content-exfil path.
  Pinned in tests; feature.md + t02 caveat corrected before t02 ran.
- 2026-07-16 **The change was ~1 line + one Set** because the matcher was already
  well-factored: `matchesRule`'s switch dispatches on `rule.tool` (not the call's tool),
  and `pathSpecifierMatches` reads `file_path ?? path ?? notebook_path` field-agnostically.
  So expanding `ruleToolMatches` for `Read` was the only production change needed — the
  same clean seam the Edit family already used. Good prior design paid off.
- 2026-07-16 **Strict monotonicity is the load-bearing safety property.** The expansion
  only ADDS deny-matches; `grantMatches` (the sole tool-adding path in gateTools) uses
  `toolNameMatches`, untouched — so a widened `allow: Read` can never grant Grep. Three
  reviewers independently confirmed the change cannot weaken any existing deny.
- 2026-07-16 **Tooling friction (t01 fix pass):** the implementer's built-in Edit tool
  served a stale snapshot of `permissions-hardening.test.ts` (pre-t01 HEAD, 467 lines)
  that disagreed with the worktree's on-disk file (550 lines), causing exact-match Edit
  failures; the agent fell back to a Python-script edit against real content and (in its
  report) mislabeled the worktree path as the main-checkout path. Verified independently:
  edits landed in the worktree; main checkout stayed clean. Worth flagging as a
  worktree/tool-cache coherence rough edge.
- 2026-07-16 **Deferred (agreed with maintainer):** the Claude v2.1.208 behavior where a
  `Read` deny also blocks the `Edit` tool on the same path (inverse direction) — file as
  a follow-up ticket at close.
- 2026-07-16 **Parity depth note:** hook `if: Read(...)` widening is a PiCC-only surface
  (Claude's hook `matcher` is separate); no Claude-parity divergence. `ask: Read(...)`
  also widens but `permissions.ask` is degraded-noop, so it never prompts — docs must not
  imply otherwise.
