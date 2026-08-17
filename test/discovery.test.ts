import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  expandEnvVars,
  loadSettings,
  stripJsonc,
  type OrdinarySettingsProbeResult,
} from "../src/discovery/settings.js";
import {
  defaultManagedMcpPath,
  defaultManagedPolicyDescription,
  discoverManagedMcp,
  discoverManagedPolicy,
  type ManagedPolicyIo,
} from "../src/discovery/managed-policy.js";
import {
  createNodeManagedMcpIo,
  type ManagedMcpFileMetadata,
  type ManagedMcpIo,
  type ManagedMcpNodeFs,
} from "../src/claude/managed-mcp.js";
import {
  dedupeByName,
  defaultManagedDirs,
  discoverArtifactDirs,
  resolveProjectRoot,
} from "../src/discovery/locations.js";
import { DEFAULT_CLEANUP_PERIOD_DAYS, type SourceRef } from "../src/types.js";

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

describe("marketplace settings observations", () => {
  it("captures the three marketplace keys per source in ascending settings order", () => {
    const scopes = makeScopes();
    const userFile = path.join(scopes.userDir, "settings.json");
    const projectFile = path.join(scopes.projectRoot, ".claude", "settings.json");
    writeJson(userFile, {
      extraKnownMarketplaces: { "user-marketplace": { source: { source: "github", repo: "example/user" } } },
      blockedMarketplaces: [{ source: "github", repo: "example/blocked" }],
    });
    writeJson(projectFile, { strictKnownMarketplaces: [] });

    const result = load(scopes);

    expect(result.pluginMarketplaceSettings).toEqual([
      {
        scope: "user", sourcePath: userFile,
        extraKnownMarketplaces: { "user-marketplace": { descriptor: { kind: "github", repo: "example/user" }, matchKey: '{"kind":"github","repo":"example/user"}', validity: "valid" } },
        blockedMarketplaces: [{ descriptor: { kind: "github", repo: "example/blocked" }, matchKey: '{"kind":"github","repo":"example/blocked"}', validity: "valid" }],
      },
      { scope: "project", sourcePath: projectFile, strictKnownMarketplaces: [] },
    ]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("serializes only bounded redacted descriptor evidence for extra, strict, and blocked settings", () => {
    const scopes = makeScopes();
    const canaries = ["extra-password", "strict-password", "blocked-password", "inline-command-canary"];
    writeJson(path.join(scopes.userDir, "settings.json"), {
      extraKnownMarketplaces: { extra: { source: { source: "url", url: `https://user:${canaries[0]}@example.test/catalog?command=${canaries[3]}#fragment` } } },
      strictKnownMarketplaces: [{ source: "git", url: `https://user:${canaries[1]}@example.test/repo?token=x` }],
      blockedMarketplaces: [{ source: "url", url: `https://user:${canaries[2]}@example.test/catalog#secret` }],
    });

    const result = load(scopes);
    const serialized = JSON.stringify(result.pluginMarketplaceSettings);
    for (const canary of canaries) expect(serialized).not.toContain(canary);
    expect(result.pluginMarketplaceSettings?.[0]).toMatchObject({
      extraKnownMarketplaces: { extra: { validity: "redacted", indeterminate: "credential-bearing-or-ambiguous" } },
      strictKnownMarketplaces: [{ validity: "redacted", indeterminate: "credential-bearing-or-ambiguous" }],
      blockedMarketplaces: [{ validity: "redacted", indeterminate: "credential-bearing-or-ambiguous" }],
    });
  });

  it("redacts hostile project and local path text during shared normalization", () => {
    const scopes = makeScopes();
    const projectCanaries = ["project-absolute-canary", "project-traversal-canary", "project-uri-canary"];
    const localCanaries = ["local-device-canary", "local-unc-canary"];
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { extraKnownMarketplaces: {
      absolute: { source: { source: "directory", path: `/outside/${projectCanaries[0]}` } },
      traversal: { source: { source: "file", path: `../${projectCanaries[1]}/marketplace.json` } },
      uri: { source: { source: "directory", path: `https://user:${projectCanaries[2]}@example.test/x` } },
    } });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), { extraKnownMarketplaces: {
      device: { source: { source: "directory", path: `\\\\?\\C:\\${localCanaries[0]}` } },
      unc: { source: { source: "file", path: `\\\\server\\${localCanaries[1]}\\marketplace.json` } },
    } });

    const result = load(scopes);
    const serialized = JSON.stringify(result.pluginMarketplaceSettings);
    for (const canary of [...projectCanaries, ...localCanaries]) expect(serialized).not.toContain(canary);
    for (const contribution of result.pluginMarketplaceSettings ?? []) {
      for (const observation of Object.values(contribution.extraKnownMarketplaces ?? {})) {
        expect(observation).toMatchObject({ descriptor: { path: "<redacted-path>", localPath: "<redacted-path>" }, validity: "redacted" });
      }
    }
  });

  it("preserves user, project, nested, local, and managed source order and provenance", () => {
    const scopes = makeScopes();
    const nested = path.join(scopes.projectRoot, "packages", "child");
    const managed = path.join(path.dirname(scopes.projectRoot), "managed.json");
    writeJson(path.join(scopes.userDir, "settings.json"), { extraKnownMarketplaces: { user: { source: { source: "github", repo: "example/user" } } } });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { extraKnownMarketplaces: { project: { source: { source: "github", repo: "example/project" } } } });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), { blockedMarketplaces: [] });
    writeJson(path.join(nested, ".claude", "settings.json"), { strictKnownMarketplaces: [] });
    writeJson(path.join(nested, ".claude", "settings.local.json"), { extraKnownMarketplaces: { local: { source: { source: "github", repo: "example/local" } } } });
    writeJson(managed, { blockedMarketplaces: [{ source: "github", repo: "example/blocked" }] });

    const result = loadSettings({ cwd: nested, projectRoot: scopes.projectRoot, userDir: scopes.userDir, managedPaths: [managed] });

    expect(result.pluginMarketplaceSettings?.map(({ scope, sourcePath }) => [scope, sourcePath])).toEqual([
      ["user", path.join(scopes.userDir, "settings.json")],
      ["project", path.join(scopes.projectRoot, ".claude", "settings.json")],
      ["local", path.join(scopes.projectRoot, ".claude", "settings.local.json")],
      ["project", path.join(nested, ".claude", "settings.json")],
      ["local", path.join(nested, ".claude", "settings.local.json")],
      ["managed", managed],
    ]);
  });

  it("bounds marketplace declarations while preserving deterministic omission evidence", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      extraKnownMarketplaces: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`market-${String(index).padStart(3, "0")}`, { source: { source: "github", repo: `example/package-${index}` } }])),
      blockedMarketplaces: [{ source: "github", repo: "example/not-copied" }],
    });
    const result = load(scopes);
    const contribution = result.pluginMarketplaceSettings?.[0];
    expect(Object.keys(contribution?.extraKnownMarketplaces ?? {})).toHaveLength(256);
    expect(contribution?.blockedMarketplaces).toEqual([]);
    expect(result.pluginMarketplaceSettingsOmissions).toEqual({ contributions: 0, declarations: 2 });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("declarations omitted") }));
  });

  it("bounds marketplace setting contributions across managed sources", () => {
    const scopes = makeScopes();
    const managed = Array.from({ length: 257 }, (_, index) => path.join(path.dirname(scopes.projectRoot), `managed-${index}.json`));
    for (let index = 0; index < managed.length; index++) writeJson(managed[index]!, { strictKnownMarketplaces: [] });
    const result = load(scopes, managed);
    expect(result.pluginMarketplaceSettings).toHaveLength(256);
    expect(result.pluginMarketplaceSettingsOmissions).toEqual({ contributions: 1, declarations: 0 });
  });

  it("diagnoses wrong top-level types without treating marketplace keys as unknown", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      extraKnownMarketplaces: [], strictKnownMarketplaces: {}, blockedMarketplaces: "no",
    });

    const result = load(scopes);

    expect(result.pluginMarketplaceSettings).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
    expect(result.diagnostics.filter((item) => item.message.includes("Marketplaces") || item.message.includes("marketplaces"))).toHaveLength(3);
  });
});

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

