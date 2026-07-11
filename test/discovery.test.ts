import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandEnvVars, loadSettings, stripJsonc } from "../src/discovery/settings.js";
import {
  dedupeByName,
  discoverArtifactDirs,
  resolveProjectRoot,
} from "../src/discovery/locations.js";
import type { SourceRef } from "../src/types.js";

const tempDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (Windows can hold handles briefly)
    }
  }
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

/** Standard three-scope fixture: userDir + projectRoot, no managed file. */
function makeScopes(): { userDir: string; projectRoot: string; absentManaged: string[] } {
  const base = makeTmp();
  const userDir = path.join(base, "userhome", ".claude");
  const projectRoot = path.join(base, "project");
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  return {
    userDir,
    projectRoot,
    absentManaged: [path.join(base, "managed", "managed-settings.json")],
  };
}

function load(scopes: { userDir: string; projectRoot: string; absentManaged: string[] }, managedPaths?: string[]) {
  return loadSettings({
    cwd: scopes.projectRoot,
    projectRoot: scopes.projectRoot,
    userDir: scopes.userDir,
    managedPaths: managedPaths ?? scopes.absentManaged,
  });
}

describe("loadSettings — precedence & merging", () => {
  it("applies scalar precedence: local over project over user", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), { model: "user-model", cleanupPeriodDays: 10 });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { model: "project-model" });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), { model: "local-model" });

    const settings = load(scopes);
    expect(settings.model).toBe("local-model");
    // Scalar only present at a lower scope still survives.
    expect(settings.cleanupPeriodDays).toBe(10);
  });

  it("gives managed settings the highest precedence", () => {
    const scopes = makeScopes();
    const managedFile = scopes.absentManaged[0]!;
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), { model: "local-model" });
    writeJson(managedFile, { model: "managed-model" });

    const settings = load(scopes, [managedFile]);
    expect(settings.model).toBe("managed-model");
  });

  it("accumulates permission rules across scopes with dedup", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      permissions: { allow: ["Bash(npm *)"], deny: ["Read(./.env)"] },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      permissions: { allow: ["Bash(git *)", "Bash(npm *)"], ask: ["Write(./important.js)"] },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), {
      permissions: { deny: ["Bash(curl *)"], additionalDirectories: ["../shared"] },
    });

    const settings = load(scopes);
    expect(settings.permissions.allow).toEqual(["Bash(npm *)", "Bash(git *)"]);
    expect(settings.permissions.deny).toEqual(["Read(./.env)", "Bash(curl *)"]);
    expect(settings.permissions.ask).toEqual(["Write(./important.js)"]);
    expect(settings.permissions.additionalDirectories).toEqual(["../shared"]);
  });

  it("accumulates hooks per event across scopes", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
      },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      hooks: {
        PreToolUse: [
          { matcher: "Write|Edit", hooks: [{ type: "command", command: "echo project-hook", timeout: 5 }] },
        ],
        SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
      },
    });

    const settings = load(scopes);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("echo user-hook");
    expect(settings.hooks.PreToolUse?.[1]?.matcher).toBe("Write|Edit");
    expect(settings.hooks.PreToolUse?.[1]?.hooks[0]?.timeout).toBe(5);
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("merges env key-wise with higher precedence winning, and expands ${VAR}", () => {
    const scopes = makeScopes();
    process.env.PCD_TEST_VALUE = "expanded-value";
    try {
      writeJson(path.join(scopes.userDir, "settings.json"), {
        env: { KEEP_ME: "from-user", OVERRIDE_ME: "user-version" },
      });
      writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
        env: { OVERRIDE_ME: "${PCD_TEST_VALUE}", UNSET_STAYS: "${PCD_DEFINITELY_UNSET_VAR}" },
      });

      const settings = load(scopes);
      expect(settings.env.KEEP_ME).toBe("from-user");
      expect(settings.env.OVERRIDE_ME).toBe("expanded-value");
      // Unknown variables stay literal rather than vanishing.
      expect(settings.env.UNSET_STAYS).toBe("${PCD_DEFINITELY_UNSET_VAR}");
    } finally {
      delete process.env.PCD_TEST_VALUE;
    }
  });

  it("accumulates claudeMdExcludes across scopes", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), { claudeMdExcludes: ["**/vendor/CLAUDE.md"] });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      claudeMdExcludes: ["**/legacy/CLAUDE.md", "**/vendor/CLAUDE.md"],
    });

    const settings = load(scopes);
    expect(settings.claudeMdExcludes).toEqual(["**/vendor/CLAUDE.md", "**/legacy/CLAUDE.md"]);
  });
});

