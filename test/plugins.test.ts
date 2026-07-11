import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverInstalledPlugins,
  discoverProjectBundledPlugin,
  expandPluginVariables,
  loadPluginHooks,
  type InstalledPlugin,
} from "../src/claude/plugins.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugins-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

/** Create a plugin dir at `root` with manifest + optional content. */
function makePlugin(
  root: string,
  manifest: Record<string, unknown> | string,
  opts: { skills?: boolean; agents?: boolean; commands?: boolean; hooks?: string } = {},
): void {
  const manifestText =
    typeof manifest === "string" ? manifest : JSON.stringify(manifest);
  write(path.join(root, ".claude-plugin", "plugin.json"), manifestText);
  if (opts.skills) {
    write(path.join(root, "skills", "demo", "SKILL.md"), "---\ndescription: d\n---\nbody");
  }
  if (opts.agents) {
    write(path.join(root, "agents", "worker.md"), "---\ndescription: w\n---\nprompt");
  }
  if (opts.commands) {
    write(path.join(root, "commands", "go.md"), "run it");
  }
  if (opts.hooks !== undefined) {
    write(path.join(root, "hooks", "hooks.json"), opts.hooks);
  }
}

describe("discoverInstalledPlugins", () => {
  it("discovers a plugin at repos/<owner>/<repo>/<name> nesting depth with content dirs", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "repos", "owner", "repo", "mytool");
    makePlugin(root, { name: "mytool", version: "1.0.0" }, {
      skills: true,
      agents: true,
      commands: true,
      hooks: JSON.stringify({ PreToolUse: [] }),
    });

    const { plugins, diagnostics } = discoverInstalledPlugins({
      userDir,
      enabledPlugins: undefined,
    });

    // (an info diagnostic about "none enabled" is expected here — filter it out)
    expect(diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(plugins).toHaveLength(1);
    const plugin = plugins[0]!;
    expect(plugin.name).toBe("mytool");
    expect(plugin.root).toBe(root);
    expect(plugin.manifest["version"]).toBe("1.0.0");
    expect(plugin.skillDirs).toEqual([path.join(root, "skills")]);
    expect(plugin.agentDirs).toEqual([path.join(root, "agents")]);
    expect(plugin.commandDirs).toEqual([path.join(root, "commands")]);
    expect(plugin.hooksFiles).toEqual([path.join(root, "hooks", "hooks.json")]);
  });

  it("omits content dirs that do not exist", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "cache", "lonely");
    makePlugin(root, { name: "lonely" }, { skills: true });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.skillDirs).toHaveLength(1);
    expect(plugins[0]!.agentDirs).toEqual([]);
    expect(plugins[0]!.commandDirs).toEqual([]);
    expect(plugins[0]!.hooksFiles).toEqual([]);
  });

  it("does not discover plugins beyond the depth cap of 5", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const tooDeep = path.join(userDir, "plugins", "a", "b", "c", "d", "e", "deep");
    makePlugin(tooDeep, { name: "deep" });
    const atCap = path.join(userDir, "plugins", "a", "b", "c", "d", "shallow");
    makePlugin(atCap, { name: "shallow" });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins.map((p) => p.name)).toEqual(["shallow"]);
  });

  it("resolves enabled from object form: explicit true enables, false / unmentioned disable", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "mytool"), { name: "mytool" });
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "offtool"), { name: "offtool" });
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "unlisted"), { name: "unlisted" });

    const { plugins } = discoverInstalledPlugins({
      userDir,
      enabledPlugins: { "mytool@mp": true, "offtool@mp": false },
    });

    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect(byName.get("mytool")!.enabled).toBe(true);
    expect(byName.get("offtool")!.enabled).toBe(false);
    // Not mentioned → NOT enabled (a plugin loads only when explicitly enabled).
    expect(byName.get("unlisted")!.enabled).toBe(false);
  });

  it("resolves enabled from array form by membership", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "yes"), { name: "yes" });
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "no"), { name: "no" });

    const { plugins } = discoverInstalledPlugins({
      userDir,
      enabledPlugins: ["yes@somewhere"],
    });

    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect(byName.get("yes")!.enabled).toBe(true);
    expect(byName.get("no")!.enabled).toBe(false);
  });

  it("enables NOTHING when enabledPlugins is undefined (a marketplace catalog is not auto-enabled)", () => {
    const userDir = path.join(tmpRoot, ".claude");
    // Simulate a cloned marketplace: several plugins available under marketplaces/.
    makePlugin(path.join(userDir, "plugins", "marketplaces", "official", "plugins", "foo"), { name: "foo" }, { skills: true });
    makePlugin(path.join(userDir, "plugins", "marketplaces", "official", "external_plugins", "bar"), { name: "bar" }, { skills: true });

    const { plugins, diagnostics } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins).toHaveLength(2);
    expect(plugins.every((p) => p.enabled)).toBe(false);
    expect(plugins.find((p) => p.name === "foo")!.marketplace).toBe("official");
    // Surfaces a helpful info diagnostic so the user understands why nothing loads.
    expect(diagnostics.some((d) => d.severity === "info" && /none are enabled/.test(d.message))).toBe(true);
  });

  it("enables a marketplace plugin only when explicitly listed as name@marketplace", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "marketplaces", "official", "plugins", "foo"), { name: "foo" }, { skills: true });
    makePlugin(path.join(userDir, "plugins", "marketplaces", "official", "plugins", "baz"), { name: "baz" }, { skills: true });

    const { plugins } = discoverInstalledPlugins({
      userDir,
      enabledPlugins: { "foo@official": true },
    });
    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect(byName.get("foo")!.enabled).toBe(true);
    expect(byName.get("baz")!.enabled).toBe(false);
  });

  it("prefers the most specific enabledPlugins key: an explicit qualified false beats a bare true", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "marketplaces", "official", "plugins", "foo"), { name: "foo" });

    const disabled = discoverInstalledPlugins({
      userDir,
      enabledPlugins: { foo: true, "foo@official": false },
    });
    expect(disabled.plugins[0]!.enabled).toBe(false);

    const enabled = discoverInstalledPlugins({
      userDir,
      enabledPlugins: { foo: false, "foo@official": true },
    });
    expect(enabled.plugins[0]!.enabled).toBe(true);
  });

  it("degrades a malformed blocklist.json to a diagnostic instead of throwing", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const pluginsRoot = path.join(userDir, "plugins");
    makePlugin(path.join(pluginsRoot, "repos", "o", "r", "mytool"), { name: "mytool" });

    for (const bad of ['{"plugins": {}}', '{"plugins": 5}', "[1,2]", "{{{ garbage"]) {
      write(path.join(pluginsRoot, "blocklist.json"), bad);
      const result = discoverInstalledPlugins({ userDir, enabledPlugins: { mytool: true } });
      // Discovery survives, the plugin still loads, and the problem is visible.
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]!.enabled).toBe(true);
      expect(
        result.diagnostics.some((d) => d.severity === "warning" && /blocklist/i.test(d.message)),
      ).toBe(true);
    }

    // An object without a "plugins" key is just an empty blocklist — no diagnostic.
    write(path.join(pluginsRoot, "blocklist.json"), "{}");
    const empty = discoverInstalledPlugins({ userDir, enabledPlugins: { mytool: true } });
    expect(empty.diagnostics.filter((d) => /blocklist/i.test(d.message))).toEqual([]);
  });

  it('skips a plugin whose name collides with Object.prototype (e.g. "__proto__")', () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "evil"), { name: "__proto__" });
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "fine"), { name: "fine" });

    const { plugins, diagnostics } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins.map((p) => p.name)).toEqual(["fine"]);
    expect(diagnostics.some((d) => d.message.includes("not allowed"))).toBe(true);
  });

  it("honors a manifest hooks-path override (with ${CLAUDE_PLUGIN_ROOT}) over the default hooks/hooks.json", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "repos", "o", "r", "hooked");
    makePlugin(
      root,
      { name: "hooked", hooks: "${CLAUDE_PLUGIN_ROOT}/custom/h.json" },
      { hooks: JSON.stringify({ SessionStart: [] }) }, // default file that must be ignored
    );
    write(path.join(root, "custom", "h.json"), JSON.stringify({ PreToolUse: [] }));

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins[0]!.hooksFiles).toEqual([path.join(root, "custom", "h.json")]);
  });

  it("honors installed-plugin manifest content-path overrides (skills)", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "repos", "o", "r", "custom");
    makePlugin(root, { name: "custom", skills: "./my-skills" }, { skills: true });
    write(path.join(root, "my-skills", "s", "SKILL.md"), "---\ndescription: d\n---\nbody");

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    // Manifest override wins; the default skills/ dir is not used.
    expect(plugins[0]!.skillDirs).toEqual([path.join(root, "my-skills")]);
  });

  it("records a diagnostic when a manifest-declared content path fails to resolve (and falls back)", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "repos", "o", "r", "dangling");
    makePlugin(root, { name: "dangling", skills: "./no-such-dir", hooks: "./no-such.json" }, { skills: true });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    const plugin = plugins[0]!;
    // Falls back to the default dir…
    expect(plugin.skillDirs).toEqual([path.join(root, "skills")]);
    // …and both dangling paths are visible.
    expect(
      plugin.diagnostics.filter((d) => d.message.includes("does not resolve")),
    ).toHaveLength(2);
  });

  it("records a diagnostic for a non-string manifest hooks value (unsupported shape)", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "repos", "o", "r", "inline");
    makePlugin(root, { name: "inline", hooks: { PreToolUse: [] } });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(
      plugins[0]!.diagnostics.some((d) => d.message.includes('"hooks" is not a path')),
    ).toBe(true);
  });

  it("never enables a blocklisted plugin, even if explicitly enabled", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const pluginsRoot = path.join(userDir, "plugins");
    makePlugin(path.join(pluginsRoot, "marketplaces", "official", "plugins", "danger"), { name: "danger" });
    write(
      path.join(pluginsRoot, "blocklist.json"),
      JSON.stringify({ plugins: [{ plugin: "danger@official", reason: "security" }] }),
    );

    const { plugins } = discoverInstalledPlugins({
      userDir,
      enabledPlugins: { "danger@official": true },
    });
    expect(plugins[0]!.enabled).toBe(false);
  });

  it("skips a plugin with a malformed manifest and records a diagnostic", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "broken"), "{ not json !!");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "fine"), { name: "fine" });

    const { plugins, diagnostics } = discoverInstalledPlugins({
      userDir,
      enabledPlugins: undefined,
    });

    expect(plugins.map((p) => p.name)).toEqual(["fine"]);
    const warnings = diagnostics.filter((d) => d.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("not valid JSON");
  });

  it("falls back to the directory name when the manifest has no name", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "dirname-tool"), {
      description: "no name key",
    });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.name).toBe("dirname-tool");
  });

  it("computes dataDir as <userDir>/plugins/data/<name>", () => {
    const userDir = path.join(tmpRoot, ".claude");
    makePlugin(path.join(userDir, "plugins", "repos", "o", "r", "mytool"), { name: "mytool" });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(plugins[0]!.dataDir).toBe(path.join(userDir, "plugins", "data", "mytool"));
  });

  it("returns empty (no throw) when the plugins dir does not exist", () => {
    const userDir = path.join(tmpRoot, "no-such-claude-dir");
    const result = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("discoverProjectBundledPlugin", () => {
  it("returns undefined when there is no .claude-plugin directory", () => {
    expect(discoverProjectBundledPlugin(tmpRoot)).toBeUndefined();
  });

  it("loads a bundled plugin with default content dirs under .claude-plugin/", () => {
    const projectRoot = path.join(tmpRoot, "proj");
    write(
      path.join(projectRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "bundled" }),
    );
    write(
      path.join(projectRoot, ".claude-plugin", "skills", "s", "SKILL.md"),
      "---\ndescription: d\n---\nbody",
    );
    write(path.join(projectRoot, ".claude-plugin", "commands", "c.md"), "cmd");

    const plugin = discoverProjectBundledPlugin(projectRoot);
    expect(plugin).toBeDefined();
    expect(plugin!.name).toBe("bundled");
    expect(plugin!.root).toBe(projectRoot);
    expect(plugin!.enabled).toBe(true);
    expect(plugin!.skillDirs).toEqual([path.join(projectRoot, ".claude-plugin", "skills")]);
    expect(plugin!.commandDirs).toEqual([path.join(projectRoot, ".claude-plugin", "commands")]);
    expect(plugin!.agentDirs).toEqual([]);
  });

  it("honors manifest content-path overrides relative to the project root", () => {
    const projectRoot = path.join(tmpRoot, "proj2");
    write(
      path.join(projectRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "bundled2",
        skills: "./my-skills",
        commands: ["tools/cmds"],
      }),
    );
    write(path.join(projectRoot, "my-skills", "s", "SKILL.md"), "body");
    write(path.join(projectRoot, "tools", "cmds", "c.md"), "cmd");
    // A default-location dir that must be IGNORED because the manifest overrides skills.
    write(path.join(projectRoot, ".claude-plugin", "skills", "x", "SKILL.md"), "body");

    const plugin = discoverProjectBundledPlugin(projectRoot);
    expect(plugin!.skillDirs).toEqual([path.join(projectRoot, "my-skills")]);
    expect(plugin!.commandDirs).toEqual([path.join(projectRoot, "tools", "cmds")]);
  });

  it("falls back to the project dir name when the manifest lacks a name, and never throws on a missing manifest", () => {
    const projectRoot = path.join(tmpRoot, "named-by-dir");
    fs.mkdirSync(path.join(projectRoot, ".claude-plugin"), { recursive: true });

    const plugin = discoverProjectBundledPlugin(projectRoot);
    expect(plugin).toBeDefined();
    expect(plugin!.name).toBe("named-by-dir");
    expect(plugin!.manifest).toEqual({});
    expect(plugin!.diagnostics.some((d) => d.message.includes("no plugin.json"))).toBe(true);
  });
});

