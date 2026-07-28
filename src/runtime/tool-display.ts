import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeDisplayText, themedFg } from "./render-util.js";

export interface DisplayComponent { render(width: number): string[] }
export type DisplayRootResolver = () => unknown;

export type SemanticDisplayTone = "text" | "muted" | "success" | "warning" | "error";

export interface SemanticDisplaySegment {
  readonly text: string;
  readonly tone: SemanticDisplayTone;
}

export interface SemanticDisplayRowOptions {
  readonly action: string;
  readonly primary?: string;
  readonly required?: readonly SemanticDisplaySegment[];
  readonly optional?: readonly string[];
  readonly cue?: string;
  readonly compactCue?: string;
}

export interface DisplayRoots {
  readonly workspace?: string;
  readonly repository?: string;
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  WebFetch: "web fetch",
  WebSearch: "web search",
  MultiEdit: "multi edit",
  TaskOutput: "task output",
  TaskStop: "task stop",
  EnterWorktree: "enter worktree",
  ExitWorktree: "exit worktree",
  SlashCommand: "slash command",
  SendMessage: "send message",
});

/** Format a canonical tool name for human rows without changing operational identity. */
export function formatToolDisplayName(value: unknown): string {
  if (typeof value !== "string") return "";
  const known = DISPLAY_NAMES[value];
  if (known) return known;
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

type PathImplementation = typeof path.posix | typeof path.win32;
interface AbsolutePath {
  readonly implementation: PathImplementation;
  readonly normalized: string;
}

function windowsDevice(value: string): boolean {
  return /^[/\\]+(?:\?{1,2}|\.)[/\\]/u.test(value);
}

function windowsDriveAbsolute(value: string): boolean {
  return /^[A-Za-z]:[/\\]/u.test(value);
}

function windowsDriveRelative(value: string): boolean {
  return /^[A-Za-z]:(?![/\\])/u.test(value);
}

function validUncAuthorityPart(value: string): boolean {
  return value !== "." && value !== ".." && !/[\p{Cc}\p{Cf}<>:"|?*]/u.test(value);
}

function windowsUncAbsolute(value: string): boolean {
  const match = /^[/\\]{2}(?![/\\])([^/\\]+)[/\\]([^/\\]+)(?:[/\\]|$)/u.exec(value);
  return Boolean(match && validUncAuthorityPart(match[1] ?? "") && validUncAuthorityPart(match[2] ?? ""));
}

function ambiguousNamespace(value: string): boolean {
  if (windowsDevice(value) || windowsDriveRelative(value)) return true;
  if (/^[/\\]{2}/u.test(value) && !windowsUncAbsolute(value)) return true;
  return false;
}

function absolutePath(value: unknown): AbsolutePath | undefined {
  if (typeof value !== "string" || value.length === 0 || ambiguousNamespace(value)) return undefined;
  if (windowsDriveAbsolute(value) || windowsUncAbsolute(value)) {
    return { implementation: path.win32, normalized: path.win32.normalize(value) };
  }
  if (path.posix.isAbsolute(value) && !value.startsWith("//")) {
    return { implementation: path.posix, normalized: path.posix.normalize(value) };
  }
  return undefined;
}

function insideRelative(relative: string, implementation: PathImplementation): boolean {
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${implementation.sep}`) &&
    !implementation.isAbsolute(relative));
}

function sameNamespace(left: AbsolutePath, right: AbsolutePath): boolean {
  return left.implementation === right.implementation;
}

function samePath(left: AbsolutePath, right: AbsolutePath): boolean {
  if (!sameNamespace(left, right)) return false;
  return left.implementation === path.win32
    ? left.normalized.toLowerCase() === right.normalized.toLowerCase()
    : left.normalized === right.normalized;
}

function relativeInside(target: AbsolutePath, root: AbsolutePath): string | undefined {
  if (!sameNamespace(target, root)) return undefined;
  const relative = root.implementation.relative(root.normalized, target.normalized);
  return insideRelative(relative, root.implementation) ? relative || "." : undefined;
}

/** Keep genuine relative names distinct from PiCC's generated repository marker. */
export function escapeRepositoryDisplayCollision(value: string): string {
  return value.startsWith("repo:") ? `./${value}` : value;
}

/** Neutralize terminal controls and line separators in an already-classified inline value. */
export function sanitizeInlineDisplay(value: unknown, limit = 16_384): string {
  if (typeof value !== "string" || !Number.isFinite(limit) || limit <= 0) return "";
  let text: string;
  try { text = value.slice(0, Math.floor(limit)); }
  catch { return ""; }
  return text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "�")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu, "�")
    .replace(/\u001b(?:[ -/]*[@-~]?|.)?/gu, "�")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "�");
}

function contextCwd(context: unknown): unknown {
  try { return Reflect.get(context as object, "cwd"); }
  catch { return undefined; }
}

export function isLivePreExecutionDisplayContext(context: unknown): boolean {
  try {
    return Reflect.get(context as object, "argsComplete") === true &&
      Reflect.get(context as object, "executionStarted") === false;
  } catch {
    return false;
  }
}

/** Snapshot validated workspace and repository roots without consulting process cwd. */
export function resolveDisplayRoots(
  workspaceResolver: DisplayRootResolver | undefined,
  repositoryRoot: unknown,
  context: unknown,
): DisplayRoots {
  let workspaceValue = contextCwd(context);
  if (workspaceResolver && isLivePreExecutionDisplayContext(context)) {
    try {
      const resolved = workspaceResolver();
      if (absolutePath(resolved)) workspaceValue = resolved;
    } catch {
      // The supplied render context is the stable fallback.
    }
  }
  const workspace = absolutePath(workspaceValue)?.normalized;
  const repository = absolutePath(repositoryRoot)?.normalized;
  return Object.freeze({ ...(workspace ? { workspace } : {}), ...(repository ? { repository } : {}) });
}

/**
 * Lexically classify an invocation path against an immutable root snapshot.
 * Relative inputs are based only on a valid workspace, never the repository.
 */
export function formatDisplayPathFromRoots(input: unknown, roots: DisplayRoots): string {
  if (typeof input !== "string" || input.length === 0) return typeof input === "string" ? input : "";
  if (ambiguousNamespace(input)) return input;

  try {
    const workspace = absolutePath(roots.workspace);
    const repository = absolutePath(roots.repository);
    const windowsRoot = workspace?.implementation === path.win32 ||
      (!workspace && repository?.implementation === path.win32);
    if (windowsRoot && /^[/\\](?![/\\])/u.test(input)) return input;

    let target = absolutePath(input);
    if (!target) {
      if (!workspace) return escapeRepositoryDisplayCollision(input);
      target = {
        implementation: workspace.implementation,
        normalized: workspace.implementation.resolve(workspace.normalized, input),
      };
    }

    if (workspace) {
      const relative = relativeInside(target, workspace);
      if (relative !== undefined) return escapeRepositoryDisplayCollision(relative);
    }
    if (repository) {
      const relative = relativeInside(target, repository);
      if (relative !== undefined) {
        const rootsDiffer = !workspace || !samePath(workspace, repository);
        return rootsDiffer ? `repo:${relative}` : relative;
      }
    }
    return target.normalized;
  } catch {
    return input;
  }
}

/** Lexically shorten a path only when it is contained by the snapshotted display root. */
export function formatDisplayPath(input: unknown, root: unknown): string {
  return formatDisplayPathFromRoots(input, {
    ...(typeof root === "string" ? { workspace: root } : {}),
  });
}

/** Legacy workspace-only snapshot used by existing specialized renderers. */
export function resolveDisplayRoot(resolver: DisplayRootResolver | undefined, context: unknown): string | undefined {
  if (resolver) {
    try {
      const value = resolver();
      const resolved = absolutePath(value);
      if (resolved) return resolved.normalized;
    } catch {
      // Render-only context fallback below remains safe.
    }
  }
  return absolutePath(contextCwd(context))?.normalized;
}

function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.floor(width);
  try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
  catch { return ""; }
}

function truncatePlain(value: string, width: number): string {
  return truncateToWidth(value, width, "…").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

const SEMANTIC_SCALAR_LIMIT = 2_048;
const SEMANTIC_SEGMENT_LIMIT = 16;
const SEMANTIC_SECOND_LINE_MIN_WIDTH = 8;
const SEMANTIC_SEPARATOR = " · ";
const SEMANTIC_TONES: ReadonlySet<string> = new Set(["text", "muted", "success", "warning", "error"]);

interface SemanticSnapshotSegment {
  readonly text: string;
  readonly tone: SemanticDisplayTone;
}

function semanticScalar(value: unknown): string {
  return typeof value === "string" ? sanitizeDisplayText(value, SEMANTIC_SCALAR_LIMIT, true) : "";
}

function property(value: unknown, key: PropertyKey): unknown {
  try { return Reflect.get(value as object, key); }
  catch { return undefined; }
}

function semanticArray(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) return [];
  const values: unknown[] = [];
  let length = 0;
  try { length = Math.min(Math.max(0, value.length), limit); }
  catch { return values; }
  for (let index = 0; index < length; index++) values.push(property(value, index));
  return values;
}

function semanticTone(value: unknown): SemanticDisplayTone {
  return typeof value === "string" && SEMANTIC_TONES.has(value) ? value as SemanticDisplayTone : "text";
}

function plainSemanticLine(
  action: string,
  primary: string,
  required: readonly SemanticSnapshotSegment[],
  optional: readonly string[],
  cue: string,
): string {
  let line = action;
  if (primary) line += `${action ? " " : ""}${primary}`;
  for (const segment of required) if (segment.text) line += `${line ? SEMANTIC_SEPARATOR : ""}${segment.text}`;
  for (const segment of optional) if (segment) line += `${line ? SEMANTIC_SEPARATOR : ""}${segment}`;
  if (cue) line += `${line ? SEMANTIC_SEPARATOR : ""}${cue}`;
  return line;
}

function styledSemanticLine(
  theme: unknown,
  action: string,
  primary: string,
  required: readonly SemanticSnapshotSegment[],
  optional: readonly string[],
  cue: string,
): string {
  let line = action ? themedFg(theme, "text", action) : "";
  if (primary) line += `${action ? " " : ""}${themedFg(theme, "accent", primary)}`;
  const append = (text: string, tone: SemanticDisplayTone): void => {
    if (line) line += themedFg(theme, "muted", SEMANTIC_SEPARATOR);
    line += themedFg(theme, tone, text);
  };
  for (const segment of required) if (segment.text) append(segment.text, segment.tone);
  for (const segment of optional) if (segment) append(segment, "muted");
  if (cue) append(cue, "muted");
  return line;
}

/** Build a bounded, sanitized overview row with stable semantic color and width priorities. */
export function semanticDisplayRow(options: SemanticDisplayRowOptions, theme: unknown): DisplayComponent {
  const action = semanticScalar(property(options, "action"));
  const primary = semanticScalar(property(options, "primary"));
  const requiredValues = semanticArray(property(options, "required"), SEMANTIC_SEGMENT_LIMIT);
  const required = Object.freeze(requiredValues.map((segment) => Object.freeze({
    text: semanticScalar(property(segment, "text")),
    tone: semanticTone(property(segment, "tone")),
  })));
  const optionalLimit = Math.max(0, SEMANTIC_SEGMENT_LIMIT - required.length);
  const optional = Object.freeze(semanticArray(property(options, "optional"), optionalLimit)
    .map(semanticScalar).filter(Boolean));
  const cue = semanticScalar(property(options, "cue"));
  const compactCue = semanticScalar(property(options, "compactCue"));

  return { render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [""];
    const columns = Math.floor(width);
    if (columns <= 0) return [""];
    try {
      const extras = [...optional];
      const full = () => plainSemanticLine(action, primary, required, extras, cue);
      while (extras.length > 0 && visibleWidth(full()) > columns) extras.pop();

      const fixedInline = plainSemanticLine(action, "", required, extras, cue);
      if (visibleWidth(fixedInline) <= columns) {
        const separatorWidth = primary && action ? 1 : 0;
        const allowance = Math.max(0, columns - visibleWidth(fixedInline) - separatorWidth);
        const fittedPrimary = visibleWidth(primary) > allowance ? truncatePlain(primary, allowance) : primary;
        return [clamp(styledSemanticLine(theme, action, fittedPrimary, required, extras, cue), columns)];
      }

      let secondLineCue = "";
      if (cue && columns >= SEMANTIC_SECOND_LINE_MIN_WIDTH) {
        if (visibleWidth(cue) <= columns) secondLineCue = cue;
        else if (compactCue && visibleWidth(compactCue) <= columns) secondLineCue = compactCue;
      }
      const fixedFirst = plainSemanticLine(action, "", required, [], "");
      const separatorWidth = primary && action ? 1 : 0;
      const allowance = Math.max(0, columns - visibleWidth(fixedFirst) - separatorWidth);
      const fittedPrimary = visibleWidth(primary) > allowance ? truncatePlain(primary, allowance) : primary;
      const first = clamp(styledSemanticLine(theme, action, fittedPrimary, required, [], ""), columns);
      return secondLineCue
        ? [first, clamp(themedFg(theme, "muted", secondLineCue), columns)]
        : [first];
    } catch {
      return [clamp(plainSemanticLine(action, primary, required, optional, cue), columns)];
    }
  } };
}

/** Fit one emphasized elastic field around pinned recovery evidence and optional metadata. */
export function priorityDisplayRow(
  keyword: string,
  elastic: string,
  required: readonly string[],
  optional: readonly string[],
  cue: string,
  theme: unknown,
  elasticSeparator = " ",
): DisplayComponent {
  return { render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [""];
    const columns = Math.floor(width);
    const extras = [...optional];
    let visibleCue = cue;
    const suffix = () => [...required, ...extras, visibleCue].filter(Boolean);
    const fullPlain = () => `${keyword}${elastic ? `${elasticSeparator}${elastic}` : ""}` +
      suffix().map((segment) => ` · ${segment}`).join("");
    try {
      while (extras.length > 0 && visibleWidth(fullPlain()) > columns) extras.pop();
      if (visibleCue && visibleWidth(fullPlain()) > columns) visibleCue = "";

      const requiredPlain = required.filter(Boolean).join(" · ");
      const fixedWidth = visibleWidth(keyword) + suffix().length * visibleWidth(" · ") +
        suffix().reduce((sum, segment) => sum + visibleWidth(segment), 0);
      if (fixedWidth > columns && requiredPlain) {
        return [clamp(themedFg(theme, "toolOutput", requiredPlain), columns)];
      }
      const allowance = Math.max(0, columns - fixedWidth - (elastic ? visibleWidth(elasticSeparator) : 0));
      const fittedElastic = allowance > 0 && elastic
        ? (visibleWidth(elastic) > allowance ? truncatePlain(elastic, allowance) : elastic)
        : "";
      let line = themedFg(theme, "text", keyword);
      if (fittedElastic) line += themedFg(theme, "accent", `${elasticSeparator}${fittedElastic}`);
      for (const segment of required) if (segment) line += themedFg(theme, "toolOutput", ` · ${segment}`);
      for (const segment of extras) if (segment) line += themedFg(theme, "muted", ` · ${segment}`);
      if (visibleCue) line += themedFg(theme, "muted", ` · ${visibleCue}`);
      return [clamp(line, columns)];
    } catch {
      return [clamp(fullPlain(), columns)];
    }
  } };
}
