#!/usr/bin/env node
/**
 * PiClauDex launcher: runs Pi with the PiClauDex extension preloaded, in the
 * current directory (the target Claude Code project). All arguments pass through
 * to pi (e.g. `piclaudex -p "..."`, `piclaudex --model openai/gpt-5.5`).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.join(here, "..", "src", "index.ts");
const require = createRequire(import.meta.url);

let piCli;
try {
  // The package's exports map hides dist/cli.js, so resolve the main export
  // (dist/index.js) and take cli.js from the same directory.
  const mainEntry = require.resolve("@earendil-works/pi-coding-agent", {
    paths: [path.join(here, ".."), process.cwd()],
  });
  piCli = path.join(path.dirname(mainEntry), "cli.js");
} catch {
  piCli = path.join(
    here,
    "..",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
}
if (!(await import("node:fs")).existsSync(piCli)) {
  console.error(
    "PiClauDex: could not find the Pi CLI (@earendil-works/pi-coding-agent). Run `npm install` in the PiClauDex directory.",
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