describe("expandPluginVariables / loadPluginHooks", () => {
  function stubPlugin(overrides: Partial<InstalledPlugin>): InstalledPlugin {
    return {
      name: "stub",
      root: path.join(tmpRoot, "stub-root"),
      dataDir: path.join(tmpRoot, "stub-data"),
      manifest: {},
      skillDirs: [],
      agentDirs: [],
      commandDirs: [],
      hooksFiles: [],
      enabled: true,
      diagnostics: [],
      ...overrides,
    };
  }

  it("expands ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA}, repeatedly", () => {
    const plugin = stubPlugin({});
    const out = expandPluginVariables(
      "run ${CLAUDE_PLUGIN_ROOT}/a and ${CLAUDE_PLUGIN_ROOT}/b into ${CLAUDE_PLUGIN_DATA}/out",
      plugin,
    );
    expect(out).toBe(
      `run ${plugin.root}/a and ${plugin.root}/b into ${plugin.dataDir}/out`,
    );
  });

  it("loads hooks.json and expands plugin variables in nested command strings", () => {
    const userDir = path.join(tmpRoot, ".claude");
    const root = path.join(userDir, "plugins", "repos", "o", "r", "hooky");
    makePlugin(root, { name: "hooky" }, {
      hooks: JSON.stringify({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "${CLAUDE_PLUGIN_ROOT}/scripts/check.sh --data ${CLAUDE_PLUGIN_DATA}",
              },
            ],
          },
        ],
      }),
    });

    const { plugins } = discoverInstalledPlugins({ userDir, enabledPlugins: undefined });
    const plugin = plugins[0]!;
    const { config, diagnostics } = loadPluginHooks(plugin);

    expect(diagnostics).toEqual([]);
    const entries = config["PreToolUse"] as Array<{ hooks: Array<{ command: string }> }>;
    expect(entries[0]!.hooks[0]!.command).toBe(
      `${plugin.root}/scripts/check.sh --data ${path.join(userDir, "plugins", "data", "hooky")}`,
    );
  });

  it("merges multiple hooks files, concatenating entries per event", () => {
    const fileA = path.join(tmpRoot, "hooks-a.json");
    const fileB = path.join(tmpRoot, "hooks-b.json");
    write(fileA, JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [] }] }));
    write(
      fileB,
      JSON.stringify({
        PreToolUse: [{ matcher: "Write", hooks: [] }],
        SessionStart: [{ hooks: [] }],
      }),
    );
    const plugin = stubPlugin({ hooksFiles: [fileA, fileB] });

    const { config, diagnostics } = loadPluginHooks(plugin);
    expect(diagnostics).toEqual([]);
    expect(config["PreToolUse"]).toHaveLength(2);
    expect((config["PreToolUse"] as Array<{ matcher: string }>).map((e) => e.matcher)).toEqual([
      "Bash",
      "Write",
    ]);
    expect(config["SessionStart"]).toHaveLength(1);
  });

  it('unwraps a top-level "hooks" wrapper key in a hooks file', () => {
    const file = path.join(tmpRoot, "wrapped-hooks.json");
    write(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }));
    const plugin = stubPlugin({ hooksFiles: [file] });

    const { config } = loadPluginHooks(plugin);
    expect(config["PreToolUse"]).toHaveLength(1);
    expect(config["hooks"]).toBeUndefined();
  });

  it('drops a hostile "__proto__" event key in a plugin hooks file with a diagnostic', () => {
    const file = path.join(tmpRoot, "hostile-hooks.json");
    // Raw JSON — a JS object literal would interpret __proto__ itself.
    write(file, '{"__proto__": [{"hooks": []}], "PreToolUse": [{"matcher": "Bash", "hooks": []}]}');
    const plugin = stubPlugin({ hooksFiles: [file] });

    const { config, diagnostics } = loadPluginHooks(plugin);
    expect(config["PreToolUse"]).toHaveLength(1);
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
    expect(diagnostics.some((d) => d.message.includes("Unsafe hook event key"))).toBe(true);
  });

  it("reports a diagnostic for a malformed hooks file instead of throwing", () => {
    const hooksFile = path.join(tmpRoot, "bad-hooks.json");
    write(hooksFile, "{{{ nope");
    const plugin = stubPlugin({ hooksFiles: [hooksFile] });

    const { config, diagnostics } = loadPluginHooks(plugin);
    expect(config).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("warning");
  });
});
