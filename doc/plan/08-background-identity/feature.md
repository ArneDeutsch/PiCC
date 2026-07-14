# F08: Consistent Background-Task Identity

## What

PiCC presents background-task identity consistently when a task is stopped, when a settled task is announced, and when a resumed agent starts a new background task. Each surface names the task, the clean displayed agent type, and the stable agent id using the established background-task vocabulary.

The feature changes model-visible wording but not structured or behavioral contracts. It does not change task lifecycle behavior, stopping semantics, settlement delivery, agent resume behavior, tool schemas or structured results, output framing or limits, or deliberately channel-specific identity forms elsewhere in the product. The revised messages stay concise: they include only the task-to-agent identity needed to correlate work and the existing action or outcome information needed to act on it.

The established displayed type is the requested/display label. It can differ from the resolved agent name after fallback or case-insensitive resolution; correcting that existing mismatch would require broader identity plumbing and is explicitly deferred.

## Why

A person following background work should be able to recognize the same task and agent without translating between several identity formats or seeing internal namespaced labels. Extending the established vocabulary to the remaining lifecycle surfaces makes task activity easier to correlate and removes implementation terminology from user-facing text.

## Acceptance

- Stopping a background task identifies the task, clean displayed agent type, and stable agent id consistently for every stop outcome.
- A background-task settlement announcement uses the same identity vocabulary while retaining its existing outcome, error, and untrusted-output protections.
- Resuming an agent into a new background task uses the same identity vocabulary, names the new task id, and retains the stable agent id.
- Existing task stopping, settlement, resume, structured-result, and output behavior remains unchanged.
- The revised wording is compact and does not duplicate identity or add unrelated task, agent, path, transcript, prompt, or output details.
- Intentional identity forms outside these three surfaces remain unchanged.

## Tasks

1. t01 Unify Runtime Identity Messages (depends on: –)
2. t02 Document the Identity Contract (depends on: t01)