describe("loadSettings — precedence & merging", () => {
  it("loads legacy linked-worktree local settings below the verified main-checkout local file", () => {
    const base = makeTmp(); const main = path.join(base, "main"); const linked = path.join(base, "linked"); const userDir = path.join(base, "user"); fs.mkdirSync(main); fs.mkdirSync(userDir);
    for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) expect(spawnSync("git", args, { cwd: main }).status).toBe(0);
    fs.writeFileSync(path.join(main, "seed"), "seed"); expect(spawnSync("git", ["add", "."], { cwd: main }).status).toBe(0); expect(spawnSync("git", ["commit", "-m", "seed"], { cwd: main }).status).toBe(0); expect(spawnSync("git", ["worktree", "add", "-b", "discovery-linked", linked], { cwd: main }).status).toBe(0);
    const nested = path.join(linked, "nested"); fs.mkdirSync(path.join(linked, ".claude")); fs.mkdirSync(path.join(nested, ".claude"), { recursive: true }); fs.mkdirSync(path.join(main, ".claude"));
    writeJson(path.join(linked, ".claude", "settings.local.json"), { enabledPlugins: { "shared@official": false, "active@official": true } }); writeJson(path.join(nested, ".claude", "settings.local.json"), { enabledPlugins: { "nested@official": true } }); writeJson(path.join(main, ".claude", "settings.local.json"), { enabledPlugins: { "shared@official": true } });
    const loaded = loadSettings({ cwd: nested, projectRoot: linked, userDir, managedPaths: [] }); expect(loaded.effectivePluginEnablement?.["shared@official"]).toMatchObject({ enabled: true, source: path.join(fs.realpathSync.native(main), ".claude", "settings.local.json") }); expect(loaded.effectivePluginEnablement?.["active@official"]?.enabled).toBe(true); expect(loaded.effectivePluginEnablement?.["nested@official"]?.enabled).toBe(true);
  });
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

  it("resolves every effective agent scalar precedence step", () => {
    const scopes = makeScopes();
    const managedFile = scopes.absentManaged[0]!;
    writeJson(path.join(scopes.userDir, "settings.json"), { agent: "user-agent" });
    expect(load(scopes).agent).toBe("user-agent");

    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { agent: "project-agent" });
    expect(load(scopes).agent).toBe("project-agent");

    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), { agent: "local-agent" });
    expect(load(scopes).agent).toBe("local-agent");

    writeJson(managedFile, { agent: "managed-agent" });
    const managed = load(scopes, [managedFile]);
    expect(managed.agent).toBe("managed-agent");
    expect(managed.unknownKeys).not.toContainEqual(expect.objectContaining({ key: "agent" }));
  });

  it("diagnoses blank and malformed higher-scope agent values without erasing a valid selector", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), { agent: "user-agent" });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { agent: "   " });
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.local.json"), { agent: { hostile: true } });

    const settings = load(scopes);
    expect(settings.agent).toBe("user-agent");
    expect(settings.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Setting "agent" must not be blank; ignored' }),
      expect.objectContaining({ message: 'Setting "agent" is not a string; ignored' }),
    ]));
    expect(settings.unknownKeys).not.toContainEqual(expect.objectContaining({ key: "agent" }));
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
      settings.diagnostics.some((d) => d.message.includes('"claudeMd" applies only in managed')),
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

