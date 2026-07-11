import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expandImports,
  findNestedClaudeMd,
  loadClaudeMdHierarchy,
} from "../src/claude/claude-md.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picc-claudemd-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a file under tmp (creating parent dirs), returns absolute path. */
function write(rel: string, content: string): string {
  const full = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

describe("expandImports", () => {
  it("expands a single-hop import", () => {
    write("sub.md", "SUB CONTENT");
    const res = expandImports("Intro\n@sub.md\nOutro", tmp, {});
    expect(res.content).toBe("Intro\nSUB CONTENT\nOutro");
    expect(res.imported).toEqual([path.join(tmp, "sub.md")]);
    expect(res.diagnostics).toEqual([]);
  });

  it("expands relative ./ imports and imports in subdirectories relative to the importing file", () => {
    write("docs/a.md", "A then @./b.md");
    write("docs/b.md", "B");
    const res = expandImports("@./docs/a.md", tmp, {});
    expect(res.content).toBe("A then B");
  });

  it("expands a 3-hop chain fully", () => {
    write("a.md", "A @b.md");
    write("b.md", "B @c.md");
    write("c.md", "C");
    const res = expandImports("root @a.md end", tmp, {});
    expect(res.content).toBe("root A B C end");
    expect(res.diagnostics).toEqual([]);
    expect(res.imported).toHaveLength(3);
  });

  it("cuts at the 4-hop limit with a diagnostic", () => {
    write("f1.md", "F1 @f2.md");
    write("f2.md", "F2 @f3.md");
    write("f3.md", "F3 @f4.md");
    write("f4.md", "F4 @f5.md");
    write("f5.md", "F5");
    const res = expandImports("@f1.md", tmp, {});
    expect(res.content).toContain("F4");
    expect(res.content).toContain("@f5.md"); // token kept, not expanded
    expect(res.content).not.toContain("F5");
    expect(res.diagnostics.some((d) => /max import depth/i.test(d.message))).toBe(true);
  });

  it("honors a maxHops override", () => {
    write("a.md", "A @b.md");
    write("b.md", "B");
    const res = expandImports("@a.md", tmp, { maxHops: 1 });
    expect(res.content).toBe("A @b.md");
    expect(res.diagnostics.some((d) => /max import depth/i.test(d.message))).toBe(true);
  });

  it("detects cycles and stops with a diagnostic", () => {
    write("a.md", "A @b.md");
    write("b.md", "B @a.md");
    const aContent = fs.readFileSync(path.join(tmp, "a.md"), "utf8");
    const res = expandImports(aContent, tmp, {});
    // a expands b; b's import of a expands once more; then a's @b.md hits the cycle.
    expect(res.diagnostics.some((d) => /circular/i.test(d.message))).toBe(true);
    expect(res.content).toContain("A");
    expect(res.content).toContain("B");
  });

  it("does not expand imports inside fenced code blocks", () => {
    write("x.md", "SHOULD NOT APPEAR");
    const content = "before\n```\n@x.md\n```\nafter";
    const res = expandImports(content, tmp, {});
    expect(res.content).toBe(content);
    expect(res.imported).toEqual([]);
  });

  it("does not expand imports inside inline code spans", () => {
    write("x.md", "SHOULD NOT APPEAR");
    const content = "wrap `@x.md` literal";
    const res = expandImports(content, tmp, {});
    expect(res.content).toBe(content);
  });

  it("still expands an import after a closed code span on the same line", () => {
    write("x.md", "X");
    const res = expandImports("`code` then @x.md", tmp, {});
    expect(res.content).toBe("`code` then X");
  });

  it("does not treat email-like text as an import", () => {
    const content = "contact arne@idedeluxe.com or admin@host.org for help";
    const res = expandImports(content, tmp, {});
    expect(res.content).toBe(content);
    expect(res.diagnostics).toEqual([]);
  });

  it("does not treat @word (no dot/slash) as an import", () => {
    const content = "mention @channel please";
    const res = expandImports(content, tmp, {});
    expect(res.content).toBe(content);
    expect(res.diagnostics).toEqual([]);
  });

  it("keeps the token and warns when the imported file is missing", () => {
    const res = expandImports("see @missing/file.md here", tmp, {});
    expect(res.content).toBe("see @missing/file.md here");
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]!.severity).toBe("warning");
    expect(res.diagnostics[0]!.message).toContain("@missing/file.md");
  });

  it("expands @~/ against opts.home", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "prefs.md"), "HOME PREFS", "utf8");
    const res = expandImports("@~/prefs.md", tmp, { home });
    expect(res.content).toBe("HOME PREFS");
  });

  it("expands absolute-path imports", () => {
    const abs = write("elsewhere/abs.md", "ABS");
    const token = `@${abs.replace(/\\/g, "/")}`;
    const res = expandImports(`${token} done`, path.join(tmp, "unrelated"), {});
    expect(res.content).toBe("ABS done");
  });
});

