import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgents } from "../src/claude/agents.js";
import { loadSkillBody, loadSkills } from "../src/claude/skills.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import { REINJECT_PER_SKILL_MAX_CHARS } from "../src/runtime/skill-activation.js";
import type { PermissionRules, ToolCallDescriptor } from "../src/types.js";
import { walkFiles } from "../src/util/fs.js";

// Resolve the shipped dirs from THIS test file, never process.cwd() — sibling
// tests process.chdir into temp dirs (see implementer-generalist-agents.test.ts).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");
const SKILL_DIR = path.join(SKILLS_DIR, "evaluate");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");
const AGENTS_DIR = path.join(ROOT, ".claude", "agents");
const SETTINGS_PATH = path.join(ROOT, ".claude", "settings.json");

const norm = (p: string): string => p.replace(/\\/g, "/");

describe("evaluate router (evaluate-skill t01)", () => {
  // Use the real loader (not fs.readFileSync): loadSkillBody/parseMarkdown normalize
  // CRLF and strip the BOM, so the char count is deterministic cross-platform.
  const { skills } = loadSkills([{ dir: SKILLS_DIR, scope: "project" }], []);
  const skill = skills.find((s) => s.name === "evaluate");

  it("loads with a valid frontmatter contract", () => {
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("evaluate");
    expect(typeof skill!.description).toBe("string");
    expect(skill!.description.length).toBeGreaterThan(0);
    // argument-hint is present so the palette can render the invocation shape.
    expect(typeof skill!.argumentHint).toBe("string");
    expect(skill!.argumentHint!.length).toBeGreaterThan(0);
    // Per-skill parse diagnostics live on the skill itself (NOT in the top-level
    // loadSkills diagnostics array), so a malformed frontmatter would slip past
    // the dir-wide check — pin the skill to a clean parse here.
    expect(skill!.diagnostics).toEqual([]);
    // The skill must be user-invocable so `/evaluate` shows up in the palette.
    expect(skill!.userInvocable).toBe(true);
  });

  it("router body stays within the per-skill re-injection cap", () => {
    // Tie the assertion to the runtime constant, not a hardcoded 20000.
    const body = loadSkillBody(skill!);
    expect(body.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
  });

  it("every linked reference resolves, and every reference file is linked (bidirectional, count-agnostic)", () => {
    const body = loadSkillBody(skill!);

    // Path tokens the router mentions (markdown link or bare path), deduped. Every
    // token must resolve on disk (catches a link to a mistyped/not-yet-created file).
    const mentioned = [...new Set(body.match(/references\/[A-Za-z0-9_-]+\.md/g) ?? [])];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const token of mentioned) {
      expect(fs.existsSync(path.join(SKILL_DIR, token))).toBe(true);
    }

    // Every reference file on disk must be linked from the router (catches a dropped
    // routing line). Glob the actual references/*.md rather than hardcoding a count —
    // t02–t04 add the per-mode files later.
    const onDisk = fs
      .readdirSync(REFERENCES_DIR)
      .filter((n) => n.endsWith(".md"))
      .map((n) => `references/${n}`);
    expect(onDisk.length).toBeGreaterThan(0);
    const mentionedSet = new Set(mentioned);
    for (const ref of onDisk) {
      expect(mentionedSet.has(ref)).toBe(true);
    }

    // The two shared references must be present (superset check, not an exact
    // set) — the bidirectional glob integrity above already guards completeness,
    // and t02–t04 add more mode files, so don't pin the count here.
    const onDiskSet = new Set(onDisk);
    expect(onDiskSet.has("references/evaluation-engine.md")).toBe(true);
    expect(onDiskSet.has("references/write-discipline.md")).toBe(true);
  });

  it("keeps the load-bearing kernel resident in the router (loose structural check)", () => {
    // The always-loaded router must carry the safety kernel even after compaction. Loose
    // on purpose: assert the markers exist (case-insensitive, whitespace-collapsed so a
    // marker split across a line wrap still matches), not their exact prose.
    const body = loadSkillBody(skill!).toLowerCase().replace(/\s+/g, " ");
    // Fixed action envelope.
    expect(body).toContain("fixed action envelope");
    // Target auto-detection (no user mode pick).
    expect(body).toContain("auto-detect");
    // Confirm-before-close (no autonomous mode).
    expect(body).toContain("before any close");
    // Coordinator redirects content to a file it does not read.
    expect(body).toContain("without reading");
    // Write-discipline floor markers (mirrors implement-feature's floor check).
    expect(body).toContain("--body-file");
    expect(body).toContain("allow-list");
  });

  it("registers exactly one SKILL.md (no second skill), scoped to the skill dir", () => {
    const hits = walkFiles(SKILL_DIR, (n) => n === "SKILL.md").map(norm);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(norm(path.join(SKILL_DIR, "SKILL.md")));
  });
});

