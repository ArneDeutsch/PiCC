<!--
  Fill in each section. See CONTRIBUTING.md → "Pull requests" → "Manual verification"
  for the full verification contract this template surfaces.
-->

## Summary

<!-- What changed and why, in a few lines. Note any capability-registry or documentation updates. -->

## Automated checks

- [ ] `npm run typecheck` is green
- [ ] `npm test` is green

CI runs the same across Windows/Linux on Node 22 and 24.

## Manual verification guidance

<!--
  The plan a reviewer follows to verify this change in the running app. Be concrete, not a vague
  "try it out": name the branch, how to launch picc against a named examples/ project
  (e.g. `cd examples/hello-claude && node ../../bin/picc.mjs`), the exact in-app steps, and the
  observable outcome to expect.

  Escape: if this change has no runtime surface to drive — a docs-only change — or is fully and
  genuinely covered by automated tests, delete the steps below and write instead:
    "no manual verification needed: <reason>" (name the covering tests if that is the reason).
  Note: a skill / harness / prose change is NOT exempt — picc executes it, so it has a runtime
  surface and must give steps.
-->

### Start your review here

1.
2.

**Expected observable outcome:**

- [ ] The verification guidance above is filled in — **or** this change is exempt (escape written above).

## Manual-verification comment

- [ ] After running the steps above myself, I will post a **manual-verification comment** on this PR
      recording what I ran by hand and observed, on which OS/shell, and anything I could not verify —
      **or** the change is exempt (see the escape above) and needs none.
