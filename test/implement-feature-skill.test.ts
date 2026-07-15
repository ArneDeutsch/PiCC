import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSkillBody, loadSkills, substituteArguments } from "../src/claude/skills.js";
import { REINJECT_PER_SKILL_MAX_CHARS } from "../src/runtime/skill-activation.js";
import { walkFiles } from "../src/util/fs.js";

// Resolve the shipped skills dir from THIS test file, never process.cwd() —
// sibling tests process.chdir into temp dirs (see implementer-generalist-agents.test.ts).
const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "skills",
);
const SKILL_DIR = path.join(SKILLS_DIR, "implement-feature");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");

const norm = (p: string): string => p.replace(/\\/g, "/");

describe("implement-feature router (F12 t01)", () => {
  // Use the real loader (not fs.readFileSync): loadSkillBody/parseMarkdown normalize
  // CRLF and strip the BOM, so the char count is deterministic cross-platform.
  const { skills } = loadSkills([{ dir: SKILLS_DIR, scope: "project" }], []);
  const skill = skills.find((s) => s.name === "implement-feature");

  it("loads with a valid frontmatter contract", () => {
    // `name` must equal the expected identity (catches a `name:` value typo; the loader falls back to
    // the dir basename, which is also "implement-feature", so a removed key still passes — acceptable).
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("implement-feature");
    expect(typeof skill!.description).toBe("string");
    expect(skill!.description.length).toBeGreaterThan(0);
  });

  it("router body stays within the per-skill re-injection cap", () => {
    // Tie the assertion to the runtime constant, not a hardcoded 20000.
    const body = loadSkillBody(skill!);
    expect(body.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
  });

  it("rendered body stays within the cap even under a long invocation argument", () => {
    // Guards the substitution-inflation regression: the router must carry NO literal `$ARGUMENTS`
    // token (each mention is globally substituted at activation, which both garbles the prose and,
    // under a long documented invocation like `#5 also add …`, multiplies the args text into the
    // resident body and can push it past the cap). With no marker, the ref reaches the coordinator
    // once via the append-fallback instead. Render with a representative ~150-char invocation and
    // assert the rendered body still fits.
    const body = loadSkillBody(skill!);
    const argsText =
      "#5 also add structured logging around the dispatch loop and make sure the retry path is " +
      "covered by an offline integration test in the tester layer please";
    expect(argsText.length).toBeGreaterThanOrEqual(140);
    const rendered = substituteArguments(body, argsText, skill!.arguments);
    expect(rendered.text.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
    // The ref still reaches the coordinator — via the no-marker append fallback, since the router
    // body carries no literal `$ARGUMENTS`/`$N`/`$name` marker to substitute in place.
    expect(rendered.text).toContain(`ARGUMENTS: ${argsText}`);
  });

  it("every linked reference resolves, and every reference file is linked (bidirectional, count-agnostic)", () => {
    const body = loadSkillBody(skill!);

    // Path tokens the router mentions (markdown link, bare path, or ${CLAUDE_SKILL_DIR}/ prefix),
    // deduped. Every token must resolve on disk (catches a link to a mistyped file).
    const mentioned = [...new Set(body.match(/references\/[A-Za-z0-9_-]+\.md/g) ?? [])];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const token of mentioned) {
      expect(fs.existsSync(path.join(SKILL_DIR, token))).toBe(true);
    }

    // Every reference file on disk must be linked from the router (catches a dropped routing line).
    // Glob the actual references/*.md rather than hardcoding a file count — t02–t05 add more.
    const onDisk = fs
      .readdirSync(REFERENCES_DIR)
      .filter((n) => n.endsWith(".md"))
      .map((n) => `references/${n}`);
    expect(onDisk.length).toBeGreaterThan(0);
    const mentionedSet = new Set(mentioned);
    for (const ref of onDisk) {
      expect(mentionedSet.has(ref)).toBe(true);
    }
  });

  it("keeps the write-discipline floor resident in the router (loose structural check)", () => {
    // The fail-closed floor must survive in the always-loaded router even after compaction — so the
    // resident checklist keeps its two load-bearing markers. Loose on purpose: assert the markers are
    // present (case-insensitive), not their exact prose, so this stays a floor check, not a
    // wording change-detector.
    const body = loadSkillBody(skill!).toLowerCase();
    expect(body).toContain("--body-file");
    expect(body).toContain("allow-list");
  });

  it("registers exactly one SKILL.md (no second skill), scoped to the skill dir", () => {
    // Reuse the loader's own primitive. Scope to the skill dir — a repo-wide walk
    // would hit many examples/** fixtures that ship their own SKILL.md.
    const hits = walkFiles(SKILL_DIR, (n) => n === "SKILL.md").map(norm);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(norm(path.join(SKILL_DIR, "SKILL.md")));
  });
});

describe("proposal-gate wiring floor markers (evaluate-skill t04)", () => {
  // Loose, case-insensitive, whitespace-collapsed structural checks. The proposal-gate
  // wiring lives in the REFERENCE files (Phase 8 gate + Phase 1 annotate), NOT the router
  // body — loadSkillBody never reads reference bodies, and the router clause is optional —
  // so assert the marker in the files the wiring actually edits. We do NOT re-assert the
  // existing --body-file / allow-list floor (it already holds and stays green).
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");

  const TICKET_INTEGRATION_PATH = path.join(REFERENCES_DIR, "ticket-integration.md");
  const TICKET_CREATION_PATH = path.join(REFERENCES_DIR, "ticket-creation.md");

  it("Phase 8 (ticket-integration.md) gates findings through proposal-gate, dropping clear slop with a review.md tally", () => {
    const body = collapse(TICKET_INTEGRATION_PATH);
    expect(body).toContain("proposal-gate");
    // Clear slop dropped, but the tally says the dropped findings remain in review.md.
    expect(body).toContain("remain in review.md");
    // The gate only subtracts clear slop; per-presented-finding choice preserved (one coherent rule).
    expect(body).toContain("subtracts clear slop, never adds");
    expect(body).toContain("choose per _presented_ finding");
  });

  it("Phase 1 (ticket-creation.md) only annotates via proposal-gate in-session and never suppresses the offer", () => {
    const body = collapse(TICKET_CREATION_PATH);
    expect(body).toContain("proposal-gate");
    // Annotate-only, presented in-session and never baked into the filed public issue body.
    expect(body).toContain("in-session");
    expect(body).toContain("never baked into the filed public issue body");
    expect(body).toContain("only annotates");
    expect(body).toContain("never suppresses this offer");
  });
});
