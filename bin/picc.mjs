#!/usr/bin/env node
/**
 * PiCC launcher: runs Pi with the PiCC extension preloaded, in the current
 * directory (the target Claude Code project).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Load via the picc/ entry (thin re-export of src/index.ts) so Pi's startup
// banner labels the extension `picc` rather than `src`.
const extension = path.join(here, "..", "picc", "index.ts");

/**
 * Resolve Pi's CLI (dist/cli.js). The package's `exports` map exposes only an
 * `"import"` condition and hides subpaths, so `require.resolve()` fails and a
 * subpath import can't reach dist/cli.js directly.
 */
function resolvePiCli() {
  // 1) ESM resolution of the package main (works when installed as a dependency,
  //    including npm-hoisted layouts).
  try {
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const cli = path.join(path.dirname(fileURLToPath(mainUrl)), "cli.js");
    if (fs.existsSync(cli)) return cli;
  } catch {
    /* fall through to the directory walk */
  }

  // 2) Walk candidate node_modules directories from the launcher and the cwd up.
  const roots = new Set();
  for (const start of [here, process.cwd()]) {
    let dir = start;
    for (;;) {
      roots.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const root of roots) {
    const cli = path.join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    if (fs.existsSync(cli)) return cli;
  }
  return undefined;
}

const piCli = resolvePiCli();
if (!piCli) {
  console.error(
    "PiCC: could not find the Pi CLI (@earendil-works/pi-coding-agent).\n" +
      "Run `npm install` (or `npm install -g picc`) so the dependency is present.",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [piCli, "-e", extension, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
