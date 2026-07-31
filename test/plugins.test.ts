import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EffectivePluginEnablement, NormalizedPluginInstallation } from "../src/types.js";
import {
  loadPluginHooks,
  resolveInstalledPlugins,
} from "../src/claude/plugins.js";

let tmpRoot: string;
let userDir: string;
let projectRoot: string;

const directoryLinkProbe = (() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugins-dir-link-probe-"));
  try {
    const target = path.join(parent, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(parent, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})();

const fileLinkProbe = (() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugins-file-link-probe-"));
  try {
    const target = path.join(parent, "target.md");
    fs.writeFileSync(target, "probe", "utf8");
    fs.symlinkSync(target, path.join(parent, "link.md"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})();

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugins-"));
  userDir = path.join(tmpRoot, "home", ".claude");
  projectRoot = path.join(tmpRoot, "project");
  fs.mkdirSync(path.join(userDir, "plugins", "cache"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
});

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function installedRoot(pluginId = "alpha@official", version = "1.0.0", cache = path.join(userDir, "plugins", "cache")): string {
  const [name, marketplace] = pluginId.split("@");
  const root = path.join(cache, marketplace!, name!, version);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function record(options: Partial<NormalizedPluginInstallation> = {}): NormalizedPluginInstallation {
  const pluginId = options.pluginId ?? "alpha@official";
  const version = options.version ?? "1.0.0";
  return {
    pluginId,
    scope: "user",
    installPath: installedRoot(pluginId, version),
    version,
    provenance: { statePath: path.join(userDir, "plugins", "installed_plugins.json"), stateVersion: 2 },
    ...options,
  };
}

function enablement(values: Record<string, boolean>): Record<string, EffectivePluginEnablement> {
  return Object.fromEntries(Object.entries(values).map(([id, enabled]) => [id, {
    enabled,
    scope: "user" as const,
    source: path.join(userDir, "settings.json"),
  }]));
}

function resolve(options: {
  enabled?: Record<string, boolean>;
  installations?: NormalizedPluginInstallation[];
  status?: "absent" | "valid" | "unreadable" | "unsupported" | "malformed";
  env?: NodeJS.ProcessEnv;
  readBlocklistForTest?: (file: string) => string;
} = {}) {
  return resolveInstalledPlugins({
    userDir,
    projectRoot,
    enablement: enablement(options.enabled ?? { "alpha@official": true }),
    installations: options.installations ?? [record()],
    installedStateStatus: options.status ?? "valid",
    env: options.env ?? {},
    ...(options.readBlocklistForTest ? { readBlocklistForTest: options.readBlocklistForTest } : {}),
  });
}

describe("resolveInstalledPlugins — installed identity selection", () => {
  it("loads one exact record and keeps lifecycle identity separate from manifest namespace", () => {
    const installation = record();
    write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "component-name" }));
    write(path.join(installation.installPath, "skills", "demo", "SKILL.md"), "---\ndescription: demo\n---\nbody");

    const result = resolve({ installations: [installation] });

    expect(result.outcomes.map(({ pluginId, status }) => ({ pluginId, status }))).toEqual([
      { pluginId: "alpha@official", status: "loaded" },
    ]);
    expect(result.plugins[0]).toMatchObject({
      pluginId: "alpha@official",
      name: "component-name",
      marketplace: "official",
      version: "1.0.0",
      root: installation.installPath,
    });
    expect(result.plugins[0]!.skillSources).toHaveLength(1);
    expect(result.plugins[0]!.context.pluginId).toBe("alpha@official");
    expect(result.plugins[0]!.dataDir).toContain("alpha-official");
  });

  it("represents false, missing, absent, unsupported, malformed, and unreadable state without loading", () => {
    const disabled = resolve({ enabled: { "alpha@official": false } });
    expect(disabled.outcomes[0]!.status).toBe("disabled");
    for (const [status, expected, cause] of [
      ["absent", "enabled-but-uninstalled", undefined],
      ["unsupported", "unsupported", "installed-state-unsupported"],
      ["malformed", "malformed", "installed-state-malformed"],
      ["unreadable", "rejected", "installed-state-unreadable"],
    ] as const) {
      const result = resolve({ status, enabled: { "alpha@official": true, "beta@official": true }, installations: [] });
      expect(result.plugins).toEqual([]);
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([expected, expected]);
      expect(result.outcomes.map((outcome) => outcome.sharedStateCauses)).toEqual([
        cause ? [cause] : undefined,
        cause ? [cause] : undefined,
      ]);
    }
    expect(resolve({ installations: [] }).outcomes[0]!.status).toBe("enabled-but-uninstalled");
  });

  it("chooses managed precedence, deduplicates canonical equivalent winners, and rejects true conflicts", () => {
    const user = record({ scope: "user" });
    const project = record({ scope: "project", projectPath: projectRoot, version: "2.0.0", installPath: installedRoot("alpha@official", "2.0.0") });
    const local = record({ scope: "local", projectPath: projectRoot, version: "3.0.0", installPath: installedRoot("alpha@official", "3.0.0") });
    const duplicate = { ...local, provenance: { ...local.provenance, installedAt: "later" } };
    expect(resolve({ installations: [user, project, local, duplicate] }).plugins[0]!.version).toBe("3.0.0");

    const managed = record({ scope: "managed", version: "5.0.0", installPath: installedRoot("alpha@official", "5.0.0") });
    expect(resolve({ installations: [local, managed] }).plugins[0]!.version).toBe("5.0.0");
    projectRoot = path.join(tmpRoot, "unrelated-project");
    fs.mkdirSync(projectRoot);
    expect(resolve({ installations: [managed] }).outcomes[0]!.status).toBe("loaded");

    projectRoot = path.join(tmpRoot, "project");
    const rootConflict = record({ scope: "local", projectPath: projectRoot, version: "3.0.0", installPath: installedRoot("alpha@official", "3.0.0", path.join(tmpRoot, "other-cache")) });
    const versionConflict = record({ scope: "local", projectPath: projectRoot, version: "4.0.0", installPath: installedRoot("alpha@official", "4.0.0") });
    for (const conflict of [rootConflict, versionConflict]) {
      const rejected = resolve({ installations: [local, conflict], env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(tmpRoot, "other-cache") } });
      expect(rejected.plugins).toEqual([]);
      expect(rejected.outcomes[0]!.status).toBe("ambiguous");
    }
  });

  it.skipIf(!directoryLinkProbe)("deduplicates canonically equivalent project and installed directory-link spellings", () => {
    const installation = record({ scope: "local", projectPath: projectRoot });
    const equivalentProject = path.join(tmpRoot, "project-link");
    const equivalentInstall = path.join(tmpRoot, "install-link");
    fs.symlinkSync(projectRoot, equivalentProject, process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(installation.installPath, equivalentInstall, process.platform === "win32" ? "junction" : "dir");
    const canonicalDuplicate = { ...installation, projectPath: equivalentProject, installPath: equivalentInstall };

    expect(resolve({ installations: [canonicalDuplicate, installation] }).outcomes[0]!.status).toBe("loaded");
  });

  it("keeps the same entry name in different marketplaces as exact distinct installed identities", () => {
    const first = record({ pluginId: "alpha@one", installPath: installedRoot("alpha@one") });
    const second = record({ pluginId: "alpha@two", installPath: installedRoot("alpha@two") });
    for (const [item, name] of [[first, "first-component"], [second, "second-component"]] as const) {
      write(path.join(item.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
    }
    const result = resolve({ enabled: { "alpha@one": true, "alpha@two": true }, installations: [second, first] });
    expect(result.plugins.map((item) => item.pluginId)).toEqual(["alpha@one", "alpha@two"]);
  });

  it.skipIf(process.platform === "win32")("keeps POSIX case-distinct neighboring project identities separate", () => {
    const upper = path.join(tmpRoot, "Project");
    const lower = path.join(tmpRoot, "project");
    fs.mkdirSync(upper);
    projectRoot = upper;
    const installation = record({ scope: "project", projectPath: lower });
    expect(resolve({ installations: [installation] }).outcomes[0]!.status).toBe("enabled-but-uninstalled");
  });

  it.skipIf(process.platform !== "win32")("deduplicates Windows case, drive, and separator spellings by filesystem identity", () => {
    const installation = record({ scope: "project", projectPath: projectRoot });
    const alternate = {
      ...installation,
      projectPath: projectRoot.replaceAll("\\", "/").replace(/^[a-z]:/i, (drive) => drive.toUpperCase()),
      installPath: installation.installPath.replaceAll("\\", "/").replace(/^[a-z]:/i, (drive) => drive.toUpperCase()),
    };
    expect(resolve({ installations: [alternate, installation] }).outcomes[0]!.status).toBe("loaded");
  });

  it("does not apply a project record from a neighboring checkout", () => {
    const other = path.join(tmpRoot, "other");
    fs.mkdirSync(other, { recursive: true });
    const installation = record({ scope: "project", projectPath: other });
    expect(resolve({ installations: [installation] }).outcomes[0]!.status).toBe("enabled-but-uninstalled");
  });

  it("applies a main-checkout project record to its genuine linked worktree but rejects copied foreign indirection", () => {
    const main = path.join(tmpRoot, "main");
    const worktree = path.join(tmpRoot, "linked");
    fs.mkdirSync(main);
    execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: main });
    write(path.join(main, "tracked.txt"), "tracked");
    execFileSync("git", ["add", "."], { cwd: main });
    execFileSync("git", ["-c", "user.name=Test", "commit", "-m", "fixture"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "linked-test", worktree], { cwd: main, stdio: "ignore" });
    const installation = record({ scope: "project", projectPath: main });

    projectRoot = worktree;
    expect(resolve({ installations: [installation] }).outcomes[0]!.status).toBe("loaded");

    const foreign = path.join(tmpRoot, "foreign");
    fs.mkdirSync(foreign);
    fs.copyFileSync(path.join(worktree, ".git"), path.join(foreign, ".git"));
    projectRoot = foreign;
    expect(resolve({ installations: [installation] }).outcomes[0]!.status).toBe("enabled-but-uninstalled");

    const malformed = path.join(tmpRoot, "malformed-worktree");
    fs.mkdirSync(malformed);
    write(path.join(malformed, ".git"), "gitdir: missing-admin-directory");
    projectRoot = malformed;
    expect(resolve({ installations: [installation] }).outcomes[0]!.status).toBe("enabled-but-uninstalled");
  });

  it.skipIf(!directoryLinkProbe)("projects the canonical runtime root even after an authorized cache spelling retargets", () => {
    const firstCache = path.join(tmpRoot, "canonical-cache-a");
    const secondCache = path.join(tmpRoot, "canonical-cache-b");
    fs.mkdirSync(firstCache);
    fs.mkdirSync(secondCache);
    const cacheLink = path.join(tmpRoot, "configured-cache-link");
    fs.symlinkSync(firstCache, cacheLink, process.platform === "win32" ? "junction" : "dir");
    const installation = record({ installPath: installedRoot("alpha@official", "1.0.0", cacheLink) });
    const result = resolve({ installations: [installation], env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheLink } });
    const canonicalRoot = fs.realpathSync.native(installation.installPath);
    expect(result.plugins[0]!.root).toBe(canonicalRoot);
    expect(result.plugins[0]!.context.root).toBe(canonicalRoot);

    fs.unlinkSync(cacheLink);
    fs.symlinkSync(secondCache, cacheLink, process.platform === "win32" ? "junction" : "dir");
    expect(result.plugins[0]!.root).toBe(canonicalRoot);
    expect(result.plugins[0]!.context.root).toBe(canonicalRoot);
  });

  it("keeps non-equivalent or unresolvable duplicate spellings ambiguous", () => {
    const first = record({ scope: "user", installPath: path.join(tmpRoot, "missing-one") });
    const second = record({ scope: "user", installPath: path.join(tmpRoot, "missing-two") });
    const result = resolve({ installations: [first, second] });
    expect(result.outcomes[0]!.status).toBe("ambiguous");
  });

  it("rejects roots outside cache, stale cache without a record, and identity/version layout mismatches", () => {
    const outside = path.join(tmpRoot, "outside");
    fs.mkdirSync(outside);
    expect(resolve({ installations: [record({ installPath: outside })] }).outcomes[0]!.status).toBe("rejected");
    expect(resolve({ installations: [] }).plugins).toEqual([]);
    const wrong = installedRoot("other@official", "1.0.0");
    expect(resolve({ installations: [record({ installPath: wrong })] }).outcomes[0]!.status).toBe("rejected");
  });

  it("keeps safe root-authorization reason evidence on the owning rejected outcome", () => {
    const secretRoot = path.join(tmpRoot, "secret-root");
    fs.mkdirSync(secretRoot);
    const result = resolve({ installations: [record({ installPath: secretRoot })] });
    expect(result.outcomes[0]!.diagnostics.map((item) => item.message)).toEqual([
      "Installed plugin root is outside every authorized plugin cache",
      'Installed plugin "alpha@official" has an unauthorized or invalid installed root; nothing was loaded',
    ]);
    expect(JSON.stringify(result.outcomes[0]!.diagnostics)).not.toContain(secretRoot);
  });

  it("authorizes configured and path-delimited seed cache bases only for exact records", () => {
    const configured = path.join(tmpRoot, "configured-cache");
    fs.mkdirSync(configured);
    const configuredRecord = record({ installPath: installedRoot("alpha@official", "1.0.0", configured) });
    expect(resolve({ installations: [configuredRecord], env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: configured } }).outcomes[0]!.status).toBe("loaded");

    const firstSeed = path.join(tmpRoot, "first-seed");
    const secondSeed = path.join(tmpRoot, "second-seed");
    const firstCache = path.join(firstSeed, "cache");
    const secondCache = path.join(secondSeed, "cache");
    fs.mkdirSync(firstCache, { recursive: true });
    fs.mkdirSync(secondCache, { recursive: true });
    const firstRecord = record({ installPath: installedRoot("alpha@official", "1.0.0", firstCache) });
    expect(resolve({ installations: [firstRecord], env: { CLAUDE_CODE_PLUGIN_SEED_DIR: firstSeed } }).outcomes[0]!.status).toBe("loaded");

    const secondRecord = record({ installPath: installedRoot("alpha@official", "1.0.0", secondCache) });
    const seeds = ["", firstSeed, secondSeed, firstSeed, ""].join(path.delimiter);
    expect(resolve({ installations: [secondRecord], env: { CLAUDE_CODE_PLUGIN_SEED_DIR: seeds } }).outcomes[0]!.status).toBe("loaded");
    expect(resolve({ installations: [], env: { CLAUDE_CODE_PLUGIN_SEED_DIR: seeds } }).outcomes[0]!.status).toBe("enabled-but-uninstalled");

    const erroneous = path.join(tmpRoot, "erroneous-seed");
    const erroneousCache = path.join(erroneous, "plugins", "cache");
    fs.mkdirSync(erroneousCache, { recursive: true });
    const erroneousRecord = record({ installPath: installedRoot("alpha@official", "1.0.0", erroneousCache) });
    expect(resolve({ installations: [erroneousRecord], env: { CLAUDE_CODE_PLUGIN_SEED_DIR: erroneous } }).outcomes[0]!.status).toBe("rejected");
  });
});

