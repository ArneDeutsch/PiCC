#!/usr/bin/env node

const HELP = `Usage: picc [Pi options]
       picc update [--check|--help]
       picc plugin <command>
       picc mcp <command>

PiCC options:
  -h, --help       Show this help
  -v, --version    Show PiCC and embedded Pi versions
  update           Update or repair PiCC
  plugin           Local marketplace/plugin lifecycle and offline recovery
                   Run picc plugin --help for the strict command grammar
  mcp              Standalone MCP server administration
                   Run picc mcp --help for the strict command grammar`;
const USAGE_ERROR = "PiCC: invalid arguments. Run `picc --help` for usage.";
const UPDATER_UNAVAILABLE = "PiCC: updater unavailable in this build. Reinstall PiCC or update from its source checkout.";
const PLUGIN_INVENTORY_UNAVAILABLE = "PiCC plugin lifecycle is unavailable in this build. Update or reinstall PiCC.";
const MCP_ADMINISTRATION_UNAVAILABLE = "PiCC MCP administration is unavailable in this build. Update or reinstall PiCC.";
const INITIALIZATION_FAILED = "PiCC: launcher initialization failed. Reinstall PiCC from a package or source checkout.";
const SPAWN_FAILED = "PiCC: could not start the embedded Pi runtime. Run `picc update` or reinstall PiCC.";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function runtimeFailure(selection, installationKind) {
  if (installationKind === "source") return `PiCC: ${selection.reason}`;
  const state = selection.category === "missing" ? "missing" : selection.category === "version-mismatch" ? "version-incoherent" : "damaged";
  return `PiCC: The installed PiCC runtime is ${state}. TypeScript source was not used. Run \`picc update\`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.`;
}

function runtimeStatus(selection, installationKind) {
  if (selection.ok) {
    if (selection.mode === "compiled") return "Runtime compiled (verified)";
    return `Runtime source fallback (${selection.notice.category}): ${selection.notice.message}`;
  }
  return `Runtime unavailable (${selection.category}): ${runtimeFailure(selection, installationKind).slice("PiCC: ".length)}`;
}

async function selectRuntime(packageRoot, installationKind) {
  const runtime = await import("./picc-runtime.mjs");
  return runtime.selectPiccRuntime({ packageRoot, installationKind });
}

async function main() {
  try {
    const admin = await import("./picc-admin.mjs");
    const [{ spawn }, fs, path, url] = await Promise.all([
      import("node:child_process"), import("node:fs"), import("node:path"), import("node:url"),
    ]);
    const packageRoot = admin.findPackageRoot(import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest?.name !== "@arnedeutsch/picc" || !admin.parseStableExactVersion(manifest.version)) throw new Error("invalid manifest");
    const installationKind = admin.classifyInstallation({ packageRoot });
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
      let status;
      try {
        status = runtimeStatus(await selectRuntime(packageRoot, installationKind), installationKind);
      } catch {
        status = installationKind === "source"
          ? "Runtime unavailable (launcher): Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC."
          : "Runtime unavailable (launcher): TypeScript source was not used. Run `picc update`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.";
      }
      console.log(`PiCC ${manifest.version}\nEmbedded Pi ${suite.ok ? suite.version : "unavailable/incoherent"}\nInstall ${installationKind}\n${status}`);
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
    if (first === "plugin") {
      let adapterPath;
      try {
        adapterPath = admin.canonicalPath(path.join(packageRoot, "bin", "picc-plugin.mjs"));
        if (!fs.statSync(adapterPath).isFile() || !admin.isPathInside(adapterPath, packageRoot)) throw new Error();
        const loaded = await import(url.pathToFileURL(adapterPath).href);
        if (typeof loaded.runPackagedPluginCommand !== "function") throw new Error();
        const result = await loaded.runPackagedPluginCommand({ packageRoot, argv: argv.slice(1) });
        process.exitCode = Number.isInteger(result) ? result : 1;
      } catch { fail(PLUGIN_INVENTORY_UNAVAILABLE); }
      return;
    }
    if (first === "mcp") {
      try {
        const adapterPath = admin.canonicalPath(path.join(packageRoot, "bin", "picc-mcp.mjs"));
        if (!fs.statSync(adapterPath).isFile() || !admin.isPathInside(adapterPath, packageRoot)) throw new Error();
        const loaded = await import(url.pathToFileURL(adapterPath).href);
        if (typeof loaded.runPackagedMcpCommand !== "function") throw new Error();
        const result = await loaded.runPackagedMcpCommand({ packageRoot, argv: argv.slice(1) });
        process.exitCode = Number.isInteger(result) ? result : 1;
      } catch { fail(MCP_ADMINISTRATION_UNAVAILABLE); }
      return;
    }

    let selection;
    try {
      selection = await selectRuntime(packageRoot, installationKind);
    } catch {
      return fail(installationKind === "source"
        ? "PiCC: runtime selection is unavailable. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC."
        : "PiCC: runtime selection is unavailable. TypeScript source was not used. Run `picc update`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.");
    }
    if (!selection.ok) return fail(runtimeFailure(selection, installationKind));
    if (selection.notice) console.error(selection.notice.message);

    const resolution = admin.resolvePiCli(packageRoot);
    if (!resolution.ok) return fail(`PiCC: ${resolution.reason}`);
    let extension;
    try {
      extension = admin.canonicalPath(path.join(packageRoot, ...selection.entries.extensionPath.split("/")));
      if (!admin.isPathInside(extension, packageRoot) || !fs.statSync(extension).isFile()) throw new Error();
    } catch { return fail(INITIALIZATION_FAILED); }
    const child = spawn(process.execPath, ["--enable-source-maps", resolution.cli, "-e", extension, ...argv], {
      stdio: "inherit",
      env: {
        ...process.env,
        PICC_LAUNCHER_PID: String(process.pid),
        PICC_INSTALL_KIND: installationKind,
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
