import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type FormattingOptions, type ParseError } from "jsonc-parser";
import { loadSettings, type LoadedClaudeSettings, type OrdinarySettingsProbeResult } from "../discovery/settings.js";
import { defaultManagedPolicyDescription, type ManagedDirectoryRead, type ManagedFileRead, type ManagedPolicyIo } from "../discovery/managed-policy.js";
import { isQualifiedPluginId } from "../discovery/managed-policy.js";
import {
  isDocumentedMarketplaceName,
  normalizeMarketplaceRegistrationRecord,
} from "../util/plugin-marketplace-descriptor.js";
import { projectIdentities } from "../util/project-identity.js";
import type { PluginMarketplaceRegistrationSource, Scope } from "../types.js";
import { checkoutFamilyLocationKey, lifecycleSettingsTarget, type LifecycleLocationInputs } from "./locations.js";
import { sha256, type StoreResult } from "./state-store.js";
import type { LifecycleSettingsTarget, MutablePluginScope, Sha256 } from "./types.js";

const SETTINGS_BYTE_LIMIT = 1024 * 1024;

export type PluginSettingsMutation =
  | { readonly kind: "enabled-plugin"; readonly key: string; readonly value?: boolean }
  | { readonly kind: "known-marketplace"; readonly key: string; readonly value?: PluginMarketplaceRegistrationSource };

export interface PluginSettingsPlanInputs extends LifecycleLocationInputs {
  readonly scope: MutablePluginScope;
  readonly projectRoot?: string;
  readonly cwd?: string;
  readonly managedPaths?: readonly string[];
  readonly managedPolicy?: Omit<import("../discovery/managed-policy.js").ManagedPolicyDiscoveryOptions, "io" | "overridePaths">;
  readonly mutation: PluginSettingsMutation;
  readonly declarationOnly?: boolean;
}

export interface SettingsValueState {
  readonly present: boolean;
  readonly value?: boolean | PluginMarketplaceRegistrationSource;
  readonly scope?: Scope;
  readonly source?: string;
}

export interface PluginSettingsEffectSummary {
  readonly scope: MutablePluginScope;
  readonly targetPath: string;
  readonly setting: "enabledPlugins" | "extraKnownMarketplaces";
  readonly key: string;
  readonly requested: boolean | PluginMarketplaceRegistrationSource | null;
  readonly declarationBefore: SettingsValueState;
  readonly declarationAfter: SettingsValueState;
  readonly effectiveBefore: SettingsValueState;
  readonly effectiveAfter: SettingsValueState;
  readonly declarationOnly: boolean;
  readonly effective: boolean;
}

