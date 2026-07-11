import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findByName, loadClaudeProject } from "../src/project.js";

/**
 * Assembly-level coverage for loadClaudeProject (plan §3, §4.9, §5): settings,
 * skills, agents, and plugin content folded into one project model. These tests
 * build on-disk fixtures — they guard the wiring, not just the parsers.
 */

const tempDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-assembly-"));
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

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeSkill(dir: string, name: string, description: string): void {
  write(path.join(dir, name, "SKILL.md"), `---\ndescription: ${description}\n---\nbody of ${name}`);
}

/** Base fixture: a git repo root and a hermetic user dir. */
function makeBase(): { base: string; repo: string; userDir: string } {
  const base = makeTmp();
  const repo = path.join(base, "repo");
  const userDir = path.join(base, "home", ".claude");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); // repo-root marker
  fs.mkdirSync(userDir, { recursive: true });
  return { base, repo, userDir };
}

function load(cwd: string, userDir: string) {
  return loadClaudeProject({
    cwd,
    userDir,
    managedSettingsPaths: [],
    managedArtifactDirs: [],
  });
}

/** A marketplace plugin with one skill, one agent, and one hook. */
function makeMarketplacePlugin(userDir: string, marketplace: string, name: string): void {
  const root = path.join(userDir, "plugins", "marketplaces", marketplace, "plugins", name);
  write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  writeSkill(path.join(root, "skills"), `${name}-skill`, `skill of ${name}`);
  write(
    path.join(root, "agents", `${name}-agent.md`),
    `---\nname: ${name}-agent\ndescription: agent of ${name}\n---\nprompt`,
  );
  write(
    path.join(root, "hooks", "hooks.json"),
    JSON.stringify({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `echo ${name}-hook` }] }],
    }),
  );
}

describe("loadClaudeProject — plugin enablement (b393e6e regression)", () => {
  it("loads ONLY explicitly enabled plugins from a marketplace catalog (skills, agents, hooks)", () => {
    const { repo, userDir } = makeBase();
    makeMarketplacePlugin(userDir, "official", "alpha");
    makeMarketplacePlugin(userDir, "official", "beta");
    write(
      path.join(userDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "alpha@official": true, "beta@official": false } }),
    );

    const project = load(repo, userDir);

    // Only the enabled plugin is kept…
    expect(project.plugins.map((p) => p.name)).toEqual(["alpha"]);
    expect(Object.keys(project.pluginRoots)).toEqual(["alpha"]);
    // …its content is present under the CC plugin namespace…
    expect(project.skills.map((s) => s.name)).toContain("alpha:alpha-skill");
    expect(project.agents.map((a) => a.name)).toContain("alpha:alpha-agent");
    const hookCommands = JSON.stringify(project.mergedHooks);
    expect(hookCommands).toContain("echo alpha-hook");
    // …and the disabled sibling contributes NOTHING.
    expect(project.skills.some((s) => s.name.includes("beta"))).toBe(false);
    expect(project.agents.some((a) => a.name.includes("beta"))).toBe(false);
    expect(hookCommands).not.toContain("beta-hook");
  });

  it("loads no plugin content at all when enabledPlugins is absent (catalog is not auto-enabled)", () => {
    const { repo, userDir } = makeBase();
    makeMarketplacePlugin(userDir, "official", "alpha");

    const project = load(repo, userDir);
    expect(project.plugins).toEqual([]);
    expect(project.skills.some((s) => s.source.pluginName === "alpha")).toBe(false);
    expect(JSON.stringify(project.mergedHooks)).not.toContain("alpha-hook");
  });
});

describe("loadClaudeProject — multi-scope precedence", () => {
  it("resolves a same-named skill at pkg/root/user scopes to the nearest project one; user-only skills stay usable", () => {
    const { repo, userDir } = makeBase();
    const pkg = path.join(repo, "packages", "app");
    writeSkill(path.join(repo, ".claude", "skills"), "deploy", "root deploy");
    writeSkill(path.join(pkg, ".claude", "skills"), "deploy", "pkg deploy");
    writeSkill(path.join(userDir, "skills"), "deploy", "user deploy");
    writeSkill(path.join(userDir, "skills"), "user-only", "only in user scope");

    const project = load(pkg, userDir);

    const deploy = project.skills.find((s) => s.name === "deploy");
    expect(deploy?.description).toBe("pkg deploy");
    expect(deploy?.source.scope).toBe("project");
    expect(project.skills.filter((s) => s.name === "deploy")).toHaveLength(1);
    expect(project.skills.find((s) => s.name === "user-only")?.source.scope).toBe("user");
  });

  it("nested .claude/settings.json is honored by the assembled project (cwd wiring)", () => {
    const { repo, userDir } = makeBase();
    const pkg = path.join(repo, "packages", "app");
    fs.mkdirSync(pkg, { recursive: true });
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ model: "root-model" }));
    write(
      path.join(pkg, ".claude", "settings.json"),
      JSON.stringify({ model: "pkg-model", permissions: { deny: ["Bash(rm *)"] } }),
    );

    const project = load(pkg, userDir);
    expect(project.settings.model).toBe("pkg-model");
    expect(project.settings.permissions.deny).toEqual(["Bash(rm *)"]);
  });
});

