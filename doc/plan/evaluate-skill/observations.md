# Observations — evaluate skill

Running record of friction, bugs, and opportunities. Dated bullets, one line each; raw material for review.md.

## t01 — foundation (2026-07-15)

- **Deny floor is best-effort, not a boundary.** A `*`-anywhere Bash matcher can't express "flag in any
  position", so `gh api` write coverage is inherently incomplete (leading-flag + long-form forms were
  bypassable until broadened; residual forms remain). The real controls are the shell-free `evaluator`
  sandbox (structural) + the trusted-coordinator envelope discipline — the floor is defence-in-depth.
- **Redirect isolation rests on an unverified harness premise.** "Coordinator never reads raw content"
  assumes `gh … > file` returns empty stdout to the Bash tool. Sound by construction, but not
  runtime-confirmed offline — needs one live `gh` smoke test before the "dual-LLM quarantine" framing is
  fully relied on. (Deferred; candidate for a user-run smoke test, like the F14 pattern.)
- **Test gotcha (reusable):** per-skill frontmatter parse diagnostics live on `skill.diagnostics`, NOT
  in `loadSkills`'s top-level `diagnostics` array — a "loads clean" test must assert `skill.diagnostics`
  directly or it silently misses malformed frontmatter.
- **Spec friction:** an exact-file-count test pin (`toEqual([...two refs])`) would have forced a
  mandatory test edit in every later task; relaxed to a glob/superset check. Note for future task specs:
  prefer count-agnostic structural assertions when later tasks extend the same surface.
- **Carried-forward safety constraint:** the `evaluator` has unrestricted `Read` (can see `~/.pi`/`.env`),
  so its return must be a bounded *structured* rating the coordinator *composes* the comment from —
  never pasted verbatim — else a successful injection could exfiltrate a secret into a public comment.
  Folded into t02's keep-open-comment spec.