export interface SettingsPathAnchor {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

export interface SettingsAuthorityFingerprint {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly status: "absent" | "text" | "unreadable";
  readonly digest?: Sha256;
}

export interface PluginSettingsWritePlan {
  readonly summary: PluginSettingsEffectSummary;
  readonly homePath: string;
  readonly profileKey: string;
  readonly checkoutFamilyKey?: string;
  readonly checkoutFamilyPath?: string;
  readonly activeCheckoutPath?: string;
  readonly targetPath: string;
  readonly precondition: { readonly state: "absent" } | { readonly state: "present"; readonly digest: Sha256 };
  readonly replacementBytes: Uint8Array;
  readonly replacementDigest: Sha256;
  readonly anchors: readonly SettingsPathAnchor[];
  readonly hierarchyAnchors: readonly SettingsPathAnchor[];
  readonly authorityFingerprints: readonly SettingsAuthorityFingerprint[];
  readonly missingParent?: SettingsPathAnchor;
  readonly fileMode?: number;
  readonly targetIdentity?: { readonly dev: string; readonly ino: string };
}

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function equalValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function authenticMarketplaceValue(value: PluginMarketplaceRegistrationSource): Record<string, unknown> {
  if (value.kind === "github") return { source: "github", repo: value.repo, ...(value.ref === undefined ? {} : { ref: value.ref }) };
  if (value.kind === "git") return { source: "git", url: value.url, ...(value.ref === undefined ? {} : { ref: value.ref }) };
  if (value.kind === "url") return { source: "url", url: value.url };
  return { source: value.kind, path: value.path };
}

function normalizedMutation(mutation: PluginSettingsMutation, scope: MutablePluginScope): StoreResult<{ setting: "enabledPlugins" | "extraKnownMarketplaces"; key: string; value: boolean | PluginMarketplaceRegistrationSource | undefined; writeValue: unknown }> {
  if (mutation.kind === "enabled-plugin") {
    if (!isQualifiedPluginId(mutation.key) || (mutation.value !== undefined && typeof mutation.value !== "boolean")) return fail("invalid-setting", "Plugin settings require an exact qualified identity and a literal boolean or removal");
    return { ok: true, value: { setting: "enabledPlugins", key: mutation.key, value: mutation.value, writeValue: mutation.value } };
  }
  if (!isDocumentedMarketplaceName(mutation.key)) return fail("invalid-setting", "Marketplace settings require an exact documented marketplace name");
  if (mutation.value === undefined) return { ok: true, value: { setting: "extraKnownMarketplaces", key: mutation.key, value: undefined, writeValue: undefined } };
  const descriptorValue = authenticMarketplaceValue(mutation.value);
  const writeValue = { source: descriptorValue };
  const observation = normalizeMarketplaceRegistrationRecord(writeValue, scope);
  if (observation.validity !== "valid" || observation.descriptor === undefined || "hostPattern" in observation.descriptor || "pathPattern" in observation.descriptor) return fail("invalid-setting", "Marketplace settings require a normalized credential-free registration descriptor");
  return { ok: true, value: { setting: "extraKnownMarketplaces", key: mutation.key, value: observation.descriptor, writeValue } };
}

function readTarget(target: string): StoreResult<{ bytes?: Buffer; text: string; parsed: Record<string, unknown>; bom: string; mode?: number; targetIdentity?: { readonly dev: string; readonly ino: string } }> {
  try {
    let stat: fs.BigIntStats;
    try { stat = fs.lstatSync(target, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: { text: "{}\n", parsed: {}, bom: "" } };
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !samePath(fs.realpathSync.native(target), target)) return fail("unsafe-target", "Settings target is not an ordinary unaliased file");
    const descriptor = fs.openSync(target, "r"); let bytes: Buffer;
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== stat.dev || opened.ino !== stat.ino) return fail("unsafe-target", "Settings target identity changed while opening");
      bytes = Buffer.allocUnsafe(Number(opened.size)); let offset = 0;
      while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count; }
      if (offset !== bytes.length) return fail("unreadable-settings", "Settings target changed while being read");
      const after = fs.lstatSync(target, { bigint: true });
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || !samePath(fs.realpathSync.native(target), target)) return fail("unsafe-target", "Settings target changed while being read");
    } finally { fs.closeSync(descriptor); }
    if (bytes.byteLength > SETTINGS_BYTE_LIMIT) return fail("bounded-data", "Settings target exceeds the supported byte limit");
    const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bom === "" ? 0 : 3)); }
    catch { return fail("malformed-settings", "Settings target is not valid UTF-8 JSONC text"); }
    if (text.includes("\u0000")) return fail("malformed-settings", "Settings target is not valid UTF-8 JSONC text");
    const errors: ParseError[] = [];
    const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) return fail("malformed-settings", `Settings target is malformed JSONC (${printParseErrorCode(errors[0]!.error)})`);
    if (!plain(parsed)) return fail("non-object-settings", "Settings target must contain one top-level object");
    return { ok: true, value: { bytes, text, parsed, bom, mode: Number(stat.mode & 0o777n), targetIdentity: Object.freeze({ dev: stat.dev.toString(), ino: stat.ino.toString() }) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES" || (error as NodeJS.ErrnoException).code === "EPERM") return fail("unreadable-settings", "Settings target is unreadable");
    return fail("unreadable-settings", "Settings target could not be read safely");
  }
}

function formatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /(?:^|\r?\n)([\t ]+)\S/.exec(text)?.[1] ?? "  ";
  return indent.includes("\t") ? { insertSpaces: false, tabSize: 1, eol } : { insertSpaces: true, tabSize: Math.max(1, indent.length), eol };
}

