# F02: Subagent lifecycle — failures, observability, communication

## What

Make the fate and activity of every PiCC subagent fully visible — to the coordinating
model and to the human — and give the coordinator a channel back into its subagents.

1. **Loud failures.** A subagent whose run ends on a terminal API error is reported as a
   failure with the error named — never as an empty or normal-looking success. If the
   subagent produced output before dying, that partial output is preserved and delivered
   alongside an explicit cut-off marker. A subagent stopped on purpose (user abort,
   TaskStop) is reported as aborted — distinct from failure. This holds for foreground
   and background dispatches alike; a background task that failed is never shown as
   completed. Retry behavior stays exactly Pi's own — no additional recovery logic.
2. **Observable subagents.** Every subagent leaves a transcript on disk, discoverable
   next to the main session's transcript, readable during and after the run. While a
   subagent runs, the UI shows which agent it is and what it is doing: at minimum the
   agent type and dispatch description instead of the bare word "Agent"; target state is
   a rolling tail of its recent activity (latest output lines / current tool), including
   visibility of silent waits (API auto-retry). Cancelling in the parent (Esc) actually
   aborts a running foreground dispatch.
3. **A channel to subagents.** Every resumable subagent gets a stable ID the coordinator
   receives on completion — in text the model can actually read. A SendMessage-shaped
   tool lets the coordinator send a follow-up message to a finished subagent (it
   resumes in the background under the same ID with its full prior context) or steer a
   still-running background one (Claude Code 2.1.x semantics). Background settlement
   (success or failure) becomes visible to the coordinator at its next turn without
   polling. Honest limit, documented: an idle coordinator learns of settlement when the
   conversation continues — PiCC v1 does not re-invoke an idle agent.
4. **Usage accounting.** Per-subagent token/cost usage is recorded with the dispatch
   result and in the transcript, and is visible to the human somewhere practical — not
   silently dropped as today.
5. **Truthful bookkeeping.** The capability registry tells the truth about all of the
   above (including a SendMessage entry, currently missing entirely); the generated
   capability matrix, docs, and CHANGELOG reflect the new behavior.

**Non-goals:** subagent↔subagent direct messaging, mailboxes, or anything from Claude's
experimental agent teams; a background-task listing tool (Claude Code has none); live
per-subagent token tickers in the UI; switching the whole TUI between main and subagent
views (a possible later feature); auto-recovery beyond Pi's built-in retry; remote/cloud
agents.

## Why

Dogfooding on 2026-07-12 (feature 01, run by a GPT model under PiCC) hit a drained
usage limit: every subagent dispatch failed instantly, PiCC returned those failures as
empty successes, and the coordinator — unable to distinguish "reviewer found nothing"
from "reviewer never ran" — committed under-reviewed work and silently absorbed
implementation into its own context. Meanwhile the human saw only a grey "Agent" box:
no progress, no output, no cost. Every planned fan-out workflow (plan review,
implementation review, close review) rests on subagent reports being trustworthy and
inspectable; today they are neither. Claude Code fixed the same failure class in
2.1.199/2.1.200 and defines the target semantics — this feature closes PiCC's gap to
its pinned baseline, which is the product's core promise.

## Acceptance

- Dispatching a subagent against an exhausted/unreachable API produces a visible
  failure naming the cause — in the tool result (foreground), in the task status and
  its retrieval (background) — and demonstrably cannot produce an empty success.
- A subagent that did real work before dying delivers its partial output plus an
  explicit cut-off note; a deliberately stopped subagent reports as aborted, not failed.
- After any dispatch, a transcript file for that subagent exists on disk and contains
  its turns; the user can locate it from the session without guessing.
- Watching a dispatch in the TUI, the user can tell which agent is running, what it was
  asked, and that it is alive (activity/rolling output); Esc cancels it.
- The coordinator can address a completed subagent by its ID and continue it with its
  context intact, and can redirect a running one; when a background task settles, the
  coordinator learns about it without calling TaskOutput.
- Token/cost usage of each subagent is recorded and human-visible.
- `doc/supported-features.md` regenerates cleanly and the registry entries for the
  Agent tool, background agents, and SendMessage match observed behavior; CHANGELOG
  and docs updated.
- Full test suite and typecheck green. **Flake policy** (baseline was green-but-flaky
  before this feature, see observations.md): a task gate means *no new failures*; one
  retry is allowed for a file-level flake that reproduces neither in isolation nor on
  re-run; genuine new failures always block.

## Tasks

Execute **strictly serially in this order** — t01–t06 share `src/runtime/subagents.ts`,
`src/runtime/background-tasks.ts`, and `src/index.ts`; parallel implementation would
conflict by design.

- t01 Loud failure semantics + abort wiring (depends on: –)
- t02 Persisted subagent transcripts + agent IDs (depends on: t01)
- t03 Live progress in the UI (depends on: t01, t02)
- t04 SendMessage channel — resume and steer subagents (depends on: t01, t02)
- t05 Background settlement visible without polling (depends on: t01, t02)
- t06 Per-subagent usage accounting (depends on: t01, t02, t04, t05)
- t07 Registry truthfulness, docs, CHANGELOG (depends on: t01–t06)
