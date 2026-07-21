# Phase 4 — HOW investigation

Dispatch prompts are governed by [dispatch-discipline.md](dispatch-discipline.md) — read it before your first fan-out; if it cannot be read, do not dispatch.

Now work out how to build it. Fan out to the relevant specialists — always including `docs`, and `generalist` for cross-surface questions no single specialist owns — in investigate mode with concrete questions (where does this hook into the code? what are the risks? what does Claude Code do here? what must tests cover?). The docs specialist applies [*Proportional scope* in the documentation guide](../../../../doc/documentation-guide.md) and returns either a concise justified no-durable-change disposition or the smallest sufficient set. Search the web where external behavior matters (Claude Code semantics, library APIs). Integrate the reports into one coherent technical picture: chosen approach, seams to existing code, risks, open questions. Carry the docs disposition or accepted surface rationales into that picture; reuse it later unless assumptions change.

Decide what you can; escalate to the user only what is direction-deciding. Small technical questions: batch them rather than interrupting repeatedly.
