import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LIFECYCLE_MARKETPLACE = "full-surface-local";
export const LIFECYCLE_BASE_ID = `lifecycle-base@${LIFECYCLE_MARKETPLACE}`;
export const LIFECYCLE_DISABLED_ID = `lifecycle-disabled@${LIFECYCLE_MARKETPLACE}`;
export const LIFECYCLE_DEPENDENT_ID = `lifecycle-dependent@${LIFECYCLE_MARKETPLACE}`;

/** Preserves process basics while excluding ambient network and package-host credentials. */
export function lifecycleSubprocessEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const name of Object.keys(env)) {
    if (/^(?:ALL|HTTP|HTTPS|NO)_PROXY$/iu.test(name)
      || /^(?:AWS|AZURE|GOOGLE|GITHUB|GH|NPM|NODE_AUTH|OPENAI|ANTHROPIC|CLAUDE).*?(?:KEY|TOKEN|SECRET|PASSWORD|PROFILE|CONFIG)?$/iu.test(name)) {
      delete env[name];
    }
  }
  delete env.NODE_OPTIONS;
  return env;
}

function write(filename: string, contents: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function pluginManifest(name: string, version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version, ...extra }, null, 2);
}

export interface PluginLifecycleFixture {
  readonly project: string;
  readonly worktree: string;
  readonly marketplace: string;
  readonly userDir: string;
  readonly homeDir: string;
  readonly lifecycleTrace: string;
  readonly shutdownMutationGate: string;
  readonly runtimeCanary: string;
  writeGeneration(version: "1.0.0" | "2.0.0"): void;
  seedImportedCoexistence(): void;
  cleanup(): void;
}

