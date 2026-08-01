import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../types.js";
import { parseJsonSafe } from "../util/fs.js";

const MAX_TEXT = 2048;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_NESTING = 64;
const MAX_KEYWORDS = 32;
const MAX_COMPONENTS = 64;
const MAX_DIAGNOSTICS = 32;
const readOnlyCapabilityBrand: unique symbol = Symbol("PluginMetadataReadCapability");

export interface SafePluginManifestProjection {
  readonly manifestName?: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords: readonly string[];
  readonly components: readonly { field: "skills" | "commands" | "agents" | "hooks" | "mcpServers" | "lspServers"; declaration: "path" | "paths" | "object"; count: number }[];
  readonly omissions?: Readonly<{ keywords: number; components: number; diagnostics: number }>;
}

export interface PluginMetadataReadCapability {
  readonly cacheBases: readonly string[];
  readonly [readOnlyCapabilityBrand]: true;
}

function canonicalDirectory(value: string): string | undefined {
  try {
    const canonical = fs.realpathSync.native(value);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch { return undefined; }
}

function contained(root: string, candidate: string, allowEqual = false): boolean {
  const relative = path.relative(root, candidate);
  return (allowEqual && relative === "") || (relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function createPluginMetadataReadCapability(cacheBases: readonly string[]): PluginMetadataReadCapability {
  const bases = [...new Set(cacheBases.map(canonicalDirectory).filter((item): item is string => item !== undefined))].sort();
  return Object.freeze({ cacheBases: Object.freeze(bases), [readOnlyCapabilityBrand]: true as const });
}

function safeText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const text = safeText(value);
  if (text === undefined) return undefined;
  try {
    const parsed = new URL(text);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      ? text : undefined;
  } catch { return undefined; }
}

function author(value: unknown): string | undefined {
  if (typeof value === "string") return safeText(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return safeText((value as Record<string, unknown>)["name"]);
  return undefined;
}

function repository(value: unknown): string | undefined {
  if (typeof value === "string") return safeUrl(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return safeUrl((value as Record<string, unknown>)["url"]);
  return undefined;
}

/** Project only the allowlisted, display-safe fields while the resolver's manifest object is in hand. */
export function projectPluginManifest(manifest: Readonly<Record<string, unknown>>): { projection: SafePluginManifestProjection; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let keywordOmissions = 0;
  let componentOmissions = 0;
  const wrong = (field: string): void => { diagnostics.push({ severity: "warning", message: `Plugin manifest metadata field ${field} has an invalid type or unsafe value and was ignored` }); };
  const optional = (field: string, projector: (value: unknown) => string | undefined): string | undefined => {
    if (!Object.hasOwn(manifest, field)) return undefined;
    const value = projector(manifest[field]);
    if (value === undefined) wrong(field);
    return value;
  };
  const manifestName = optional("name", safeText);
  const version = optional("version", safeText);
  const description = optional("description", safeText);
  const manifestAuthor = optional("author", author);
  const homepage = optional("homepage", safeUrl);
  const repo = optional("repository", repository);
  const license = optional("license", safeText);
  const keywords: string[] = [];
  if (Object.hasOwn(manifest, "keywords")) {
    const raw = manifest["keywords"];
    if (!Array.isArray(raw)) wrong("keywords");
    else {
      keywordOmissions += Math.max(0, raw.length - MAX_KEYWORDS);
      for (const item of raw.slice(0, MAX_KEYWORDS)) {
        const value = safeText(item);
        if (value !== undefined) keywords.push(value); else wrong("keywords");
      }
    }
  }
  const components: Array<{ field: "skills" | "commands" | "agents" | "hooks" | "mcpServers" | "lspServers"; declaration: "path" | "paths" | "object"; count: number }> = [];
  for (const field of ["skills", "commands", "agents", "hooks", "mcpServers", "lspServers"] as const) {
    if (!Object.hasOwn(manifest, field)) continue;
    const raw = manifest[field];
    if (typeof raw === "string") components.push({ field, declaration: "path", count: 1 });
    else if (Array.isArray(raw)) {
      componentOmissions += Math.max(0, raw.length - MAX_COMPONENTS);
      components.push({ field, declaration: "paths", count: Math.min(raw.length, MAX_COMPONENTS) });
    } else if (typeof raw === "object" && raw !== null) components.push({ field, declaration: "object", count: 1 });
    else wrong(field);
  }
  const diagnosticOmissions = Math.max(0, diagnostics.length - MAX_DIAGNOSTICS);
  return {
    projection: Object.freeze({
      ...(manifestName === undefined ? {} : { manifestName }), ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }), ...(manifestAuthor === undefined ? {} : { author: manifestAuthor }),
      ...(homepage === undefined ? {} : { homepage }), ...(repo === undefined ? {} : { repository: repo }),
      ...(license === undefined ? {} : { license }), keywords: Object.freeze(keywords), components: Object.freeze(components.map((item) => Object.freeze({ ...item }))),
      omissions: Object.freeze({ keywords: keywordOmissions, components: componentOmissions, diagnostics: diagnosticOmissions }),
    }),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
  };
}

function readBoundedText(file: string): "too-large" | string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    const bytes = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    return count > MAX_MANIFEST_BYTES ? "too-large" : bytes.subarray(0, count).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* best-effort read cleanup */ }
  }
}

function exceedsNesting(source: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") { depth++; if (depth > MAX_NESTING) return true; }
    else if (character === "}" || character === "]") depth--;
  }
  return false;
}

/** Observe a manifest only after canonical containment beneath an independently branded cache base. */
export function readObservedPluginMetadata(root: string, capability: PluginMetadataReadCapability): { projection?: SafePluginManifestProjection; diagnostics: Diagnostic[] } {
  if (capability[readOnlyCapabilityBrand] !== true || !path.isAbsolute(root)) return { diagnostics: [{ severity: "warning", message: "Observed plugin metadata root was not eligible for read-only inspection" }] };
  const canonicalRoot = canonicalDirectory(root);
  const cacheBase = canonicalRoot === undefined ? undefined : capability.cacheBases.find((base) => contained(base, canonicalRoot));
  if (canonicalRoot === undefined || cacheBase === undefined) return { diagnostics: [{ severity: "warning", message: "Observed plugin metadata root was outside every eligible plugin cache" }] };
  const candidate = path.join(canonicalRoot, ".claude-plugin", "plugin.json");
  let canonicalManifest: string;
  try {
    canonicalManifest = fs.realpathSync.native(candidate);
    if (!fs.statSync(canonicalManifest).isFile() || !contained(canonicalRoot, canonicalManifest) || !contained(cacheBase, canonicalManifest)) {
      return { diagnostics: [{ severity: "warning", message: "Observed plugin manifest escaped its eligible plugin root" }] };
    }
  } catch {
    return { diagnostics: [] };
  }
  const source = readBoundedText(canonicalManifest);
  if (source === "too-large") return { diagnostics: [{ severity: "warning", message: "Observed plugin manifest exceeded the metadata byte limit" }] };
  if (source === undefined) return { diagnostics: [{ severity: "warning", message: "Observed plugin manifest could not be read safely" }] };
  if (exceedsNesting(source)) return { diagnostics: [{ severity: "warning", message: "Observed plugin manifest exceeded the metadata nesting limit" }] };
  const parsed = parseJsonSafe(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { diagnostics: [{ severity: "warning", message: "Observed plugin manifest was malformed" }] };
  return projectPluginManifest(parsed as Record<string, unknown>);
}
