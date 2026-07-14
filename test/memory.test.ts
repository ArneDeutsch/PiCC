import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flattenProjectPath, loadAgentMemory, loadAutoMemory } from "../src/claude/memory.js";
import { buildSystemPromptSuffix, newSessionContextState } from "../src/runtime/context-assembly.js";
import type { ClaudeSettings } from "../src/types.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "picc-memory-"));
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

function baseSettings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    autoMemoryEnabled: true,
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 2,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

describe("flattenProjectPath", () => {
  it("replaces every non-alphanumeric char of the absolute path with '-'", () => {
    if (process.platform === "win32") {
      expect(flattenProjectPath("F:\\Arne\\Projekte\\picc")).toBe("F--Arne-Projekte-picc");
    } else {
      expect(flattenProjectPath("/home/user/my.project")).toBe("-home-user-my-project");
    }
    // Never produces anything outside [A-Za-z0-9-].
    expect(flattenProjectPath(tmp)).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe("loadAutoMemory", () => {
  it("resolves the default dir <userDir>/projects/<flattened>/memory and loads MEMORY.md", () => {
    const userDir = path.join(tmp, "userhome");
    const projectRoot = path.join(tmp, "proj");
    fs.mkdirSync(projectRoot, { recursive: true });
    const memDir = path.join(userDir, "projects", flattenProjectPath(projectRoot), "memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, "MEMORY.md"), "# Memory index\n- fact one", "utf8");

    const res = loadAutoMemory(projectRoot, userDir, {}, {});
    expect(res).toBeDefined();
    expect(res!.dir).toBe(memDir);
    expect(res!.content).toBe("# Memory index\n- fact one");
  });

  it("returns the dir with no content when MEMORY.md is absent (instructions still inject)", () => {
    const userDir = path.join(tmp, "userhome");
    const projectRoot = path.join(tmp, "proj");
    fs.mkdirSync(projectRoot, { recursive: true });

    const res = loadAutoMemory(projectRoot, userDir, {}, {});
    expect(res).toBeDefined();
    expect(res!.dir).toBe(
      path.join(userDir, "projects", flattenProjectPath(projectRoot), "memory"),
    );
    expect(res!.content).toBeUndefined();
  });

  it("honors the autoMemoryDirectory override", () => {
    const custom = path.join(tmp, "custom-memory");
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, "MEMORY.md"), "CUSTOM", "utf8");

    const res = loadAutoMemory(path.join(tmp, "proj"), path.join(tmp, "userhome"), {
      autoMemoryDirectory: custom,
    }, {});
    expect(res!.dir).toBe(custom);
    expect(res!.content).toBe("CUSTOM");
  });

  it("is disabled by autoMemoryEnabled: false", () => {
    const res = loadAutoMemory(path.join(tmp, "proj"), path.join(tmp, "userhome"), {
      autoMemoryEnabled: false,
    }, {});
    expect(res).toBeUndefined();
  });

  it("is disabled by a truthy CLAUDE_CODE_DISABLE_AUTO_MEMORY, but not by an off value", () => {
    const projectRoot = path.join(tmp, "proj");
    const userDir = path.join(tmp, "userhome");
    expect(
      loadAutoMemory(projectRoot, userDir, {}, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
    ).toBeUndefined();
    expect(
      loadAutoMemory(projectRoot, userDir, {}, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "true" }),
    ).toBeUndefined();
    expect(
      loadAutoMemory(projectRoot, userDir, {}, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" }),
    ).toBeDefined();
    expect(loadAutoMemory(projectRoot, userDir, {}, {})).toBeDefined();
  });

  it("truncates MEMORY.md to the first 200 lines with a marker", () => {
    const custom = path.join(tmp, "mem-lines");
    fs.mkdirSync(custom, { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(custom, "MEMORY.md"), lines.join("\n"), "utf8");

    const res = loadAutoMemory(path.join(tmp, "proj"), path.join(tmp, "userhome"), {
      autoMemoryDirectory: custom,
    }, {});
    expect(res!.content).toContain("line 200");
    expect(res!.content).not.toContain("line 201");
    expect(res!.content).toContain("[MEMORY.md truncated");
  });

  it("truncates MEMORY.md to 25 KB when the byte cap cuts before the line cap", () => {
    const custom = path.join(tmp, "mem-bytes");
    fs.mkdirSync(custom, { recursive: true });
    // One huge line: the line cap never fires, the byte cap must.
    fs.writeFileSync(path.join(custom, "MEMORY.md"), "x".repeat(30_000), "utf8");

    const res = loadAutoMemory(path.join(tmp, "proj"), path.join(tmp, "userhome"), {
      autoMemoryDirectory: custom,
    }, {});
    const body = res!.content!;
    expect(body).toContain("[MEMORY.md truncated");
    const kept = body.slice(0, body.indexOf("\n[MEMORY.md truncated"));
    expect(Buffer.byteLength(kept, "utf8")).toBe(25 * 1024);
  });

  it("never splits a multi-byte UTF-8 char at the byte cap", () => {
    const custom = path.join(tmp, "mem-utf8");
    fs.mkdirSync(custom, { recursive: true });
    // "→" is 3 bytes; 10_000 of them = 30_000 bytes on one line.
    fs.writeFileSync(path.join(custom, "MEMORY.md"), "→".repeat(10_000), "utf8");

    const res = loadAutoMemory(path.join(tmp, "proj"), path.join(tmp, "userhome"), {
      autoMemoryDirectory: custom,
    }, {});
    expect(res!.content).not.toContain("�"); // no replacement chars
    expect(res!.content).toContain("[MEMORY.md truncated");
  });
});

describe("loadAgentMemory", () => {
  it("resolves all three scopes to their agent-memory dirs and loads MEMORY.md", () => {
    const userDir = path.join(tmp, "userhome");
    const projectRoot = path.join(tmp, "proj");
    write("userhome/agent-memory/reviewer/MEMORY.md", "USER MEM");
    write("proj/.claude/agent-memory/reviewer/MEMORY.md", "PROJECT MEM");
    write("proj/.claude/agent-memory-local/reviewer/MEMORY.md", "LOCAL MEM");

    const user = loadAgentMemory("reviewer", "user", projectRoot, userDir);
    expect(user!.dir).toBe(path.join(userDir, "agent-memory", "reviewer"));
    expect(user!.content).toBe("USER MEM");

    const project = loadAgentMemory("reviewer", "project", projectRoot, userDir);
    expect(project!.dir).toBe(path.join(projectRoot, ".claude", "agent-memory", "reviewer"));
    expect(project!.content).toBe("PROJECT MEM");

    const local = loadAgentMemory("reviewer", "local", projectRoot, userDir);
    expect(local!.dir).toBe(path.join(projectRoot, ".claude", "agent-memory-local", "reviewer"));
    expect(local!.content).toBe("LOCAL MEM");
  });

  it("returns the dir without content when MEMORY.md does not exist", () => {
    const res = loadAgentMemory("fresh-agent", "project", path.join(tmp, "proj"), path.join(tmp, "u"));
    expect(res).toBeDefined();
    expect(res!.content).toBeUndefined();
  });

  it("truncates agent MEMORY.md to the first 200 lines", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `agent line ${i + 1}`);
    write("userhome/agent-memory/big/MEMORY.md", lines.join("\n"));
    const res = loadAgentMemory("big", "user", path.join(tmp, "proj"), path.join(tmp, "userhome"));
    expect(res!.content).toContain("agent line 200");
    expect(res!.content).not.toContain("agent line 201");
    expect(res!.content).toContain("[MEMORY.md truncated");
  });

  it("degrades to undefined for an unknown scope (never throws)", () => {
    const res = loadAgentMemory(
      "reviewer",
      "weird" as unknown as "user",
      path.join(tmp, "proj"),
      path.join(tmp, "userhome"),
    );
    expect(res).toBeUndefined();
  });
});

describe("buildSystemPromptSuffix — Auto memory section (B4)", () => {
  function suffix(autoMemory?: { dir: string; content?: string }): string {
    return buildSystemPromptSuffix({
      claudeMd: [],
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState([]),
      autoMemory,
    });
  }

  it("injects dir, content, and conservative write guidance when memory exists", () => {
    const out = suffix({ dir: "F:\\mem\\dir", content: "# Memory index\n- durable fact" });
    expect(out).toContain("# Auto memory");
    expect(out).toContain("Memory directory: F:\\mem\\dir");
    expect(out).toContain("- durable fact");
    // Intent-not-prose: conservative, explicit-request-only writing (F10).
    // Positive trigger for the explicit-request path.
    expect(out).toMatch(/remember/i);
    // Deference carve-out so a project's CLAUDE.md eager-write opt-in wins.
    expect(out).toMatch(/unless[^.]*instructions/i);
    // Regression guard for the flip: the old eager string said "whenever you learn".
    expect(out).not.toMatch(/whenever you learn/i);
    // Index convention preserved (loosened from the old exact phrase).
    expect(out).toMatch(/MEMORY\.md/);
    expect(out).toMatch(/index/i);
    // Mechanism preserved.
    expect(out).toContain("Write/Edit");
  });

  it("injects the section with path + guidance but no content when MEMORY.md is absent", () => {
    const out = suffix({ dir: "F:\\mem\\dir" });
    expect(out).toContain("# Auto memory");
    expect(out).toContain("Memory directory: F:\\mem\\dir");
    expect(out).toMatch(/remember/i);
    expect(out).not.toMatch(/whenever you learn/i);
  });

  it("omits the section entirely when auto memory is disabled (undefined)", () => {
    expect(suffix(undefined)).not.toContain("Auto memory");
  });
});
