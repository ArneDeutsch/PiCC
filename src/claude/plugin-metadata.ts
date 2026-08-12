import fs from "node:fs";
import path from "node:path";
import type { Diagnostic, PluginManifestDefaultEnabledEvidence } from "../types.js";
import { parseJsonSafe } from "../util/fs.js";
import { observeUnsupportedPluginComponents } from "./plugin-component-observation.js";

const MAX_TEXT = 2048;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_NESTING = 64;
const MAX_KEYWORDS = 32;
const MAX_COMPONENTS = 64;
const MAX_DEPENDENCIES = 128;
const MAX_DIAGNOSTICS = 32;
const readOnlyCapabilityBrand: unique symbol = Symbol("PluginMetadataReadCapability");

export type SafePluginManifestComponentField =
  | "skills" | "commands" | "agents" | "hooks" | "mcpServers" | "lspServers"
  | "workflows" | "outputStyles" | "themes" | "monitors" | "experimental.themes" | "experimental.monitors" | "channels";

export interface SafePluginManifestDependency {
  readonly name: string;
  readonly version?: string;
  readonly marketplace?: string;
  readonly itemIndex: number;
}

export type PluginDependencyDeclarationEvidence = "absent" | "complete" | "invalid" | "truncated";

export interface SafePluginManifestProjection {
  readonly manifestName?: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords: readonly string[];
  readonly dependencies?: readonly SafePluginManifestDependency[];
  readonly dependencyDeclaration?: PluginDependencyDeclarationEvidence;
  readonly defaultEnabled?: PluginManifestDefaultEnabledEvidence;
  readonly components: readonly { field: SafePluginManifestComponentField; declaration: "path" | "paths" | "object" | "shape"; count: number }[];
  readonly omissions?: Readonly<{ keywords: number; dependencies?: number; components: number; diagnostics: number }>;
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

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dependencyName(value: unknown): string | undefined {
  const candidate = safeText(value);
  return candidate !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)
    ? candidate
    : undefined;
}

/** Project only the allowlisted, display-safe fields while the resolver's manifest object is in hand. */
export function projectPluginManifest(manifest: Readonly<Record<string, unknown>>, sourcePath = "plugin manifest"): { projection: SafePluginManifestProjection; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let keywordOmissions = 0;
  let dependencyOmissions = 0;
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
  const defaultEnabled: PluginManifestDefaultEnabledEvidence = Object.hasOwn(manifest, "defaultEnabled") && typeof manifest["defaultEnabled"] === "boolean"
    ? { presence: "explicit", value: manifest["defaultEnabled"], sourcePath }
    : { presence: "absent", sourcePath };
  if (Object.hasOwn(manifest, "defaultEnabled") && typeof manifest["defaultEnabled"] !== "boolean") wrong("defaultEnabled");
  const dependencies: SafePluginManifestDependency[] = [];
  let dependencyInvalid = false;
  if (Object.hasOwn(manifest, "dependencies")) {
    const raw = manifest["dependencies"];
    if (!Array.isArray(raw)) { wrong("dependencies"); dependencyInvalid = true; }
    else {
      dependencyOmissions += Math.max(0, raw.length - MAX_DEPENDENCIES);
      for (let itemIndex = 0; itemIndex < Math.min(raw.length, MAX_DEPENDENCIES); itemIndex++) {
        const item = raw[itemIndex];
        let name: string | undefined;
        let dependencyVersion: string | undefined;
        let dependencyMarketplace: string | undefined;
        if (typeof item === "string") name = dependencyName(item);
        else if (plain(item) && Object.keys(item).every((key) => key === "name" || key === "version" || key === "marketplace") && Object.hasOwn(item, "name")) {
          name = dependencyName(item["name"]);
          if (Object.hasOwn(item, "version")) dependencyVersion = safeText(item["version"]);
          if (Object.hasOwn(item, "marketplace")) dependencyMarketplace = dependencyName(item["marketplace"]);
        }
        if (name === undefined || (plain(item) && Object.hasOwn(item, "version") && dependencyVersion === undefined) || (plain(item) && Object.hasOwn(item, "marketplace") && dependencyMarketplace === undefined)) { wrong("dependencies"); dependencyInvalid = true; }
        else dependencies.push(Object.freeze({ name, ...(dependencyVersion === undefined ? {} : { version: dependencyVersion }), ...(dependencyMarketplace === undefined ? {} : { marketplace: dependencyMarketplace }), itemIndex }));
      }
    }
  }
  const components: Array<{ field: SafePluginManifestComponentField; declaration: "path" | "paths" | "object" | "shape"; count: number }> = [];
  for (const field of ["skills", "commands", "agents", "hooks", "mcpServers", "lspServers"] as const) {
    if (!Object.hasOwn(manifest, field)) continue;
    const raw = manifest[field];
    if (typeof raw === "string") components.push({ field, declaration: "path", count: 1 });
    else if (Array.isArray(raw)) {
      componentOmissions += Math.max(0, raw.length - MAX_COMPONENTS);
      components.push({ field, declaration: "paths", count: Math.min(raw.length, MAX_COMPONENTS) });
    } else if (plain(raw)) components.push({ field, declaration: "object", count: 1 });
    else wrong(field);
  }
  const unsupported = observeUnsupportedPluginComponents(manifest, {
    maximumItems: MAX_COMPONENTS,
    reportInvalid: (field) => wrong(field),
    reportOmitted: (field) => diagnostics.push({ severity: "warning", message: `Plugin manifest metadata field ${field} nested evidence exceeded observation limits and was omitted` }),
  });
  componentOmissions += unsupported.omittedItems;
  components.push(...unsupported.observations.map(({ field, count }) => ({ field, declaration: "shape" as const, count })));
  const diagnosticOmissions = Math.max(0, diagnostics.length - MAX_DIAGNOSTICS);
  return {
    projection: Object.freeze({
      ...(manifestName === undefined ? {} : { manifestName }), ...(version === undefined ? {} : { version }),
      ...(description === undefined ? {} : { description }), ...(manifestAuthor === undefined ? {} : { author: manifestAuthor }),
      ...(homepage === undefined ? {} : { homepage }), ...(repo === undefined ? {} : { repository: repo }),
      ...(license === undefined ? {} : { license }), keywords: Object.freeze(keywords), defaultEnabled: Object.freeze(defaultEnabled),
      dependencyDeclaration: !Object.hasOwn(manifest, "dependencies") ? "absent" : dependencyOmissions > 0 ? "truncated" : dependencyInvalid ? "invalid" : "complete",
      ...(Object.hasOwn(manifest, "dependencies") ? { dependencies: Object.freeze(dependencies) } : {}),
      components: Object.freeze(components.map((item) => Object.freeze({ ...item }))),
      omissions: Object.freeze({ keywords: keywordOmissions, ...(Object.hasOwn(manifest, "dependencies") ? { dependencies: dependencyOmissions } : {}), components: componentOmissions, diagnostics: diagnosticOmissions }),
    }),
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
  };
}

function readBoundedText(file: string): "too-large" | string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, "r");
    const bytes = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return offset > MAX_MANIFEST_BYTES ? "too-large" : bytes.subarray(0, offset).toString("utf8");
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
