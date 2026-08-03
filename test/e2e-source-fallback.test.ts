import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_SUITE_PACKAGES } from "../bin/picc-admin.mjs";
import {
  cliMissing,
  createE2ELive,
  REPO_ROOT,
} from "./helpers/e2e-live.js";

const SOURCE_WITNESS_WATCHDOG_MS = 300_000;
const SOURCE_WITNESS_TEST_TIMEOUT_MS = 330_000;
const SOURCE_RELOAD_COMMAND = "__picc_test_reload_source_witness__";
const { startPi, cleanup } = createE2ELive({
  runtime: "source-fallback",
  sourceWitnessWatchdogMs: SOURCE_WITNESS_WATCHDOG_MS,
});
const temporary: string[] = [];

afterEach(async () => {
  await cleanup();
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const CONTAINED_DEPENDENCIES = new Set([...PI_SUITE_PACKAGES, "jiti"]);

function materializeNodeModules(root: string): void {
  const source = path.join(REPO_ROOT, "node_modules");
  const target = path.join(root, "node_modules");
  fs.mkdirSync(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      fs.mkdirSync(targetEntry);
      for (const child of fs.readdirSync(sourceEntry, { withFileTypes: true })) {
        const qualified = `${entry.name}/${child.name}`;
        const sourceChild = path.join(sourceEntry, child.name);
        const targetChild = path.join(targetEntry, child.name);
        if (CONTAINED_DEPENDENCIES.has(qualified)) fs.cpSync(sourceChild, targetChild, { recursive: true });
        else fs.symlinkSync(sourceChild, targetChild, process.platform === "win32" ? "junction" : "dir");
      }
    } else if (CONTAINED_DEPENDENCIES.has(entry.name)) {
      fs.cpSync(sourceEntry, targetEntry, { recursive: true });
    } else if (entry.isDirectory()) {
      fs.symlinkSync(sourceEntry, targetEntry, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.copyFileSync(sourceEntry, targetEntry);
    }
  }
}

function isolatedCheckout(): {
  root: string;
  launcher: string;
  driftedSource: string;
  extensionCanary: string;
  pluginCanary: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-source-fallback-"));
  temporary.push(root);
  for (const entry of ["bin", "dist", "picc", "scripts", "src"]) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(root, entry), { recursive: true });
  }
  for (const entry of ["package.json", "package-lock.json", "tsconfig.runtime.json"]) {
    fs.copyFileSync(path.join(REPO_ROOT, entry), path.join(root, entry));
  }
  fs.mkdirSync(path.join(root, ".git"));
  materializeNodeModules(root);
  const extensionCanary = path.join(root, "source-extension-canary.jsonl");
  const pluginCanary = path.join(root, "source-plugin-canary.jsonl");
  fs.writeFileSync(path.join(root, "picc", "index.ts"), [
    'import fs from "node:fs";',
    'import picc from "../src/index.js";',
    `const witness = ${JSON.stringify(extensionCanary)};`,
    'const sourcePath = import.meta.url;',
    'const record = (type: string) => fs.appendFileSync(witness, JSON.stringify({ type, producerPid: process.pid, sourcePath }) + "\\n");',
    'export default async function sourceWitness(pi: any) {',
    '  record("source-factory");',
    '  await picc(pi);',
    `  pi.registerCommand(${JSON.stringify(SOURCE_RELOAD_COMMAND)}, {`,
    '    description: "Reload the isolated source representation witness",',
    '    handler: async (_args: string, ctx: any) => { await ctx.reload(); },',
    '  });',
    '}',
    '',
  ].join("\n"));
  const driftedSource = path.join(root, "src", "plugin-inventory-cli.ts");
  fs.appendFileSync(driftedSource, [
    '',
    'const sourcePluginCanary = process.env.PICC_SOURCE_PLUGIN_CANARY;',
    'if (!sourcePluginCanary) throw new Error("source plugin canary is unavailable");',
    'fs.appendFileSync(sourcePluginCanary, JSON.stringify({ type: "source-plugin", producerPid: process.pid, sourcePath: import.meta.url, argv: process.argv.slice(2) }) + "\\n");',
    '',
  ].join("\n"));
  return { root, launcher: path.join(root, "bin", "picc.mjs"), driftedSource, extensionCanary, pluginCanary };
}

function pluginCommand(launcher: string, cwd: string, args: string[], pluginCanary: string) {
  const profile = path.join(cwd, ".empty-claude-profile");
  fs.mkdirSync(profile, { recursive: true });
  return spawnSync(process.execPath, [launcher, "plugin", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PICC_CLAUDE_USER_DIR: profile, PICC_SOURCE_PLUGIN_CANARY: pluginCanary },
    timeout: 30_000,
  });
}

