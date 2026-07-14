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