/** Adds execution-created plugin trees and a linked checkout to a copied full-surface fixture. */
export function createPluginLifecycleFixture(project: string, root: string): PluginLifecycleFixture {
  const canonicalProject = fs.realpathSync.native(project);
  const canonicalRoot = fs.realpathSync.native(root);
  const worktree = path.join(canonicalRoot, "linked-worktree");
  const userDir = path.join(canonicalRoot, "claude-profile");
  const homeDir = path.join(canonicalRoot, "home");
  const marketplace = path.join(canonicalProject, "lifecycle-marketplace", ".claude-plugin");
  const lifecycleTrace = path.join(canonicalRoot, "lifecycle-trace.jsonl");
  const shutdownMutationGate = path.join(canonicalRoot, "mutate-on-shutdown");
  const runtimeCanary = path.join(canonicalRoot, "runtime-canary");
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  write(path.join(marketplace, "marketplace.json"), JSON.stringify({
    name: LIFECYCLE_MARKETPLACE,
    owner: { name: "PiCC e2e fixture" },
    plugins: [
      { name: "lifecycle-base", source: "./plugins/lifecycle-base", version: "1.0.0", defaultEnabled: true },
      { name: "lifecycle-disabled", source: "./plugins/lifecycle-disabled", version: "1.0.0", defaultEnabled: false },
      {
        name: "lifecycle-dependent",
        source: "./plugins/lifecycle-dependent",
        version: "1.0.0",
        defaultEnabled: true,
        dependencies: [{ name: "lifecycle-base", version: "^1.0.0" }],
      },
    ],
  }, null, 2));

  const hookScript = path.join(canonicalRoot, "lifecycle-hook.cjs");
  write(hookScript, [
    'const fs = require("node:fs");',
    'const cp = require("node:child_process");',
    'let hookParentPid=process.ppid;',
    'if (process.platform === "win32") {',
    '  const query=`(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}").ParentProcessId`;',
    '  hookParentPid=Number(cp.execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",query],{encoding:"utf8"}).trim());',
    '}',
    'let input=""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => input += chunk);',
    'process.stdin.on("end", () => {',
    '  let event={}; try { event=JSON.parse(input); } catch {}',
    `  fs.appendFileSync(${JSON.stringify(lifecycleTrace)}, JSON.stringify({hookEvent:event.hook_event_name??null,source:event.source??null,reason:event.reason??null,hookParentPid,hookChildPid:process.pid,recorderParentPid:process.ppid})+"\\n");`,
    `  if (event.hook_event_name === "SessionEnd" && fs.existsSync(${JSON.stringify(shutdownMutationGate)})) {`,
    `    fs.writeFileSync(${JSON.stringify(path.join(userDir, "settings.json"))}, JSON.stringify({enabledPlugins:{"missing-after-shutdown@full-surface-local":true}}));`,
    '  }',
    '});',
    '',
  ].join("\n"));
  const hookCommand = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`;

  const writeGeneration = (version: "1.0.0" | "2.0.0"): void => {
    const catalog = JSON.parse(fs.readFileSync(path.join(marketplace, "marketplace.json"), "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    for (const item of catalog.plugins) {
      item.version = version;
      if (item.name === "lifecycle-dependent") item.dependencies = [{ name: "lifecycle-base", version: `^${version[0]}.0.0` }];
    }
    write(path.join(marketplace, "marketplace.json"), `${JSON.stringify(catalog, null, 2)}\n`);

    const base = path.join(path.dirname(marketplace), "plugins", "lifecycle-base");
    write(path.join(base, ".claude-plugin", "plugin.json"), pluginManifest("lifecycle-base", version, {
      defaultEnabled: true,
      commands: "./commands",
      hooks: "./hooks/hooks.json",
      mcpServers: { inert: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(runtimeCanary)},'mcp')`] } },
      lspServers: { inert: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(runtimeCanary)},'lsp')`] } },
    }));
    write(path.join(base, "commands", "generation.md"), `---\ndescription: lifecycle generation witness\n---\nFS-LIFECYCLE-GENERATION-${version}\nDATA=$CLAUDE_PLUGIN_DATA\n`);
    write(path.join(base, "hooks", "hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: hookCommand }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: hookCommand }] }],
    } }, null, 2));

    const disabled = path.join(path.dirname(marketplace), "plugins", "lifecycle-disabled");
    write(path.join(disabled, ".claude-plugin", "plugin.json"), pluginManifest("lifecycle-disabled", version, { defaultEnabled: false }));
    write(path.join(disabled, "skills", "disabled", "SKILL.md"), "---\nname: disabled\ndescription: disabled lifecycle witness\n---\nFS-LIFECYCLE-DISABLED\n");

    const dependent = path.join(path.dirname(marketplace), "plugins", "lifecycle-dependent");
    write(path.join(dependent, ".claude-plugin", "plugin.json"), pluginManifest("lifecycle-dependent", version, {
      defaultEnabled: true,
      dependencies: [{ name: "lifecycle-base", version: `^${version[0]}.0.0` }],
    }));
  };
  writeGeneration("1.0.0");

  execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: canonicalProject, stdio: "pipe" });
  // The linked checkout receives only execution-created lifecycle fixture content.
  const linkedMarketplace = path.join(worktree, "lifecycle-marketplace", ".claude-plugin");
  fs.mkdirSync(linkedMarketplace, { recursive: true });
  fs.copyFileSync(path.join(marketplace, "marketplace.json"), path.join(linkedMarketplace, "marketplace.json"));
  fs.cpSync(
    path.join(path.dirname(marketplace), "plugins"),
    path.join(path.dirname(linkedMarketplace), "plugins"),
    { recursive: true },
  );

  const seedImportedCoexistence = (): void => {
    const roots = {
      same: path.join(userDir, "plugins", "cache", "full-surface-local", "lifecycle-base", "0.9.0"),
      other: path.join(userDir, "plugins", "cache", "foreign", "imported-visible", "3.0.0"),
    };
    write(path.join(roots.same, ".claude-plugin", "plugin.json"), pluginManifest("lifecycle-base", "0.9.0"));
    write(path.join(roots.other, ".claude-plugin", "plugin.json"), pluginManifest("imported-visible", "3.0.0"));
    write(path.join(userDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      [LIFECYCLE_BASE_ID]: [{ scope: "user", installPath: roots.same, version: "0.9.0" }],
      "imported-visible@foreign": [{ scope: "user", installPath: roots.other, version: "3.0.0" }],
    } }, null, 2));
  };

  return {
    project: canonicalProject, worktree, marketplace, userDir, homeDir, lifecycleTrace, shutdownMutationGate, runtimeCanary,
    writeGeneration,
    seedImportedCoexistence,
    cleanup() {
      try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: canonicalProject, stdio: "pipe" }); }
      catch { fs.rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    },
  };
}