describe("loadClaudeMdHierarchy", () => {
  it("loads user, then root→cwd chain, then .claude, in order with correct scopes", () => {
    const userDir = path.join(tmp, "userhome");
    const root = path.join(tmp, "proj");
    const cwd = path.join(root, "pkg", "app");
    write("userhome/CLAUDE.md", "USER");
    write("proj/CLAUDE.md", "ROOT");
    write("proj/pkg/CLAUDE.md", "PKG");
    write("proj/pkg/app/CLAUDE.md", "APP");
    write("proj/.claude/CLAUDE.md", "DOTCLAUDE");

    const res = loadClaudeMdHierarchy({ cwd, projectRoot: root, userDir, excludes: [] });
    expect(res.files.map((f) => f.content)).toEqual(["USER", "ROOT", "PKG", "APP", "DOTCLAUDE"]);
    expect(res.files.map((f) => f.scope)).toEqual([
      "user",
      "project",
      "project",
      "project",
      "project",
    ]);
    expect(res.files.every((f) => f.loadAtStart)).toBe(true);
    expect(res.files.map((f) => f.dir)).toEqual([
      userDir,
      root,
      path.join(root, "pkg"),
      cwd,
      path.join(root, ".claude"),
    ]);
  });

  it("places CLAUDE.local.md right after its sibling with scope local", () => {
    const root = path.join(tmp, "proj");
    write("proj/CLAUDE.md", "ROOT");
    write("proj/CLAUDE.local.md", "ROOT LOCAL");
    write("proj/sub/CLAUDE.md", "SUB");

    const res = loadClaudeMdHierarchy({
      cwd: path.join(root, "sub"),
      projectRoot: root,
      userDir: path.join(tmp, "nouser"),
      excludes: [],
    });
    expect(res.files.map((f) => f.content)).toEqual(["ROOT", "ROOT LOCAL", "SUB"]);
    expect(res.files[1]!.scope).toBe("local");
  });

  it("honors excludes (glob against absolute path, base projectRoot)", () => {
    const root = path.join(tmp, "proj");
    write("proj/CLAUDE.md", "ROOT");
    write("proj/vendor/CLAUDE.md", "VENDOR");

    const res = loadClaudeMdHierarchy({
      cwd: path.join(root, "vendor"),
      projectRoot: root,
      userDir: path.join(tmp, "nouser"),
      excludes: ["vendor/CLAUDE.md"],
    });
    expect(res.files.map((f) => f.content)).toEqual(["ROOT"]);
    expect(res.diagnostics.some((d) => /claudeMdExcludes/.test(d.message))).toBe(true);
  });

  it("strips block-level HTML comments", () => {
    const root = path.join(tmp, "proj");
    write("proj/CLAUDE.md", "line1\n<!-- maintainer note -->\nline2");
    const res = loadClaudeMdHierarchy({
      cwd: root,
      projectRoot: root,
      userDir: path.join(tmp, "nouser"),
      excludes: [],
    });
    expect(res.files[0]!.content).toBe("line1\nline2");
  });

  it("expands @imports in hierarchy files relative to each file's dir", () => {
    const root = path.join(tmp, "proj");
    write("proj/CLAUDE.md", "@AGENTS.md");
    write("proj/AGENTS.md", "AGENT INSTRUCTIONS");
    const res = loadClaudeMdHierarchy({
      cwd: root,
      projectRoot: root,
      userDir: path.join(tmp, "nouser"),
      excludes: [],
    });
    expect(res.files[0]!.content).toBe("AGENT INSTRUCTIONS");
  });

  it("returns empty when nothing exists (never throws)", () => {
    const root = path.join(tmp, "empty");
    fs.mkdirSync(root, { recursive: true });
    const res = loadClaudeMdHierarchy({
      cwd: root,
      projectRoot: root,
      userDir: path.join(tmp, "nouser"),
      excludes: [],
    });
    expect(res.files).toEqual([]);
  });
});