function marketplaceEntrySupported(entry: unknown): boolean {
  if (entry === undefined) return true;
  if (!plain(entry) || Object.keys(entry).some((key) => key !== "source" && key !== "autoUpdate") || (entry.autoUpdate !== undefined && typeof entry.autoUpdate !== "boolean") || !plain(entry.source)) return false;
  return Object.keys(entry.source).every((key) => ["source", "repo", "ref", "url", "path", "skipLfs"].includes(key))
    && (entry.source.skipLfs === undefined || typeof entry.source.skipLfs === "boolean");
}

export function renderPluginSettingsEdit(original: Uint8Array | undefined, scope: MutablePluginScope, mutation: PluginSettingsMutation): StoreResult<Buffer> {
  const normalized = normalizedMutation(mutation, scope); if (!normalized.ok) return normalized;
  const current: StoreResult<{ text: string; parsed: Record<string, unknown>; bom: string }> = original === undefined ? { ok: true, value: { text: "{}\n", parsed: {}, bom: "" } } : readTargetBytes(original); if (!current.ok) return current;
  const container = current.value.parsed[normalized.value.setting];
  if (container !== undefined && !plain(container)) return fail("malformed-setting", `Settings field "${normalized.value.setting}" must be an object before it can be edited`);
  if (normalized.value.setting === "extraKnownMarketplaces" && plain(container) && !marketplaceEntrySupported(container[normalized.value.key])) return fail("unsupported-marketplace-entry", "Selected marketplace entry contains unsupported or sensitive fields");
  try {
    let updated = current.value.text;
    const apply = (segments: string[], value: unknown): void => { updated = applyEdits(updated, modify(updated, segments, value, { formattingOptions: formatting(updated), isArrayInsertion: false })); };
    if (normalized.value.setting !== "extraKnownMarketplaces" || normalized.value.writeValue === undefined || !plain(container) || container[normalized.value.key] === undefined) {
      apply([normalized.value.setting, normalized.value.key], normalized.value.writeValue);
    } else {
      const desired = (normalized.value.writeValue as { source: Record<string, unknown> }).source;
      const existing = (container[normalized.value.key] as { source: Record<string, unknown> }).source;
      for (const key of ["source", "repo", "ref", "url", "path"] as const) if (Object.hasOwn(existing, key) && !Object.hasOwn(desired, key)) apply([normalized.value.setting, normalized.value.key, "source", key], undefined);
      for (const key of ["source", "repo", "ref", "url", "path"] as const) if (Object.hasOwn(desired, key)) apply([normalized.value.setting, normalized.value.key, "source", key], desired[key]);
    }
    const errors: ParseError[] = []; const parsed = parse(updated, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0 || !plain(parsed)) return fail("formatting-failure", "JSONC editing did not produce a valid settings object");
    return { ok: true, value: Buffer.concat([current.value.bom === "" ? Buffer.alloc(0) : Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(updated, "utf8")]) };
  } catch { return fail("formatting-failure", "JSONC editing could not preserve the settings document"); }
}

function readTargetBytes(bytesInput: Uint8Array): StoreResult<{ text: string; parsed: Record<string, unknown>; bom: string }> {
  const bytes = Buffer.from(bytesInput); if (bytes.byteLength > SETTINGS_BYTE_LIMIT) return fail("bounded-data", "Settings target exceeds the supported byte limit");
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\uFEFF" : "";
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(bom === "" ? 0 : 3)); } catch { return fail("malformed-settings", "Settings target is not valid UTF-8 JSONC text"); }
  const errors: ParseError[] = []; const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || text.includes("\u0000")) return fail("malformed-settings", `Settings target is malformed JSONC${errors[0] === undefined ? "" : ` (${printParseErrorCode(errors[0].error)})`}`);
  if (!plain(parsed)) return fail("non-object-settings", "Settings target must contain one top-level object");
  return { ok: true, value: { text, parsed, bom } };
}