describe("loadSettings — retention cleanup policy", () => {
  it("defaults an omitted period to 30 days and admits cleanup", () => {
    const settings = load(makeScopes());
    expect(settings.cleanupPeriodDays).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
    expect(settings.retentionCleanupAllowed).toBe(true);
    expect(settings.retentionCleanupBlockers).toEqual([]);
  });

  it.each([1, 30, Number.MAX_SAFE_INTEGER])(
    "accepts the literal positive integer %s",
    (value) => {
      const scopes = makeScopes();
      writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
        cleanupPeriodDays: value,
      });
      const settings = load(scopes);
      expect(settings.cleanupPeriodDays).toBe(value);
      expect(settings.retentionCleanupAllowed).toBe(true);
    },
  );

  it.each(["30", 1.5, 0, -1, null, true])(
    "rejects cleanupPeriodDays=%j and blocks cleanup",
    (value) => {
      const scopes = makeScopes();
      writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), {
        cleanupPeriodDays: value,
      });
      const settings = load(scopes);
      expect(settings.cleanupPeriodDays).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
      expect(settings.retentionCleanupAllowed).toBe(false);
      expect(settings.retentionCleanupBlockers).toEqual([{
        reason: "invalid-period",
        source: path.join(scopes.projectRoot, ".claude", "settings.json"),
      }]);
      expect(settings.diagnostics).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("literal positive integer") }),
      );
    },
  );

  it("latches cleanup off across precedence while retaining ordinary scalar precedence", () => {
    const invalidLower = makeScopes();
    writeJson(path.join(invalidLower.userDir, "settings.json"), { cleanupPeriodDays: 0 });
    writeJson(path.join(invalidLower.projectRoot, ".claude", "settings.json"), {
      cleanupPeriodDays: 7,
    });
    const laterValid = load(invalidLower);
    expect(laterValid.cleanupPeriodDays).toBe(7);
    expect(laterValid.retentionCleanupAllowed).toBe(false);
    expect(laterValid.retentionCleanupBlockers).toEqual([{
      reason: "invalid-period",
      source: path.join(invalidLower.userDir, "settings.json"),
    }]);

    const invalidHigher = makeScopes();
    writeJson(path.join(invalidHigher.userDir, "settings.json"), { cleanupPeriodDays: 9 });
    writeJson(path.join(invalidHigher.projectRoot, ".claude", "settings.json"), {
      cleanupPeriodDays: -2,
    });
    const higherInvalid = load(invalidHigher);
    expect(higherInvalid.cleanupPeriodDays).toBe(9);
    expect(higherInvalid.retentionCleanupAllowed).toBe(false);
    expect(higherInvalid.retentionCleanupBlockers).toEqual([{
      reason: "invalid-period",
      source: path.join(invalidHigher.projectRoot, ".claude", "settings.json"),
    }]);
  });

  it.each([
    ["absent", { status: "absent" }, true],
    ["unreadable", { status: "unreadable" }, false],
    ["malformed", { status: "text", text: "{ nope" }, false],
    ["non-object", { status: "text", text: "[]" }, false],
    ["non-finite value", { status: "text", text: '{"cleanupPeriodDays":1e400}' }, false],
  ] as const)(
    "classifies an injected %s ordinary settings source",
    (_name, outcome, allowed) => {
      const scopes = makeScopes();
      const projectFile = path.join(scopes.projectRoot, ".claude", "settings.json");
      const settings = loadSettings({
        cwd: scopes.projectRoot,
        projectRoot: scopes.projectRoot,
        userDir: scopes.userDir,
        managedPaths: scopes.absentManaged,
        ordinarySettingsProbe: (filePath): OrdinarySettingsProbeResult =>
          filePath === projectFile ? outcome : { status: "absent" },
      });
      expect(settings.retentionCleanupAllowed).toBe(allowed);
      expect(settings.cleanupPeriodDays).toBe(DEFAULT_CLEANUP_PERIOD_DAYS);
      expect(settings.retentionCleanupBlockers).toEqual(
        allowed ? [] : [{
          reason: _name === "unreadable"
            ? "unreadable-source"
            : _name === "malformed"
              ? "malformed-source"
              : _name === "non-object"
                ? "non-object-source"
                : "invalid-period",
          source: projectFile,
        }],
      );
    },
  );

  it("classifies stat-time ENOENT as absent but read-time ENOENT as unreadable", () => {
    const scopes = makeScopes();
    const absent = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPaths: scopes.absentManaged,
      ordinarySettingsIo: {
        statIsFile: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
        readText: () => { throw new Error("must not read"); },
      },
    });
    expect(absent.retentionCleanupAllowed).toBe(true);
    expect(absent.retentionCleanupBlockers).toEqual([]);

    const racedPath = path.join(scopes.userDir, "settings.json");
    const raced = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPaths: scopes.absentManaged,
      ordinarySettingsIo: {
        statIsFile: (filePath) => {
          if (filePath === racedPath) return true;
          throw Object.assign(new Error("absent"), { code: "ENOENT" });
        },
        readText: () => { throw Object.assign(new Error("gone after stat"), { code: "ENOENT" }); },
      },
    });
    expect(raced.retentionCleanupAllowed).toBe(false);
    expect(raced.retentionCleanupBlockers).toEqual([
      { reason: "unreadable-source", source: racedPath },
    ]);
  });

  it.each(["<unreadable>", "{ malformed"] as const)(
    "blocks cleanup for a managed source failure (%s)",
    (managedValue) => {
      const scopes = makeScopes();
      const source = "/policy/managed-settings.json";
      const settings = loadSettings({
        cwd: scopes.projectRoot,
        projectRoot: scopes.projectRoot,
        userDir: scopes.userDir,
        managedPolicy: {
          platform: "linux",
          description: {
            systemSettingsPath: source,
            dropInDir: "/policy/managed-settings.d",
            artifactDirs: ["/policy"],
          },
          io: inertPolicyIo({ [source]: managedValue }),
        },
        ordinarySettingsProbe: () => ({ status: "absent" }),
      });
      expect(settings.retentionCleanupAllowed).toBe(false);
      expect(settings.retentionCleanupBlockers).toEqual([{
        reason: managedValue === "<unreadable>" ? "unreadable-source" : "malformed-source",
        source,
      }]);
      expect(settings.diagnostics).toContainEqual(
        expect.objectContaining({
          category:
            managedValue === "<unreadable>"
              ? "managed-policy-unreadable"
              : "managed-policy-malformed",
        }),
      );
    },
  );

  it("deduplicates the same blocker reason and source", () => {
    const scopes = makeScopes();
    const source = "/policy/duplicate.json";
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPaths: [source, source],
      managedPolicy: { io: inertPolicyIo({ [source]: "{ malformed" }) },
      ordinarySettingsProbe: () => ({ status: "absent" }),
    });
    expect(settings.retentionCleanupBlockers).toEqual([
      { reason: "malformed-source", source },
    ]);
  });

  it("does not block cleanup for unrelated validation diagnostics", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.projectRoot, ".claude", "settings.json"), { model: 42 });
    const settings = load(scopes);
    expect(settings.diagnostics).not.toHaveLength(0);
    expect(settings.retentionCleanupAllowed).toBe(true);
    expect(settings.retentionCleanupBlockers).toEqual([]);
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

