import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../types.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;
const authorizedPluginRootBrand: unique symbol = Symbol("AuthorizedPluginRoot");
const claudeUserDirectoryBrand: unique symbol = Symbol("ClaudeUserDirectory");
const validatedPluginPathBrand: unique symbol = Symbol("ValidatedPluginPath");
const pluginDataLocationBrand: unique symbol = Symbol("PluginDataLocation");

export type PluginPathKind = "file" | "directory" | "either";
export type PluginPathInputKind = "explicit" | "generated";
export type PluginPathFailureCode =
  | "invalid-path"
  | "unreadable-path"
  | "path-escape"
  | "wrong-kind"
  | "changed-path"
  | "walk-failure";

export interface PluginPathFailure {
  ok: false;
  code: PluginPathFailureCode;
  diagnostic: Diagnostic;
}

export interface AuthorizedPluginRoot {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [authorizedPluginRootBrand]: true;
}

export interface ClaudeUserDirectory {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [claudeUserDirectoryBrand]: true;
}

export interface ValidatedPluginPath {
  readonly root: AuthorizedPluginRoot;
  readonly inputKind: PluginPathInputKind;
  readonly declaredPath: string;
  readonly relativePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly kind: "file" | "directory";
  readonly [validatedPluginPathBrand]: true;
}

export type PluginPathResult<T> = { ok: true; value: T } | PluginPathFailure;

export interface PluginWalkResult {
  files: ValidatedPluginPath[];
  failures: PluginPathFailure[];
  diagnostics: Diagnostic[];
}

export interface PluginDataLocation {
  readonly qualifiedIdentity: string;
  readonly key: string;
  readonly collisionToken: string;
  readonly userDir: ClaudeUserDirectory;
  readonly lexicalBasePath: string;
  readonly canonicalBasePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [pluginDataLocationBrand]: true;
}

function failure(
  code: PluginPathFailureCode,
  message: string,
  source?: string,
): PluginPathFailure {
  return {
    ok: false,
    code,
    diagnostic: { severity: "warning", message, ...(source === undefined ? {} : { source }) },
  };
}

