import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandEnvVars, loadSettings, stripJsonc } from "../src/discovery/settings.js";
import {
  createWindowsManagedRegistryAdapter,
  defaultManagedPolicyDescription,
  discoverManagedPolicy,
  type ManagedPolicyIo,
  type ManagedRegistryAdapter,
  type RegistryCommandInvocation,
} from "../src/discovery/managed-policy.js";
import {
  dedupeByName,
  defaultManagedDirs,
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

function inertPolicyIo(
  files: Record<string, string | "<unreadable>">,
  dropIns: string[] = [],
): ManagedPolicyIo {
  return {
    readFile(filePath) {
      if (!Object.hasOwn(files, filePath)) return { status: "absent" };
      const text = files[filePath];
      return text === "<unreadable>"
        ? { status: "unreadable" }
        : { status: "present", text: text! };
    },
    listJsonFiles() {
      return { status: "present", files: dropIns };
    },
  };
}

function inertRegistry(
  hklm: ReturnType<ManagedRegistryAdapter["readSettings"]>,
  hkcu: ReturnType<ManagedRegistryAdapter["readSettings"]>,
  calls: string[] = [],
): ManagedRegistryAdapter {
  return {
    readSettings(hive) {
      calls.push(hive);
      return hive === "HKLM" ? hklm : hkcu;
    },
  };
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

  it("rejects array-form enabledPlugins without affecting valid entries", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), { enabledPlugins: ["foo@official"] });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      enabledPlugins: { "bar@acme": true },
    });

    const settings = load(scopes);
    expect(settings.enabledPlugins).toEqual({ "bar@acme": true });
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({ message: 'Setting "enabledPlugins" is not an object; ignored' }),
    );
  });

  it("accepts only exact qualified-ID literal booleans and preserves each winning source", () => {
    const scopes = makeScopes();
    const userFile = path.join(scopes.userDir, "settings.json");
    const projectFile = path.join(scopes.projectRoot, ".claude", "settings.json");
    writeJson(userFile, {
      enabledPlugins: {
        "good@official": true,
        bare: true,
        " spaced@official": true,
        "string@official": "false",
        "number@official": 1,
        "null@official": null,
        "array@official": [],
        "object@official": {},
      },
    });
    writeJson(projectFile, {
      enabledPlugins: { "good@official": false, "second@acme": true },
    });

    const settings = load(scopes);
    expect(settings.enabledPlugins).toEqual({
      "good@official": false,
      "second@acme": true,
    });
    expect(settings.effectivePluginEnablement).toEqual({
      "good@official": { enabled: false, scope: "project", source: projectFile },
      "second@acme": { enabled: true, scope: "project", source: projectFile },
    });
    expect(settings.diagnostics.filter((d) => d.message.includes("literal boolean"))).toHaveLength(5);
    expect(settings.diagnostics.filter((d) => d.message.includes("Invalid plugin identity"))).toHaveLength(2);
  });

  it("does not let an invalid higher-precedence plugin value erase a valid lower value", () => {
    const scopes = makeScopes();
    const userFile = path.join(scopes.userDir, "settings.json");
    const projectFile = path.join(scopes.projectRoot, ".claude", "settings.json");
    writeJson(userFile, { enabledPlugins: { "safe@official": false } });
    writeJson(projectFile, { enabledPlugins: { "safe@official": "yes" } });

    const settings = load(scopes);
    expect(settings.enabledPlugins).toEqual({ "safe@official": false });
    expect(settings.effectivePluginEnablement?.["safe@official"]).toEqual({
      enabled: false,
      scope: "user",
      source: userFile,
    });
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({ source: projectFile, message: expect.stringContaining("literal boolean") }),
    );
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
    expect(settings.diagnostics.filter((d) => d.message.includes("Unsafe key"))).toHaveLength(2);
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({ message: 'Invalid plugin identity in "enabledPlugins" ignored' }),
    );
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
      outputStyle: "explanatory",
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      permissions: { defaultMode: "acceptEdits" },
      statusLine: { type: "command", command: "echo hi" },
    });

    const settings = load(scopes);
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

    // Ambient source resolution is covered through inert adapters; tests never probe host policy.
    expect(() =>
      loadSettings({
        cwd: scopes.projectRoot,
        projectRoot: scopes.projectRoot,
        userDir: scopes.userDir,
        managedPolicy: {
          platform: "win32",
          io: inertPolicyIo({}),
          registry: inertRegistry({ status: "absent" }, { status: "absent" }),
        },
      }),
    ).not.toThrow();
  });

  it("returns pure defaults when no settings files exist at all", () => {
    const scopes = makeScopes();
    const settings = load(scopes);
    expect(settings.permissions.allow).toEqual([]);
    expect(settings.hooks).toEqual({});
    expect(settings.worktree.baseRef).toBe("head");
    expect(settings.subagentsEnabled).toBe(true);
    // Positive integers are valid, but nesting requires maxDepth > 1. Keep
    // main-session-only as the default to avoid unexpected recursive fan-out
    // draining subscription capacity.
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

describe("loadSettings — MCP settings capture (graduated keys)", () => {
  it("no longer reports the four MCP keys as deferred or unknown", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      mcpServers: { github: { command: "gh-mcp" } },
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["a"],
      disabledMcpjsonServers: ["b"],
    });

    const settings = load(scopes);
    expect(settings.deferredKeys).toHaveLength(0);
    expect(settings.unknownKeys).toHaveLength(0);
  });

  it("captures MCP keys scope-tagged per file, never merged across scopes", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      mcpServers: { github: { command: "gh-mcp" } },
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["one", "two"],
    });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), {
      disabledMcpjsonServers: ["two"],
      mcpServers: { local: { command: "local-mcp" } },
    });

    const settings = load(scopes);
    const entries = settings.mcpSettings ?? [];
    expect(entries).toHaveLength(3);
    // Ascending precedence order: user, project, local — one entry per file.
    expect(entries[0]).toMatchObject({
      scope: "user",
      sourcePath: path.join(scopes.userDir, "settings.json"),
    });
    expect(entries[0]?.servers?.github).toEqual({ command: "gh-mcp" });
    expect(entries[1]).toMatchObject({
      scope: "project",
      sourcePath: path.join(scopes.projectRoot, ".claude", "settings.json"),
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ["one", "two"],
    });
    // No cross-scope merge: the project entry has no servers, the local one no enable flag.
    expect(entries[1]?.servers).toBeUndefined();
    expect(entries[2]).toMatchObject({
      scope: "local",
      sourcePath: path.join(scopes.projectRoot, ".claude", "settings.local.json"),
      disabledMcpjsonServers: ["two"],
    });
    expect(entries[2]?.servers?.local).toEqual({ command: "local-mcp" });
    expect(entries[2]?.enableAllProjectMcpServers).toBeUndefined();
  });

  it('captures a "__proto__" server name safely (null-prototype record, no pollution)', () => {
    const scopes = makeScopes();
    // NOTE: raw JSON text — a JS object literal would interpret __proto__ itself.
    writeText(
      path.join(scopes.projectRoot, ".claude", "settings.json"),
      `{ "mcpServers": { "__proto__": { "command": "evil" }, "good": { "command": "ok" } } }`,
    );

    const settings = load(scopes);
    const servers = settings.mcpSettings?.[0]?.servers;
    expect(servers).toBeDefined();
    expect(Object.getPrototypeOf(servers)).toBeNull();
    expect(Object.keys(servers!)).toEqual(["__proto__", "good"]);
    expect(({} as Record<string, unknown>)["command"]).toBeUndefined();
    expect(Object.prototype.toString).toBeTypeOf("function"); // untouched
  });

  it("degrades malformed MCP key shapes with diagnostics", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      mcpServers: ["not", "an", "object"],
      enableAllProjectMcpServers: "definitely",
      enabledMcpjsonServers: "srv",
      disabledMcpjsonServers: [1, "ok"],
    });

    const settings = load(scopes);
    expect(settings.diagnostics.some((d) => d.message.includes('"mcpServers" is not an object'))).toBe(true);
    expect(settings.diagnostics.some((d) => d.message.includes('"enableAllProjectMcpServers" is not a boolean'))).toBe(true);
    expect(settings.diagnostics.some((d) => d.message.includes('"enabledMcpjsonServers" is not an array'))).toBe(true);
    expect(settings.diagnostics.some((d) => d.message.includes('Non-string entry in "disabledMcpjsonServers"'))).toBe(true);
    // Only the valid list value lands in the capture.
    const entry = settings.mcpSettings?.[0];
    expect(entry?.servers).toBeUndefined();
    expect(entry?.enableAllProjectMcpServers).toBeUndefined();
    expect(entry?.enabledMcpjsonServers).toBeUndefined();
    expect(entry?.disabledMcpjsonServers).toEqual(["ok"]);
  });

  it("defaults to an empty mcpSettings capture when no file carries MCP keys", () => {
    expect(load(makeScopes()).mcpSettings).toEqual([]);
  });
});