describe("MCP policy settings projection", () => {
  const malformedFields = {
    allowedMcpServers: { not: "a-list" },
    deniedMcpServers: "not-a-list",
    allowManagedMcpServersOnly: "not-a-boolean",
  } as const;

  it("rejects each malformed policy field as a whole ordinary user, project, or local file", () => {
    for (const scope of ["user", "project", "local"] as const) {
      for (const [key, value] of Object.entries(malformedFields)) {
        const scopes = makeScopes();
        const filePath = scope === "user"
          ? path.join(scopes.userDir, "settings.json")
          : path.join(scopes.projectRoot, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
        writeJson(filePath, { model: "must-not-apply", [key]: value });
        const settings = load(scopes);
        expect(settings.model, `${scope}:${key}`).toBeUndefined();
        expect(settings.mcpPolicySettings, `${scope}:${key}`).toEqual([]);
        expect(settings.diagnostics).toContainEqual(expect.objectContaining({
          severity: "error", message: `Setting "${key}" is invalid; settings file skipped`, source: filePath,
        }));
        expect(settings.unknownKeys).toEqual([]);
      }
    }
  });

  it("retains zero ordinary projection while preserving an independent managed contribution", () => {
    const scopes = makeScopes();
    writeJson(path.join(scopes.userDir, "settings.json"), {
      allowedMcpServers: [{ serverName: "must-not-authorize" }, { malformed: true }],
      deniedMcpServers: [{ serverName: "must-not-restrict" }],
    });
    const managedPath = path.join(makeTmp(), "managed.json");
    writeJson(managedPath, { deniedMcpServers: [{ serverName: "managed-only" }] });

    const settings = load(scopes, [managedPath]);
    expect(settings.mcpPolicySettings).toEqual([expect.objectContaining({
      scope: "managed",
      sourcePath: managedPath,
      deniedMcpServers: [{ serverName: "managed-only" }],
    })]);
  });

  it("retains managed whole-field presence, strips malformed list entries, and preserves source order", () => {
    const scopes = makeScopes();
    const first = path.join(makeTmp(), "first.json");
    const second = path.join(makeTmp(), "second.json");
    const third = path.join(makeTmp(), "third.json");
    writeJson(first, {
      allowedMcpServers: [{ serverName: "kept" }, { wrong: "stripped" }],
      allowManagedMcpServersOnly: false,
    });
    writeJson(second, {
      allowedMcpServers: { malformed: "whole-field" },
      deniedMcpServers: { malformed: "whole-field" },
      allowManagedMcpServersOnly: "invalid-whole-field",
    });
    writeJson(third, {
      deniedMcpServers: [{ serverCommand: ["node", "ok"] }, { serverCommand: [] }],
      allowManagedMcpServersOnly: true,
    });

    const settings = load(scopes, [first, second, third]);
    expect(settings.mcpPolicySettings).toEqual([
      {
        scope: "managed", sourcePath: first, order: 0, valid: true,
        allowedMcpServers: [{ serverName: "kept" }], allowManagedMcpServersOnly: false,
      },
      {
        scope: "managed", sourcePath: second, order: 1, valid: true,
        allowedMcpServers: { malformed: "whole-field" },
        deniedMcpServers: { malformed: "whole-field" }, allowManagedMcpServersOnly: "invalid-whole-field",
      },
      {
        scope: "managed", sourcePath: third, order: 2, valid: true,
        deniedMcpServers: [{ serverCommand: ["node", "ok"] }], allowManagedMcpServersOnly: true,
      },
    ]);
    expect(settings.diagnostics.filter((diagnostic) => diagnostic.message.startsWith("Managed MCP policy field"))).toHaveLength(5);
  });

  it("rejects mixed malformed ordinary arrays but strips malformed managed siblings field-sensitively", () => {
    for (const scope of ["user", "project", "local"] as const) {
      for (const key of ["allowedMcpServers", "deniedMcpServers"] as const) {
        const scopes = makeScopes();
        const filePath = scope === "user"
          ? path.join(scopes.userDir, "settings.json")
          : path.join(scopes.projectRoot, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
        writeJson(filePath, { model: "must-not-apply", [key]: [{ serverName: "valid" }, { extra: "malformed" }] });
        const settings = load(scopes);
        expect(settings.model, `${scope}:${key}`).toBeUndefined();
        expect(settings.mcpPolicySettings).toEqual([]);
      }
    }

    const scopes = makeScopes();
    const managedPath = path.join(makeTmp(), "managed.json");
    writeJson(managedPath, {
      allowedMcpServers: [{ serverName: "valid_name" }, { serverName: "invalid.name" }],
      deniedMcpServers: [{ serverName: "punctuation.is/valid:here" }, { serverName: "" }],
    });
    const settings = load(scopes, [managedPath]);
    expect(settings.mcpPolicySettings).toEqual([expect.objectContaining({
      valid: true,
      allowedMcpServers: [{ serverName: "valid_name" }],
      deniedMcpServers: [{ serverName: "punctuation.is/valid:here" }],
    })]);
  });

  it("rejects undocumented allow-name punctuation but accepts deny-name punctuation in ordinary scopes", () => {
    for (const scope of ["user", "project", "local"] as const) {
      const scopes = makeScopes();
      const filePath = scope === "user"
        ? path.join(scopes.userDir, "settings.json")
        : path.join(scopes.projectRoot, ".claude", scope === "project" ? "settings.json" : "settings.local.json");
      writeJson(filePath, {
        model: "must-not-apply",
        allowedMcpServers: [{ serverName: "invalid.name" }],
        deniedMcpServers: [{ serverName: "punctuation.is/valid:here" }],
      });
      const settings = load(scopes);
      expect(settings.model).toBeUndefined();
      expect(settings.mcpPolicySettings).toEqual([]);

      writeJson(filePath, {
        model: "applies",
        deniedMcpServers: [{ serverName: "punctuation.is/valid:here" }],
      });
      const denyOnly = load(scopes);
      expect(denyOnly.model).toBe("applies");
      expect(denyOnly.mcpPolicySettings).toEqual([expect.objectContaining({ valid: true })]);
    }
  });

  it("projects valid ordinary allow and deny lists while managed-only outside managed scope has no effect", () => {
    const scopes = makeScopes();
    const userFile = path.join(scopes.userDir, "settings.json");
    writeJson(userFile, {
      allowedMcpServers: [{ serverUrl: "https://allowed.example" }],
      deniedMcpServers: [{ serverName: "blocked" }],
      allowManagedMcpServersOnly: true,
    });
    const settings = load(scopes);
    expect(settings.mcpPolicySettings).toEqual([{
      scope: "user", sourcePath: userFile, order: 0, valid: true,
      allowedMcpServers: [{ serverUrl: "https://allowed.example" }],
      deniedMcpServers: [{ serverName: "blocked" }],
    }]);
    expect(settings.diagnostics).toContainEqual(expect.objectContaining({
      message: 'Setting "allowManagedMcpServersOnly" applies only in managed settings; ignored',
    }));
    expect(settings.mcpPolicyRestrictiveMaterialOmitted).toBe(false);
  });

  it("projects retained managed-file failures without paths or raw policy data", () => {
    const scopes = makeScopes();
    const description = {
      systemSettingsPath: "/policy/system.json",
      dropInDir: "/policy/drop-ins",
      artifactDirs: ["/policy"],
    };
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: {
        platform: "win32",
        description,
        io: inertPolicyIo({ [description.systemSettingsPath]: "{ malformed" }),
      },
    });
    expect(settings.mcpPolicySourceFailures).toEqual([{
      kind: "malformed", sourceClass: "system-file", authority: "administrator-controlled",
      remediation: "repair-administrator-policy",
    }]);
    const serialized = JSON.stringify(settings.mcpPolicySourceFailures);
    expect(serialized).not.toContain(description.systemSettingsPath);
    expect(serialized).not.toContain("{ malformed");
  });

  it("bounds policy contributions with stable order and retains later managed evidence", () => {
    const atLimitScopes = makeScopes();
    const atLimitPaths = Array.from({ length: 256 }, (_, index) => {
      const filePath = path.join(makeTmp(), `managed-${index}.json`);
      writeJson(filePath, { deniedMcpServers: [{ serverName: `deny-${index}` }] });
      return filePath;
    });
    const atLimit = load(atLimitScopes, atLimitPaths);
    expect(atLimit.mcpPolicySettings).toHaveLength(256);
    expect(atLimit.mcpPolicyRestrictiveMaterialOmitted).toBe(false);
    expect(atLimit.mcpPolicySettings.map((entry) => entry.order)).toEqual(
      Array.from({ length: 256 }, (_, index) => index),
    );

    const overflowScopes = makeScopes();
    const userFile = path.join(overflowScopes.userDir, "settings.json");
    writeJson(userFile, { deniedMcpServers: [{ serverName: "ordinary-first" }] });
    const overflowPaths = Array.from({ length: 256 }, (_, index) => {
      const filePath = path.join(makeTmp(), `later-${index}.json`);
      writeJson(filePath, { deniedMcpServers: [{ serverName: `managed-${index}` }] });
      return filePath;
    });
    const overflow = load(overflowScopes, overflowPaths);
    expect(overflow.mcpPolicySettings).toHaveLength(256);
    expect(overflow.mcpPolicyRestrictiveMaterialOmitted).toBe(true);
    expect(overflow.mcpPolicySettings[0]).toEqual(expect.objectContaining({ scope: "managed", order: 1 }));
    expect(overflow.mcpPolicySettings.at(-1)).toEqual(expect.objectContaining({ scope: "managed", order: 256 }));
    expect(overflow.mcpPolicySettings.map((entry) => entry.order)).toEqual(
      Array.from({ length: 256 }, (_, index) => index + 1),
    );
  });

  it("preserves duplicate limit-plus-one rule material for bounded compiler projection", () => {
    const scopes = makeScopes();
    const managedPath = path.join(makeTmp(), "duplicates.json");
    const rules = Array.from({ length: 513 }, () => ({ serverName: "same-name" }));
    writeJson(managedPath, { deniedMcpServers: rules });
    const settings = load(scopes, [managedPath]);
    expect(settings.mcpPolicySettings).toHaveLength(1);
    expect(settings.mcpPolicySettings[0]?.deniedMcpServers).toHaveLength(513);
    expect(settings.mcpPolicyRestrictiveMaterialOmitted).toBe(false);
  });

  it("bounds retained managed-file failure records and redacts source data", () => {
    const scopes = makeScopes();
    const description = {
      systemSettingsPath: "/policy/system.json",
      dropInDir: "/policy/drop-ins",
      artifactDirs: ["/policy"],
    };
    const dropIns = Array.from({ length: 65 }, (_, index) => `/policy/drop-ins/${String(index).padStart(2, "0")}-secret.json`);
    const files = Object.fromEntries(dropIns.map((filePath) => [filePath, `{ malformed-secret-${filePath}`]));
    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: { platform: "win32", description, io: inertPolicyIo(files, dropIns) },
    });
    expect(settings.mcpPolicySourceFailures).toHaveLength(64);
    expect(settings.mcpPolicyRestrictiveMaterialOmitted).toBe(true);
    expect(settings.mcpPolicySourceFailures.every((failure) => failure.sourceClass === "system-drop-in")).toBe(true);
    const serialized = JSON.stringify(settings.mcpPolicySourceFailures);
    expect(serialized).not.toContain("/policy");
    expect(serialized).not.toContain("secret");
  });

  it("projects malformed and unreadable evidence for every retained managed-file source class", () => {
    const scopes = makeScopes();
    const description = {
      systemSettingsPath: "/redacted/system.json",
      dropInDir: "/redacted/drop-ins",
      artifactDirs: ["/redacted"],
    };
    for (const unreadable of [false, true]) {
      const category = unreadable ? "unreadable" : "malformed";
      const malformed = unreadable ? "<unreadable>" : "{ secret-value";
      const settings = loadSettings({
        cwd: scopes.projectRoot, projectRoot: scopes.projectRoot, userDir: scopes.userDir,
        managedPolicy: {
          platform: "win32", description,
          io: inertPolicyIo({
            [description.systemSettingsPath]: malformed,
            [`${description.dropInDir}/entry.json`]: malformed,
          }, [`${description.dropInDir}/entry.json`]),
        },
      });
      expect(settings.mcpPolicySourceFailures).toEqual([
        { kind: category, sourceClass: "system-file", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
        { kind: category, sourceClass: "system-drop-in", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      ]);
      expect(JSON.stringify(settings.mcpPolicySourceFailures)).not.toMatch(/redacted|secret/u);
    }
  });
});

