import fs from "node:fs";
import { createRequire, setSourceMapsSupport } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, classifyInstallation, isPathInside } from "./picc-admin.mjs";
import { selectPiccRuntime } from "./picc-runtime.mjs";

const UNAVAILABLE = "PiCC plugin inventory is unavailable in this build. Update or reinstall PiCC.";

function containingNodeModules(packageRoot) {
  const parent = path.dirname(packageRoot);
  if (path.basename(parent).toLowerCase() === "node_modules") return parent;
  if (path.basename(path.dirname(parent)).toLowerCase() === "node_modules" && path.basename(parent).startsWith("@")) {
    return path.dirname(parent);
  }
  return undefined;
}

function allowedDependencyRoots(packageRoot) {
  const roots = [];
  const containing = containingNodeModules(packageRoot);
  for (const [candidate, boundary] of [
    [path.join(packageRoot, "node_modules"), packageRoot],
    [containing, containing],
  ]) {
    if (!candidate || !boundary) continue;
    try {
      const root = canonicalPath(candidate);
      if (isPathInside(root, boundary) && fs.statSync(root).isDirectory() && !roots.includes(root)) roots.push(root);
    } catch {
      // A dependency root that is absent, unreadable, or escaped is not trusted.
    }
  }
  return roots;
}

function trustedEntrypoint(packageRoot, relativePath) {
  const entrypoint = canonicalPath(path.join(packageRoot, ...relativePath.split("/")));
  if (!isPathInside(entrypoint, packageRoot) || !fs.statSync(entrypoint).isFile()) throw new Error("entrypoint unavailable");
  return entrypoint;
}

function trustedJitiApi(packageRoot) {
  const piccManifestPath = canonicalPath(path.join(packageRoot, "package.json"));
  if (!isPathInside(piccManifestPath, packageRoot) || !fs.statSync(piccManifestPath).isFile()) {
    throw new Error("PiCC manifest unavailable");
  }
  const piccManifest = JSON.parse(fs.readFileSync(piccManifestPath, "utf8"));
  const declarations = [piccManifest?.dependencies?.jiti, piccManifest?.devDependencies?.jiti]
    .filter((value) => value !== undefined);

  for (const root of allowedDependencyRoots(packageRoot)) {
    try {
      const resolver = createRequire(path.join(root, ".picc-loader.cjs"));
      const manifestPath = canonicalPath(resolver.resolve("jiti/package.json"));
      const owner = canonicalPath(path.dirname(manifestPath));
      if (!isPathInside(owner, root) || !isPathInside(manifestPath, owner)) continue;
      if (!fs.statSync(owner).isDirectory() || !fs.statSync(manifestPath).isFile()) continue;

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const staticExport = manifest?.exports?.["./static"]?.import;
      if (manifest?.name !== "jiti" || declarations.length === 0 || !declarations.every((version) => version === manifest.version)) continue;
      if (typeof staticExport !== "string" || !staticExport.startsWith("./")) continue;
      const api = canonicalPath(path.join(owner, staticExport));
      if (!isPathInside(api, owner) || !fs.statSync(api).isFile()) continue;
      return api;
    } catch {
      // Resolve and validate every authorized root independently; a bad shadow must not hide a valid hoist.
    }
  }
  throw new Error("loader unavailable");
}

function reportSelectionFailure(selection, installationKind, output) {
  if (installationKind === "source") {
    output.error(`PiCC plugin inventory: ${selection.reason}`);
    return;
  }
  const state = selection.category === "missing" ? "missing" : selection.category === "version-mismatch" ? "version-incoherent" : "damaged";
  output.error(`PiCC plugin inventory: The installed PiCC runtime is ${state}. TypeScript source was not used. Run \`picc update\`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.`);
}

export async function runPackagedPluginCommand({ packageRoot, argv, output = console }) {
  const installationKind = classifyInstallation({ packageRoot });
  let selection;
  try {
    selection = selectPiccRuntime({ packageRoot, installationKind });
  } catch {
    output.error(UNAVAILABLE);
    return 1;
  }
  if (!selection.ok) {
    reportSelectionFailure(selection, installationKind, output);
    return 1;
  }
  if (selection.notice) output.error(selection.notice.message);

  setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
  try {
    const entrypoint = trustedEntrypoint(packageRoot, selection.entries.pluginInventoryPath);
    if (selection.mode === "compiled") {
      const loaded = await import(pathToFileURL(entrypoint).href);
      if (typeof loaded?.runPluginInventoryCli !== "function") throw new Error("entrypoint API unavailable");
      return loaded.runPluginInventoryCli(argv, output);
    }

    const loaderApi = trustedJitiApi(packageRoot);
    const loader = await import(pathToFileURL(loaderApi).href);
    if (typeof loader.createJiti !== "function") throw new Error("loader API unavailable");
    const jiti = loader.createJiti(pathToFileURL(entrypoint).href, {
      fsCache: false,
      moduleCache: false,
      tsconfigPaths: false,
      tryNative: false,
    });
    const loaded = await jiti.import(pathToFileURL(entrypoint).href);
    if (typeof loaded?.runPluginInventoryCli !== "function") throw new Error("entrypoint API unavailable");
    return loaded.runPluginInventoryCli(argv, output);
  } catch {
    output.error(UNAVAILABLE);
    return 1;
  }
}
