#!/usr/bin/env node

const HELP = `Usage: picc [Pi options]
       picc update [--check|--help]

PiCC options:
  -h, --help       Show this help
  -v, --version    Show PiCC and embedded Pi versions
  update           Update or repair PiCC`;
const USAGE_ERROR = "PiCC: invalid arguments. Run `picc --help` for usage.";
const UPDATER_UNAVAILABLE = "PiCC: updater unavailable in this build. Reinstall PiCC or update from its source checkout.";
const INITIALIZATION_FAILED = "PiCC: launcher initialization failed. Reinstall PiCC from a package or source checkout.";
const SPAWN_FAILED = "PiCC: could not start the embedded Pi runtime. Run `picc update` or reinstall PiCC.";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  try {
    const admin = await import("./picc-admin.mjs");
    const [{ spawn }, fs, path, url] = await Promise.all([
      import("node:child_process"), import("node:fs"), import("node:path"), import("node:url"),
    ]);
    const packageRoot = admin.findPackageRoot(import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest?.name !== "picc" || !admin.parseStableExactVersion(manifest.version)) throw new Error("invalid manifest");
    const argv = process.argv.slice(2);
    const first = argv[0];

    if (first === "--help" || first === "-h") {
      if (argv.length !== 1) return fail(USAGE_ERROR);
      console.log(HELP);
      return;
    }
    if (first === "--version" || first === "-v") {
      if (argv.length !== 1) return fail(USAGE_ERROR);
      const suite = admin.validatePiSuite({ packageRoot });
      console.log(`PiCC ${manifest.version}\nEmbedded Pi ${suite.ok ? suite.version : "unavailable/incoherent"}\nInstall ${admin.classifyInstallation({ packageRoot })}`);
      return;
    }
    if (first === "update") {
      if (argv.length > 2 || (argv[1] !== undefined && !["--check", "--help"].includes(argv[1]))) return fail(USAGE_ERROR);
      const updater = path.join(packageRoot, "bin", "picc-update.mjs");
      let updaterPath;
      try {
        updaterPath = admin.canonicalPath(updater);
        if (!fs.statSync(updaterPath).isFile() || !admin.isPathInside(updaterPath, packageRoot)) throw new Error();
      } catch { return fail(UPDATER_UNAVAILABLE); }
      try {
        const loaded = await import(url.pathToFileURL(updaterPath).href);
        const run = loaded.runUpdate ?? loaded.default;
        if (typeof run !== "function") return fail(UPDATER_UNAVAILABLE);
        const result = await run({ action: argv[1] === "--check" ? "check" : argv[1] === "--help" ? "help" : "update" });
        if (Number.isInteger(result)) process.exitCode = result;
      } catch { fail(UPDATER_UNAVAILABLE); }
      return;
    }

    const resolution = admin.resolvePiCli(packageRoot);
    if (!resolution.ok) return fail(`PiCC: ${resolution.reason}`);
    let extension;
    try {
      extension = admin.canonicalPath(path.join(packageRoot, "picc", "index.ts"));
      if (!admin.isPathInside(extension, packageRoot) || !fs.statSync(extension).isFile()) throw new Error();
    } catch { return fail(INITIALIZATION_FAILED); }
    const child = spawn(process.execPath, [resolution.cli, "-e", extension, ...argv], {
      stdio: "inherit",
      env: {
        ...process.env,
        PICC_LAUNCHER_PID: String(process.pid),
        PICC_INSTALL_KIND: admin.classifyInstallation({ packageRoot }),
        PICC_VERSION: manifest.version,
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    admin.wireChildLifecycle(child, {
      onSpawnError: () => fail(SPAWN_FAILED),
      onExitCode: (code) => { process.exitCode = code; },
      onSignal: (signal) => { process.kill(process.pid, signal); },
    });
  } catch { fail(INITIALIZATION_FAILED); }
}

await main();