interface ManagedMcpIoFixture {
  io: ManagedMcpIo;
  calls: string[];
}

function managedMcpIoFixture(options: {
  bytes?: Uint8Array;
  open?: "absent" | "unreadable";
  before?: Partial<ManagedMcpFileMetadata>;
  after?: Partial<ManagedMcpFileMetadata>;
  current?: Partial<ManagedMcpFileMetadata>;
  readFails?: boolean;
  closeFails?: boolean;
  closeThrows?: boolean;
}): ManagedMcpIoFixture {
  const bytes = options.bytes ?? Buffer.from('{"mcpServers":{}}');
  const base: ManagedMcpFileMetadata = {
    regular: true,
    size: bytes.byteLength,
    identity: "1:2",
    modified: "3:4",
  };
  const calls: string[] = [];
  return {
    calls,
    io: {
      open(filePath) {
        calls.push(`open:${filePath}`);
        if (options.open !== undefined) return { status: options.open };
        let metadataCalls = 0;
        return {
          status: "opened",
          handle: {
            metadata() {
              calls.push("metadata");
              return metadataCalls++ === 0 ? { ...base, ...options.before } : { ...base, ...options.after };
            },
            read(maxBytes) {
              calls.push(`read:${maxBytes}`);
              return options.readFails ? undefined : bytes.subarray(0, maxBytes);
            },
            currentPathMetadata() {
              calls.push("current-path-metadata");
              return { ...base, ...options.current };
            },
            close() {
              calls.push("close");
              if (options.closeThrows === true) throw new Error("close canary");
              return options.closeFails !== true;
            },
          },
        };
      },
    },
  };
}

