import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { collectCompilationIdentity, verifyCompiledRuntime } from "../bin/picc-runtime.mjs";

function sha256File(fileSystem, file) {
  return createHash("sha256").update(fileSystem.readFileSync(file)).digest("hex");
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function walkOutputs(fileSystem, root) {
  const files = [];
  function visit(directory, relativeDirectory) {
    for (const entry of fileSystem.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const stat = fileSystem.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("The compiler produced a symbolic link.");
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) files.push(relative.normalize("NFC"));
      else throw new Error("The compiler produced a non-regular output.");
    }
  }
  visit(root, "");
  return files.sort(bytewiseCompare);
}

function removeBestEffort(fileSystem, target) {
  try {
    fileSystem.rmSync(target, { recursive: true, force: true });
  } catch {
    // Publication success must not be reversed because Windows still holds a stale tree open.
  }
}

/**
 * @typedef {object} BuildRuntimeOptions
 * @property {string} packageRoot
 * @property {(...args: any[]) => any} [spawnSync]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [execPath]
 * @property {() => string} [uniqueId]
 * @property {typeof fs} [fileSystem]
 */

/** @param {BuildRuntimeOptions} options */
export function buildRuntime({
  packageRoot,
  spawnSync = nodeSpawnSync,
  env = process.env,
  execPath = process.execPath,
  uniqueId = randomUUID,
  fileSystem = fs,
}) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0) throw new TypeError("packageRoot must be a non-empty string");
  if (typeof spawnSync !== "function" || typeof uniqueId !== "function") throw new TypeError("invalid process seam");
  if (fileSystem === null || typeof fileSystem !== "object") throw new TypeError("invalid filesystem seam");

  const root = path.resolve(packageRoot);
  const dist = path.join(root, "dist");
  const token = `${process.pid}-${String(uniqueId()).replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const stage = path.join(root, `dist.staging-${token}`);
  const backup = path.join(root, `dist.backup-${token}`);
  const before = collectCompilationIdentity(root);
  if (fileSystem.existsSync(stage) || fileSystem.existsSync(backup)) throw new Error("The unique runtime publication path already exists.");
  fileSystem.mkdirSync(stage, { recursive: false });

  let published = false;
  try {
    const packageRequire = createRequire(path.join(root, "package.json"));
    const compilerPackagePath = packageRequire.resolve("typescript/package.json");
    const compilerPath = path.join(path.dirname(compilerPackagePath), "bin", "tsc");
    let result;
    try {
      result = spawnSync(execPath, [compilerPath, "-p", path.join(root, "tsconfig.runtime.json"), "--outDir", stage], {
        cwd: root,
        env,
        shell: false,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("PiCC runtime compilation failed. Fix the TypeScript errors and retry.");
    }
    if (result?.error || result?.status !== 0) throw new Error("PiCC runtime compilation failed. Fix the TypeScript errors and retry.");

    const outputPaths = walkOutputs(fileSystem, stage);
    if (outputPaths.length === 0 || outputPaths.some((output) => !output.endsWith(".js") && !output.endsWith(".js.map"))) {
      throw new Error("PiCC runtime compilation produced missing or unexpected outputs.");
    }
    const outputSet = new Set(outputPaths);
    for (const output of outputPaths) {
      if (output.endsWith(".js") && !outputSet.has(`${output}.map`)) throw new Error("PiCC runtime compilation did not produce every source map.");
      if (output.endsWith(".js.map") && !outputSet.has(output.slice(0, -4))) throw new Error("PiCC runtime compilation produced an orphan source map.");
    }

    const files = [
      ...outputPaths.map((output) => ({ path: `dist/${output}`, sha256: sha256File(fileSystem, path.join(stage, ...output.split("/"))) })),
      { path: "picc/index.js", sha256: sha256File(fileSystem, path.join(root, "picc", "index.js")) },
    ].sort((left, right) => bytewiseCompare(left.path, right.path));
    const runtimeDigest = createHash("sha256").update(Buffer.from(JSON.stringify(files), "utf8")).digest("hex");
    const after = collectCompilationIdentity(root);
    if (before.sourceDigest !== after.sourceDigest) throw new Error("PiCC source inputs changed during runtime compilation; retry the build.");

    const manifest = {
      schemaVersion: 1,
      package: before.package,
      compiler: before.compiler,
      sources: before.sources,
      sourceDigest: before.sourceDigest,
      files,
      runtimeDigest,
      entries: { extension: "picc/index.js", pluginInventory: "dist/plugin-inventory-cli.js" },
    };
    fileSystem.writeFileSync(path.join(stage, "picc-runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

    const verified = verifyCompiledRuntime({ packageRoot: root, checkSource: true, distDirectory: stage });
    if (!verified.ok) throw new Error(`PiCC staged runtime verification failed (${verified.category}): ${verified.reason}`);

    const hadOld = fileSystem.existsSync(dist);
    if (hadOld) fileSystem.renameSync(dist, backup);
    try {
      fileSystem.renameSync(stage, dist);
      published = true;
    } catch {
      if (hadOld) {
        try {
          fileSystem.renameSync(backup, dist);
        } catch {
          throw new Error("PiCC runtime publication failed and the previous runtime could not be restored. Run the build again.");
        }
      }
      throw new Error("PiCC runtime publication failed. The previous runtime was restored; retry the build.");
    }

    if (hadOld) removeBestEffort(fileSystem, backup);
    return manifest;
  } finally {
    if (!published) removeBestEffort(fileSystem, stage);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildRuntime({ packageRoot: process.cwd() });
    console.log("Built and verified the PiCC compiled runtime.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
