#!/usr/bin/env node

const INITIALIZATION_FAILED = "PiCC: launcher initialization failed. Reinstall PiCC from a package or source checkout.";
const START_FAILED = "PiCC: could not start the embedded Pi runtime. Run `picc update` or reinstall PiCC.";

process.setSourceMapsEnabled(true);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function runtimeFailure(selection, installationKind) {
  if (installationKind === "source") return `PiCC: ${selection.reason}`;
  const state = selection.category === "missing" ? "missing" : selection.category === "version-mismatch" ? "version-incoherent" : "damaged";
  return `PiCC: The installed PiCC runtime is ${state}. TypeScript source was not used. Run \`picc update\`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.`;
}

function runtimeUnavailable(installationKind) {
  return installationKind === "source"
    ? "PiCC: The source-checkout runtime could not be verified. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC."
    : "PiCC: The installed PiCC runtime could not be verified. Run `picc update`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.";
}

async function main() {
  try {
    const [admin, fs, path, url] = await Promise.all([
      import("./picc-admin.mjs"), import("node:fs"), import("node:path"), import("node:url"),
    ]);
    const packageRoot = admin.findPackageRoot(import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest?.name !== "@arnedeutsch/picc" || manifest.type !== "module" || !admin.parseStableExactVersion(manifest.version)) throw new Error("invalid manifest");
    const installationKind = admin.classifyInstallation({ packageRoot });
    const resolution = admin.resolvePiCli(packageRoot);
    if (!resolution.ok) return fail(`PiCC: ${resolution.reason}`);

    let extension;
    try {
      extension = admin.physicalPath(path.join(packageRoot, "picc", "index.ts"));
      if (!admin.isPathInside(extension, packageRoot) || !fs.statSync(extension).isFile()) throw new Error();
    } catch {
      return fail(INITIALIZATION_FAILED);
    }

    let runtime;
    try {
      runtime = await import("./picc-runtime.mjs");
    } catch {
      return fail(runtimeUnavailable(installationKind));
    }
    let selection;
    try {
      selection = runtime.selectPiccRuntime({ packageRoot, installationKind });
      if (selection.ok) runtime.installInitialRuntimeSelection(selection);
    } catch {
      return fail(runtimeUnavailable(installationKind));
    }
    if (!selection.ok) return fail(runtimeFailure(selection, installationKind));

    process.argv = [process.execPath, resolution.cli, "-e", extension, ...process.argv.slice(2)];
    try {
      await import(url.pathToFileURL(resolution.cli).href);
    } catch {
      console.error(START_FAILED);
      process.exit(1);
    }
  } catch {
    fail(INITIALIZATION_FAILED);
  }
}

await main();