describe("loadClaudeProject — plugin namespacing", () => {
  it("keeps a plugin skill alongside a same-named project skill instead of dropping it", () => {
    const { repo, userDir } = makeBase();
    writeSkill(path.join(repo, ".claude", "skills"), "deploy", "project deploy");
    const pluginRoot = path.join(userDir, "plugins", "marketplaces", "official", "plugins", "alpha");
    write(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha" }));
    writeSkill(path.join(pluginRoot, "skills"), "deploy", "plugin deploy");
    write(
      path.join(userDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "alpha@official": true } }),
    );

    const project = load(repo, userDir);
    const names = project.skills.map((s) => s.name);
    expect(names).toContain("deploy");
    expect(names).toContain("alpha:deploy");
    expect(project.skills.find((s) => s.name === "alpha:deploy")?.source.pluginName).toBe("alpha");
    // findByName: exact match wins; the bare name resolves to the project skill.
    expect(findByName(project.skills, "deploy")?.description).toBe("project deploy");
    expect(findByName(project.skills, "alpha:deploy")?.description).toBe("plugin deploy");
  });
});

describe("findByName", () => {
  const mk = (name: string) => ({ name });

  it("resolves an unambiguous bare name against plugin-namespaced content", () => {
    expect(findByName([mk("alpha:review"), mk("deploy")], "review")?.name).toBe("alpha:review");
  });

  it("returns undefined for an ambiguous bare name", () => {
    expect(findByName([mk("alpha:review"), mk("beta:review")], "review")).toBeUndefined();
  });

  it("never suffix-matches a namespaced query", () => {
    expect(findByName([mk("alpha:review")], "other:review")).toBeUndefined();
  });
});

describe("loadClaudeProject — skillOverrides consumption (§5)", () => {
  it('honors "off", "user-invocable-only", and "name-only" and diagnoses unknown values', () => {
    const { repo, userDir } = makeBase();
    writeSkill(path.join(repo, ".claude", "skills"), "gone", "to be disabled");
    writeSkill(path.join(repo, ".claude", "skills"), "manual", "user invocable only");
    writeSkill(path.join(repo, ".claude", "skills"), "terse", "listed name-only");
    writeSkill(path.join(repo, ".claude", "skills"), "weird", "unknown override value");
    writeSkill(path.join(repo, ".claude", "skills"), "normal", "untouched");
    write(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({
        skillOverrides: {
          gone: "off",
          manual: "user-invocable-only",
          terse: "name-only",
          weird: "sideways",
        },
      }),
    );

    const project = load(repo, userDir);
    const byName = new Map(project.skills.map((s) => [s.name, s]));
    expect(byName.has("gone")).toBe(false);
    expect(byName.get("manual")?.disableModelInvocation).toBe(true);
    expect(byName.get("terse")?.description).toBe("");
    expect(byName.get("weird")?.description).toBe("unknown override value");
    expect(byName.get("normal")?.description).toBe("untouched");
    expect(
      project.diagnostics.some((d) => d.message.includes('disabled by skillOverrides')),
    ).toBe(true);
    expect(
      project.diagnostics.some((d) => d.message.includes("Unknown skillOverrides value")),
    ).toBe(true);
  });
});

describe("loadClaudeProject — bundled plugin diagnostics", () => {
  it("surfaces project-bundled plugin diagnostics into the project diagnostics", () => {
    const { repo, userDir } = makeBase();
    write(path.join(repo, ".claude-plugin", "plugin.json"), "{ this is not json !!");

    const project = load(repo, userDir);
    expect(
      project.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("not valid JSON"),
      ),
    ).toBe(true);
  });
});