describe("evaluator sandbox agent (evaluate-skill t01)", () => {
  const { agents, diagnostics } = loadAgents([{ dir: AGENTS_DIR, scope: "project" }]);

  // allKnownToolNames() is a private closure in src/index.ts; inline an equivalent
  // list covering every tool we assert on (mirrors implementer-generalist test).
  const KNOWN = [
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Grep",
    "Glob",
    "WebFetch",
    "WebSearch",
    "Agent",
    "Task",
    "Skill",
    "EnterWorktree",
    "ExitWorktree",
    "TodoWrite",
  ];

  const emptyRules = (): PermissionRules => ({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
  });
  const engine = new PermissionEngine(emptyRules(), { cwd: AGENTS_DIR });

  it("loads the real agent files without diagnostics", () => {
    // Dir-wide: also asserts the existing roster loads clean, so a malformed
    // evaluator.md would redden this (as it does the existing dir-wide test).
    expect(diagnostics).toEqual([]);
  });

  it("evaluator carries exactly Read/Grep/Glob and is structurally powerless", () => {
    const evaluator = agents.find((a) => a.name === "evaluator");
    if (!evaluator) throw new Error(`agent "evaluator" failed to load from ${AGENTS_DIR}`);
    // The tools list IS the load-bearing safety control — pin it exactly.
    expect(evaluator.tools).toEqual(["Read", "Grep", "Glob"]);
    const granted = engine.gateTools(evaluator.tools, evaluator.disallowedTools, KNOWN);
    expect(granted).toContain("Read");
    expect(granted).toContain("Grep");
    expect(granted).toContain("Glob");
    // No write, no shell, no fetch, no dispatch — structurally stripped.
    for (const forbidden of ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Agent", "Task"]) {
      expect(granted).not.toContain(forbidden);
    }
  });
});

