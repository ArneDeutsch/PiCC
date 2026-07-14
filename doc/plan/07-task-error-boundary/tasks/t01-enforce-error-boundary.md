# t01: Enforce the Resolved-Error Storage Boundary

## Goal

Resolved failed and aborted background dispatches retain bounded, single-line error text at the registry boundary, with focused regression coverage and a changelog record.

## Context & seams

`BackgroundTaskRegistry.start()` in `src/runtime/background-tasks.ts` settles fulfilled dispatch results. Its completed, aborted, and failed branches are distinct. The aborted and failed branches currently assign `result.error` directly after choosing an existing fallback, while the promise-rejection branch already passes error text through the module-local `capErrorText` helper.

Apply the existing helper's contract at both fulfilled error assignments. The helper collapses whitespace and Unicode control-character runs to one space, trims the result, and, when the normalized text exceeds 500 JavaScript string units, retains the first 500 and appends ` [truncated]`.

Preserve these boundary contracts:

- failed maps to status `failed`; aborted maps to status `stopped`;
- the nullish fallbacks remain exactly `subagent dispatch failed` and `subagent dispatch was aborted`;
- normalization happens after fallback selection, so an explicitly supplied empty string remains empty;
- completed result text and failed partial `finalMessage` remain verbatim;
- rejection handling and the stopped-task late-result discard remain unchanged.

Add direct registry coverage in `test/background-tasks.test.ts`. Tests must inspect the retained record rather than relying only on settlement-notice rendering, which independently normalizes output. Exercise a resolved aborted result without first calling `stop()`, because a stopped record discards its late result before this boundary.

Record the defense-in-depth fix under a Fixed heading in the existing Unreleased section of `CHANGELOG.md` without claiming a presently exploitable vulnerability or broader Claude Code behavior change.

## Writable surface

- `src/runtime/background-tasks.ts`
- `test/background-tasks.test.ts`
- `CHANGELOG.md`
- `doc/plan/07-task-error-boundary/log/t01.md`

Everything else is read-only.

## Approach constraints

- Reuse the existing module-local `capErrorText`; do not export, relocate, or duplicate it.
- Change only resolved failed/aborted error storage and its focused tests; do not redesign presentation or upstream dispatch normalization.
- Preserve all existing observable behavior except the intended normalization and cap for previously raw resolved errors.

## Left open

- The exact organization and naming of the focused tests.
- Whether hostile normalization and oversize coverage share one payload or use separate cases, provided both failed and aborted outcomes are covered directly.
- The concise wording and placement of the Unreleased changelog entry.

## Testing

At the registry unit layer, cover both resolved `failed` and resolved `aborted` outcomes with raw `Cc` control characters, mixed whitespace, and oversized error text. Assert exact stored normalization/cap behavior—including no truncation at exactly 500 string units and the first 500 units plus ` [truncated]` above the boundary—and unchanged status mapping. Cover the existing missing-error fallbacks directly, and prove that an explicitly supplied empty string remains empty under the existing nullish contract. Construct control bytes and line breaks in an OS-independent way.

Run `npm run typecheck` and the full `npm test` suite on Windows; the tests must remain platform-neutral for Linux CI.

## Acceptance criteria

- [ ] Every resolved failed or aborted dispatch error is normalized through the existing storage-boundary helper.
- [ ] Focused tests prove both outcomes remove control characters/collapse whitespace and cap oversized stored errors.
- [ ] Existing statuses, nullish fallbacks (including explicit empty-string preservation), completed output, failed partial output, rejection handling, and stopped late-result behavior remain unchanged.
- [ ] The Unreleased changelog accurately describes the narrow defense-in-depth fix.
- [ ] typecheck and full test suite green

## Depends on

–
