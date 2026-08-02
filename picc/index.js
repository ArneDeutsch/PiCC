import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCompiledRuntime } from "../bin/picc-runtime.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let sourceCheckout = false;
try {
  const gitState = fs.lstatSync(path.join(packageRoot, ".git"));
  sourceCheckout = gitState.isDirectory() || gitState.isFile();
} catch {
  sourceCheckout = false;
}

const verified = verifyCompiledRuntime({ packageRoot, checkSource: sourceCheckout });
if (!verified.ok) {
  if (sourceCheckout && verified.category === "source-stale") {
    throw new Error("The compiled runtime does not match this checkout. Run `node scripts/build-runtime.mjs`, exit PiCC, and relaunch; `/reload` cannot switch runtime representation.");
  }
  if (sourceCheckout) {
    throw new Error("The source-checkout compiled PiCC runtime is unavailable or damaged. Run `node scripts/build-runtime.mjs`, exit PiCC, and relaunch.");
  }
  throw new Error("The installed PiCC runtime is unavailable, damaged, or version-incoherent. Update or reinstall PiCC, then relaunch.");
}

const generationKey = Symbol.for("picc.runtime-generation.v1");
const processState = globalThis;
const generations = processState[generationKey] ??= new Map();
const canonicalRoot = fs.realpathSync(packageRoot);
const generation = {
  sourceDigest: verified.manifest.sourceDigest,
  runtimeDigest: verified.manifest.runtimeDigest,
};
const pinned = generations.get(canonicalRoot);
if (pinned !== undefined
  && (pinned.sourceDigest !== generation.sourceDigest || pinned.runtimeDigest !== generation.runtimeDigest)) {
  throw new Error("The verified PiCC runtime changed while this process was running. Exit PiCC and relaunch; `/reload` cannot switch runtime generation.");
}
if (pinned === undefined) generations.set(canonicalRoot, generation);

let picc;
try {
  ({ default: picc } = await import("../dist/index.js"));
} catch (error) {
  if (pinned === undefined && generations.get(canonicalRoot) === generation) generations.delete(canonicalRoot);
  throw error;
}

export default picc;