describe("evaluate deny floor (evaluate-skill t01)", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as {
    enabledPlugins?: Record<string, boolean>;
    permissions?: { deny?: string[] };
  };
  const deny = settings.permissions?.deny ?? [];
  const rules: PermissionRules = { allow: [], deny, ask: [], additionalDirectories: [] };
  const engine = new PermissionEngine(rules, { cwd: ROOT });

  const bash = (command: string): ToolCallDescriptor => ({
    tool: "Bash",
    input: { command },
    cwd: ROOT,
  });
  const isDenied = (command: string): boolean => engine.evaluate(bash(command)).decision === "deny";

  it("preserves the existing enabledPlugins content", () => {
    expect(settings.enabledPlugins).toEqual({
      "skill-creator@claude-plugins-official": true,
    });
  });

  it("enumerates the intended destructive subcommands + gh api write bypass", () => {
    const expected = [
      "Bash(gh pr merge *)",
      "Bash(gh pr close *)",
      "Bash(gh pr reopen *)",
      "Bash(gh pr edit *)",
      "Bash(gh pr review *)",
      "Bash(gh issue edit *)",
      "Bash(gh issue delete *)",
      "Bash(gh issue lock *)",
      "Bash(gh issue reopen *)",
      "Bash(gh repo delete *)",
      "Bash(gh repo rename *)",
      "Bash(gh repo archive *)",
      "Bash(gh label create *)",
      "Bash(gh label delete *)",
      "Bash(gh label edit *)",
      "Bash(gh api * --method *)",
      "Bash(gh api * -X *)",
      "Bash(gh api * -f *)",
      "Bash(gh api * -F *)",
      "Bash(gh api graphql *)",
      // Broadened forms: leading-flag ordering + long-form field flags.
      "Bash(gh api -X *)",
      "Bash(gh api --method *)",
      "Bash(gh api -f *)",
      "Bash(gh api -F *)",
      "Bash(gh api --field *)",
      "Bash(gh api --raw-field *)",
      "Bash(gh api --input *)",
      "Bash(gh api * --field *)",
      "Bash(gh api * --raw-field *)",
      "Bash(gh api * --input *)",
    ];
    for (const matcher of expected) {
      expect(deny).toContain(matcher);
    }
  });

  it("hard-denies the destructive writes (via the real PermissionEngine)", () => {
    expect(isDenied("gh pr merge 5 --repo owner/repo")).toBe(true);
    expect(isDenied("gh pr close 5 --repo owner/repo")).toBe(true);
    expect(isDenied("gh pr edit 5 --add-label foo")).toBe(true);
    expect(isDenied("gh issue edit 5 --title x")).toBe(true);
    expect(isDenied("gh issue delete 5")).toBe(true);
    expect(isDenied("gh issue reopen 5")).toBe(true);
    expect(isDenied("gh repo delete owner/repo")).toBe(true);
    expect(isDenied("gh label create bug")).toBe(true);
    // gh api write bypass — flag AFTER the endpoint (original matchers).
    expect(isDenied("gh api repos/o/r/issues/5 --method PATCH")).toBe(true);
    expect(isDenied("gh api repos/o/r/issues/5 -X DELETE")).toBe(true);
    expect(isDenied("gh api repos/o/r/labels -f name=bug")).toBe(true);
    expect(isDenied("gh api repos/o/r/labels -F name=bug")).toBe(true);
    expect(isDenied("gh api graphql -f query=mutation")).toBe(true);
    // gh api write bypass — LEADING-flag ordering (broadened matchers).
    expect(isDenied("gh api -X PUT repos/o/r/pulls/5/merge")).toBe(true);
    expect(isDenied("gh api --method PATCH repos/o/r/issues/5")).toBe(true);
    // gh api write bypass — long-form field flags.
    expect(isDenied("gh api repos/o/r/labels --field name=bug")).toBe(true);
    expect(isDenied("gh api repos/o/r/issues/5 --raw-field body=x")).toBe(true);
  });

  it("does NOT deny the reads/writes both skills legitimately need", () => {
    // evaluate needs `gh issue close`; the engine is shared with implement-feature.
    expect(isDenied("gh issue close 5 --repo owner/repo")).toBe(false);
    // Fork detection / target resolution read these.
    expect(isDenied("gh repo view owner/repo --json name")).toBe(false);
    // The metadata-only type/state detection GET.
    expect(
      isDenied("gh api repos/owner/repo/issues/5 --jq '{isPR:(.pull_request!=null), state:.state}'"),
    ).toBe(false);
    // A plain `--jq` GET read must survive the broadened write matchers — no
    // `-X`/`--method`/`-f`/`-F`/`--field`/`--raw-field`/`--input` flag present.
    expect(isDenied("gh api repos/o/r/issues/5 --jq '.state'")).toBe(false);
    // Our comment writes and PR-diff read.
    expect(isDenied("gh issue comment 5 --body-file /tmp/body.md")).toBe(false);
    expect(isDenied("gh pr comment 5 --body-file /tmp/body.md")).toBe(false);
    expect(isDenied("gh pr diff 5 --repo owner/repo")).toBe(false);
    // Bare read subcommands must never be swept up by a group wildcard.
    expect(isDenied("gh issue view 5 --repo owner/repo --json title,body,comments")).toBe(false);
    expect(isDenied("gh pr view 5 --repo owner/repo")).toBe(false);
  });
});