describe("loadSettings — robustness (completeness floor)", () => {
  it("degrades malformed settings.json with a diagnostic and does not throw", () => {
    const scopes = makeScopes();
    writeText(path.join(scopes.projectRoot, ".claude", "settings.json"), "{ this is not json !!!");
    writeJson(path.join(scopes.userDir, "settings.json"), { model: "user-model" });

    const settings = load(scopes);
    // Broken file skipped, other scopes still applied.
    expect(settings.model).toBe("user-model");
    const diag = settings.diagnostics.find(
      (d) => d.severity === "error" && d.source?.endsWith("settings.json") && d.message.includes("Malformed"),
    );
    expect(diag).toBeDefined();
  });

  it("degrades a non-object settings root with a diagnostic", () => {
    const scopes = makeScopes();
    writeText(path.join(scopes.projectRoot, ".claude", "settings.json"), "[1, 2, 3]");
    const settings = load(scopes);
    expect(settings.diagnostics.some((d) => d.message.includes("not an object"))).toBe(true);
  });

  it("tolerates JSONC: // line comments and trailing commas", () => {
    const scopes = makeScopes();
    writeText(
      path.join(scopes.projectRoot, ".claude", "settings.json"),
      [
        "{",
        '  // model choice — note the comment and the URL-in-string below',
        '  "model": "jsonc-model",',
        '  "env": { "URL": "https://example.com//path", },',
        "}",
      ].join("\n"),
    );

    const settings = load(scopes);
    expect(settings.model).toBe("jsonc-model");
    // String content containing "//" must survive comment stripping.
    expect(settings.env.URL).toBe("https://example.com//path");
    expect(settings.diagnostics).toHaveLength(0);
  });

  it("records unknown keys in unknownKeys with the correct scope", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      totallyMadeUpKey: 42,
      permissions: { allow: [], futureSubKey: true },
    });
    writeJson(path.join(scopes.userDir, "settings.json"), { anotherUnknown: "x" });

    const settings = load(scopes);
    expect(settings.unknownKeys).toContainEqual({ key: "totallyMadeUpKey", scope: "project" });
    expect(settings.unknownKeys).toContainEqual({ key: "permissions.futureSubKey", scope: "project" });
    expect(settings.unknownKeys).toContainEqual({ key: "anotherUnknown", scope: "user" });
  });

  it("records deferred-subsystem keys in deferredKeys (recognized, no-op)", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      mcpServers: { github: { command: "gh-mcp" } },
      outputStyle: "explanatory",
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      permissions: { defaultMode: "acceptEdits" },
      statusLine: { type: "command", command: "echo hi" },
    });

    const settings = load(scopes);
    expect(settings.deferredKeys).toContainEqual({ key: "mcpServers", scope: "user" });
    expect(settings.deferredKeys).toContainEqual({ key: "outputStyle", scope: "user" });
    expect(settings.deferredKeys).toContainEqual({ key: "statusLine", scope: "project" });
    expect(settings.deferredKeys).toContainEqual({ key: "permissions.defaultMode", scope: "project" });
    // Not reported as unknown.
    expect(settings.unknownKeys).toHaveLength(0);
    // defaultMode value is still parsed for the compat report.
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
  });

  it("degrades silently when managed settings are absent (default and explicit paths)", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { model: "m" });

    // Explicit nonexistent managed path.
    const settings = load(scopes);
    expect(settings.model).toBe("m");
    expect(settings.diagnostics).toHaveLength(0);

    // Default platform managed path (probed, most likely absent) must not throw either.
    expect(() =>
      loadSettings({ cwd: scopes.projectRoot, projectRoot: scopes.projectRoot, userDir: scopes.userDir }),
    ).not.toThrow();
  });

  it("returns pure defaults when no settings files exist at all", () => {
    const scopes = makeScopes();
    const settings = load(scopes);
    expect(settings.permissions.allow).toEqual([]);
    expect(settings.hooks).toEqual({});
    expect(settings.worktree.baseRef).toBe("head");
    expect(settings.subagentsEnabled).toBe(true);
    expect(settings.subagentMaxDepth).toBe(2);
    expect(settings.subagentConcurrency).toBe(4);
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.disableSkillShellExecution).toBe(false);
    expect(settings.diagnostics).toEqual([]);
  });
});

