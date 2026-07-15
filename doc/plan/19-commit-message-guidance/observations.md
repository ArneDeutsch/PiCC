# F19 observations

Running record of friction, planning errors, bugs, and opportunities. Raw material for review.md.

- 2026-07-15 (plan review) — The adversarial `generalist` caught a real design flaw the
  investigation phase missed: making "match the repo's commit-message style" the *primary*
  directive is self-defeating in the exact repos this feature targets (terse PiCC/GPT-authored
  or empty histories). Fixed in-plan to "match … where it is richer" + a why-body floor for
  non-trivial changes. Lesson: for prompt-guidance features, always test the wording against
  the degenerate input it's meant to fix, not just the happy path.
- 2026-07-15 (plan review) — `generalist` also flagged a missing deference clause: a flat
  "only when the user asks to commit" contradicts skills (like implement-feature) that drive
  proactive commits. The sibling `MEMORY_WRITE_POLICY` already solved this with an "Unless this
  project's own instructions…" lead-in; the new bullet had ignored that precedent. Resolved with
  a lighter parenthetical trigger-scope ("by the user, or by a skill or project instruction").
- 2026-07-15 (plan review) — `user-experience` found the docs under-promised control: "cannot
  fully disable" is mechanically true (the text can't be deleted) but misleading (a later
  steering entry overrides the behavior). Reframed t02 docs to state the override path + a
  concrete commit-steering example. Lesson: honest-about-the-mechanism can still be
  dishonest-about-the-outcome.
- 2026-07-15 (t01 review) — `coder` noted the `--no-verify` prohibition, now folded into the
  Commits bullet, was unguarded by any test (pre-existing gap, not a regression). Added a cheap
  `toMatch(/--no-verify/)` durability guard. Good instance of a review turning a pre-existing
  latent gap into a one-line hardening.
