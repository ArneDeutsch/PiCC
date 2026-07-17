import { describe, expect, it } from "vitest";
import {
  appendCutOffNote,
  presentDispatchResult,
  type DispatchPresentation,
  type DispatchResult,
} from "../src/runtime/subagents.js";
import { agentTrailerFrame, agentTrailerLine } from "../src/util/subagent-transcripts.js";

/**
 * Unit coverage for the shared, pure `presentDispatchResult` helper.
 * It reproduces the Agent tool's four-branch mapping (completed /
 * failed-with-partial / failed-no-output / aborted). The Agent-tool regression
 * proof lives in subagent-outcomes.test.ts; here we exercise the helper
 * directly, on hand-built DispatchResult values, over the full
 * outcome × resumable × trailer matrix.
 *
 * DispatchResult.error fixtures are ALREADY-CAPPED single-line strings, mirroring
 * real dispatch() output — the helper does not (and must not) re-cap.
 */

const AGENT_ID = "agent-0123456789ab";

// A capped, single-line API-death error string, exactly as dispatch construction
// would have produced it (capErrorText already applied — no control chars/runs).
const CAPPED_ERROR = "Agent terminated early due to an API error: 503 service unavailable";
const ABORT_WORDING = `Subagent "reviewer" was aborted before completing its task.`;

function makeResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    ok: false,
    outcome: "failed",
    finalMessage: "",
    agentId: AGENT_ID,
    resumable: false,
    diagnostics: [],
    ...overrides,
  };
}

function asResult(p: DispatchPresentation): { kind: "result"; text: string; cutOff: boolean } {
  expect(p.kind).toBe("result");
  return p as { kind: "result"; text: string; cutOff: boolean };
}

function asFailure(p: DispatchPresentation): { kind: "failure"; message: string } {
  expect(p.kind).toBe("failure");
  return p as { kind: "failure"; message: string };
}

const CUT_OFF_FRAME = /\n\n---\n\[subagent cut off\] /;

describe("presentDispatchResult — completed", () => {
  it("non-resumable → verbatim final message, no trailer, cutOff false", () => {
    const r = presentDispatchResult(
      makeResult({ ok: true, outcome: "completed", finalMessage: "```yaml\nverdict: approve\n```" }),
    );
    const res = asResult(r);
    expect(res.text).toBe("```yaml\nverdict: approve\n```");
    expect(res.cutOff).toBe(false);
    expect(res.text).not.toContain("resumable via SendMessage");
  });

  it("resumable (default trailer) → final message + standalone completed trailer frame", () => {
    const r = presentDispatchResult(
      makeResult({ ok: true, outcome: "completed", finalMessage: "done", resumable: true }),
    );
    const res = asResult(r);
    expect(res.text).toBe(`done${agentTrailerFrame(AGENT_ID, { completed: true })}`);
    expect(res.cutOff).toBe(false);
  });

  it("resumable but allowResumeTrailer:false → verbatim, no trailer bytes", () => {
    const r = presentDispatchResult(
      makeResult({ ok: true, outcome: "completed", finalMessage: "done", resumable: true }),
      { allowResumeTrailer: false },
    );
    const res = asResult(r);
    expect(res.text).toBe("done");
    expect(res.text).not.toContain("resumable via SendMessage");
    expect(res.text).not.toContain("---");
  });
});

describe("presentDispatchResult — completed (truncated)", () => {
  it("cutOff comes from truncated, not hard-coded false (non-resumable)", () => {
    const r = presentDispatchResult(
      makeResult({ ok: true, outcome: "completed", finalMessage: "half", truncated: true }),
    );
    const res = asResult(r);
    expect(res.text).toBe("half");
    expect(res.cutOff).toBe(true);
  });

  it("resumable + truncated → bare trailer line INSIDE the existing frame (single \\n)", () => {
    const r = presentDispatchResult(
      makeResult({
        ok: true,
        outcome: "completed",
        finalMessage: "half",
        resumable: true,
        truncated: true,
      }),
    );
    const res = asResult(r);
    expect(res.text).toBe(`half\n${agentTrailerLine(AGENT_ID, { completed: false })}`);
    // Rides inside the existing frame: does NOT open a second `\n\n---\n` frame.
    expect(res.text).not.toContain("\n\n---\n");
    expect(res.cutOff).toBe(true);
  });

  it("resumable + truncated + allowResumeTrailer:false → no trailer, cutOff still true", () => {
    const r = presentDispatchResult(
      makeResult({
        ok: true,
        outcome: "completed",
        finalMessage: "half",
        resumable: true,
        truncated: true,
      }),
      { allowResumeTrailer: false },
    );
    const res = asResult(r);
    expect(res.text).toBe("half");
    expect(res.cutOff).toBe(true);
  });
});

