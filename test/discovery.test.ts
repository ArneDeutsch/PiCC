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

  it("preserves hook handler execution fields (async/once/timeout/shell/args) and entry if:", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            if: "Bash(git *)",
            hooks: [
              {
                type: "command",
                command: "notify.sh",
                args: ["done"],
                shell: "powershell",
                timeout: 9,
                once: true,
                async: true,
              },
            ],
          },
        ],
      },
    });

    const settings = load(scopes);
    const entry = settings.hooks.PostToolUse?.[0];
    expect(entry?.matcher).toBe("Bash");
    expect(entry?.if).toBe("Bash(git *)");
    // `async: true` in particular: dropping it would silently turn a
    // fire-and-forget hook into a BLOCKING one.
    expect(entry?.hooks[0]).toMatchObject({
      type: "command",
      command: "notify.sh",
      args: ["done"],
      shell: "powershell",
      timeout: 9,
      once: true,
      async: true,
    });
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

  it("merges enabledPlugins key-wise across scopes (project must not wipe user-enabled plugins)", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      enabledPlugins: { "foo@official": true, "baz@official": true },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      enabledPlugins: { "bar@acme": true },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), {
      enabledPlugins: { "baz@official": false },
    });

    const settings = load(scopes);
    // User-enabled plugin survives a project file that mentions enabledPlugins…
    expect(settings.enabledPlugins).toEqual({
      "foo@official": true,
      "bar@acme": true,
      // …while a nearer scope still wins PER KEY (explicit disable).
      "baz@official": false,
    });
  });

  it("normalizes array-form enabledPlugins into the merged object", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), { enabledPlugins: ["foo@official"] });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      enabledPlugins: { "bar@acme": true },
    });

    const settings = load(scopes);
    expect(settings.enabledPlugins).toEqual({ "foo@official": true, "bar@acme": true });
  });

  it("ignores a malformed boolean at a higher scope instead of resetting the lower scope's value", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      disableAllHooks: true,
      disableSkillShellExecution: true,
      includeCoAuthoredBy: false,
      disableSubagents: true,
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      disableAllHooks: "definitely", // garbage — must NOT silently re-enable hooks
      disableSkillShellExecution: { nested: true },
      includeCoAuthoredBy: "maybe",
      disableSubagents: "kinda",
    });

    const settings = load(scopes);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.disableSkillShellExecution).toBe(true);
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.subagentsEnabled).toBe(false);
    // Each malformed value is visible, not silent.
    expect(
      settings.diagnostics.filter((d) => d.message.includes("is not a boolean")),
    ).toHaveLength(4);
  });

  it("recognizes autoMemoryEnabled and autoMemoryDirectory", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      autoMemoryEnabled: false,
      autoMemoryDirectory: "/custom/memory",
    });

    const settings = load(scopes);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.autoMemoryDirectory).toBe("/custom/memory");
    expect(settings.unknownKeys).toHaveLength(0);

    // Default: enabled.
    expect(load(makeScopes()).autoMemoryEnabled).toBe(true);
  });

  it("honors the claudeMd inline key ONLY in managed settings", () => {
    const scopes = makeScopes();
    const managedFile = scopes.absentManaged[0]!;
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      claudeMd: "PROJECT INLINE — must be ignored",
    });
    writeJson(managedFile, { claudeMd: "MANAGED INLINE" });

    const settings = load(scopes, [managedFile]);
    expect(settings.managedClaudeMd).toEqual({ content: "MANAGED INLINE", source: managedFile });
    // The project-scope attempt degrades to a diagnostic, not silence.
    expect(
      settings.diagnostics.some((d) => d.message.includes('"claudeMd" is only honored in managed')),
    ).toBe(true);

    // Without a managed file, a project claudeMd never lands anywhere.
    const noManaged = load(scopes, [path.join(scopes.projectRoot, "absent-managed.json")]);
    expect(noManaged.managedClaudeMd).toBeUndefined();
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

describe("loadSettings — nested/monorepo settings", () => {
  it("loads .claude/settings.json from every dir between cwd and the repo root, nearest wins", () => {
    const base = makeTmp();
    const root = path.join(base, "repo");
    const pkg = path.join(root, "packages", "app");
    const userDir = path.join(base, "home", ".claude");
    fs.mkdirSync(userDir, { recursive: true });
    writeJson(path.join(root, ".claude", "settings.json"), {
      model: "root-model",
      permissions: { deny: ["Bash(rm *)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo root" }] }] },
    });
    writeJson(path.join(pkg, ".claude", "settings.json"), {
      model: "pkg-model",
      permissions: { deny: ["Bash(curl *)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo pkg" }] }] },
    });

    const settings = loadSettings({ cwd: pkg, projectRoot: root, userDir, managedPaths: [] });
    // Nearest dir wins on scalars…
    expect(settings.model).toBe("pkg-model");
    // …while rules and hooks accumulate (root layer applied first).
    expect(settings.permissions.deny).toEqual(["Bash(rm *)", "Bash(curl *)"]);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("echo root");
    expect(settings.hooks.SessionStart?.[1]?.hooks[0]?.command).toBe("echo pkg");
  });

  it("loads nested settings.local.json too, above the same dir's settings.json", () => {
    const base = makeTmp();
    const root = path.join(base, "repo");
    const pkg = path.join(root, "packages", "app");
    const userDir = path.join(base, "home", ".claude");
    fs.mkdirSync(userDir, { recursive: true });
    writeJson(path.join(root, ".claude", "settings.local.json"), { model: "root-local" });
    writeJson(path.join(pkg, ".claude", "settings.json"), { model: "pkg-model" });
    writeJson(path.join(pkg, ".claude", "settings.local.json"), { model: "pkg-local" });

    const settings = loadSettings({ cwd: pkg, projectRoot: root, userDir, managedPaths: [] });
    expect(settings.model).toBe("pkg-local");
  });
});