describe("loadSettings — recognized toggles", () => {
  it("recognizes subagent toggles in both spellings", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      subagents: { maxDepth: 5, concurrency: 8 },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      disableSubagents: true,
    });

    const settings = load(scopes);
    expect(settings.subagentsEnabled).toBe(false);
    expect(settings.subagentMaxDepth).toBe(5);
    expect(settings.subagentConcurrency).toBe(8);

    // subagents.enabled re-enables at a higher scope.
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), {
      subagents: { enabled: true },
    });
    expect(load(scopes).subagentsEnabled).toBe(true);
  });

  it("recognizes worktree.baseRef and rejects invalid values with a diagnostic", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      worktree: { baseRef: "fresh" },
    });
    expect(load(scopes).worktree.baseRef).toBe("fresh");

    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      worktree: { baseRef: "nonsense" },
    });
    const settings = load(scopes);
    expect(settings.worktree.baseRef).toBe("head");
    expect(settings.diagnostics.some((d) => d.message.includes("worktree.baseRef"))).toBe(true);
  });

  it("maps the remaining recognized scalar keys", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      includeCoAuthoredBy: false,
      attribution: { commit: "none" },
      disableAllHooks: true,
      disableSkillShellExecution: true,
      skillListingBudgetFraction: 0.2,
      skillListingMaxDescChars: 120,
      skillOverrides: { "legacy-context": "name-only" },
      apiKeyHelper: "/bin/helper.sh",
      enabledPlugins: { "my-plugin@marketplace": true },
    });

    const settings = load(scopes);
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.attribution).toEqual({ commit: "none" });
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.disableSkillShellExecution).toBe(true);
    expect(settings.skillListingBudgetFraction).toBe(0.2);
    expect(settings.skillListingMaxDescChars).toBe(120);
    expect(settings.skillOverrides).toEqual({ "legacy-context": "name-only" });
    expect(settings.apiKeyHelper).toBe("/bin/helper.sh");
    expect(settings.enabledPlugins).toEqual({ "my-plugin@marketplace": true });
    expect(settings.unknownKeys).toHaveLength(0);
  });
});

describe("stripJsonc / expandEnvVars", () => {
  it("strips comments and trailing commas but preserves string contents", () => {
    const input = '{\n  "a": "//not-a-comment", // real comment\n  "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(input))).toEqual({ a: "//not-a-comment", b: [1, 2] });
  });

  it("expands only defined variables", () => {
    process.env.PCD_TEST_EXPAND = "yes";
    try {
      expect(expandEnvVars("v=${PCD_TEST_EXPAND}")).toBe("v=yes");
      expect(expandEnvVars("v=${PCD_TEST_MISSING_XYZ}")).toBe("v=${PCD_TEST_MISSING_XYZ}");
    } finally {
      delete process.env.PCD_TEST_EXPAND;
    }
  });
});

describe("locations — project root & artifact discovery", () => {
  it("resolveProjectRoot walks up to the git repo root, falling back to cwd", () => {
    const base = makeTmp();
    const repo = path.join(base, "repo");
    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    expect(resolveProjectRoot(nested)).toBe(repo);

    const noRepo = path.join(base, "loose");
    fs.mkdirSync(noRepo, { recursive: true });
    // No .git anywhere under base — but the temp dir may live inside a repo-owned
    // tree on dev machines, so just assert it does not throw and returns a string.
    expect(typeof resolveProjectRoot(noRepo)).toBe("string");
  });

  it("monorepo walk-up discovers nested .claude dirs nearest-first, then user scope", () => {
    const base = makeTmp();
    const root = path.join(base, "repo");
    const pkg = path.join(root, "packages", "app");
    const userDir = path.join(base, "home", ".claude");

    for (const claudeBase of [path.join(root, ".claude"), path.join(pkg, ".claude"), userDir]) {
      fs.mkdirSync(path.join(claudeBase, "skills"), { recursive: true });
      fs.mkdirSync(path.join(claudeBase, "agents"), { recursive: true });
    }
    // Rules only at root; commands nowhere.
    fs.mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });

    const dirs = discoverArtifactDirs({ cwd: pkg, projectRoot: root, userDir });

    expect(dirs.skillDirs.map((d) => d.dir)).toEqual([
      path.join(pkg, ".claude", "skills"),
      path.join(root, ".claude", "skills"),
      path.join(userDir, "skills"),
    ]);
    expect(dirs.skillDirs.map((d) => d.scope)).toEqual(["project", "project", "user"]);
    expect(dirs.agentDirs).toHaveLength(3);
    expect(dirs.ruleDirs).toEqual([{ dir: path.join(root, ".claude", "rules"), scope: "project" }]);
    expect(dirs.commandDirs).toEqual([]);
  });

  it("returns only user dirs when the project has no .claude directory", () => {
    const base = makeTmp();
    const root = path.join(base, "repo");
    const userDir = path.join(base, "home", ".claude");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(userDir, "commands"), { recursive: true });

    const dirs = discoverArtifactDirs({ cwd: root, projectRoot: root, userDir });
    expect(dirs.skillDirs).toEqual([]);
    expect(dirs.commandDirs).toEqual([{ dir: path.join(userDir, "commands"), scope: "user" }]);
  });

  it("dedupeByName keeps the first occurrence per name (nearest/highest scope wins)", () => {
    const mk = (name: string, scope: SourceRef["scope"]): { name: string; source: SourceRef } => ({
      name,
      source: { path: `<virtual>/${scope}/${name}`, scope },
    });
    const winners = dedupeByName([
      mk("review", "local"),
      mk("review", "project"),
      mk("deploy", "project"),
      mk("review", "user"),
      mk("deploy", "user"),
      mk("lint", "user"),
    ]);
    expect(winners.map((w) => `${w.name}:${w.source.scope}`)).toEqual([
      "review:local",
      "deploy:project",
      "lint:user",
    ]);
  });
});
