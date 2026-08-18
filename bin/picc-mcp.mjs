import fs from "node:fs";
import { createRequire, setSourceMapsSupport } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalPath, classifyInstallation, isPathInside } from "./picc-admin.mjs";
import { selectPiccRuntime } from "./picc-runtime.mjs";

const UNAVAILABLE = "PiCC MCP administration is unavailable in this build. Update or reinstall PiCC.";

function containingNodeModules(packageRoot) {
  const parent = path.dirname(packageRoot);
  if (path.basename(parent).toLowerCase() === "node_modules") return parent;
  if (path.basename(path.dirname(parent)).toLowerCase() === "node_modules" && path.basename(parent).startsWith("@")) return path.dirname(parent);
  return undefined;
}
function dependencyRoots(packageRoot) {
  const roots = []; const containing = containingNodeModules(packageRoot);
  for (const [candidate, boundary] of [[path.join(packageRoot, "node_modules"), packageRoot], [containing, containing]]) {
    if (!candidate || !boundary) continue;
    try { const root = canonicalPath(candidate); if (isPathInside(root, boundary) && fs.statSync(root).isDirectory() && !roots.includes(root)) roots.push(root); } catch {}
  }
  return roots;
}
function trustedEntry(packageRoot, relative) { const target = canonicalPath(path.join(packageRoot, ...relative.split("/"))); if (!isPathInside(target, packageRoot) || !fs.statSync(target).isFile()) throw new Error(); return target; }
function trustedJiti(packageRoot) {
  const manifest = JSON.parse(fs.readFileSync(trustedEntry(packageRoot, "package.json"), "utf8")); const declared = [manifest?.dependencies?.jiti, manifest?.devDependencies?.jiti].filter((value) => value !== undefined);
  for (const root of dependencyRoots(packageRoot)) try { const resolver = createRequire(path.join(root, ".picc-loader.cjs")); const manifestPath = canonicalPath(resolver.resolve("jiti/package.json")); const owner = canonicalPath(path.dirname(manifestPath)); const value = JSON.parse(fs.readFileSync(manifestPath, "utf8")); const entry = value?.exports?.["./static"]?.import; if (!isPathInside(owner, root) || value?.name !== "jiti" || declared.length === 0 || !declared.every((version) => version === value.version) || typeof entry !== "string" || !entry.startsWith("./")) continue; const api = canonicalPath(path.join(owner, entry)); if (isPathInside(api, owner) && fs.statSync(api).isFile()) return api; } catch {}
  throw new Error();
}
function selectionFailure(selection, kind, output) { if (kind === "source") output.error(`PiCC MCP administration: ${selection.reason}`); else { const state = selection.category === "missing" ? "missing" : selection.category === "version-mismatch" ? "version-incoherent" : "damaged"; output.error(`PiCC MCP administration: The installed PiCC runtime is ${state}. TypeScript source was not used. Run \`picc update\`; if PiCC is managed by another installation owner, repair or reinstall it through that owner.`); } }

export async function runPackagedMcpCommand({ packageRoot, argv, output = console }) {
  const kind = classifyInstallation({ packageRoot }); let selection;
  try { selection = selectPiccRuntime({ packageRoot, installationKind: kind }); } catch { output.error(UNAVAILABLE); return 1; }
  if (!selection.ok) { selectionFailure(selection, kind, output); return 1; }
  if (selection.notice) output.error(selection.notice.message);
  setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
  try {
    const entry = trustedEntry(packageRoot, selection.entries.mcpAdministrationPath);
    let loaded;
    if (selection.mode === "compiled") loaded = await import(pathToFileURL(entry).href);
    else { const loader = await import(pathToFileURL(trustedJiti(packageRoot)).href); if (typeof loader.createJiti !== "function") throw new Error(); const jiti = loader.createJiti(pathToFileURL(entry).href, { fsCache: false, moduleCache: false, tsconfigPaths: false, tryNative: false }); loaded = await jiti.import(pathToFileURL(entry).href); }
    if (typeof loaded?.runMcpAdministrationCli !== "function") throw new Error();
    return await loaded.runMcpAdministrationCli(argv, output);
  } catch { output.error(UNAVAILABLE); return 1; }
}
