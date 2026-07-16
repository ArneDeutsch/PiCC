# t04: Runtime discoverability — /doctor nesting posture + guard-error remedy

## Goal

The main-session-only default is no longer a silent behavior change. `/doctor`
always shows a subagent nesting-posture line (main-session-only at the default;
the actual configured value when `subagents.maxDepth` is raised) plus how to opt
into nesting, and the runtime depth-guard error names `subagents.maxDepth` and the
remedy. Typecheck and the full suite are green.

## Context & seams

**Line numbers are from a snapshot — locate by content.**

(A) **`/doctor` posture line** — `renderDoctorReport(project, report)` in
`src/registry/compat-report.ts:~359-403` builds the text via `lines.push(...)` /
`lines.join("\n")`. It has always-present sections (header, findings-or-none,
unassessed-or-none, support matrix). Settings are in scope via
`project.settings.subagentMaxDepth` and `project.settings.subagentsEnabled`
(`src/types.ts:~300-301`) — no signature change needed.

- Add an **unconditional** posture line in the header block (after the
  `Project: ${project.root}` line, before the trailing blank). Do **not** invent a
  `CompatFinding` — this is informational, not a declared-but-degraded finding.
- At render time you only see the *effective* number, not whether it was explicitly
  set. Branch on the value:
  - `subagentMaxDepth === 1` → main-session-only wording, e.g. *"Subagent nesting:
    main-session-only (subagents.maxDepth=1, PiCC default; Claude Code nests up to
    5). Raise subagents.maxDepth to 2..5 in .claude/settings.json to allow nested
    delegation."*
  - `subagentMaxDepth >= 2` → reflect the configured value, e.g. *"Subagent
    nesting: up to N level(s) below the main session (subagents.maxDepth=N)."*
  - Consider `subagentsEnabled === false` (all delegation off) → a short "subagent
    dispatch disabled (subagents.enabled=false)" variant, so the line is never
    misleading. Keep wording consistent with t02/t03 ("PiCC extension",
    "main-session-only").

(B) **Guard-error remedy** — `src/runtime/subagents.ts:~896`, currently:
`` error: `Subagent nesting depth ${opts.depth} exceeds the configured maximum of ${this.deps.maxDepth}.` ``
Only `opts.depth` and `this.deps.maxDepth` are in scope (no enabled flag — that's
fine; a depth-guard hit means dispatch is already enabled). Reword to also name
`subagents.maxDepth` and the remedy (raise it to 2..5 to allow nested delegation).
**Keep the substring "depth"** — `runtime-core.test.ts:~473` asserts
`toContain("depth")`.

## Writable surface

- `src/registry/compat-report.ts` (the posture line in `renderDoctorReport`)
- `src/runtime/subagents.ts` (the guard-error string only — this is the one place
  t01 deliberately did not touch; it is yours)
- `test/registry.test.ts` (new `renderDoctorReport` posture-line cases)
- `test/runtime-core.test.ts` (extend the depth-cap guard test)
- `doc/plan/22-main-session-only-default/log/t04.md`

Do **not** change enforcement logic, the settings default (t01), the registry
capability notes (t02), or prose docs (t03).

## Approach constraints

- The `/doctor` line is **always present**, reads the *effective* configured value,
  and is never misleading across the default / raised / disabled states.
- No new runtime dependency threaded into `SubagentRuntime` for the error (use
  `maxDepth` alone).
- Wording consistent with the registry/doc wording from t02/t03.
- No `CompatFinding` fabrication; no signature changes to `renderDoctorReport`.

## Left open

- Exact phrasing of the posture line and the reworded error (implementer authors
  them within the constraints above).
- Whether the disabled-state (`subagentsEnabled === false`) variant is a distinct
  line or folded into the default wording — implementer's call, as long as it's not
  misleading.

## Testing

- **Unit (`test/registry.test.ts`, `describe("renderDoctorReport")`, ~:882-912):**
  using `makeProject({...})` to set settings, assert the posture line for (a) the
  default `subagentMaxDepth: 1` → "main-session-only" text, and (b) a raised value
  (e.g. `3`) → reflects the configured value. Existing doctor tests use `toContain`
  (no snapshots), so additions won't break them.
- **Unit (`test/runtime-core.test.ts`, ~:469-474):** extend the real-guard test to
  `toContain("subagents.maxDepth")` and the remedy phrasing, still containing
  "depth".
- No exact-output/snapshot `/doctor` tests exist to update.

## Acceptance criteria

- [ ] `/doctor` always shows a subagent nesting-posture line; at the default it says main-session-only and names `subagents.maxDepth` + the 2..5 opt-in; when raised it reflects the configured value.
- [ ] The runtime depth-guard error names `subagents.maxDepth` and the remedy, and still contains "depth".
- [ ] Tests cover the posture line (default + raised) and the reworded guard error.
- [ ] typecheck and full test suite green.

## Depends on
t01 (the default must be 1 so the "PiCC default" posture wording is truthful)