describe("resolveInstalledPlugins — blocklist and collision boundary", () => {
  it("qualified deny dominates enablement", () => {
    write(path.join(userDir, "plugins", "blocklist.json"), JSON.stringify({ plugins: [{ plugin: "alpha@official" }] }));
    const result = resolve();
    expect(result.plugins).toEqual([]);
    expect(result.outcomes[0]!.status).toBe("blocked");
  });

  it("every malformed or unreadable non-absent blocklist rejects all with one bounded diagnostic", () => {
    for (const content of ["not json", "[]", '{"plugins":{}}', '{"plugins":[{"plugin":"bare"}]}']) {
      write(path.join(userDir, "plugins", "blocklist.json"), content);
      const beta = record({ pluginId: "beta@official", installPath: installedRoot("beta@official") });
      const result = resolve({ enabled: { "alpha@official": true, "beta@official": true }, installations: [record(), beta] });
      expect(result.plugins).toEqual([]);
      expect(result.outcomes.map((item) => item.status)).toEqual(["malformed", "malformed"]);
      expect(result.outcomes.map((item) => item.sharedStateCauses)).toEqual([
        ["blocklist-malformed"],
        ["blocklist-malformed"],
      ]);
      expect(result.diagnostics).toHaveLength(1);
    }
    const unreadable = resolve({
      enabled: { "alpha@official": true, "beta@official": true },
      installations: [record(), record({ pluginId: "beta@official", installPath: installedRoot("beta@official") })],
      readBlocklistForTest: () => { const error = new Error("secret path"); Object.assign(error, { code: "EACCES" }); throw error; },
    });
    expect(unreadable.plugins).toEqual([]);
    expect(unreadable.outcomes.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(unreadable.outcomes.map((item) => item.sharedStateCauses)).toEqual([
      ["blocklist-unreadable"],
      ["blocklist-unreadable"],
    ]);
    expect(unreadable.diagnostics).toHaveLength(1);
    expect(unreadable.diagnostics[0]!.message).not.toContain("secret path");

    const simultaneous = resolve({
      status: "unreadable",
      enabled: { "alpha@official": true, "beta@official": true },
      installations: [record(), record({ pluginId: "beta@official" })],
      readBlocklistForTest: () => "{broken",
    });
    expect(simultaneous.plugins).toEqual([]);
    expect(simultaneous.outcomes.map((item) => item.status)).toEqual(["malformed", "malformed"]);
    expect(simultaneous.outcomes.map((item) => item.sharedStateCauses)).toEqual([
      ["installed-state-unreadable", "blocklist-malformed"],
      ["installed-state-unreadable", "blocklist-malformed"],
    ]);
  });

  it("rejects component namespace collisions without conflating punctuation-distinct data projections", () => {
    const first = record({ pluginId: "one@market", installPath: installedRoot("one@market") });
    const second = record({ pluginId: "two@market", installPath: installedRoot("two@market") });
    for (const item of [first, second]) write(path.join(item.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "same" }));
    const namespace = resolve({ enabled: { "one@market": true, "two@market": true }, installations: [first, second] });
    expect(namespace.plugins).toEqual([]);
    expect(namespace.outcomes.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(namespace.outcomes[0]!.diagnostics.map((item) => item.message).join(" ")).toContain("component namespace collision");
    expect(namespace.outcomes[0]!.diagnostics.map((item) => item.message).join(" ")).not.toContain("persistent data key collision");

    const dot = record({ pluginId: "same.name@market", installPath: installedRoot("same.name@market") });
    const dash = record({ pluginId: "same-name@market", installPath: installedRoot("same-name@market") });
    write(path.join(dot.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dot-component" }));
    write(path.join(dash.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dash-component" }));
    const data = resolve({ enabled: { "same.name@market": true, "same-name@market": true }, installations: [dot, dash] });
    expect(data.plugins.map((plugin) => plugin.pluginId)).toEqual(["same-name@market", "same.name@market"]);
    expect(data.outcomes.every((outcome) => outcome.status === "loaded")).toBe(true);
    expect(new Set(data.plugins.map((plugin) => path.basename(plugin.dataDir))).size).toBe(2);

    for (const item of [dot, dash]) write(path.join(item.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "same" }));
    const both = resolve({ enabled: { "same.name@market": true, "same-name@market": true }, installations: [dot, dash] });
    const messages = both.outcomes[0]!.diagnostics.map((item) => item.message).join(" ");
    expect(messages).toContain("component namespace collision");
    expect(messages).not.toContain("persistent data key collision");
  });
});

describe("resolveInstalledPlugins — component declarations", () => {
  it("supports manifestless defaults, root skill fallback, and command/agent defaults", () => {
    const installation = record();
    write(path.join(installation.installPath, "SKILL.md"), "---\nname: root\ndescription: root\n---\nbody");
    write(path.join(installation.installPath, "commands", "go.md"), "go");
    write(path.join(installation.installPath, "agents", "worker.md"), "---\ndescription: worker\n---\nprompt");
    const plugin = resolve({ installations: [installation] }).plugins[0]!;
    expect(plugin.manifest).toEqual({});
    expect(plugin.skillSources[0]!.source.kind).toBe("file");
    expect(plugin.commandSources).toHaveLength(1);
    expect(plugin.agentSources).toHaveLength(1);
  });

  it("adds explicit skills to defaults, replaces command/agent defaults, and merges default/path/inline hooks", () => {
    const installation = record();
    write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "alpha",
      skills: "./extra-skills",
      commands: ["./custom-command.md", "./custom-commands"],
      agents: ["./custom-agents", "./custom-agent.md"],
      hooks: ["./custom-hooks.json", { SessionStart: [{ hooks: ["echo inline"] }] }],
    }));
    write(path.join(installation.installPath, "skills", "default", "SKILL.md"), "---\ndescription: d\n---\nbody");
    write(path.join(installation.installPath, "extra-skills", "extra", "SKILL.md"), "---\ndescription: e\n---\nbody");
    write(path.join(installation.installPath, "commands", "ignored.md"), "ignored");
    write(path.join(installation.installPath, "custom-command.md"), "custom");
    write(path.join(installation.installPath, "custom-commands", "nested.md"), "nested");
    write(path.join(installation.installPath, "agents", "ignored.md"), "---\ndescription: i\n---\ni");
    write(path.join(installation.installPath, "custom-agents", "kept.md"), "---\ndescription: k\n---\nk");
    write(path.join(installation.installPath, "custom-agent.md"), "---\ndescription: f\n---\nf");
    write(path.join(installation.installPath, "hooks", "hooks.json"), JSON.stringify({ PreToolUse: [{ hooks: ["echo default"] }] }));
    write(path.join(installation.installPath, "custom-hooks.json"), JSON.stringify({ PreToolUse: [{ hooks: ["echo custom"] }] }));

    const plugin = resolve({ installations: [installation] }).plugins[0]!;
    expect(plugin.skillSources).toHaveLength(2);
    expect(plugin.commandSources).toHaveLength(2);
    expect(plugin.commandSources.map((item) => item.source.kind)).toEqual(["file", "directory"]);
    expect(plugin.agentSources).toHaveLength(2);
    expect(plugin.agentSources.map((item) => item.source.kind)).toEqual(["directory", "file"]);
    expect(plugin.hookSources).toHaveLength(3);
    const hooks = loadPluginHooks(plugin);
    expect(hooks.diagnostics).toEqual([]);
    expect(hooks.config["PreToolUse"]).toHaveLength(2);
    expect(hooks.config["SessionStart"]).toHaveLength(1);
  });

  it("rejects all recognized wrong types and invalid component-aware explicit declarations without fallback", () => {
    for (const field of ["skills", "commands", "agents", "hooks"] as const) {
      const installation = record();
      write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", [field]: 5 }));
      const result = resolve({ installations: [installation] });
      expect(result.plugins, field).toEqual([]);
      expect(result.outcomes[0]!.diagnostics.map((item) => item.message).join(" ")).toContain(`manifest ${field} declaration has the wrong type`);
      fs.rmSync(installation.installPath, { recursive: true, force: true });
    }

    for (const [field, declared, create] of [
      ["commands", "./missing", undefined],
      ["commands", "../escape", undefined],
      ["commands", "./wrong.txt", "file"],
      ["agents", "./wrong.json", "file"],
      ["skills", "./skill.md", "file"],
      ["hooks", "./hooks", "directory"],
      ["hooks", "./hooks.md", "file"],
    ] as const) {
      const installation = record();
      const target = path.join(installation.installPath, declared.replace(/^\.\//, ""));
      if (create === "file") write(target, "content");
      if (create === "directory") fs.mkdirSync(target, { recursive: true });
      write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", [field]: declared }));
      write(path.join(installation.installPath, "commands", "fallback.md"), "must not load");
      const result = resolve({ installations: [installation] });
      expect(result.plugins, `${field}:${declared}`).toEqual([]);
      const evidence = result.outcomes[0]!.diagnostics.map((item) => `${item.message} ${item.source ?? ""}`).join(" ");
      expect(evidence).toContain(`manifest ${field} declaration`);
      expect(evidence).not.toContain(declared);
      expect(evidence).not.toContain(target);
      fs.rmSync(installation.installPath, { recursive: true, force: true });
    }
  });

  it.skipIf(!fileLinkProbe)("rejects an explicit file-link escape without fallback or path disclosure", () => {
    const installation = record();
    const declared = "./escaped-command.md";
    const target = path.join(installation.installPath, "escaped-command.md");
    const outside = path.join(tmpRoot, "outside-command.md");
    write(outside, "outside");
    fs.symlinkSync(outside, target, "file");
    write(path.join(installation.installPath, "commands", "fallback.md"), "must not load");
    write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", commands: declared }));

    const result = resolve({ installations: [installation] });

    expect(result.plugins).toEqual([]);
    expect(result.outcomes[0]!.status).toBe("rejected");
    expect(result.outcomes[0]!.diagnostics.map((item) => item.message)).toContain(
      "Plugin manifest commands declaration has an invalid path (path-escape)",
    );
    const evidence = JSON.stringify(result.outcomes[0]!.diagnostics);
    expect(evidence).not.toContain(declared);
    expect(evidence).not.toContain(target);
    expect(evidence).not.toContain(outside);
  });

  it("rejects a deterministically unreadable explicit file without fallback or raw I/O disclosure", () => {
    const installation = record();
    const declared = "./private-command.md";
    const target = path.join(installation.installPath, "private-command.md");
    write(target, "private");
    write(path.join(installation.installPath, "commands", "fallback.md"), "must not load");
    write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", commands: declared }));
    const nativeRealpath = fs.realpathSync.native.bind(fs.realpathSync);
    const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      if (path.normalize(String(value)) === path.normalize(target)) {
        const error = new Error(`EACCES private source ${target}`);
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return nativeRealpath(value);
    });
    try {
      const result = resolve({ installations: [installation] });
      expect(result.plugins).toEqual([]);
      expect(result.outcomes[0]!.status).toBe("rejected");
      expect(result.outcomes[0]!.diagnostics.map((item) => item.message)).toContain(
        "Plugin manifest commands declaration has an invalid path (unreadable-path)",
      );
      const evidence = JSON.stringify(result.outcomes[0]!.diagnostics);
      expect(evidence).not.toContain(declared);
      expect(evidence).not.toContain(target);
      expect(evidence).not.toContain("EACCES private source");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an empty hooks array valid and retains the default JSON hook source", () => {
    const installation = record();
    write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", hooks: [] }));
    write(path.join(installation.installPath, "hooks", "hooks.json"), JSON.stringify({ SessionStart: [{ hooks: [] }] }));
    const plugin = resolve({ installations: [installation] }).plugins[0]!;
    expect(plugin.hookSources).toHaveLength(1);
    expect(plugin.hookSources[0]!.kind).toBe("file");
  });

  it("rejects an invalid manifestless lifecycle namespace with neutral fixed wording", () => {
    const installation = record({
      pluginId: "Alpha@official",
      installPath: installedRoot("Alpha@official"),
    });
    const outcome = resolve({ enabled: { "Alpha@official": true }, installations: [installation] }).outcomes[0]!;
    expect(outcome.status).toBe("rejected");
    expect(outcome.diagnostics).toContainEqual({
      severity: "warning",
      message: "Plugin component namespace is malformed; expected lowercase letters or digits separated by single hyphens",
    });
    const namespaceDiagnostic = outcome.diagnostics.find((item) => item.message.startsWith("Plugin component namespace"));
    expect(namespaceDiagnostic?.message).not.toContain("Alpha");
    expect(namespaceDiagnostic?.message).not.toContain("manifest");
  });

  it("accepts only kebab-case manifest component namespaces", () => {
    for (const name of ["alpha", "alpha-2", "2-alpha"]) {
      const installation = record();
      write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
      expect(resolve({ installations: [installation] }).outcomes[0]!.status, name).toBe("loaded");
      fs.rmSync(installation.installPath, { recursive: true, force: true });
    }
    for (const manifest of ["not json", "{}"]) {
      const installation = record();
      write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), manifest);
      expect(resolve({ installations: [installation] }).outcomes[0]!.status, manifest).toBe("rejected");
      fs.rmSync(installation.installPath, { recursive: true, force: true });
    }
    for (const name of ["../bad", "Upper", "has.dot", "has_under", "-leading", "trailing-", "two--hyphens"]) {
      const installation = record();
      write(path.join(installation.installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
      const outcome = resolve({ installations: [installation] }).outcomes[0]!;
      expect(outcome.status, name).toBe("rejected");
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
        "Plugin manifest name is malformed; expected lowercase letters or digits separated by single hyphens",
      );
      expect(JSON.stringify(outcome.diagnostics)).not.toContain(name);
      fs.rmSync(installation.installPath, { recursive: true, force: true });
    }
  });
});

describe("loadPluginHooks", () => {
  it("preserves placeholders literally outside execution and drops hostile event keys", () => {
    const installation = record();
    write(path.join(installation.installPath, "hooks", "hooks.json"), JSON.stringify({
      ["__proto__"]: [{ hooks: [] }],
      PreToolUse: [{
        matcher: "Bash(${CLAUDE_PLUGIN_ROOT})",
        if: "${CLAUDE_PLUGIN_DATA}",
        hooks: [{
          command: "${CLAUDE_PLUGIN_ROOT}",
          args: ["${CLAUDE_PLUGIN_DATA}"],
          url: "https://example.test/${CLAUDE_PLUGIN_ROOT}",
          rawField: "${CLAUDE_PLUGIN_DATA}",
        }],
      }],
    }));
    const plugin = resolve({ installations: [installation] }).plugins[0]!;
    const loaded = loadPluginHooks(plugin);
    expect(Object.hasOwn(loaded.config, "__proto__")).toBe(false);
    const entry = (loaded.config["PreToolUse"] as Array<{
      matcher: string; if: string; hooks: Array<Record<string, unknown>>;
    }>)[0]!;
    expect(entry).toEqual({
      matcher: "Bash(${CLAUDE_PLUGIN_ROOT})",
      if: "${CLAUDE_PLUGIN_DATA}",
      hooks: [{
        command: "${CLAUDE_PLUGIN_ROOT}",
        args: ["${CLAUDE_PLUGIN_DATA}"],
        url: "https://example.test/${CLAUDE_PLUGIN_ROOT}",
        rawField: "${CLAUDE_PLUGIN_DATA}",
      }],
    });
    expect(loaded.diagnostics).toHaveLength(1);
  });
});