describe("standalone managed MCP discovery", () => {
  it("uses the fixed platform paths", () => {
    expect(defaultManagedMcpPath("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-mcp.json");
    expect(defaultManagedMcpPath("linux")).toBe("/etc/claude-code/managed-mcp.json");
    expect(defaultManagedMcpPath("win32")).toBe("C:\\Program Files\\ClaudeCode\\managed-mcp.json");
  });

  it("distinguishes absent, loaded empty, and loaded populated snapshots without expansion", () => {
    const absent = managedMcpIoFixture({ open: "absent" });
    expect(discoverManagedMcp({ platform: "linux", testAuthority: { path: "/test/policy", io: absent.io } })).toEqual({ status: "absent" });

    const empty = managedMcpIoFixture({});
    expect(discoverManagedMcp({ testAuthority: { path: "/test/empty", io: empty.io } })).toEqual({ status: "loaded", servers: [] });

    const populated = managedMcpIoFixture({ bytes: Buffer.from(JSON.stringify({ mcpServers: {
      raw: { command: "${MCP_COMMAND}", args: ["${MCP_ARG:-fallback}"] },
    } })) });
    const result = discoverManagedMcp({ testAuthority: { path: "/test/populated", io: populated.io } });
    expect(result).toMatchObject({ status: "loaded", servers: [{
      name: "raw", source: "managed-mcp", command: "${MCP_COMMAND}", args: ["${MCP_ARG:-fallback}"], skipped: false,
    }] });
    expect(populated.calls.filter((call) => call.startsWith("open:"))).toEqual(["open:/test/populated"]);
    expect(populated.calls).toContain("read:1048577");
  });

  it("returns fixed unusable reasons for every whole-artifact uncertainty", () => {
    const cases: Array<[string, Parameters<typeof managedMcpIoFixture>[0], string]> = [
      ["unreadable open", { open: "unreadable" }, "unreadable"],
      ["unreadable read", { readFails: true }, "unreadable"],
      ["non-regular", { before: { regular: false } }, "non-regular"],
      ["oversized metadata", { before: { size: 1_048_577 } }, "oversized"],
      ["invalid encoding", { bytes: Uint8Array.from([0xc3, 0x28]) }, "invalid-encoding"],
      ["malformed", { bytes: Buffer.from("{") }, "malformed"],
      ["JSONC rejected", { bytes: Buffer.from('{"mcpServers":{} // comment\n}') }, "malformed"],
      ["wrong root", { bytes: Buffer.from('{"servers":{}}') }, "wrong-root"],
      ["handle metadata race", { after: { modified: "changed" } }, "unstable"],
      ["path replacement", { current: { identity: "replacement" } }, "unstable"],
      ["close failure", { closeFails: true }, "unstable"],
      ["close exception", { closeThrows: true }, "unstable"],
    ];
    for (const [label, fixtureOptions, reason] of cases) {
      const fixture = managedMcpIoFixture(fixtureOptions);
      expect(discoverManagedMcp({ testAuthority: { path: `/test/${label}`, io: fixture.io } }), label)
        .toEqual({ status: "unusable", reason });
    }
  });

  it("treats open ENOENT as absent only when lstat also proves the path absent", () => {
    const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("redacted"), { code: "ENOENT" });
    const adapter = (pathPresent: boolean): ManagedMcpIo => createNodeManagedMcpIo({
      constants: { O_RDONLY: 0 },
      openSync() { throw enoent(); },
      lstatSync() {
        if (!pathPresent) throw enoent();
        return { isFile: () => false } as fs.Stats;
      },
      fstatSync() { throw new Error("not reached"); },
      readSync() { throw new Error("not reached"); },
      closeSync() { throw new Error("not reached"); },
    } satisfies ManagedMcpNodeFs);

    expect(discoverManagedMcp({ testAuthority: { path: "/fixed/absent", io: adapter(false) } }))
      .toEqual({ status: "absent" });
    expect(discoverManagedMcp({ testAuthority: { path: "/fixed/dangling-symlink", io: adapter(true) } }))
      .toEqual({ status: "unusable", reason: "unreadable" });
  });

  it("accepts the exact byte boundary and rejects one byte beyond it", () => {
    const prefix = '{"mcpServers":{}}';
    const exactBytes = Buffer.from(prefix + " ".repeat(1_048_576 - Buffer.byteLength(prefix)));
    const exact = managedMcpIoFixture({ bytes: exactBytes });
    expect(discoverManagedMcp({ testAuthority: { path: "/test/exact", io: exact.io } })).toEqual({ status: "loaded", servers: [] });

    const overBytes = Buffer.concat([exactBytes, Buffer.from(" ")]);
    expect(overBytes.byteLength).toBe(1_048_577);
    const over = managedMcpIoFixture({ bytes: overBytes, before: { size: 1_048_576 } });
    expect(discoverManagedMcp({ testAuthority: { path: "/test/over", io: over.io } })).toEqual({ status: "unusable", reason: "oversized" });
  });

  it("uses only injected standalone authority and performs no managed-settings or project lookup", () => {
    const fixture = managedMcpIoFixture({ open: "absent" });
    discoverManagedMcp({
      platform: "win32",
      testAuthority: { path: "/only/injected", io: fixture.io },
    });
    expect(fixture.calls).toEqual(["open:/only/injected"]);
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

  it("loads system settings plus sorted drop-ins across retained managed policy categories", () => {
    const scopes = makeScopes();
    const description = {
      systemSettingsPath: "/policy/managed-settings.json",
      dropInDir: "/policy/managed-settings.d",
      artifactDirs: ["/policy"],
    };
    const a = "/policy/managed-settings.d/10-a.json";
    const b = "/policy/managed-settings.d/20-b.json";
    const io = inertPolicyIo(
      {
        [description.systemSettingsPath]: JSON.stringify({
          permissions: { deny: ["Read(./secret)"] },
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo managed" }] }] },
          deniedMcpServers: [{ serverName: "blocked" }],
          enabledPlugins: { "base@official": true },
          claudeMd: "managed instructions",
          env: { BASE: "yes", SHARED: "base" },
          subagents: { maxDepth: 3 },
          worktree: { baseRef: "fresh" },
          cleanupPeriodDays: 12,
          autoMemoryEnabled: false,
          nested: { a: 1, same: "base" },
          list: ["base", { x: 1 }],
        }),
        [a]: JSON.stringify({
          permissions: { deny: ["Bash(curl *)"] },
          env: { A: "yes", SHARED: "a" },
          subagents: { concurrency: 4 },
          nested: { b: 2, same: "a" },
          list: ["a", { x: 1 }],
        }),
        [b]: JSON.stringify({
          model: "drop-in",
          allowedMcpServers: [{ serverName: "allowed" }],
          autoMemoryDirectory: "/managed/memory",
          list: ["base", "b"],
        }),
      },
      [b, a],
    );

    const discovered = discoverManagedPolicy({ platform: "win32", description, io });
    expect(discovered.settings).toMatchObject({
      model: "drop-in",
      nested: { a: 1, same: "a", b: 2 },
      list: ["base", { x: 1 }, "a", "b"],
    });
    expect(discovered.sources.map(({ source, sourceClass }) => [source, sourceClass])).toEqual([
      [description.systemSettingsPath, "system-file"],
      [a, "system-drop-in"],
      [b, "system-drop-in"],
    ]);

    const settings = loadSettings({
      cwd: scopes.projectRoot,
      projectRoot: scopes.projectRoot,
      userDir: scopes.userDir,
      managedPolicy: { platform: "win32", description, io },
    });
    expect(settings.permissions.deny).toEqual(["Read(./secret)", "Bash(curl *)"]);
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("echo managed");
    expect(settings.mcpPolicySettings.map(({ sourcePath }) => sourcePath)).toEqual([
      description.systemSettingsPath,
      b,
    ]);
    expect(settings.effectivePluginEnablement?.["base@official"]).toMatchObject({
      enabled: true, scope: "managed", source: description.systemSettingsPath,
    });
    expect(settings.managedClaudeMd).toEqual({ content: "managed instructions", source: description.systemSettingsPath });
    expect(settings.env).toMatchObject({ BASE: "yes", A: "yes", SHARED: "a" });
    expect(settings.subagentMaxDepth).toBe(3);
    expect(settings.subagentConcurrency).toBe(4);
    expect(settings.worktree.baseRef).toBe("fresh");
    expect(settings.cleanupPeriodDays).toBe(12);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.autoMemoryDirectory).toBe("/managed/memory");
  });

  it("preserves exact duplicate policy arrays per physical source while aggregate merging stays compatible", () => {
    const first = "/policy/first.json";
    const second = "/policy/second.json";
    const duplicate = { serverName: "duplicate" };
    const result = discoverManagedPolicy({
      platform: "linux",
      overridePaths: [first, second],
      io: inertPolicyIo({
        [first]: JSON.stringify({
          allowedMcpServers: [duplicate, duplicate, { serverName: "tail" }],
          deniedMcpServers: [{ serverName: "deny" }, { serverName: "deny" }],
          allowManagedMcpServersOnly: false,
        }),
        [second]: JSON.stringify({
          allowedMcpServers: [{ serverName: "second" }, duplicate],
          allowManagedMcpServersOnly: true,
        }),
      }),
    });

    expect(result.sources[0]?.value).toMatchObject({
      allowedMcpServers: [duplicate, duplicate, { serverName: "tail" }],
      deniedMcpServers: [{ serverName: "deny" }, { serverName: "deny" }],
      allowManagedMcpServersOnly: false,
    });
    expect(result.sources[1]?.value.allowedMcpServers).toEqual([{ serverName: "second" }, duplicate]);
    expect(result.settings).toMatchObject({
      allowedMcpServers: [duplicate, { serverName: "tail" }, { serverName: "second" }],
      deniedMcpServers: [{ serverName: "deny" }],
      allowManagedMcpServersOnly: true,
    });
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

  it("explicit settings overrides perform zero ambient directory I/O", () => {
    const scopes = makeScopes();
    const override = scopes.absentManaged[0]!;
    const ioCalls: string[] = [];
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
      },
    });
    expect(settings.model).toBe("override");
    expect(ioCalls).toEqual([override]);
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

  it("covers every retained injected file source/status with exact access and no host lookup", () => {
    type Status = "absent" | "unreadable" | "malformed" | "present";
    type Target = "system" | "directory" | "drop-in" | "override";
    const description = {
      systemSettingsPath: "/policy/base.json",
      dropInDir: "/policy/drop",
      artifactDirs: ["/policy"],
    };
    const dropIn = "/policy/drop/listed.json";
    const override = "/override.json";
    const statuses: readonly Status[] = ["absent", "unreadable", "malformed", "present"];
    for (const target of ["system", "drop-in", "override"] as const satisfies readonly Target[]) {
      for (const status of statuses) {
        const fileCalls: string[] = [];
        const listCalls: string[] = [];
        const read = (model: string): ReturnType<ManagedPolicyIo["readFile"]> => {
          if (status === "absent") return { status: "absent" };
          if (status === "unreadable") return { status: "unreadable" };
          return { status: "present", text: status === "malformed" ? "{" : JSON.stringify({ model }) };
        };
        const result = discoverManagedPolicy({
          platform: "win32",
          description,
          io: {
            readFile(filePath) {
              fileCalls.push(filePath);
              if (target === "override") return read("override");
              if (target === "system" && filePath === description.systemSettingsPath) return read("system");
              if (target === "drop-in" && filePath === dropIn) return read("drop-in");
              return { status: "absent" };
            },
            listJsonFiles(dir) {
              listCalls.push(dir);
              return { status: "present", files: target === "drop-in" ? [dropIn] : [] };
            },
          },
          ...(target === "override" ? { overridePaths: [override] } : {}),
        });
        expect(result.settings, `${target}:${status}`).toEqual(
          status === "present" ? { model: target } : undefined,
        );
        expect(fileCalls).toEqual(
          target === "override" ? [override] : target === "system"
            ? [description.systemSettingsPath]
            : [description.systemSettingsPath, dropIn],
        );
        expect(listCalls).toEqual(target === "override" ? [] : [description.dropInDir]);
        expect(result.diagnostics).toHaveLength(status === "unreadable" || status === "malformed" ? 1 : 0);
      }
    }

    for (const status of ["absent", "unreadable", "present"] as const) {
      const result = discoverManagedPolicy({
        platform: "win32",
        description,
        io: {
          readFile: () => ({ status: "absent" }),
          listJsonFiles: () => status === "absent"
            ? { status: "absent" }
            : status === "unreadable"
              ? { status: "unreadable" }
              : { status: "present", files: [] },
        },
      });
      expect(result.diagnostics).toHaveLength(status === "unreadable" ? 1 : 0);
    }
  });

  it("resolves all platform file defaults without non-file adapters", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const result = discoverManagedPolicy({ platform, io: inertPolicyIo({}) });
      expect(result.settings).toBeUndefined();
      expect(result.diagnostics).toEqual([]);
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
    fs.mkdirSync(path.join(root, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(managedBase, "skills"), { recursive: true });
    fs.mkdirSync(path.join(managedBase, "agents"), { recursive: true });
    fs.mkdirSync(path.join(managedBase, "commands"), { recursive: true });
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
    expect(dirs.commandDirs).toEqual([
      { dir: path.join(managedBase, "commands"), scope: "managed" },
      { dir: path.join(root, ".claude", "commands"), scope: "project" },
    ]);

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
