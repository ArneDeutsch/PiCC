# F07 Review: Defensive Background-Task Error Boundary

## Outcome

Resolved failed and aborted background dispatches now normalize retained error text through the existing storage-boundary helper, so whitespace and Unicode `Cc` control-character runs collapse and oversized errors are capped before any registry reader consumes them. Focused registry tests cover both paths and preserve existing statuses, fallbacks, explicit empty-string behavior, and partial-output handling. The implementation stayed within the planned narrow scope.

## Planning errors & spec gaps

The initial feature wording referred broadly to “control characters,” although the existing helper specifically normalizes whitespace and Unicode category `Cc`; plan review caught and corrected that overclaim. Close review also found that the first test payload contained only ASCII/C0 controls despite the Unicode-wide `Cc` acceptance language, so a non-ASCII C1 case was added. No implementation seam or task dependency was missing.

## Friction

Several plan reviewers proposed changing empty or normalized-empty errors to a fallback cause. That may be a defensible separate behavior improvement, but it conflicted with issue #3's exact nullish contract and narrow scope, requiring explicit triage rather than plan expansion. During task review, `git diff HEAD` omitted the newly created untracked execution log, causing every reviewer to flag possible log loss even though the file existed.

## Bugs discovered

None. The ticket itself described a latent defense-in-depth gap rather than a presently unsafe caller path, and development did not uncover another pre-existing defect.

## Improvement opportunities

Review prompts should pair `git diff HEAD` with `git status --short` and explicitly read expected task logs so untracked deliverables are visible. Security-sensitive acceptance wording should name exact Unicode categories rather than using broad terms such as “control characters.”

## Proposed follow-ups

- Update the `implement-feature` task-review instructions to include untracked writable-surface files, preventing false omission findings and real missed artifacts.
- Consider explicit fallback behavior for empty or normalization-empty failure causes as a separately scoped UX/parity decision; do not fold it into this defensive boundary change implicitly.
