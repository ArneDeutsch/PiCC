# t01: Unify Runtime Identity Messages

## Goal

TaskStop results, settlement-notice headers, and SendMessage resume acknowledgments use one compact, safe identity vocabulary while preserving every existing lifecycle, schema, and delivery behavior.

## Context & seams

The canonical plain-text identity is exactly `Task(task-N) · Agent(<display-type>) · agent-<id>` for normal valid records. Each target appends only its existing outcome or actionable guidance after that identity:

- `createTaskStopTool` retains its three distinct outcomes: already settled, cooperative abort requested, and marked stopped without cooperative abort support.
- `buildSettlementNotice` changes only its trusted metadata header; its outcome mapping, error handling, informational warning, retrieval guidance, transcript reference, untrusted-output frame, caps, defanging, stopped-result suppression, and delivery/dedup behavior remain unchanged.
- The settled-agent branch of `createSendMessageToolDefinition` retains immediate acknowledgment, prior-context resume, a new task id, the same agent id, and TaskOutput retrieval guidance. Its wording says that resume has started rather than claiming the resumed dispatch already succeeded.

Create a small dependency-light `src/runtime/background-identity.ts` utility exporting a pure `formatBackgroundTaskIdentity` formatter. Both target runtime modules import downward from it; neither gains a value import from the other. The formatter accepts task id, displayed type, and stable id and never parses the internal `agent:<type>` label.

For background records, preserve F04's established displayed/requested-type source: `agentType ?? agentName ?? "subagent"`. For resume, use the registry's clean resolved agent name. Requested labels can differ from resolved names after unknown-type fallback or case-insensitive resolution; correcting those existing value mismatches requires broader dispatch-identity plumbing and is an explicit follow-up, not part of this wording task. F08 standardizes the vocabulary and correlation fields, not that pre-existing source distinction.

This is a model-visible wording change. Tool schemas, structured result fields, status transitions, abort behavior, dispatch/resume behavior, and delivery mechanics are contracts and must not change. Intentional identity forms in Agent start output, TaskOutput content/renderers, SendMessage steering acknowledgments, errors/refusals, hooks, progress UI, and usage reporting remain untouched.

## Writable surface

- `src/runtime/background-identity.ts`
- `src/runtime/background-tasks.ts`
- `src/runtime/subagents.ts`
- `test/background-identity.test.ts`
- `test/background-tasks.test.ts`
- `test/sendmessage.test.ts`
- `test/integration-extension.test.ts`
- `doc/plan/08-background-identity/log/t01.md`

## Approach constraints

- Keep the shared formatter limited to the identity tuple; callers continue to own action, outcome, and guidance wording.
- Formatter grammar is explicit:
  - task ids must match `^task-[1-9][0-9]{0,11}$`; otherwise render the fixed non-minted fallback `task-unavailable`;
  - displayed types are single-line sanitized; Unicode format/bidi controls are removed; incoming `%` and reserved tuple delimiters `(`, `)`, and `·` are percent-encoded; minted-looking `task-N` and `agent-<12 hex>` substrings inside the type are neutralized; and the encoded value is capped at 120 characters without splitting a code point or percent-escape token; an empty result renders `type-unavailable`;
  - agent ids render only when accepted by the existing `isAgentId` validator; otherwise render the fixed non-minted fallback `agent-id-unavailable`.
- The formatter must produce one unambiguous tuple with a bounded total length. Attacker-controlled text cannot close `Agent(...)`, add tuple segments, forge outcomes, or introduce another task/agent token that looks registry-minted.
- The utility may expose a small task-id normalizer alongside the tuple formatter. Settlement retrieval guidance must reuse the same validated/fallback task id rather than re-interpolating raw record metadata; normal structured details remain unchanged.
- Keep each message single-line until the settlement notice's existing subsequent lines.
- Do not expose prompts, follow-up messages, task output, diagnostics, or new path/transcript/error metadata.
- Preserve the settlement notice's existing 500-character error cap, 1,200-character post-defanging excerpt cap, framing, and exactly-once/retry semantics.
- Keep wording compact: the identity tuple appears once, followed only by the existing outcome/consequence or retrieval instruction needed by the coordinator. Repeating only the task id inside executable `TaskOutput (task_id "...")` guidance is allowed and considered actionable, not duplicated identity.
- The resume edit is acknowledgment-only and remains after the existing successful `backgroundTasks.start`. Preserve registry-only address resolution, registry-owned transcript/cwd/worktree state, same validated agent-id reuse, full dispatch/permission/guard/hook path, synchronous running-state transition, and asynchronous settlement.

## Left open

- Whether focused identity assertions use a small test helper or direct assertions.
- Minor punctuation in action/outcome suffixes, provided the canonical identity, pending resume wording, and existing meanings remain clear.

## Testing

At unit/offline-integration layers:

- Test the formatter directly with valid values; missing/malformed/oversized task and agent ids; empty/whitespace type; overlong type; controls, ANSI/OSC, Unicode format/bidi characters; minted-looking task/agent tokens inside the type; and same-line delimiter/outcome/TaskOutput spoof attempts. Assert one bounded line, complete encoding tokens, exactly one genuine task/agent token, no raw malformed ids or reserved injected structure, and non-minted fallbacks.
- Cover all three TaskStop result branches. Assert the canonical tuple occurs once, the internal `agent:<type>` label is absent, each existing branch meaning remains, the parameter schema still exposes `task_id`, and exact details remain `{ taskId, status }`.
- Cover completed, failed, and aborted settlement headers with the tuple once and no internal label while retaining existing error, output-frame, cap, stopped-output, and delivery assertions. Seed the real delivery fixture with an explicit displayed type matching production start sites.
- Extend the existing resume integration test to assert the new task id, clean registry agent name, unchanged stable id, pending/prior-context wording, absence of the follow-up message and internal label, and the complete unchanged details shape (`agentId`, `agent`, `taskId`, `delivery`, `resumed`). Retain its existing transcript, context, registry-state, dispatch-path, and re-arming assertions.
- For an exact-case valid agent name, prove the same displayed type and stable agent id correlate the targeted lifecycle outputs while resume alone creates a new task id. Requested-versus-resolved value mismatches (fallback and case-insensitive resolution) are excluded and recorded for follow-up.
- Sentinel prompt/output/path/diagnostic values must not appear in surfaces where they were not already part of the contract.
- Retain existing start, TaskOutput, steering, unknown-id, and structured-result behavior unchanged.
- Tests must be deterministic and platform-neutral on Windows and Linux; no live e2e or timing sleeps are needed for wording coverage.

## Acceptance criteria

- [ ] All three target surfaces use the canonical compact identity on normal valid records.
- [ ] Internal `agent:<type>` labels no longer appear on those surfaces.
- [ ] Messages add no unnecessary model-context content or duplicated identity tuple.
- [ ] Invalid identity metadata cannot inject content or be mistaken for valid minted identity.
- [ ] Existing lifecycle, schema, structured-result, settlement safety, and delivery contracts are unchanged.
- [ ] Intentional identity forms outside the three targets are unchanged.
- [ ] Requested-versus-resolved type-label mismatches are not silently broadened into this task.
- [ ] typecheck and full test suite green

## Depends on

–
