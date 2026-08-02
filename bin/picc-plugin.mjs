import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, isPathInside } from "./picc-admin.mjs";

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

function trustedEntrypoint(packageRoot) {
  const entrypoint = canonicalPath(path.join(packageRoot, "src", "plugin-inventory-cli.ts"));
  if (!isPathInside(entrypoint, packageRoot) || !fs.statSync(entrypoint).isFile()) throw new Error("entrypoint unavailable");
  return entrypoint;
}

function trustedJitiApi(packageRoot) {
  const piccManifestPath = canonicalPath(path.join(packageRoot, "package.json"));
  if (!isPathInside(piccManifestPath, packageRoot) || !fs.statSync(piccManifestPath).isFile()) {
    throw new Error("PiCC manifest unavailable");
  }
  const piccManifest = JSON.parse(fs.readFileSync(piccManifestPath, "utf8"));

  for (const root of allowedDependencyRoots(packageRoot)) {
    try {
      const resolver = createRequire(path.join(root, ".picc-loader.cjs"));
      const manifestPath = canonicalPath(resolver.resolve("jiti/package.json"));
      const owner = canonicalPath(path.dirname(manifestPath));
      if (!isPathInside(owner, root) || !isPathInside(manifestPath, owner)) continue;
      if (!fs.statSync(owner).isDirectory() || !fs.statSync(manifestPath).isFile()) continue;

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const staticExport = manifest?.exports?.["./static"]?.import;
      if (manifest?.name !== "jiti" || piccManifest?.dependencies?.jiti !== manifest.version) continue;
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

export async function runPackagedPluginCommand({ packageRoot, argv, output = console }) {
  try {
    const entrypoint = trustedEntrypoint(packageRoot);
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