function registrationDescriptor(value: unknown, scope: Scope): PluginMarketplaceRegistrationSource | undefined {
  const normalized = normalizeMarketplaceRegistrationRecord(value, scope); const descriptor = normalized.descriptor;
  return normalized.validity === "valid" && descriptor !== undefined && descriptor.kind !== "hostPattern" && descriptor.kind !== "pathPattern" ? descriptor : undefined;
}

function targetDeclaration(parsed: Record<string, unknown>, setting: string, key: string, scope: MutablePluginScope, source: string): SettingsValueState {
  const container = parsed[setting];
  if (!plain(container) || !Object.hasOwn(container, key)) return { present: false };
  const value = container[key];
  if (setting === "enabledPlugins") return typeof value === "boolean" ? { present: true, value, scope, source } : { present: false };
  const descriptor = registrationDescriptor(value, scope);
  return descriptor === undefined ? { present: false } : { present: true, value: descriptor, scope, source };
}

function marketplaceEffective(settings: LoadedClaudeSettings, key: string): SettingsValueState {
  let state: SettingsValueState = { present: false };
  for (const contribution of settings.pluginMarketplaceSettings ?? []) {
    const observation = contribution.extraKnownMarketplaces?.[key];
    const descriptor = registrationDescriptor(observation, contribution.scope);
    if (descriptor !== undefined) state = { present: true, value: descriptor, scope: contribution.scope, source: contribution.sourcePath };
  }
  return state;
}

function effective(settings: LoadedClaudeSettings, setting: string, key: string): SettingsValueState {
  if (setting === "enabledPlugins") {
    const entry = settings.effectivePluginEnablement?.[key];
    return entry === undefined ? { present: false } : { present: true, value: entry.enabled, scope: entry.scope, source: entry.source };
  }
  return marketplaceEffective(settings, key);
}

function captureAnchors(anchor: string, parent: string): StoreResult<{ readonly anchors: readonly SettingsPathAnchor[]; readonly missingParent?: SettingsPathAnchor }> {
  try {
    const root = path.resolve(anchor); const end = path.resolve(parent); const relative = path.relative(root, end);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return fail("wrong-checkout", "Settings parent is outside the selected active settings anchor");
    const paths = [root, ...relative.split(path.sep).filter(Boolean).map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1)))];
    const anchors: SettingsPathAnchor[] = []; let missingParent: SettingsPathAnchor | undefined;
    for (const [index, candidate] of paths.entries()) {
      try { const stat = fs.lstatSync(candidate, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(candidate), candidate)) throw new Error("alias"); anchors.push(Object.freeze({ path: candidate, dev: stat.dev.toString(), ino: stat.ino.toString() })); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || index !== paths.length - 1 || index === 0) throw error;
        const ancestor = anchors.at(-1)!; missingParent = Object.freeze({ path: candidate, dev: ancestor.dev, ino: ancestor.ino });
      }
    }
    return { ok: true, value: Object.freeze({ anchors: Object.freeze(anchors), ...(missingParent === undefined ? {} : { missingParent }) }) };
  } catch { return fail("unsafe-target", "Settings path contains an aliased or unsupported missing component"); }
}

function directoryAnchor(candidate: string): StoreResult<SettingsPathAnchor> {
  try { const resolved = path.resolve(candidate); const stat = fs.lstatSync(resolved, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(resolved), resolved)) return fail("unsafe-target", "Settings hierarchy contains an aliased or nonordinary directory"); return { ok: true, value: Object.freeze({ path: resolved, dev: stat.dev.toString(), ino: stat.ino.toString() }) }; }
  catch { return fail("unsafe-target", "Settings hierarchy identity is unavailable"); }
}

export function selectPluginSettingsTarget(inputs: PluginSettingsPlanInputs, projectRoot: string | undefined): StoreResult<LifecycleSettingsTarget> {
  const target = lifecycleSettingsTarget(inputs, inputs.scope); if (!target.ok) return fail(target.error.code, target.error.message);
  if (inputs.scope !== "local" || projectRoot === undefined || samePath(projectRoot, inputs.homeDir)) return target;
  const main = projectIdentities(projectRoot)[0];
  return main !== undefined && !samePath(main, projectRoot) ? { ok: true, value: Object.freeze({ ...target.value, path: path.join(main, ".claude", "settings.local.json") }) } : target;
}