describe("loadSettings — strict plugin enablement diagnostics", () => {
  it("accepts only syntactically qualified IDs across separator and whitespace cases", () => {
    const scopes = makeScopes();
    const entries: Record<string, boolean> = {
      "a@b": true,
      "A-1._@M_p.-": false,
      "@b": true,
      "a@": true,
      "a@b@c": true,
      " a@b": true,
      "a @b": true,
      "a@ b": true,
      "a/b@c": true,
      "a\\b@c": true,
      "a@b/c": true,
      "a:b@c": true,
      ".a@b": true,
      "a@.b": true,
    };
    writeJson(path.join(scopes.userDir, "settings.json"), { enabledPlugins: entries });

    const settings = load(scopes);
    expect(settings.enabledPlugins).toEqual({ "a@b": true, "A-1._@M_p.-": false });
    const messages = settings.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages.filter((message) => message.includes("Invalid plugin identity"))).toHaveLength(8);
    expect(messages).toContain('Additional malformed "enabledPlugins" entries omitted');
  });

  it("bounds diagnostics independently per source without echoing hostile keys or values", () => {
    const scopes = makeScopes();
    const userFile = path.join(scopes.userDir, "settings.json");
    const projectFile = path.join(scopes.projectRoot, ".claude", "settings.json");
    const hostileEntries = (prefix: string): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `${prefix}/../\u001b[31m-${index}`,
          `secret-value-${index}`,
        ]),
      );
    writeJson(userFile, {
      enabledPlugins: {
        ...hostileEntries("user-hostile"),
        "user-on@official": true,
        "user-off@official": false,
      },
    });
    writeJson(projectFile, {
      enabledPlugins: {
        ...hostileEntries("project-hostile"),
        "project-on@official": true,
        "project-off@official": false,
      },
    });

    const settings = load(scopes);
    expect(settings.enabledPlugins).toEqual({
      "user-on@official": true,
      "user-off@official": false,
      "project-on@official": true,
      "project-off@official": false,
    });
    expect(settings.effectivePluginEnablement).toEqual({
      "user-on@official": { enabled: true, scope: "user", source: userFile },
      "user-off@official": { enabled: false, scope: "user", source: userFile },
      "project-on@official": { enabled: true, scope: "project", source: projectFile },
      "project-off@official": { enabled: false, scope: "project", source: projectFile },
    });
    for (const source of [userFile, projectFile]) {
      const diagnostics = settings.diagnostics.filter((diagnostic) => diagnostic.source === source);
      expect(diagnostics).toHaveLength(9);
      expect(
        diagnostics.filter(
          (diagnostic) =>
            diagnostic.message === 'Additional malformed "enabledPlugins" entries omitted',
        ),
      ).toHaveLength(1);
    }
    const rendered = settings.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    expect(rendered).not.toContain("hostile");
    expect(rendered).not.toContain("secret-value");
    expect(rendered).not.toContain("secret-user-value");
  });

  it("identifies a safe qualified ID for a malformed value without echoing that value", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      enabledPlugins: { "safe-id@official": "credential-shaped-value" },
    });

    const settings = load(scopes);
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({
        message:
          'Plugin "safe-id@official" in "enabledPlugins" must be a literal boolean; ignored',
      }),
    );
    expect(settings.diagnostics[0]?.message).not.toContain("credential-shaped-value");
  });
});

