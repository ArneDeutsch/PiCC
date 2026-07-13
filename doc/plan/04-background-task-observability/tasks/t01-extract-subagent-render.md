# t01: Extract the shared subagent renderer into `subagent-render.ts`

## Goal

The Agent tool's TUI rendering (dispatch-call render, live/partial render, and final
badge/transcript/usage render) lives in a standalone module `src/runtime/subagent-render.ts`,
imported by `subagents.ts`. Behavior is **byte-for-byte unchanged** — this is a pure move so that a
later task can reuse the same renderer from `background-tasks.ts` without that file value-importing
`subagents.ts` (a boundary the codebase deliberately keeps; see the duplicated `capErrorText` and the
structural `BackgroundResultLike`/`UsageLike` mirrors in `background-tasks.ts`).

## Context & seams

- **Source of the move:** in `src/runtime/subagents.ts`, the block commented "t03 live-progress +
  result rendering helpers" — the width/theme helpers (`themedFg`, `themedBold`, `pushWrapped`,
  `pushColored`, `visibleWidth`/`truncateToWidth`/`clampLines` usage, `sanitizeInline`), plus
  `firstLine`, `formatUsageLine`, `outcomeBadgeLine`, `stripAgentTrailerForDisplay`,
  `renderAgentCall`, and `renderAgentResult`. Move the whole cluster.
- **New module `src/runtime/subagent-render.ts`** imports what the block needs: `truncateToWidth`,
  `visibleWidth`, `wrapTextWithAnsi` from `@earendil-works/pi-tui`; `sanitizeProgressText`,
  `formatUsageCompact`, `renderProgressText`, `type ProgressSnapshot` from `./subagent-progress.js`;
  `isAgentId` from `../util/subagent-transcripts.js`. Keep the module **free of any import from
  `subagents.ts`** (no cycle: subagent-render → subagent-progress + pi-tui only).
- **Exports (public contract for later tasks):** `renderAgentCall`, `renderAgentResult`. Export the
  smaller helpers only if `subagents.ts` still needs them directly; prefer keeping them module-private
  and moving their sole callers along with them.
- **`subagents.ts` after the move:** imports `renderAgentCall`, `renderAgentResult` (and any helper it
  still calls) from `./subagent-render.js`; `createAgentToolDefinition`'s `renderCall`/`renderResult`
  delegate exactly as before. No other behavior touched — do **not** modify the dispatch/execute or
  background branches in this task.
- **Do not move `progressActivityLine`** in this task (it lives near the render block but belongs with
  the progress plumbing; t02 relocates it).

## Writable surface

- `src/runtime/subagent-render.ts` (new)
- `src/runtime/subagents.ts` (remove the moved block; add the import; nothing else)
- `test/runtime-core.test.ts` — only if an existing render test imports a moved symbol directly and
  the import path must change. Do not add new assertions here.

## Approach constraints

- Pure refactor: no behavior, wording, or width/sanitize-logic changes. The existing render tests
  (the "no overflow" matrix, the sanitize/footer/badge tests) must pass **unchanged** in substance.
- Preserve every comment that documents a security/width invariant on the moved code.

## Left open

- Exact split of which helpers stay private vs. are exported (minimize the public surface).
- Whether `renderProgressText` (already in `subagent-progress.ts`) is re-exported for convenience.

## Testing

- No new tests. `npm run typecheck` and the full suite green, proving the move is behavior-preserving.
- If a render test imported a now-moved symbol, repoint the import; assertions unchanged.

## Acceptance criteria
- [ ] `renderAgentCall`/`renderAgentResult` live in `src/runtime/subagent-render.ts`; `subagents.ts`
      imports them; no import cycle; `background-tasks.ts` untouched.
- [ ] No behavior/wording/width/sanitize change; existing render tests pass unchanged in substance.
- [ ] typecheck and full test suite green.

## Depends on
–
