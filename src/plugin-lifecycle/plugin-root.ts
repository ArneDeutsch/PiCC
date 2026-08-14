import { normalizePortableRelativePath } from "./source-matrix.js";

export type PluginRootRequest =
  | { readonly kind: "tree-root" }
  | { readonly kind: "relative-subtree"; readonly path: string }
  | { readonly kind: "root-or-single-wrapper" };

export interface PluginRootSelection {
  readonly requested: PluginRootRequest["kind"];
  readonly path: string;
  readonly usedSingleWrapper: boolean;
}

export type PluginRootSelectionResult =
  | { readonly ok: true; readonly value: PluginRootSelection }
  | { readonly ok: false; readonly reason: string };

function hasDirectory(paths: ReadonlyMap<string, "directory" | "file">, candidate: string): boolean {
  return candidate.length === 0 || paths.get(candidate) === "directory";
}

export function selectPluginRoot(
  paths: ReadonlyMap<string, "directory" | "file">,
  request: PluginRootRequest,
): PluginRootSelectionResult {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, reason: "Plugin root request is invalid" };
  }
  const prototype = Object.getPrototypeOf(request);
  const descriptors = Object.getOwnPropertyDescriptors(request);
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(request).length > 0
    || Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) {
    return { ok: false, reason: "Plugin root request is invalid" };
  }
  const keys = Object.keys(request);
  if ((request.kind === "relative-subtree" && (keys.length !== 2 || !keys.includes("path")))
    || (request.kind !== "relative-subtree" && keys.length !== 1)
    || !keys.includes("kind")) {
    return { ok: false, reason: "Plugin root request is invalid" };
  }
  if (request.kind === "tree-root") {
    return { ok: true, value: Object.freeze({ requested: request.kind, path: "", usedSingleWrapper: false }) };
  }
  if (request.kind === "relative-subtree") {
    const normalized = normalizePortableRelativePath(request.path);
    return normalized !== undefined && hasDirectory(paths, normalized)
      ? { ok: true, value: Object.freeze({ requested: request.kind, path: normalized, usedSingleWrapper: false }) }
      : { ok: false, reason: "Requested plugin root is not a validated directory" };
  }

  if (request.kind !== "root-or-single-wrapper") return { ok: false, reason: "Plugin root request is invalid" };
  if (hasDirectory(paths, ".claude-plugin") && paths.has(".claude-plugin")) {
    return { ok: true, value: Object.freeze({ requested: request.kind, path: "", usedSingleWrapper: false }) };
  }
  const topLevel = new Set<string>();
  for (const entryPath of paths.keys()) topLevel.add(entryPath.split("/", 1)[0]!);
  if (topLevel.size !== 1) return { ok: false, reason: "Archive does not contain exactly one plugin wrapper" };
  const wrapper = [...topLevel][0]!;
  if (!hasDirectory(paths, wrapper) || paths.get(`${wrapper}/.claude-plugin`) !== "directory") {
    return { ok: false, reason: "Archive plugin marker is missing or nested too deeply" };
  }
  return { ok: true, value: Object.freeze({ requested: request.kind, path: wrapper, usedSingleWrapper: true }) };
}