describe("managed policy discovery", () => {
  it("describes current platform file and artifact locations without obsolete ProgramData", () => {
    expect(defaultManagedPolicyDescription("win32")).toEqual({
      systemSettingsPath: path.win32.join("C:\\", "Program Files", "ClaudeCode", "managed-settings.json"),
      dropInDir: path.win32.join("C:\\", "Program Files", "ClaudeCode", "managed-settings.d"),
      artifactDirs: [path.win32.join("C:\\", "Program Files", "ClaudeCode")],
    });
    expect(defaultManagedPolicyDescription("darwin").systemSettingsPath).toBe(
      "/Library/Application Support/ClaudeCode/managed-settings.json",
    );
    expect(defaultManagedPolicyDescription("linux").systemSettingsPath).toBe(
      "/etc/claude-code/managed-settings.json",
    );
    expect(defaultManagedDirs("win32").join("|")).not.toContain("ProgramData");
  });

  it("deep-merges base, sorted drop-ins, and HKLM with scalar, object, and stable-array semantics", () => {
    const description = {
      systemSettingsPath: "/policy/managed-settings.json",
      dropInDir: "/policy/managed-settings.d",
      artifactDirs: ["/policy"],
    };
    const a = "/policy/managed-settings.d/10-a.json";
    const b = "/policy/managed-settings.d/20-b.json";
    const result = discoverManagedPolicy({
      platform: "win32",
      description,
      io: inertPolicyIo(
        {
          [description.systemSettingsPath]: JSON.stringify({
            model: "base",
            nested: { a: 1, same: "base" },
            list: ["base", { x: 1 }],
            enabledPlugins: { "base@official": true },
          }),
          [a]: JSON.stringify({ nested: { b: 2, same: "a" }, list: ["a", { x: 1 }] }),
          [b]: JSON.stringify({ model: "drop-in", list: ["base", "b"] }),
        },
        [a, b],
      ),
      registry: inertRegistry(
        { status: "present", json: JSON.stringify({ model: "hklm", nested: { c: 3 }, list: ["hklm"] }) },
        { status: "present", json: JSON.stringify({ model: "hkcu" }) },
      ),
    });

    expect(result.settings).toEqual({
      model: "hklm",
      nested: { a: 1, same: "a", b: 2, c: 3 },
      list: ["base", { x: 1 }, "a", "b", "hklm"],
      enabledPlugins: { "base@official": true },
    });
    expect(result.sources.map(({ source }) => source)).toEqual([
      description.systemSettingsPath,
      a,
      b,
      `HKLM\\SOFTWARE\\Policies\\ClaudeCode\\Settings`,
    ]);
  });

  it("keeps hostile managed object keys on null-prototype records without leakage", () => {
    const source = "/policy/hostile.json";
    const result = discoverManagedPolicy({
      platform: "linux",
      overridePaths: [source],
      io: inertPolicyIo({
        [source]:
          '{"nested":{"__proto__":{"polluted":"yes"},"constructor":{"safe":true}}}',
      }),
    });

    const nested = result.settings?.nested as Record<string, unknown>;
    expect(Object.getPrototypeOf(result.settings)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.keys(nested)).toEqual(["__proto__", "constructor"]);
    expect(nested.__proto__).toEqual({ polluted: "yes" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("uses HKCU only when no administrator source is present", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const fallbackCalls: string[] = [];
    const fallback = discoverManagedPolicy({
      platform: "win32",
      description,
      io: inertPolicyIo({}),
      registry: inertRegistry(
        { status: "absent" },
        { status: "present", json: JSON.stringify({ model: "hkcu" }) },
        fallbackCalls,
      ),
    });
    expect(fallback.settings).toEqual({ model: "hkcu" });
    expect(fallbackCalls).toEqual(["HKLM", "HKCU"]);

    for (const administrator of ["{ malformed", "<unreadable>"] as const) {
      const calls: string[] = [];
      const blockedFallback = discoverManagedPolicy({
        platform: "win32",
        description,
        io: inertPolicyIo({ [description.systemSettingsPath]: administrator }),
        registry: inertRegistry(
          { status: "absent" },
          { status: "present", json: JSON.stringify({ model: "hkcu" }) },
          calls,
        ),
      });
      expect(blockedFallback.settings).toBeUndefined();
      expect(calls).toEqual(["HKLM"]);
      expect(blockedFallback.diagnostics[0]).toMatchObject({
        sourceClass: "system-file",
        impact: "weaker-policy-suppressed",
      });
    }
  });

  it("suppresses HKCU for malformed or unreadable HKLM and emits stable policy diagnostics", () => {
    for (const hklm of [
      { status: "present", json: "not json" } as const,
      { status: "unreadable" } as const,
    ]) {
      const calls: string[] = [];
      const result = discoverManagedPolicy({
        platform: "win32",
        io: inertPolicyIo({}),
        registry: inertRegistry(
          hklm,
          { status: "present", json: JSON.stringify({ model: "weaker" }) },
          calls,
        ),
      });
      expect(result.settings).toBeUndefined();
      expect(calls).toEqual(["HKLM"]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          category: hklm.status === "present" ? "managed-policy-malformed" : "managed-policy-unreadable",
          sourceClass: "registry-hklm",
          impact: "weaker-policy-suppressed",
        }),
      ]);
      expect(result.events).toEqual([
        { type: "diagnostic", diagnostic: result.diagnostics[0] },
      ]);
    }
  });

  it("emits discovery and validation diagnostics in exact managed source order", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const pluginSource = "/policy/drop/10-plugin.json";
    const malformedSource = "/policy/drop/20-malformed.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({ model: 42 }),
            [pluginSource]: JSON.stringify({ enabledPlugins: "invalid" }),
            [malformedSource]: "not json",
          },
          [malformedSource, pluginSource],
        ),
      },
    });

    expect(
      settings.diagnostics.map(({ source, message, category }) => ({ source, message, category })),
    ).toEqual([
      {
        source: description.systemSettingsPath,
        message: 'Setting "model" is not a string; ignored',
        category: undefined,
      },
      {
        source: pluginSource,
        message: 'Setting "enabledPlugins" is not an object; ignored',
        category: undefined,
      },
      {
        source: malformedSource,
        message: "Managed policy JSON is malformed; source ignored",
        category: "managed-policy-malformed",
      },
    ]);
  });

  it("keeps valid lower managed plugin values when a later source has an invalid entry", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const dropIn = "/policy/drop/later.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({ enabledPlugins: { "safe@official": false } }),
            [dropIn]: JSON.stringify({ enabledPlugins: { "safe@official": "yes", "other@acme": true } }),
          },
          [dropIn],
        ),
      },
    });
    expect(settings.enabledPlugins).toEqual({ "safe@official": false, "other@acme": true });
    expect(settings.effectivePluginEnablement).toEqual({
      "safe@official": { enabled: false, scope: "managed", source: description.systemSettingsPath },
      "other@acme": { enabled: true, scope: "managed", source: dropIn },
    });
    expect(settings.diagnostics.filter((d) => d.message.includes("literal boolean"))).toHaveLength(1);
  });

  it("replaces lower object owners at the first managed source, then deep-merges later managed sources", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const later = "/policy/drop/later.json";
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      attribution: {
        lowerOnly: true,
        nested: { lowerOnly: true, replaced: "lower" },
      },
      skillOverrides: {
        shared: { lowerOnly: true, nested: { lowerOnly: true, replaced: "lower" } },
        unrelated: { preserved: true },
      },
    });

    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({
              attribution: {
                baseOnly: true,
                nested: { baseOnly: true, replaced: "base" },
              },
              skillOverrides: {
                shared: { baseOnly: true, nested: { baseOnly: true, replaced: "base" } },
                managedOnly: { baseOnly: true },
              },
            }),
            [later]: JSON.stringify({
              attribution: {
                laterOnly: true,
                nested: { laterOnly: true, replaced: "later" },
              },
              skillOverrides: {
                shared: { laterOnly: true, nested: { laterOnly: true, replaced: "later" } },
                managedOnly: { laterOnly: true },
              },
            }),
          },
          [later],
        ),
      },
    });

    expect(settings.attribution).toEqual({
      baseOnly: true,
      laterOnly: true,
      nested: { baseOnly: true, laterOnly: true, replaced: "later" },
    });
    expect(settings.skillOverrides).toEqual({
      shared: {
        baseOnly: true,
        laterOnly: true,
        nested: { baseOnly: true, laterOnly: true, replaced: "later" },
      },
      unrelated: { preserved: true },
      managedOnly: { baseOnly: true, laterOnly: true },
    });
  });

  it("keeps late valid managed booleans and provenance after the diagnostic cap", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const hostile = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`managed/hostile-${index}`, `secret-${index}`]),
    );
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo({
          [description.systemSettingsPath]: JSON.stringify({
            enabledPlugins: {
              ...hostile,
              "managed-on@official": true,
              "managed-off@official": false,
            },
          }),
        }),
      },
    });

    expect(settings.enabledPlugins).toEqual({
      "managed-on@official": true,
      "managed-off@official": false,
    });
    expect(settings.effectivePluginEnablement).toEqual({
      "managed-on@official": {
        enabled: true,
        scope: "managed",
        source: description.systemSettingsPath,
      },
      "managed-off@official": {
        enabled: false,
        scope: "managed",
        source: description.systemSettingsPath,
      },
    });
    const diagnostics = settings.diagnostics.filter(
      (diagnostic) => diagnostic.source === description.systemSettingsPath,
    );
    expect(diagnostics).toHaveLength(9);
    expect(
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.message === 'Additional malformed "enabledPlugins" entries omitted',
      ),
    ).toHaveLength(1);
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).not.toMatch(
      /managed\/hostile|secret-/,
    );
  });

  it("ignores hidden drop-ins and applies visible drop-ins alphabetically", () => {
    const base = makeTmp();
    const description = {
      systemSettingsPath: path.join(base, "managed-settings.json"),
      dropInDir: path.join(base, "managed-settings.d"),
      artifactDirs: [base],
    };
    writeJson(description.systemSettingsPath, { model: "base" });
    writeJson(path.join(description.dropInDir, "20-z.json"), { model: "z" });
    writeJson(path.join(description.dropInDir, "10-a.json"), { model: "a" });
    writeJson(path.join(description.dropInDir, ".hidden.json"), { model: "hidden" });

    const result = discoverManagedPolicy({ platform: "linux", description });
    expect(result.settings?.model).toBe("z");
    expect(result.diagnostics).toEqual([]);
  });

  it("explicit settings overrides perform zero ambient directory or registry I/O", () => {
    const scopes = makeScopes();
    const override = scopes.absentManaged[0]!;
    const ioCalls: string[] = [];
    const registryCalls: string[] = [];
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPaths: [override],
      managedPolicy: {
        platform: "win32",
        io: {
          readFile(filePath) {
            ioCalls.push(filePath);
            return filePath === override
              ? { status: "present", text: JSON.stringify({ model: "override" }) }
              : { status: "absent" };
          },
          listJsonFiles() {
            throw new Error("ambient directory access");
          },
        },
        registry: inertRegistry(
          { status: "present", json: JSON.stringify({ model: "ambient" }) },
          { status: "absent" },
          registryCalls,
        ),
      },
    });
    expect(settings.model).toBe("override");
    expect(ioCalls).toEqual([override]);
    expect(registryCalls).toEqual([]);
  });

  it("keeps lower plugin values through invalid whole containers and diagnoses every source", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const invalidContainer = "/policy/drop/10-invalid.json";
    const invalidEntry = "/policy/drop/20-invalid-entry.json";
    const laterValid = "/policy/drop/30-valid.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({
              enabledPlugins: { "kept@official": false },
            }),
            [invalidContainer]: JSON.stringify({ enabledPlugins: ["erase@official"] }),
            [invalidEntry]: JSON.stringify({
              enabledPlugins: { "kept@official": "erase", "bad/path@official": true },
            }),
            [laterValid]: JSON.stringify({
              unrelated: true,
              enabledPlugins: { "later@official": true },
            }),
          },
          [laterValid, invalidEntry, invalidContainer],
        ),
      },
    });

    expect(settings.enabledPlugins).toEqual({
      "kept@official": false,
      "later@official": true,
    });
    expect(settings.effectivePluginEnablement).toEqual({
      "kept@official": {
        enabled: false,
        scope: "managed",
        source: description.systemSettingsPath,
      },
      "later@official": { enabled: true, scope: "managed", source: laterValid },
    });
    expect(settings.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: invalidContainer }),
        expect.objectContaining({ source: invalidEntry, message: expect.stringContaining("kept@official") }),
        expect.objectContaining({ source: invalidEntry, message: expect.stringContaining("Invalid plugin identity") }),
      ]),
    );
  });

  it("retains field provenance through later unrelated and nested managed contributions", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const later = "/policy/drop/later.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({
              model: [],
              subagents: { maxDepth: 0 },
            }),
            [later]: JSON.stringify({
              env: { OK: "yes" },
              subagents: { concurrency: 3 },
            }),
          },
          [later],
        ),
      },
    });

    expect(settings.subagentConcurrency).toBe(3);
    expect(settings.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: description.systemSettingsPath, message: expect.stringContaining('"model"') }),
        expect.objectContaining({ source: description.systemSettingsPath, message: expect.stringContaining("subagents.maxDepth") }),
      ]),
    );
    expect(settings.diagnostics.some((diagnostic) => diagnostic.source === later)).toBe(false);
  });

  it("validates overwritten scalars against their contributing managed source", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const later = "/policy/drop/later.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({ model: [] }),
            [later]: JSON.stringify({ model: "valid-later" }),
          },
          [later],
        ),
      },
    });

    expect(settings.model).toBe("valid-later");
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({
        source: description.systemSettingsPath,
        message: expect.stringContaining('Setting "model" is not a string'),
      }),
    );
  });

  it("keeps mixed-origin top-level array diagnostics with each contribution", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const later = "/policy/drop/later.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({ claudeMdExcludes: ["base", 7] }),
            [later]: JSON.stringify({ claudeMdExcludes: ["later"] }),
          },
          [later],
        ),
      },
    });

    expect(settings.claudeMdExcludes).toEqual(["base", "later"]);
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({
        source: description.systemSettingsPath,
        message: 'Non-string entry in "claudeMdExcludes" ignored',
      }),
    );
    expect(settings.diagnostics.some((diagnostic) => diagnostic.source === later)).toBe(false);
  });

  it("keeps same-event hook diagnostics with the contributing managed source", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const later = "/policy/drop/later.json";
    const scopes = makeScopes();
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "linux",
        description,
        io: inertPolicyIo(
          {
            [description.systemSettingsPath]: JSON.stringify({
              hooks: { PreToolUse: ["malformed", { hooks: [{ type: "command", command: "base" }] }] },
            }),
            [later]: JSON.stringify({
              hooks: {
                PreToolUse: [
                  { hooks: [{ type: "command", command: "base" }] },
                  { hooks: [{ type: "command", command: "later" }] },
                ],
              },
            }),
          },
          [later],
        ),
      },
    });

    expect(
      settings.hooks.PreToolUse?.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    ).toEqual(["base", "later"]);
    expect(settings.diagnostics).toContainEqual(
      expect.objectContaining({
        source: description.systemSettingsPath,
        message: 'Malformed matcher entry in "hooks.PreToolUse" ignored',
      }),
    );
    expect(settings.diagnostics.some((diagnostic) => diagnostic.source === later)).toBe(false);
  });

  it("shares the plugin diagnostic cap across duplicate managed source paths", () => {
    const scopes = makeScopes();
    const source = "/policy/repeated.json";
    const entries = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`invalid/path-${index}`, true]),
    );
    let reads = 0;
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPaths: [source, source],
      managedPolicy: {
        platform: "linux",
        io: {
          readFile() {
            reads++;
            return { status: "present", text: JSON.stringify({ enabledPlugins: entries }) };
          },
          listJsonFiles() {
            throw new Error("ambient directory access");
          },
        },
      },
    });

    expect(reads).toBe(1);
    expect(settings.diagnostics.filter((diagnostic) => diagnostic.source === source)).toHaveLength(9);
    expect(
      settings.diagnostics.filter(
        (diagnostic) =>
          diagnostic.message === 'Additional malformed "enabledPlugins" entries omitted',
      ),
    ).toHaveLength(1);
  });

  it("covers every injected managed source/status with exact fallback and no host access", () => {
    type Status = "absent" | "unreadable" | "malformed" | "present";
    type Target = "system" | "directory" | "drop-in" | "HKLM" | "HKCU" | "override";
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const dropIn = "/policy/drop/listed.json";
    const override = "/override.json";
    const registrySource = (hive: "HKLM" | "HKCU"): string =>
      `${hive}\\SOFTWARE\\Policies\\ClaudeCode\\Settings`;
    const cases: Array<{
      target: Target;
      status: Status;
      model?: string;
      diagnostic?: {
        source: string;
        sourceClass: "system-file" | "system-drop-in" | "registry-hklm" | "registry-hkcu" | "override";
        impact: "source-ignored" | "weaker-policy-suppressed";
      };
      registryCalls: string[];
      fileCalls: string[];
      listCalls: string[];
    }> = [];
    const addCases = (
      target: Target,
      statuses: readonly Status[],
      source: string,
      sourceClass: "system-file" | "system-drop-in" | "registry-hklm" | "registry-hkcu" | "override",
      administrator: boolean,
    ): void => {
      for (const status of statuses) {
        const success = status === "present";
        const fallsBack =
          (target === "system" && status === "absent") ||
          (target === "directory" && status !== "unreadable") ||
          (target === "drop-in" && status === "absent") ||
          (target === "HKLM" && status === "absent");
        cases.push({
          target,
          status,
          model: success
            ? target === "directory"
              ? "hkcu"
              : target.toLowerCase()
            : fallsBack
              ? "hkcu"
              : undefined,
          diagnostic:
            status === "unreadable" || status === "malformed"
              ? {
                  source,
                  sourceClass,
                  impact: administrator ? "weaker-policy-suppressed" : "source-ignored",
                }
              : undefined,
          registryCalls:
            target === "override"
              ? []
              : target === "HKCU" || fallsBack
                ? ["HKLM", "HKCU"]
                : ["HKLM"],
          fileCalls:
            target === "override"
              ? [override]
              : target === "drop-in"
                ? [description.systemSettingsPath, dropIn]
                : [description.systemSettingsPath],
          listCalls: target === "override" ? [] : [description.dropInDir],
        });
      }
    };
    addCases("system", ["absent", "unreadable", "malformed", "present"], description.systemSettingsPath, "system-file", true);
    addCases("directory", ["absent", "unreadable", "present"], description.dropInDir, "system-drop-in", true);
    addCases("drop-in", ["absent", "unreadable", "malformed", "present"], dropIn, "system-drop-in", true);
    addCases("HKLM", ["absent", "unreadable", "malformed", "present"], registrySource("HKLM"), "registry-hklm", true);
    addCases("HKCU", ["absent", "unreadable", "malformed", "present"], registrySource("HKCU"), "registry-hkcu", false);
    addCases("override", ["absent", "unreadable", "malformed", "present"], override, "override", false);

    const fileRead = (status: Status, model: string): ReturnType<ManagedPolicyIo["readFile"]> => {
      if (status === "absent") return { status: "absent" };
      if (status === "unreadable") return { status: "unreadable" };
      return {
        status: "present",
        text: status === "malformed" ? "{" : JSON.stringify({ model }),
      };
    };
    const registryRead = (
      status: Status,
      model: string,
    ): ReturnType<ManagedRegistryAdapter["readSettings"]> => {
      if (status === "absent") return { status: "absent" };
      if (status === "unreadable") return { status: "unreadable" };
      return {
        status: "present",
        json: status === "malformed" ? "{" : JSON.stringify({ model }),
      };
    };

    for (const testCase of cases) {
      const fileCalls: string[] = [];
      const listCalls: string[] = [];
      const registryCalls: string[] = [];
      const io: ManagedPolicyIo = {
        readFile(filePath) {
          fileCalls.push(filePath);
          if (testCase.target === "override") return fileRead(testCase.status, "override");
          if (filePath === description.systemSettingsPath) {
            return testCase.target === "system"
              ? fileRead(testCase.status, "system")
              : { status: "absent" };
          }
          return testCase.target === "drop-in"
            ? fileRead(testCase.status, "drop-in")
            : { status: "absent" };
        },
        listJsonFiles(dir) {
          listCalls.push(dir);
          if (testCase.target === "directory") {
            if (testCase.status === "absent") return { status: "absent" };
            if (testCase.status === "unreadable") return { status: "unreadable" };
            return { status: "present", files: [] };
          }
          return {
            status: "present",
            files: testCase.target === "drop-in" ? [dropIn] : [],
          };
        },
      };
      const registry: ManagedRegistryAdapter = {
        readSettings(hive) {
          registryCalls.push(hive);
          if (testCase.target === hive) return registryRead(testCase.status, hive.toLowerCase());
          if (hive === "HKLM") return { status: "absent" };
          return { status: "present", json: JSON.stringify({ model: "hkcu" }) };
        },
      };

      const result = discoverManagedPolicy({
        platform: "win32",
        description,
        io,
        registry,
        ...(testCase.target === "override" ? { overridePaths: [override] } : {}),
      });
      expect(result.settings, `${testCase.target}:${testCase.status} settings`).toEqual(
        testCase.model === undefined ? undefined : { model: testCase.model },
      );
      expect(fileCalls, `${testCase.target}:${testCase.status} file calls`).toEqual(
        testCase.fileCalls,
      );
      expect(listCalls, `${testCase.target}:${testCase.status} directory calls`).toEqual(
        testCase.listCalls,
      );
      expect(registryCalls, `${testCase.target}:${testCase.status} registry calls`).toEqual(
        testCase.registryCalls,
      );
      expect(result.diagnostics, `${testCase.target}:${testCase.status} diagnostics`).toEqual(
        testCase.diagnostic === undefined
          ? []
          : [
              {
                severity: "error",
                message:
                  testCase.status === "malformed"
                    ? "Managed policy JSON is malformed; source ignored"
                    : "Managed policy source is unreadable; source ignored",
                source: testCase.diagnostic.source,
                category:
                  testCase.status === "malformed"
                    ? "managed-policy-malformed"
                    : "managed-policy-unreadable",
                sourceClass: testCase.diagnostic.sourceClass,
                impact: testCase.diagnostic.impact,
              },
            ],
      );
    }
  });

  it("marks policy impact only when a failed source actually suppresses HKCU", () => {
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const withValidHklm = discoverManagedPolicy({
      platform: "win32",
      description,
      io: inertPolicyIo({ [description.systemSettingsPath]: "<unreadable>" }),
      registry: inertRegistry(
        { status: "present", json: JSON.stringify({ model: "admin" }) },
        { status: "present", json: JSON.stringify({ model: "user" }) },
      ),
    });
    expect(withValidHklm.diagnostics[0]).toMatchObject({ impact: "source-ignored" });

    const onlyFailure = discoverManagedPolicy({
      platform: "win32",
      description,
      io: inertPolicyIo({ [description.systemSettingsPath]: "<unreadable>" }),
      registry: inertRegistry(
        { status: "absent" },
        { status: "present", json: JSON.stringify({ model: "user" }) },
      ),
    });
    expect(onlyFailure.diagnostics[0]).toMatchObject({ impact: "weaker-policy-suppressed" });
  });

  it("uses an authored locale-independent registry protocol with fixed bounded invocation", () => {
    const calls: RegistryCommandInvocation[] = [];
    const absent = createWindowsManagedRegistryAdapter((invocation) => {
      calls.push(invocation);
      return "ABSENT";
    });
    expect(absent.readSettings("HKLM")).toEqual({ status: "absent" });
    expect(calls[0]).toMatchObject({
      executable: "powershell.exe",
      options: {
        shell: false,
        timeout: 2_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      },
    });
    expect(calls[0]?.args.at(-2)).toBe("-EncodedCommand");
    const authoredScript = Buffer.from(calls[0]!.args.at(-1)!, "base64").toString("utf16le");
    expect(authoredScript).toContain("[Microsoft.Win32.Registry]::LocalMachine");
    expect(authoredScript).toContain("SOFTWARE\\Policies\\ClaudeCode");
    expect(authoredScript).not.toContain("/policy");
    expect(authoredScript).not.toContain("project");

    const json = JSON.stringify({ model: "registry" });
    const present = createWindowsManagedRegistryAdapter(
      () => `PRESENT\n${Buffer.from(json, "utf8").toString("base64")}`,
    );
    expect(present.readSettings("HKCU")).toEqual({ status: "present", json });

    for (const error of [
      Object.assign(new Error("Der Registrierungsschlüssel wurde nicht gefunden"), {
        stderr: "Der Registrierungsschlüssel wurde nicht gefunden",
      }),
      Object.assign(new Error("tempo limite excedido"), { code: "ETIMEDOUT" }),
    ]) {
      const unreadable = createWindowsManagedRegistryAdapter(() => {
        throw error;
      });
      expect(unreadable.readSettings("HKLM")).toEqual({ status: "unreadable" });
    }
    expect(createWindowsManagedRegistryAdapter(() => "localized arbitrary output").readSettings("HKLM")).toEqual({
      status: "unreadable",
    });
  });

  it("resolves all platform defaults through inert adapters", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const registryCalls: string[] = [];
      const result = discoverManagedPolicy({
        platform,
        io: inertPolicyIo({}),
        registry: inertRegistry({ status: "absent" }, { status: "absent" }, registryCalls),
      });
      expect(result.settings).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
      expect(registryCalls).toEqual(platform === "win32" ? ["HKLM", "HKCU"] : []);
    }
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

  it("expands ${VAR:-default}: default on unset ONLY — an empty value is SET (Claude semantics, not bash)", () => {
    const env = { SET_VAR: "value", EMPTY_VAR: "" } as NodeJS.ProcessEnv;
    expect(expandEnvVars("${SET_VAR:-fallback}", env)).toBe("value");
    expect(expandEnvVars("${EMPTY_VAR:-fallback}", env)).toBe("");
    expect(expandEnvVars("${UNSET_VAR:-fallback}", env)).toBe("fallback");
    expect(expandEnvVars("${UNSET_VAR:-}", env)).toBe("");
  });

  it("pins the ${A:-{x}} parse: the default ends at the FIRST closing brace", () => {
    // "${A:-{x}}" matches through the first "}" (default = "{x"), leaving the
    // final "}" literal — so an unset A yields "{x}".
    expect(expandEnvVars("${PCD_UNSET_BRACE:-{x}}", {} as NodeJS.ProcessEnv)).toBe("{x}");
  });

  it("reports unset-without-default variable NAMES via onUnset; defaults never report", () => {
    const seen: string[] = [];
    const env = { PRESENT: "p" } as NodeJS.ProcessEnv;
    const out = expandEnvVars("${PRESENT} ${GONE} ${ALSO_GONE:-d}", env, (name) => seen.push(name));
    expect(out).toBe("p ${GONE} d");
    expect(seen).toEqual(["GONE"]);
  });

  it("is immune to replacement-pattern injection in env values ($& stays literal)", () => {
    const env = { PCD_INJ: "a$&b$'c" } as NodeJS.ProcessEnv;
    expect(expandEnvVars("v=${PCD_INJ}", env)).toBe("v=a$&b$'c");
  });

  it("existing consumers (env/model) gain :-default support without other changes", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
      env: { WITH_DEFAULT: "${PCD_DEFINITELY_UNSET_VAR:-fallback}", KEPT: "${PCD_DEFINITELY_UNSET_VAR}" },
      model: "${PCD_DEFINITELY_UNSET_MODEL:-model-default}",
    });

    const settings = load(scopes);
    expect(settings.env.WITH_DEFAULT).toBe("fallback");
    expect(settings.env.KEPT).toBe("${PCD_DEFINITELY_UNSET_VAR}");
    expect(settings.model).toBe("model-default");
    // Pins the onUnset gating: settings consumers pass no onUnset, so an unset
    // var yields NO diagnostic here (only MCP resolution surfaces warnings).
    expect(settings.diagnostics.some((d) => d.message.includes("PCD_DEFINITELY_UNSET"))).toBe(false);
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