describe.skipIf(cliMissing)("source-checkout fallback", () => {
  it("runs one disclosed TypeScript generation through real Pi and both plugin commands until relaunch", async () => {
    const isolated = isolatedCheckout();
    const list = pluginCommand(isolated.launcher, isolated.root, ["list"], isolated.pluginCanary);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain("Plugin inventory (read-only)");
    const details = pluginCommand(isolated.launcher, isolated.root, ["details", "missing@market"], isolated.pluginCanary);
    expect(details.status).toBe(1);
    expect(details.stderr).toContain("PiCC plugin not found: missing@market");
    const pluginObservations = fs.readFileSync(isolated.pluginCanary, "utf8").trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { type: string; producerPid: number; argv: string[]; sourcePath: string });
    expect(pluginObservations.map((observation) => observation.argv)).toEqual([
      ["plugin", "list"],
      ["plugin", "details", "missing@market"],
    ]);
    expect(pluginObservations.every((observation) => observation.type === "source-plugin" &&
      Number.isSafeInteger(observation.producerPid) && observation.producerPid !== process.pid &&
      observation.sourcePath.endsWith("/src/plugin-inventory-cli.ts"))).toBe(true);

    const live = await startPi({
      launcherPath: isolated.launcher,
      script: [{ text: "SOURCE_FALLBACK_FIRST" }, { text: "SOURCE_FALLBACK_AFTER_BUILD" }],
      prompt: "unused",
      modeArgs: ["--mode", "rpc"],
    });
    try {
      live.sendInput(JSON.stringify({ id: "first", type: "prompt", message: "first source turn" }));
      try {
        await live.waitForOutput((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("SOURCE_FALLBACK_FIRST"), 150_000);
      } catch (error) {
        await live.stop();
        const failed = await live.completion;
        throw new Error(`${String(error)}\nstdout:\n${failed.stdout}\nstderr:\n${failed.stderr}`);
      }

      const readSourceFactories = () => fs.readFileSync(isolated.extensionCanary, "utf8").trim().split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; producerPid: number; sourcePath: string })
        .filter((observation) => observation.type === "source-factory");
      const initialFactories = readSourceFactories();
      expect(initialFactories.length).toBeGreaterThan(0);
      expect(initialFactories.every((observation) => Number.isSafeInteger(observation.producerPid) &&
        observation.producerPid !== process.pid && observation.sourcePath.endsWith("/picc/index.ts"))).toBe(true);
      const childPid = initialFactories.at(-1)!.producerPid;
      const childFactoryCount = initialFactories.filter((observation) => observation.producerPid === childPid).length;

      fs.writeFileSync(isolated.driftedSource, fs.readFileSync(path.join(REPO_ROOT, "src", "plugin-inventory-cli.ts")));
      expect(fs.readFileSync(isolated.driftedSource).equals(
        fs.readFileSync(path.join(REPO_ROOT, "src", "plugin-inventory-cli.ts")),
      )).toBe(true);
      execFileSync(process.execPath, [path.join(isolated.root, "scripts", "build-runtime.mjs")], {
        cwd: isolated.root,
        stdio: "pipe",
        timeout: 120_000,
      });

      live.sendInput(JSON.stringify({
        id: "reload-source-witness",
        type: "prompt",
        message: `/${SOURCE_RELOAD_COMMAND}`,
      }));
      await live.waitForOutput((record) => record.type === "response" &&
        record.id === "reload-source-witness" && record.command === "prompt" && record.success === true, 150_000);
      const reloadedFactories = readSourceFactories();
      expect(reloadedFactories.filter((observation) => observation.producerPid === childPid).length)
        .toBeGreaterThan(childFactoryCount);
      expect(reloadedFactories.every((observation) => observation.producerPid !== process.pid &&
        observation.sourcePath.endsWith("/picc/index.ts"))).toBe(true);

      live.sendInput(JSON.stringify({ id: "second", type: "prompt", message: "second source turn" }));
      await live.waitForOutput((record) => record.type === "message_end" &&
        JSON.stringify(record).includes("SOURCE_FALLBACK_AFTER_BUILD"), 30_000);
      await live.waitForOutput((record) => record.type === "agent_settled", 30_000, 2);
      live.closeInput();
      const result = await live.completion;
      if (process.platform === "win32" && result.code !== 0) expect(result.code, result.stderr).toBe(3221226505);
      else expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain("PiCC is using TypeScript source because the compiled runtime does not match this checkout.");
      expect(result.stdout).toContain("SOURCE_FALLBACK_FIRST");
      expect(result.stdout).toContain("SOURCE_FALLBACK_AFTER_BUILD");
    } finally {
      live.closeInput();
      await live.stop();
    }

    const relaunched = execFileSync(process.execPath, [isolated.launcher, "--version"], {
      cwd: isolated.root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(relaunched).toContain("Runtime compiled (verified)");
    expect(relaunched).not.toContain("source fallback");
  }, SOURCE_WITNESS_TEST_TIMEOUT_MS);
});