describe("loadSettings — hostile keys (never-throw floor)", () => {
  it('does not throw on a hooks block with a "__proto__" event key and does not pollute prototypes', () => {
    const scopes = makeScopes();
    // NOTE: raw JSON text — a JS object literal would interpret __proto__ itself.
    writeText(
      path.join(scopes.projectRoot, ".claude", "settings.json"),
      `{
        "hooks": {
          "__proto__": [{ "hooks": [{ "type": "command", "command": "evil" }] }],
          "toString": [{ "hooks": [{ "type": "command", "command": "evil2" }] }],
          "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "ok" }] }]
        }
      }`,
    );

    const settings = load(scopes);
    // The legitimate event still loads; the hostile ones degrade to diagnostics.
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.diagnostics.filter((d) => d.message.includes("Unsafe key"))).toHaveLength(2);
    expect(Object.prototype.toString).toBeTypeOf("function"); // untouched
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it('drops "__proto__" keys in env / skillOverrides / enabledPlugins with diagnostics', () => {
    const scopes = makeScopes();
    // NOTE: raw JSON text — a JS object literal would interpret __proto__ itself.
    writeText(
      path.join(scopes.projectRoot, ".claude", "settings.json"),
      `{
        "env": { "__proto__": { "polluted": "yes" }, "GOOD": "v" },
        "skillOverrides": { "__proto__": "off", "deploy": "off" },
        "enabledPlugins": { "__proto__": true, "foo@mp": true }
      }`,
    );

    const settings = load(scopes);
    expect(settings.env.GOOD).toBe("v");
    expect(settings.skillOverrides).toEqual({ deploy: "off" });
    expect(settings.enabledPlugins).toEqual({ "foo@mp": true });
    expect(Object.getPrototypeOf(settings.env)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(settings.diagnostics.filter((d) => d.message.includes("Unsafe key"))).toHaveLength(3);
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

  it("loads a UTF-8 BOM settings.json instead of skipping it (deny rules must survive)", () => {
    const scopes = makeScopes();
    writeText(
      path.join(scopes.projectRoot, ".claude", "settings.json"),
      "\uFEFF" + JSON.stringify({ model: "bom-model", permissions: { deny: ["Bash(rm *)"] } }),
    );

    const settings = load(scopes);
    expect(settings.model).toBe("bom-model");
    expect(settings.permissions.deny).toEqual(["Bash(rm *)"]);
    expect(settings.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
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
    // Main-session-only by default — a deliberate PiCC divergence from Claude
    // Code's up-to-5 contract. Depth-1 fan-out is on; nesting is opt-in
    // via `subagents.maxDepth: 2..5`.
    expect(settings.subagentMaxDepth).toBe(1);
    expect(settings.subagentConcurrency).toBe(10);
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

  it.each([
    ["subagents.maxDepth", "subagentMaxDepth", 1, 0],
    ["subagents.maxDepth", "subagentMaxDepth", 1, -2],
    ["subagents.maxDepth", "subagentMaxDepth", 1, 1.5],
    ["subagents.concurrency", "subagentConcurrency", 10, 0],
    ["subagents.concurrency", "subagentConcurrency", 10, -2],
    ["subagents.concurrency", "subagentConcurrency", 10, 1.5],
  ] as const)(
    "rejects %s=%s (keeps default) with a diagnostic",
    (keyLabel, effectiveKey, defaultValue, badValue) => {
      const sub = keyLabel === "subagents.maxDepth" ? { maxDepth: badValue } : { concurrency: badValue };
      const scopes = makeScopes();
      writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { subagents: sub });

      const settings = load(scopes);
      expect(settings[effectiveKey]).toBe(defaultValue);
      expect(
        settings.diagnostics.some(
          (d) => d.message.includes(keyLabel) && d.message.includes("must be a positive integer"),
        ),
      ).toBe(true);
    },
  );

  it("rejects a non-numeric maxDepth/concurrency but honors a numeric string", () => {
    const scopes = makeScopes();
    // Numeric string is tolerated (asFiniteNumber), no diagnostic.
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      subagents: { maxDepth: "3", concurrency: "8" },
    });
    let settings = load(scopes);
    expect(settings.subagentMaxDepth).toBe(3);
    expect(settings.subagentConcurrency).toBe(8);
    expect(settings.diagnostics.some((d) => d.message.includes("positive integer"))).toBe(false);

    // Non-numeric values are rejected back to the defaults with diagnostics.
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      subagents: { maxDepth: "abc", concurrency: true },
    });
    settings = load(scopes);
    expect(settings.subagentMaxDepth).toBe(1);
    expect(settings.subagentConcurrency).toBe(10);
    expect(
      settings.diagnostics.filter((d) => d.message.includes("must be a positive integer")),
    ).toHaveLength(2);
  });

  it("honors large positive integers with no upper-bound rejection and no diagnostic", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      subagents: { maxDepth: 50, concurrency: 100 },
    });
    const settings = load(scopes);
    expect(settings.subagentMaxDepth).toBe(50);
    expect(settings.subagentConcurrency).toBe(100);
    expect(settings.diagnostics.some((d) => d.message.includes("positive integer"))).toBe(false);
  });

  it("keeps a valid lower-scope maxDepth when a higher scope has an invalid value (reject, not clamp)", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      subagents: { maxDepth: 3 },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      subagents: { maxDepth: 0 }, // invalid at higher scope — must be ignored, NOT clamp to 1
    });

    const settings = load(scopes);
    expect(settings.subagentMaxDepth).toBe(3);
    expect(
      settings.diagnostics.some(
        (d) => d.message.includes("subagents.maxDepth") && d.message.includes("must be a positive integer"),
      ),
    ).toBe(true);
  });

  it("keeps a valid lower-scope concurrency when a higher scope has an invalid value (reject, not clamp)", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      subagents: { concurrency: 8 },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      subagents: { concurrency: -1 }, // invalid at higher scope — must be ignored, NOT clamp
    });

    const settings = load(scopes);
    expect(settings.subagentConcurrency).toBe(8);
    expect(
      settings.diagnostics.some(
        (d) =>
          d.message.includes("subagents.concurrency") && d.message.includes("must be a positive integer"),
      ),
    ).toBe(true);
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

    const dirs = discoverArtifactDirs({ cwd: pkg, projectRoot: root, userDir, managedDirs: [] });

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

    const dirs = discoverArtifactDirs({ cwd: root, projectRoot: root, userDir, managedDirs: [] });
    expect(dirs.skillDirs).toEqual([]);
    expect(dirs.commandDirs).toEqual([{ dir: path.join(userDir, "commands"), scope: "user" }]);
  });

  it("discovers managed/policy artifact dirs first (highest precedence), degrade-safe when absent", () => {
    const base = makeTmp();
    const root = path.join(base, "repo");
    const userDir = path.join(base, "home", ".claude");
    const managedBase = path.join(base, "managed", "ClaudeCode");
    fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(managedBase, "skills"), { recursive: true });
    fs.mkdirSync(path.join(managedBase, "agents"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });

    const dirs = discoverArtifactDirs({
      cwd: root,
      projectRoot: root,
      userDir,
      managedDirs: [managedBase],
    });
    expect(dirs.skillDirs).toEqual([
      { dir: path.join(managedBase, "skills"), scope: "managed" },
      { dir: path.join(root, ".claude", "skills"), scope: "project" },
    ]);
    expect(dirs.agentDirs).toEqual([{ dir: path.join(managedBase, "agents"), scope: "managed" }]);

    // Absent managed dir: nothing contributed, nothing thrown.
    const absent = discoverArtifactDirs({
      cwd: root,
      projectRoot: root,
      userDir,
      managedDirs: [path.join(base, "does-not-exist")],
    });
    expect(absent.skillDirs).toEqual([{ dir: path.join(root, ".claude", "skills"), scope: "project" }]);
  });

  it("orders ruleDirs by ascending priority: user, project root→cwd, managed last", () => {
    const base = makeTmp();
    const root = path.join(base, "repo");
    const pkg = path.join(root, "packages", "app");
    const userDir = path.join(base, "home", ".claude");
    const managedBase = path.join(base, "managed", "ClaudeCode");
    for (const rulesDir of [
      path.join(root, ".claude", "rules"),
      path.join(pkg, ".claude", "rules"),
      path.join(userDir, "rules"),
      path.join(managedBase, "rules"),
    ]) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }

    const dirs = discoverArtifactDirs({
      cwd: pkg,
      projectRoot: root,
      userDir,
      managedDirs: [managedBase],
    });
    expect(dirs.ruleDirs).toEqual([
      { dir: path.join(userDir, "rules"), scope: "user" },
      { dir: path.join(root, ".claude", "rules"), scope: "project" },
      { dir: path.join(pkg, ".claude", "rules"), scope: "project" },
      { dir: path.join(managedBase, "rules"), scope: "managed" },
    ]);
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