describe("findNestedClaudeMd", () => {
  it("returns the nearest ancestor CLAUDE.md, expanded, loadAtStart false", () => {
    const root = path.join(tmp, "proj");
    write("proj/CLAUDE.md", "ROOT");
    write("proj/pkg/CLAUDE.md", "PKG @extra.md");
    write("proj/pkg/extra.md", "EXTRA");
    write("proj/pkg/deep/file.ts", "code");

    const found = findNestedClaudeMd(path.join(root, "pkg", "deep", "file.ts"), {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set([path.join(root, "CLAUDE.md")]),
    });
    expect(found).toBeDefined();
    expect(found!.path).toBe(path.join(root, "pkg", "CLAUDE.md"));
    expect(found!.content).toBe("PKG EXTRA");
    expect(found!.loadAtStart).toBe(false);
    expect(found!.scope).toBe("project");
  });

  it("prefers the deepest CLAUDE.md when several ancestors exist", () => {
    const root = path.join(tmp, "proj");
    write("proj/pkg/CLAUDE.md", "PKG");
    write("proj/pkg/deep/CLAUDE.md", "DEEP");
    write("proj/pkg/deep/file.ts", "code");

    const found = findNestedClaudeMd(path.join(root, "pkg", "deep", "file.ts"), {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set(),
    });
    expect(found!.content).toBe("DEEP");
  });

  it("skips CLAUDE.md files already in the loaded set and walks upward past them", () => {
    const root = path.join(tmp, "proj");
    write("proj/a/CLAUDE.md", "A");
    write("proj/a/b/CLAUDE.md", "B");
    write("proj/a/b/file.ts", "code");

    const foundHigher = findNestedClaudeMd(path.join(root, "a", "b", "file.ts"), {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set([path.join(root, "a", "b", "CLAUDE.md")]),
    });
    expect(foundHigher!.content).toBe("A");

    const none = findNestedClaudeMd(path.join(root, "a", "b", "file.ts"), {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set([
        path.join(root, "a", "b", "CLAUDE.md"),
        path.join(root, "a", "CLAUDE.md"),
      ]),
    });
    expect(none).toBeUndefined();
  });

  it("stops at the worktree root for files inside a worktree checkout", () => {
    const root = path.join(tmp, "proj");
    write("proj/CLAUDE.md", "MAIN ROOT");
    write("proj/.claude/worktrees/wt1/CLAUDE.md", "WT ROOT");
    write("proj/.claude/worktrees/wt1/src/CLAUDE.md", "WT SRC");
    write("proj/.claude/worktrees/wt1/src/file.ts", "code");

    const touched = path.join(root, ".claude", "worktrees", "wt1", "src", "file.ts");
    const found = findNestedClaudeMd(touched, {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set(),
    });
    expect(found!.content).toBe("WT SRC");

    // With the nested one loaded, falls back to the worktree's own root CLAUDE.md —
    // never the main checkout's.
    const upper = findNestedClaudeMd(touched, {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set([path.join(root, ".claude", "worktrees", "wt1", "src", "CLAUDE.md")]),
    });
    expect(upper!.content).toBe("WT ROOT");

    const none = findNestedClaudeMd(touched, {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set([
        path.join(root, ".claude", "worktrees", "wt1", "src", "CLAUDE.md"),
        path.join(root, ".claude", "worktrees", "wt1", "CLAUDE.md"),
      ]),
    });
    expect(none).toBeUndefined();
  });

  it("honors excludes", () => {
    const root = path.join(tmp, "proj");
    write("proj/pkg/CLAUDE.md", "PKG");
    write("proj/pkg/file.ts", "code");
    const found = findNestedClaudeMd(path.join(root, "pkg", "file.ts"), {
      cwd: root,
      projectRoot: root,
      excludes: ["pkg/CLAUDE.md"],
      loaded: new Set(),
    });
    expect(found).toBeUndefined();
  });

  it("returns undefined for files outside the project root", () => {
    const root = path.join(tmp, "proj");
    fs.mkdirSync(root, { recursive: true });
    write("outside/file.ts", "code");
    const found = findNestedClaudeMd(path.join(tmp, "outside", "file.ts"), {
      cwd: root,
      projectRoot: root,
      excludes: [],
      loaded: new Set(),
    });
    expect(found).toBeUndefined();
  });
});
