import { describe, expect, it } from "vitest";
import { renderDoctorReport, retentionPostureLine } from "../src/registry/compat-report.js";
import type { ClaudeProject, RetentionCleanupBlocker } from "../src/types.js";

function project(options: {
  days?: number;
  allowed?: boolean;
  blockers?: RetentionCleanupBlocker[];
} = {}): ClaudeProject {
  return {
    settings: {
      cleanupPeriodDays: options.days,
      retentionCleanupAllowed: options.allowed,
      retentionCleanupBlockers: options.blockers ?? [],
    },
  } as unknown as ClaudeProject;
}

describe("retention /doctor posture", () => {
  it.each([
    [undefined, 30],
    [17, 17],
  ])("reports the effective allowed period (%s)", (days, effective) => {
    const line = retentionPostureLine(project({ days, allowed: true }));
    expect(line).toBe(
      `Retention: ${effective} days for persisted subagent transcripts and orphaned worktrees; cleanup allowed.`,
    );
  });

  it.each([
    ["invalid-period", "invalid cleanupPeriodDays"],
    ["unreadable-source", "unreadable"],
    ["malformed-source", "malformed JSON"],
    ["non-object-source", "non-object root"],
  ] as const)("reports blocked reason %s using only a source basename", (reason, wording) => {
    const source = `C:\\private\\settings-${reason}.json\u0007`;
    const line = retentionPostureLine(project({
      days: 9,
      allowed: false,
      blockers: [{ reason, source }],
    }));
    expect(line).toContain("Retention: 9 days; cleanup paused");
    expect(line).toContain(`settings-${reason}.json: ${wording}`);
    expect(line).toContain("Repair the reported settings source and restart PiCC.");
    expect(line).not.toContain("C:\\private");
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("includes the posture in the complete /doctor report", () => {
    const loaded = project({ days: 12, allowed: true });
    const report = renderDoctorReport(loaded, { findings: [], safetyFindings: [], unassessed: [] });
    expect(report.split("\n")).toContain(
      "Retention: 12 days for persisted subagent transcripts and orphaned worktrees; cleanup allowed.",
    );
  });

  it("fails closed when admission is unexpectedly absent and bounds blocker detail", () => {
    const blockers: RetentionCleanupBlocker[] = Array.from({ length: 10 }, (_, index) => ({
      reason: "malformed-source",
      source: `/secret/${index}/settings.json`,
    }));
    const absent = retentionPostureLine(project());
    const bounded = retentionPostureLine(project({ allowed: false, blockers }));
    expect(absent).toContain("cleanup paused (settings admission unavailable)");
    expect(bounded).toContain("2 more blocker(s) omitted");
    expect(bounded).not.toContain("/secret/");
  });
});
