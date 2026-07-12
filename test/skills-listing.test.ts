import { afterEach, describe, expect, it } from "vitest";
import { renderSkillListing } from "../src/claude/skills.js";
import type { ClaudeSkill, Diagnostic } from "../src/types.js";

/**
 * Focused tests for the skill-listing budgets (audit A4): 1536-char per-entry
 * default, ~8k-char default budget, SLASH_COMMAND_TOOL_CHAR_BUDGET env
 * override, and the tiered degradation (full → no when: → truncated
 * descriptions → names-only) that never omits a skill.
 */

function mkSkill(name: string, description: string, extra: Partial<ClaudeSkill> = {}): ClaudeSkill {
  return {
    name,
    description,
    userInvocable: true,
    disableModelInvocation: false,
    contextFork: false,
    shell: "bash",
    metadata: {},
    baseDir: "/x",
    source: { path: "/x/SKILL.md", scope: "project" },
    legacyCommand: false,
    unknownKeys: [],
    diagnostics: [],
  ...extra,
  };
}

afterEach(() => {
  delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
});

describe("renderSkillListing: budgets", () => {
  it("caps each description at 1536 chars by default", () => {
    const listing = renderSkillListing([mkSkill("big", "A".repeat(3000))], { budgetChars: 10_000 });
    const desc = listing.replace("- big: ", "");
    expect(desc.length).toBe(1536);
    expect(desc.endsWith("…")).toBe(true);
  });

  it("skillListingMaxDescChars still overrides the per-entry cap", () => {
    const listing = renderSkillListing([mkSkill("big", "A".repeat(3000))], {
      budgetChars: 10_000,
      maxDescChars: 100,
    });
    expect(listing.replace("- big: ", "").length).toBe(100);
  });

  it("defaults the budget to ~8k chars (contextWindow chars × 0.01) when none is given", () => {
    // 20 skills × ~600-char descriptions ≈ 12k chars at tier 1 → must degrade.
    const skills = Array.from({ length: 20 }, (_, i) => mkSkill(`s${i}`, "D".repeat(600)));
    const diagnostics: Diagnostic[] = [];
    const listing = renderSkillListing(skills, { diagnostics });
    expect(listing.length).toBeLessThanOrEqual(8000);
    expect(diagnostics.some((d) => d.severity === "info" && /tier \d/.test(d.message))).toBe(true);
    for (let i = 0; i < 20; i++) expect(listing).toContain(`- s${i}`);
  });

  it("SLASH_COMMAND_TOOL_CHAR_BUDGET overrides the computed budget", () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "30";
    const diagnostics: Diagnostic[] = [];
    const listing = renderSkillListing(
      [mkSkill("one", "long description here"), mkSkill("two", "another long description")],
      { budgetChars: 100_000, diagnostics },
    );
    expect(listing.split("\n")).toEqual(["- one", "- two"]); // env forced tier 4
    expect(diagnostics.some((d) => d.message.includes("tier 4"))).toBe(true);
  });

  it("ignores a non-numeric SLASH_COMMAND_TOOL_CHAR_BUDGET", () => {
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = "not-a-number";
    const listing = renderSkillListing([mkSkill("one", "short")], { budgetChars: 10_000 });
    expect(listing).toBe("- one: short");
  });
});

describe("renderSkillListing: tiered degradation", () => {
  it("tier 1: within budget keeps full entries incl. when: clauses (no diagnostic)", () => {
    const diagnostics: Diagnostic[] = [];
    const listing = renderSkillListing(
      [mkSkill("alpha", "does things", { whenToUse: "when testing" })],
      { budgetChars: 10_000, diagnostics },
    );
    expect(listing).toBe("- alpha: does things (when: when testing)");
    expect(diagnostics).toHaveLength(0);
  });

  it("tier 2: drops when: clauses when tier 1 exceeds the budget", () => {
    const skills = Array.from({ length: 10 }, (_, i) =>
      mkSkill(`s${i}`, "D".repeat(100), { whenToUse: "W".repeat(200) }),
    );
    const diagnostics: Diagnostic[] = [];
    // Tier 1 ≈ 10×320 chars; without when: ≈ 10×110 chars.
    const listing = renderSkillListing(skills, { budgetChars: 2000, diagnostics });
    expect(listing).not.toContain("(when:");
    for (let i = 0; i < 10; i++) expect(listing).toContain(`- s${i}: `);
    expect(listing).toContain("D".repeat(100)); // descriptions not yet truncated
    expect(diagnostics.some((d) => d.message.includes("tier 2"))).toBe(true);
  });

  it("tier 3: progressively halves the description cap (min 64)", () => {
    const skills = Array.from({ length: 5 }, (_, i) => mkSkill(`s${i}`, "D".repeat(1500)));
    const diagnostics: Diagnostic[] = [];
    const listing = renderSkillListing(skills, { budgetChars: 2000, diagnostics });
    const diag = diagnostics.find((d) => d.message.includes("tier 3"));
    expect(diag).toBeDefined();
    expect(listing.length).toBeLessThanOrEqual(2000);
    for (let i = 0; i < 5; i++) expect(listing).toContain(`- s${i}: D`);
  });

  it("tier 3 floor: the cap never drops below 64 chars before falling to names-only", () => {
    // 100 skills × ≥64-char descriptions can never fit 500 chars → tier 4.
    const skills = Array.from({ length: 100 }, (_, i) => mkSkill(`skill-${i}`, "D".repeat(500)));
    const diagnostics: Diagnostic[] = [];
    const listing = renderSkillListing(skills, { budgetChars: 500, diagnostics });
    expect(diagnostics.some((d) => d.message.includes("tier 4"))).toBe(true);
    expect(listing).not.toContain(": D");
  });

  it("tier 4: names-only never omits a skill, even when still over budget", () => {
    const skills = Array.from({ length: 50 }, (_, i) => mkSkill(`skill-${i}`, "D".repeat(200)));
    const diagnostics: Diagnostic[] = [];
    const listing = renderSkillListing(skills, { budgetChars: 40, diagnostics });
    for (let i = 0; i < 50; i++) expect(listing).toContain(`- skill-${i}`);
    expect(listing).not.toContain("more skills");
    expect(diagnostics.some((d) => d.message.includes("tier 4") && d.message.includes("names only"))).toBe(true);
  });

  it("still hides disable-model-invocation skills at every tier", () => {
    const listing = renderSkillListing(
      [mkSkill("visible", "yes"), mkSkill("hidden", "no", { disableModelInvocation: true })],
      { budgetChars: 5 },
    );
    expect(listing).toBe("- visible");
  });
});