export async function planPluginSettingsWrite(inputs: PluginSettingsPlanInputs): Promise<StoreResult<PluginSettingsWritePlan>> {
  const normalized = normalizedMutation(inputs.mutation, inputs.scope); if (!normalized.ok) return normalized;
  const projectRoot = inputs.projectRoot === undefined ? undefined : path.resolve(inputs.projectRoot);
  const cwd = path.resolve(inputs.cwd ?? projectRoot ?? process.cwd());
  if (projectRoot === undefined || inputs.project === undefined) return fail("wrong-checkout", "Settings planning requires the active project root and checkout identity");
  const identities = projectIdentities(projectRoot); const active = identities.at(-1); const family = identities[0];
  if (active === undefined || family === undefined || !samePath(active, inputs.project.activeCheckoutPath) || !samePath(family, inputs.project.checkoutFamilyPath)) return fail("wrong-checkout", "Project identity no longer matches the selected active checkout");
  const relativeCwd = path.relative(active, cwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) return fail("wrong-checkout", "Settings cwd is outside the active checkout");
  const homePath = path.resolve(inputs.homeDir); const profilePath = path.resolve(inputs.profilePath);
  const hierarchyPaths = [homePath, profilePath, family, active];
  const hierarchyAnchors: SettingsPathAnchor[] = [];
  for (const candidate of hierarchyPaths) { if (hierarchyAnchors.some((item) => samePath(item.path, candidate))) continue; const captured = directoryAnchor(candidate); if (!captured.ok) return captured; hierarchyAnchors.push(captured.value); }
  const targetResult = selectPluginSettingsTarget(inputs, projectRoot); if (!targetResult.ok) return targetResult;
  const linkedMain = inputs.scope === "local" && projectRoot !== undefined && !samePath(projectRoot, inputs.homeDir) ? projectIdentities(projectRoot)[0] : undefined;
  const target = targetResult.value;
  const parent = path.dirname(target.path); const anchor = target.scope === "user" ? path.resolve(inputs.profilePath) : inputs.scope === "local" && linkedMain !== undefined ? linkedMain : target.activeCheckoutPath;
  const anchors = captureAnchors(anchor, parent); if (!anchors.ok) return anchors;
  const current = readTarget(target.path); if (!current.ok) return current;
  const replacement = renderPluginSettingsEdit(current.value.bytes, inputs.scope, inputs.mutation); if (!replacement.ok) return replacement;

  interface CapturedFile { readonly probe: OrdinarySettingsProbeResult; readonly fingerprint: SettingsAuthorityFingerprint; readonly bytes?: Buffer }
  interface CapturedDirectory { readonly read: ManagedDirectoryRead; readonly fingerprint: SettingsAuthorityFingerprint }
  const capturedFiles = new Map<string, CapturedFile>(); const capturedDirectories = new Map<string, CapturedDirectory>();
  let capturedBytes = current.value.bytes?.byteLength ?? 0; let captureFailure: StoreResult<never> | undefined;
  const captureFile = (filePath: string): CapturedFile => {
    const resolved = path.resolve(filePath); const memo = capturedFiles.get(resolved); if (memo !== undefined) return memo;
    let captured: CapturedFile;
    try {
      const pathname = fs.lstatSync(resolved, { bigint: true });
      if (!pathname.isFile() || pathname.isSymbolicLink() || pathname.nlink !== 1n || !samePath(fs.realpathSync.native(resolved), resolved)) throw new Error("ordinary");
      const descriptor = fs.openSync(resolved, "r"); let bytes: Buffer;
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== pathname.dev || opened.ino !== pathname.ino || opened.size > BigInt(SETTINGS_BYTE_LIMIT)) throw new Error("ordinary");
        bytes = Buffer.allocUnsafe(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count; }
        const after = fs.lstatSync(resolved, { bigint: true });
        if (offset !== bytes.length || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || !samePath(fs.realpathSync.native(resolved), resolved)) throw new Error("changed");
      } finally { fs.closeSync(descriptor); }
      capturedBytes += bytes.byteLength;
      if (capturedFiles.size >= 64 || capturedBytes > SETTINGS_BYTE_LIMIT) { captureFailure = fail("bounded-data", "Settings authority snapshot exceeds supported evidence bounds"); throw new Error("bounded"); }
      captured = Object.freeze({ probe: Object.freeze({ status: "text", text: bytes.toString("utf8") }), fingerprint: Object.freeze({ path: resolved, kind: "file", status: "text", digest: sha256(bytes) }), bytes });
    } catch (error) {
      const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
      captured = Object.freeze({ probe: Object.freeze({ status: absent ? "absent" : "unreadable" }), fingerprint: Object.freeze({ path: resolved, kind: "file", status: absent ? "absent" : "unreadable" }) });
      if (!absent && captureFailure === undefined) captureFailure = fail("indeterminate-precedence", "A settings authority could not be captured as one stable ordinary file snapshot");
    }
    capturedFiles.set(resolved, captured); return captured;
  };
  if (current.value.bytes === undefined) capturedFiles.set(path.resolve(target.path), Object.freeze({ probe: Object.freeze({ status: "absent" }), fingerprint: Object.freeze({ path: path.resolve(target.path), kind: "file", status: "absent" }) }));
  else capturedFiles.set(path.resolve(target.path), Object.freeze({ probe: Object.freeze({ status: "text", text: current.value.bytes.toString("utf8") }), fingerprint: Object.freeze({ path: path.resolve(target.path), kind: "file", status: "text", digest: sha256(current.value.bytes) }), bytes: current.value.bytes }));
  const actualProbe = (filePath: string): OrdinarySettingsProbeResult => captureFile(filePath).probe;
  const replacementProbe = (filePath: string): OrdinarySettingsProbeResult => samePath(filePath, target.path)
    ? { status: "text", text: Buffer.from(replacement.value).subarray(current.value.bom === "" ? 0 : 3).toString("utf8") }
    : captureFile(filePath).probe;
  const policyPlatform: NodeJS.Platform = inputs.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const policyDescription = inputs.managedPolicy?.description ?? defaultManagedPolicyDescription(policyPlatform);
  const managedIo: ManagedPolicyIo = {
    readFile(filePath): ManagedFileRead { const observed = captureFile(filePath).probe; return observed.status === "text" ? { status: "present", text: observed.text } : observed; },
    listJsonFiles(directory): ManagedDirectoryRead {
      const resolved = path.resolve(directory); const memo = capturedDirectories.get(resolved); if (memo !== undefined) return memo.read;
      let captured: CapturedDirectory;
      try {
        const before = fs.lstatSync(resolved, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink() || !samePath(fs.realpathSync.native(resolved), resolved)) throw new Error("ordinary");
        const names = fs.readdirSync(resolved, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.toLowerCase().endsWith(".json")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, "en"));
        const after = fs.lstatSync(resolved, { bigint: true });
        if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || names.length > 64 || capturedDirectories.size >= 16) throw new Error("changed-or-bounded");
        const digest = sha256(Buffer.from(JSON.stringify(names), "utf8"));
        captured = Object.freeze({ read: Object.freeze({ status: "present", files: names.map((name) => path.join(resolved, name)) }), fingerprint: Object.freeze({ path: resolved, kind: "directory", status: "text", digest }) });
      } catch (error) {
        const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
        captured = Object.freeze({ read: Object.freeze({ status: absent ? "absent" : "unreadable" }), fingerprint: Object.freeze({ path: resolved, kind: "directory", status: absent ? "absent" : "unreadable" }) });
        if (!absent && captureFailure === undefined) captureFailure = fail("indeterminate-precedence", "A managed settings listing could not be captured as one stable ordinary directory snapshot");
      }
      capturedDirectories.set(resolved, captured); return captured.read;
    },
  };
  const loadOptions = { cwd, projectRoot: projectRoot ?? cwd, userDir: path.resolve(inputs.profilePath), managedPolicy: { ...inputs.managedPolicy, platform: inputs.managedPolicy?.platform ?? policyPlatform, description: policyDescription, io: managedIo }, ...(inputs.managedPaths === undefined ? {} : { managedPaths: [...inputs.managedPaths] }) };
  const before = loadSettings({ ...loadOptions, ordinarySettingsProbe: actualProbe }); const after = loadSettings({ ...loadOptions, ordinarySettingsProbe: replacementProbe });
  if ((before.retentionCleanupBlockers ?? []).length > 0 || (after.retentionCleanupBlockers ?? []).length > 0) return fail("indeterminate-precedence", "An unreadable or malformed settings authority prevents an exact effective-state prediction");
  if (normalized.value.setting === "extraKnownMarketplaces" && ((before.pluginMarketplaceSettingsOmissions?.contributions ?? 0) > 0 || (before.pluginMarketplaceSettingsOmissions?.declarations ?? 0) > 0 || (after.pluginMarketplaceSettingsOmissions?.contributions ?? 0) > 0 || (after.pluginMarketplaceSettingsOmissions?.declarations ?? 0) > 0)) return fail("indeterminate-precedence", "Marketplace settings authority was omitted by a bounded projection");
  const declarationBefore = targetDeclaration(current.value.parsed, normalized.value.setting, normalized.value.key, inputs.scope, target.path);
  const afterParsed = parse(Buffer.from(replacement.value).subarray(current.value.bom === "" ? 0 : 3).toString("utf8"), [], { allowTrailingComma: true }) as Record<string, unknown>;
  const declarationAfter = targetDeclaration(afterParsed, normalized.value.setting, normalized.value.key, inputs.scope, target.path);
  const effectiveBefore = effective(before, normalized.value.setting, normalized.value.key); const effectiveAfter = effective(after, normalized.value.setting, normalized.value.key);
  const requested = normalized.value.value ?? null;
  const achieves = normalized.value.value === undefined ? !effectiveAfter.present : effectiveAfter.present && equalValue(effectiveAfter.value, normalized.value.value) && effectiveAfter.scope === inputs.scope && effectiveAfter.source !== undefined && samePath(effectiveAfter.source, target.path);
  if (!achieves && inputs.declarationOnly !== true) return fail("ineffective-declaration", `Requested declaration would not own the effective result (actual scope: ${effectiveAfter.scope ?? "absent"})`);
  const summary: PluginSettingsEffectSummary = Object.freeze({ scope: inputs.scope, targetPath: target.path, setting: normalized.value.setting, key: normalized.value.key, requested,
    declarationBefore: Object.freeze(declarationBefore), declarationAfter: Object.freeze(declarationAfter), effectiveBefore: Object.freeze(effectiveBefore), effectiveAfter: Object.freeze(effectiveAfter), declarationOnly: !achieves, effective: achieves });
  const precondition = current.value.bytes === undefined ? { state: "absent" as const } : { state: "present" as const, digest: sha256(current.value.bytes) };
  if (captureFailure !== undefined) return captureFailure;
  const fingerprints = [...capturedFiles.values()].map((item) => item.fingerprint).filter((item) => !samePath(item.path, target.path));
  fingerprints.push(...[...capturedDirectories.values()].map((item) => item.fingerprint));
  const authorityFingerprints = Object.freeze(fingerprints.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)));
  const familyKey = checkoutFamilyLocationKey(family, inputs.platform); if (!familyKey.ok) return fail(familyKey.error.code, familyKey.error.message);
  return { ok: true, value: Object.freeze({ summary, homePath, profileKey: target.profileKey, checkoutFamilyKey: familyKey.value, checkoutFamilyPath: family, activeCheckoutPath: active,
    targetPath: target.path, precondition, replacementBytes: replacement.value, replacementDigest: sha256(replacement.value), anchors: anchors.value.anchors, hierarchyAnchors: Object.freeze(hierarchyAnchors), authorityFingerprints, ...(anchors.value.missingParent === undefined ? {} : { missingParent: anchors.value.missingParent }), ...(current.value.mode === undefined ? {} : { fileMode: current.value.mode }), ...(current.value.targetIdentity === undefined ? {} : { targetIdentity: current.value.targetIdentity }) }) };
}
