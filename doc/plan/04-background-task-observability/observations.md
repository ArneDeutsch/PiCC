# F04 Observations

Running record of friction, planning errors, bugs found, and opportunities. Dated bullets; raw
material for review.md.

- 2026-07-13 t01: clean pure move, no friction. Spec's optional `renderProgressText` re-export was
  correctly omitted (unused by moved code; would trip `noUnusedLocals`) — the "Left open" framing paid
  off. coder review PASS, behavior byte-for-byte identical, baseline green.
