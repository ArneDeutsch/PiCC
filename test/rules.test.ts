import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules, ruleAppliesTo } from "../src/claude/rules.js";
import type { ClaudeRule } from "../src/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picc-rules-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function rule(overrides: Partial<ClaudeRule>): ClaudeRule {
  return {
    id: "x.md",
    body: "",
    source: { path: "<virtual>", scope: "project" },
    unknownKeys: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("loadRules", () => {
  it("loads unconditional rules (no paths frontmatter) recursively with relative ids", () => {
    const root = path.join(tmp, "proj");
    write("proj/.claude/rules/git.md", "# Git rules\nAlways rebase.");
    write("proj/.claude/rules/backend/api.md", "# API rules");

    const res = loadRules([{ dir: path.join(root, ".claude", "rules"), scope: "project" }], {
      excludes: [],
      projectRoot: root,
    });
    expect(res.rules.map((r) => r.id)).toEqual(["backend/api.md", "git.md"]);
    expect(res.rules.every((r) => r.paths === undefined)).toBe(true);
    expect(res.rules[1]!.body).toContain("Always rebase.");
    expect(res.rules[0]!.source.scope).toBe("project");
  });

  it("parses paths frontmatter into a path-scoped rule", () => {
    const root = path.join(tmp, "proj");
    write(
      "proj/.claude/rules/rust.md",
      "---\npaths:\n  - src/**/*.rs\n---\n# Rust rules\nNo unwrap.",
    );
    const res = loadRules([{ dir: path.join(root, ".claude", "rules"), scope: "project" }], {
      excludes: [],
      projectRoot: root,
    });
    expect(res.rules).toHaveLength(1);
    expect(res.rules[0]!.paths).toEqual(["src/**/*.rs"]);
    expect(res.rules[0]!.body).toContain("No unwrap.");
    expect(res.rules[0]!.unknownKeys).toEqual([]);
  });

  it("accepts paths as a comma-separated string", () => {
    const root = path.join(tmp, "proj");
    write("proj/rules/multi.md", '---\npaths: "src/**, lib/**"\n---\nbody');
    const res = loadRules([{ dir: path.join(root, "rules"), scope: "project" }], {
      excludes: [],
      projectRoot: root,
    });
    expect(res.rules[0]!.paths).toEqual(["src/**", "lib/**"]);
  });

  it("preserves input dir order (project before user) and sorts files within a dir", () => {
    const root = path.join(tmp, "proj");
    const userRules = path.join(tmp, "userhome", "rules");
    write("proj/rules/z.md", "project z");
    write("proj/rules/a.md", "project a");
    write("userhome/rules/m.md", "user m");

    const res = loadRules(
      [
        { dir: path.join(root, "rules"), scope: "project" },
        { dir: userRules, scope: "user" },
      ],
      { excludes: [], projectRoot: root },
    );
    expect(res.rules.map((r) => `${r.source.scope}:${r.id}`)).toEqual([
      "project:a.md",
      "project:z.md",
      "user:m.md",
    ]);
  });

  it("captures unknown frontmatter keys", () => {
    const root = path.join(tmp, "proj");
    write(
      "proj/rules/odd.md",
      "---\npaths:\n  - src/**\npriority: high\nowner: platform\n---\nbody",
    );
    const res = loadRules([{ dir: path.join(root, "rules"), scope: "project" }], {
      excludes: [],
      projectRoot: root,
    });
    expect(res.rules[0]!.unknownKeys.sort()).toEqual(["owner", "priority"]);
  });

  it("degrades on malformed frontmatter: rule still loads, diagnostic emitted", () => {
    const root = path.join(tmp, "proj");
    write("proj/rules/broken.md", "---\npaths: [unclosed\n  bad: : yaml\n---\nBODY STILL HERE");
    const res = loadRules([{ dir: path.join(root, "rules"), scope: "project" }], {
      excludes: [],
      projectRoot: root,
    });
    expect(res.rules).toHaveLength(1);
    // Malformed `paths: [unclosed` degrades to unset → rule loads unconditionally
    // (safer than dropping it); body preserved; a frontmatter diagnostic is emitted.
    expect(res.rules[0]!.paths).toBeUndefined();
    expect(res.rules[0]!.body).toContain("BODY STILL HERE");
    expect(res.diagnostics.some((d) => /frontmatter/i.test(d.message))).toBe(true);
  });

  it("honors excludes (glob against absolute path, base projectRoot)", () => {
    const root = path.join(tmp, "proj");
    write("proj/.claude/rules/keep.md", "keep");
    write("proj/.claude/rules/skip.md", "skip");
    const res = loadRules([{ dir: path.join(root, ".claude", "rules"), scope: "project" }], {
      excludes: [".claude/rules/skip.md"],
      projectRoot: root,
    });
    expect(res.rules.map((r) => r.id)).toEqual(["keep.md"]);
    expect(res.diagnostics.some((d) => /skipped by excludes/i.test(d.message))).toBe(true);
  });

  it("ignores non-md files and missing dirs (never throws)", () => {
    const root = path.join(tmp, "proj");
    write("proj/rules/note.txt", "not a rule");
    write("proj/rules/real.md", "a rule");
    const res = loadRules(
      [
        { dir: path.join(root, "rules"), scope: "project" },
        { dir: path.join(root, "does-not-exist"), scope: "user" },
      ],
      { excludes: [], projectRoot: root },
    );
    expect(res.rules.map((r) => r.id)).toEqual(["real.md"]);
  });
});

describe("ruleAppliesTo", () => {
  const root = "F:\\some\\project";

  it("unconditional rules always apply", () => {
    expect(ruleAppliesTo(rule({}), path.join(root, "doc", "x.md"), root)).toBe(true);
  });

  it("path-scoped rules match files under the glob (base projectRoot)", () => {
    const r = rule({ paths: ["src/**/*.rs"] });
    expect(ruleAppliesTo(r, path.join(root, "src", "a", "b.rs"), root)).toBe(true);
    expect(ruleAppliesTo(r, path.join(root, "doc", "x.md"), root)).toBe(false);
    expect(ruleAppliesTo(r, path.join(root, "src", "top.rs"), root)).toBe(true); // ** matches zero dirs
  });

  it("matches relative paths resolved against projectRoot", () => {
    const r = rule({ paths: ["src/**/*.rs"] });
    expect(ruleAppliesTo(r, "src/a/b.rs", root)).toBe(true);
    expect(ruleAppliesTo(r, "doc/x.md", root)).toBe(false);
  });

  it("supports multiple globs (any match wins)", () => {
    const r = rule({ paths: ["api/**", "*.sql"] });
    expect(ruleAppliesTo(r, path.join(root, "api", "users.ts"), root)).toBe(true);
    expect(ruleAppliesTo(r, path.join(root, "db", "schema.sql"), root)).toBe(true);
    expect(ruleAppliesTo(r, path.join(root, "web", "index.html"), root)).toBe(false);
  });
});
