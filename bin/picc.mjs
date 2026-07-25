#!/usr/bin/env node

const HELP = `Usage: picc [Pi options]
       picc update [--check|--help]

PiCC options:
  -h, --help       Show this help
  -v, --version    Show PiCC and embedded Pi versions
  update           Update PiCC as one compatible product`;
const USAGE_ERROR = "PiCC: invalid administrative arguments. Run `picc --help` for usage.";
const UPDATER_UNAVAILABLE = "PiCC: updater unavailable in this build. Reinstall PiCC or update from its source checkout.";
const INITIALIZATION_FAILED = "PiCC: launcher initialization failed. Reinstall PiCC from a trusted package or source checkout.";
const RUNTIME_INVALID = "PiCC: the embedded Pi runtime is incomplete or inconsistent. Run `picc update` or reinstall PiCC.";
const SPAWN_FAILED = "PiCC: could not start the embedded Pi runtime. Run `picc update` or reinstall PiCC.";

function fixedError(message) {
  console.error(message);
  process.exitCode = 1;
}

async function main() {
  let admin;
  try {
    admin = await import("./picc-admin.mjs");
    const [{ spawn }, fs, path, url] = await Promise.all([
      import("node:child_process"),
      import("node:fs"),
      import("node:path"),
      import("node:url"),
    ]);
    const packageRoot = admin.findPackageRoot(import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest?.name !== "picc" || !admin.parseStableExactVersion(manifest.version)) throw new Error("invalid manifest");
    const argv = process.argv.slice(2);

    const installationKind = () => {
      const local = admin.classifyInstallation({ packageRoot });
      return local === "source" ? local : admin.classifyInstallation({ packageRoot, globalRoot: admin.discoverGlobalNpmRoot() });
    };

    const first = argv[0];
    if (first === "--help" || first === "-h") {
      if (argv.length !== 1) return fixedError(USAGE_ERROR);
      console.log(HELP);
      return;
    }
    if (first === "--version" || first === "-v") {
      if (argv.length !== 1) return fixedError(USAGE_ERROR);
      const suite = admin.validatePiSuite({ packageRoot });
      const runtime = suite.ok ? `${suite.version} (${suite.mode})` : "unavailable/incoherent";
      console.log(`PiCC ${manifest.version}\nEmbedded Pi ${runtime}\nInstall ${installationKind()}`);
      return;
    }
    if (first === "update") {
      if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--check" && argv[1] !== "--help")) return fixedError(USAGE_ERROR);
      const updater = path.join(packageRoot, "bin", "picc-update.mjs");
      let updaterPath;
      try {
        updaterPath = admin.canonicalPath(updater);
        if (!fs.statSync(updaterPath).isFile() || !admin.isPathInside(updaterPath, packageRoot)) throw new Error("invalid updater");
      } catch {
        return fixedError(UPDATER_UNAVAILABLE);
      }
      let loaded;
      try {
        loaded = await import(url.pathToFileURL(updaterPath).href);
      } catch {
        return fixedError(UPDATER_UNAVAILABLE);
      }
      const run = loaded.runUpdate ?? loaded.default;
      if (typeof run !== "function") return fixedError(UPDATER_UNAVAILABLE);
      try {
        const result = await run({ action: argv[1] === "--check" ? "check" : argv[1] === "--help" ? "help" : "update" });
        if (typeof result === "number" && Number.isInteger(result) && result >= 0 && result <= 255) process.exitCode = result;
      } catch (error) {
        return fixedError(admin.isSafeAdministrativeError(error) ? error.safeMessage : UPDATER_UNAVAILABLE);
      }
      return;
    }

    const resolution = admin.resolvePiCli(packageRoot);
    if (!resolution.ok) return fixedError(RUNTIME_INVALID);
    let extension;
    try {
      extension = admin.canonicalPath(path.join(packageRoot, "picc", "index.ts"));
      if (!admin.isPathInside(extension, packageRoot) || !fs.statSync(extension).isFile()) throw new Error("invalid extension");
    } catch {
      return fixedError(INITIALIZATION_FAILED);
    }
    const child = spawn(process.execPath, [resolution.cli, "-e", extension, ...argv], {
      stdio: "inherit",
      env: {
        ...process.env,
        PICC_LAUNCHER_PID: String(process.pid),
        PICC_INSTALL_KIND: installationKind(),
        PICC_VERSION: manifest.version,
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    admin.wireChildLifecycle(child, {
      onSpawnError: () => fixedError(SPAWN_FAILED),
      onExitCode: (code) => { process.exitCode = code; },
      onSignal: (signal) => process.kill(process.pid, signal),
    });
  } catch {
    fixedError(INITIALIZATION_FAILED);
  } finally {
    admin?.cleanupAdministrativeEnvironment?.();
  }
}

await main();