function realpathNative(value: string): string {
  return fs.realpathSync.native(value);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function actualKind(value: string): "file" | "directory" | undefined {
  try {
    const stat = fs.statSync(value);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
  } catch {
    return undefined;
  }
  return undefined;
}

function validateRelativePath(
  declaredPath: string,
  inputKind: PluginPathInputKind,
): PluginPathResult<string> {
  if (declaredPath.length === 0 || declaredPath.includes("\0")) {
    return failure("invalid-path", "Plugin path is empty or contains a NUL byte");
  }
  if (inputKind === "explicit" && !declaredPath.startsWith("./")) {
    return failure("invalid-path", 'Explicit plugin paths must begin with "./"');
  }
  if (
    declaredPath.startsWith("/") ||
    declaredPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(declaredPath) ||
    /^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(declaredPath) ||
    /^(?:\\|\/)(?:\?\?|GLOBALROOT)(?:\\|\/)/i.test(declaredPath)
  ) {
    return failure("invalid-path", "Plugin path must not use an absolute, rooted, drive, UNC, or device form");
  }

  const portable = declaredPath.replaceAll("\\", "/");
  const withoutPrefix = inputKind === "explicit" ? portable.slice(2) : portable;
  if (inputKind === "explicit" && withoutPrefix === "") {
    return { ok: true, value: "" };
  }
  const parts = withoutPrefix.split("/");
  if (parts.at(-1) === "" && parts.length > 1) parts.pop();
  if (parts.some((part) => part === "..")) {
    return failure("invalid-path", "Plugin path must not contain parent traversal");
  }
  if (parts.some((part) => part === "" || part === ".")) {
    return failure("invalid-path", "Plugin path has a malformed normalized form");
  }
  for (const part of parts) {
    if (part.includes(":")) {
      return failure("invalid-path", "Plugin path must not contain an alternate-data-stream or drive separator");
    }
    if (/[<>"|?*\u0001-\u001f]/.test(part)) {
      return failure("invalid-path", "Plugin path contains characters forbidden in portable Windows paths");
    }
    if (/[. ]$/.test(part)) {
      return failure("invalid-path", "Plugin path segments must not end in a dot or space");
    }
    if (WINDOWS_RESERVED_NAME.test(part)) {
      return failure("invalid-path", "Plugin path contains a reserved Windows device name");
    }
  }
  return { ok: true, value: parts.join(path.sep) };
}

function revalidateDirectoryRoot<T extends AuthorizedPluginRoot | ClaudeUserDirectory>(root: T): PluginPathResult<T> {
  let canonical: string;
  try {
    canonical = realpathNative(root.lexicalPath);
  } catch {
    return failure("unreadable-path", "Authorized plugin root is missing or unreadable", root.lexicalPath);
  }
  if (canonical !== root.canonicalPath || actualKind(canonical) !== "directory") {
    return failure("changed-path", "Authorized plugin root changed after validation", root.lexicalPath);
  }
  return { ok: true, value: root };
}

function isNativeFullyQualifiedAbsolute(value: string): boolean {
  if (process.platform === "win32") {
    if (/^[\\/]{2}[?.][\\/]/.test(value)) return false;
    if (/^[\\/]{1,2}(?:\?\?|GLOBALROOT)[\\/]/i.test(value)) return false;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    return /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(value);
  }
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

export function authorizePluginRoot(rootPath: string): PluginPathResult<AuthorizedPluginRoot> {
  if (rootPath.length === 0 || rootPath.includes("\0") || !isNativeFullyQualifiedAbsolute(rootPath)) {
    return failure("invalid-path", "Installed plugin root must be a native fully-qualified absolute path", rootPath);
  }
  const lexicalPath = path.normalize(rootPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathNative(lexicalPath);
  } catch {
    return failure("unreadable-path", "Installed plugin root is missing or unreadable", lexicalPath);
  }
  if (actualKind(canonicalPath) !== "directory") {
    return failure("wrong-kind", "Installed plugin root is not a directory", lexicalPath);
  }
  return {
    ok: true,
    value: { lexicalPath, canonicalPath, [authorizedPluginRootBrand]: true },
  };
}

function authorizeClaudeUserDirectory(rootPath: string): PluginPathResult<ClaudeUserDirectory> {
  if (rootPath.length === 0 || rootPath.includes("\0") || !isNativeFullyQualifiedAbsolute(rootPath)) {
    return failure("invalid-path", "Claude user directory must be a native fully-qualified absolute path", rootPath);
  }
  const lexicalPath = path.normalize(rootPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathNative(lexicalPath);
  } catch {
    return failure("unreadable-path", "Claude user directory is missing or unreadable", lexicalPath);
  }
  if (actualKind(canonicalPath) !== "directory") {
    return failure("wrong-kind", "Claude user directory is not a directory", lexicalPath);
  }
  return {
    ok: true,
    value: { lexicalPath, canonicalPath, [claudeUserDirectoryBrand]: true },
  };
}

function validateExistingPath(
  root: AuthorizedPluginRoot,
  inputKind: PluginPathInputKind,
  declaredPath: string,
  relativePath: string,
  expectedKind: PluginPathKind,
): PluginPathResult<ValidatedPluginPath> {
  const rootResult = revalidateDirectoryRoot(root);
  if (!rootResult.ok) return rootResult;

  const lexicalPath = path.join(root.lexicalPath, relativePath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathNative(lexicalPath);
  } catch {
    return failure("unreadable-path", "Plugin path is missing, unreadable, or a broken filesystem link", lexicalPath);
  }
  if (!isContained(root.canonicalPath, canonicalPath)) {
    return failure("path-escape", "Plugin path resolves outside the authorized plugin root", lexicalPath);
  }
  const kind = actualKind(canonicalPath);
  if (kind === undefined || (expectedKind !== "either" && kind !== expectedKind)) {
    return failure("wrong-kind", `Plugin path is not a ${expectedKind === "either" ? "regular file or directory" : expectedKind}`, lexicalPath);
  }
  return {
    ok: true,
    value: {
      root,
      inputKind,
      declaredPath,
      relativePath,
      lexicalPath,
      canonicalPath,
      kind,
      [validatedPluginPathBrand]: true,
    },
  };
}

export function resolvePluginPath(options: {
  root: AuthorizedPluginRoot;
  declaredPath: string;
  inputKind: PluginPathInputKind;
  kind: PluginPathKind;
}): PluginPathResult<ValidatedPluginPath> {
  const relative = validateRelativePath(options.declaredPath, options.inputKind);
  if (!relative.ok) return relative;
  return validateExistingPath(
    options.root,
    options.inputKind,
    options.declaredPath,
    relative.value,
    options.kind,
  );
}

// Close-to-use revalidation rejects changes visible during validation, including deterministic
// retargeting, but one replacement can still win the subsequent check/read race. This is not an OS sandbox.
export function revalidatePluginPath(source: ValidatedPluginPath): PluginPathResult<ValidatedPluginPath> {
  const current = validateExistingPath(
    source.root,
    source.inputKind,
    source.declaredPath,
    source.relativePath,
    source.kind,
  );
  if (!current.ok) return current;
  if (current.value.canonicalPath !== source.canonicalPath) {
    return failure("changed-path", "Plugin path target changed after validation", source.lexicalPath);
  }
  return current;
}

export function walkPluginFiles(options: {
  directory: ValidatedPluginPath;
  predicate?: (name: string, source: ValidatedPluginPath) => boolean;
  maxDepth?: number;
}): PluginWalkResult {
  const files: ValidatedPluginPath[] = [];
  const failures: PluginPathFailure[] = [];
  const result = (): PluginWalkResult => ({
    files,
    failures,
    diagnostics: failures.map((item) => item.diagnostic),
  });
  const start = revalidatePluginPath(options.directory);
  if (!start.ok) {
    failures.push(start);
    return result();
  }
  if (start.value.kind !== "directory") {
    failures.push(failure("wrong-kind", "Plugin walker requires a validated directory", start.value.lexicalPath));
    return result();
  }

  const seen = new Set<string>([start.value.canonicalPath]);
  const maxDepth = options.maxDepth ?? 12;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    failures.push(failure("walk-failure", "Plugin walker maxDepth must be a non-negative safe integer", start.value.lexicalPath));
    return result();
  }
  const visit = (directory: ValidatedPluginPath, depth: number): void => {
    if (depth > maxDepth) {
      failures.push(failure(
        "walk-failure",
        `Plugin directory content was skipped because it exceeds maximum traversal depth ${maxDepth}`,
        directory.lexicalPath,
      ));
      return;
    }
    const currentDirectory = revalidatePluginPath(directory);
    if (!currentDirectory.ok) {
      failures.push(currentDirectory);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDirectory.value.lexicalPath, { withFileTypes: true });
    } catch {
      failures.push(failure("walk-failure", "Plugin directory became unreadable while walking", directory.lexicalPath));
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const nativeRelativePath = path.join(directory.relativePath, entry.name);
      const declaredPath = nativeRelativePath.split(path.sep).join("/");
      const portable = validateRelativePath(declaredPath, "generated");
      if (!portable.ok || portable.value !== nativeRelativePath) {
        failures.push(portable.ok
          ? failure("invalid-path", "Discovered plugin path does not have an exact portable representation", path.join(directory.root.lexicalPath, nativeRelativePath))
          : { ...portable, diagnostic: { ...portable.diagnostic, source: path.join(directory.root.lexicalPath, nativeRelativePath) } });
        continue;
      }
      const validated = validateExistingPath(
        directory.root,
        "generated",
        declaredPath,
        nativeRelativePath,
        "either",
      );
      if (!validated.ok) {
        failures.push(validated);
        continue;
      }
      if (validated.value.kind === "directory") {
        if (seen.has(validated.value.canonicalPath)) {
          failures.push(failure("walk-failure", "Plugin directory link forms a traversal loop or duplicate target", validated.value.lexicalPath));
          continue;
        }
        seen.add(validated.value.canonicalPath);
        visit(validated.value, depth + 1);
      } else if (options.predicate?.(entry.name, validated.value) ?? true) {
        files.push(validated.value);
      }
    }
  };
  visit(start.value, 0);
  return result();
}

export function sanitizePluginDataKey(qualifiedIdentity: string): string {
  return qualifiedIdentity.replace(/[^A-Za-z0-9_-]/g, "-");
}

function resolveProjectedPath(
  root: ClaudeUserDirectory,
  segments: readonly string[],
): PluginPathResult<{ lexicalPath: string; canonicalPath: string }> {
  let lexicalPath = root.lexicalPath;
  let canonicalPath = root.canonicalPath;
  let missing = false;
  for (const segment of segments) {
    lexicalPath = path.join(lexicalPath, segment);
    if (!missing) {
      try {
        fs.lstatSync(lexicalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          return failure("unreadable-path", "Plugin data path component is unreadable", lexicalPath);
        }
        missing = true;
      }
      if (!missing) {
        try {
          canonicalPath = realpathNative(lexicalPath);
        } catch {
          return failure("unreadable-path", "Plugin data path contains a broken or unreadable filesystem link", lexicalPath);
        }
        if (!isContained(root.canonicalPath, canonicalPath)) {
          return failure("path-escape", "Plugin data path resolves outside its user directory", lexicalPath);
        }
        if (actualKind(canonicalPath) !== "directory") {
          return failure("wrong-kind", "Existing plugin data path component is not a directory", lexicalPath);
        }
        continue;
      }
    }
    canonicalPath = path.join(canonicalPath, segment);
  }
  return { ok: true, value: { lexicalPath, canonicalPath } };
}

export function resolvePluginDataLocation(
  userDirPath: string,
  qualifiedIdentity: string,
): PluginPathResult<PluginDataLocation> {
  if (!isQualifiedPluginId(qualifiedIdentity)) {
    return failure("invalid-path", "Plugin data location requires a valid qualified plugin identity");
  }
  const key = sanitizePluginDataKey(qualifiedIdentity);
  if (key.length === 0 || key.length > 255 || WINDOWS_RESERVED_NAME.test(key) || /[. ]$/.test(key)) {
    return failure("invalid-path", "Qualified plugin identity must produce a portable data key of at most 255 ASCII characters");
  }
  const userDir = authorizeClaudeUserDirectory(userDirPath);
  if (!userDir.ok) return userDir;
  const projected = resolveProjectedPath(userDir.value, ["plugins", "data", key]);
  if (!projected.ok) return projected;
  const baseProjected = resolveProjectedPath(userDir.value, ["plugins", "data"]);
  if (!baseProjected.ok) return baseProjected;
  if (!isContained(baseProjected.value.canonicalPath, projected.value.canonicalPath) || projected.value.canonicalPath === baseProjected.value.canonicalPath) {
    return failure("path-escape", "Generated plugin data location escapes its data base", projected.value.lexicalPath);
  }
  return {
    ok: true,
    value: {
      qualifiedIdentity,
      key,
      collisionToken: key.toLowerCase(),
      userDir: userDir.value,
      lexicalBasePath: baseProjected.value.lexicalPath,
      canonicalBasePath: baseProjected.value.canonicalPath,
      lexicalPath: projected.value.lexicalPath,
      canonicalPath: projected.value.canonicalPath,
      [pluginDataLocationBrand]: true,
    },
  };
}

export function revalidatePluginDataLocation(
  location: PluginDataLocation,
): PluginPathResult<PluginDataLocation> {
  const current = resolvePluginDataLocation(location.userDir.lexicalPath, location.qualifiedIdentity);
  if (!current.ok) return current;
  if (
    current.value.userDir.canonicalPath !== location.userDir.canonicalPath ||
    current.value.canonicalBasePath !== location.canonicalBasePath ||
    current.value.canonicalPath !== location.canonicalPath
  ) {
    return failure("changed-path", "Plugin data location changed after validation", location.lexicalPath);
  }
  return current;
}