describe("presentDispatchResult — failed WITH partial output", () => {
  it("non-resumable → partial survives verbatim at the start + exact cut-off frame naming the cause", () => {
    const r = presentDispatchResult(
      makeResult({ outcome: "failed", finalMessage: "half a review", error: CAPPED_ERROR }),
    );
    const res = asResult(r);
    expect(res.text.startsWith("half a review")).toBe(true);
    expect(res.text).toBe(appendCutOffNote("half a review", CAPPED_ERROR));
    expect(res.text).toMatch(CUT_OFF_FRAME);
    expect(res.text).toContain(`\n\n---\n[subagent cut off] ${CAPPED_ERROR}`);
    expect(res.cutOff).toBe(true);
  });

  it("resumable (default) → cut-off text + bare completed:false trailer line (single \\n)", () => {
    const r = presentDispatchResult(
      makeResult({
        outcome: "failed",
        finalMessage: "half a review",
        error: CAPPED_ERROR,
        resumable: true,
      }),
    );
    const res = asResult(r);
    const cut = appendCutOffNote("half a review", CAPPED_ERROR);
    expect(res.text).toBe(`${cut}\n${agentTrailerLine(AGENT_ID, { completed: false })}`);
    expect(res.cutOff).toBe(true);
  });

  it("resumable + allowResumeTrailer:false → cut-off text only, no trailer line", () => {
    const r = presentDispatchResult(
      makeResult({
        outcome: "failed",
        finalMessage: "half a review",
        error: CAPPED_ERROR,
        resumable: true,
      }),
      { allowResumeTrailer: false },
    );
    const res = asResult(r);
    expect(res.text).toBe(appendCutOffNote("half a review", CAPPED_ERROR));
    expect(res.text).not.toContain("resumable via SendMessage");
  });

  it("no error field → falls back to the default cut-off note", () => {
    const r = presentDispatchResult(
      makeResult({ outcome: "failed", finalMessage: "half a review" }),
    );
    const res = asResult(r);
    expect(res.text).toContain(
      "\n\n---\n[subagent cut off] The run ended on an API error before completing.",
    );
    expect(res.cutOff).toBe(true);
  });

  it("does NOT re-cap the error (verbatim) — a pre-capped single-line error is passed through unchanged", () => {
    const r = presentDispatchResult(
      makeResult({ outcome: "failed", finalMessage: "x", error: CAPPED_ERROR }),
    );
    const res = asResult(r);
    expect(res.text.endsWith(CAPPED_ERROR)).toBe(true);
  });
});

describe("presentDispatchResult — failed WITHOUT partial output", () => {
  it("non-resumable → failure message names the cause, bare (no trailer, no [\\r\\n])", () => {
    const f = asFailure(presentDispatchResult(makeResult({ outcome: "failed", error: CAPPED_ERROR })));
    expect(f.message).toBe(CAPPED_ERROR);
    expect(f.message).not.toMatch(/[\r\n]/);
  });

  it("resumable → failure message carries the standalone completed:false trailer frame", () => {
    const f = asFailure(
      presentDispatchResult(makeResult({ outcome: "failed", error: CAPPED_ERROR, resumable: true })),
    );
    expect(f.message).toBe(`${CAPPED_ERROR}${agentTrailerFrame(AGENT_ID, { completed: false })}`);
  });

  it("resumable + allowResumeTrailer:false → bare failure message, no trailer", () => {
    const f = asFailure(
      presentDispatchResult(
        makeResult({ outcome: "failed", error: CAPPED_ERROR, resumable: true }),
        { allowResumeTrailer: false },
      ),
    );
    expect(f.message).toBe(CAPPED_ERROR);
    expect(f.message).not.toMatch(/[\r\n]/);
  });

  it("whitespace-only finalMessage counts as NO partial → failure (not a cut-off result)", () => {
    const f = asFailure(
      presentDispatchResult(makeResult({ outcome: "failed", finalMessage: "   \n\t ", error: CAPPED_ERROR })),
    );
    expect(f.message).toBe(CAPPED_ERROR);
  });

  it("no error field → default 'subagent failed'", () => {
    const f = asFailure(presentDispatchResult(makeResult({ outcome: "failed" })));
    expect(f.message).toBe("subagent failed");
  });
});

describe("presentDispatchResult — aborted", () => {
  it("non-resumable → failure with the abort wording, bare, no trailer, no [\\r\\n]", () => {
    const f = asFailure(presentDispatchResult(makeResult({ outcome: "aborted", error: ABORT_WORDING })));
    expect(f.message).toBe(ABORT_WORDING);
    expect(f.message).not.toMatch(/[\r\n]/);
    expect(f.message).not.toContain("resumable via SendMessage");
  });

  it("resumable aborted → STILL bare (the trailer ternary requires outcome === 'failed')", () => {
    const f = asFailure(
      presentDispatchResult(makeResult({ outcome: "aborted", error: ABORT_WORDING, resumable: true })),
    );
    expect(f.message).toBe(ABORT_WORDING);
    expect(f.message).not.toContain("resumable via SendMessage");
    expect(f.message).not.toContain("---");
  });

  it("partial output on an aborted run is intentionally DISCARDED (parity with the Agent tool)", () => {
    const f = asFailure(
      presentDispatchResult(
        makeResult({ outcome: "aborted", finalMessage: "half a review", error: ABORT_WORDING }),
      ),
    );
    expect(f.message).toBe(ABORT_WORDING);
    expect(f.message).not.toContain("half a review");
  });
});

describe("presentDispatchResult — totality (never throws)", () => {
  it("missing finalMessage on a failed result is treated as no partial, not a crash", () => {
    const malformed = { ...makeResult({ outcome: "failed", error: CAPPED_ERROR }) } as Record<
      string,
      unknown
    >;
    delete malformed.finalMessage;
    const f = asFailure(presentDispatchResult(malformed as unknown as DispatchResult));
    expect(f.message).toBe(CAPPED_ERROR);
  });

  it("missing finalMessage on a completed result yields an empty verbatim text", () => {
    const malformed = { ...makeResult({ ok: true, outcome: "completed" }) } as Record<string, unknown>;
    delete malformed.finalMessage;
    const res = asResult(presentDispatchResult(malformed as unknown as DispatchResult));
    expect(res.text).toBe("");
    expect(res.cutOff).toBe(false);
  });
});
