import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { themedFg } from "./render-util.js";

export interface DisplayComponent { render(width: number): string[] }
export type DisplayRootResolver = () => unknown;

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

function windowsNamespace(value: string): boolean {
  return /^[A-Za-z]:/u.test(value) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(value);
}

function insideRelative(relative: string, implementation: typeof path.posix | typeof path.win32): boolean {
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(relative));
}

function windowsResolved(input: string, root: string): string {
  const driveRelative = /^([A-Za-z]):(?![/\\])(.*)$/u.exec(input);
  if (!driveRelative) return path.win32.resolve(root, input);
  const drive = `${driveRelative[1] ?? ""}:`;
  const rootDrive = path.win32.parse(root).root.slice(0, 2);
  return drive.toLowerCase() === rootDrive.toLowerCase()
    ? path.win32.resolve(root, driveRelative[2] ?? "")
    : path.win32.resolve(`${drive}\\`, driveRelative[2] ?? "");
}

/** Lexically shorten a path only when it is contained by the snapshotted display root. */
export function formatDisplayPath(input: unknown, root: unknown): string {
  if (typeof input !== "string" || input.length === 0) return typeof input === "string" ? input : "";
  if (typeof root !== "string" || root.length === 0) return input;
  const unsupportedNamespace = (value: string): boolean =>
    /^[/\\]{2}[?.][/\\]/u.test(value) || (/^[/\\]{2}/u.test(value) && !windowsNamespace(value));
  if (unsupportedNamespace(input) || unsupportedNamespace(root)) return input;
  try {
    const rootIsWindows = windowsNamespace(root);
    if (rootIsWindows) {
      if (path.posix.isAbsolute(input) && !windowsNamespace(input)) return path.posix.normalize(input);
      const base = path.win32.resolve(root);
      const resolved = windowsResolved(input, base);
      const relative = path.win32.relative(base, resolved);
      return insideRelative(relative, path.win32) ? relative || "." : resolved;
    }
    if (windowsNamespace(input)) return windowsResolved(input, path.win32.parse(input).root || "C:\\");
    const base = path.posix.resolve(root);
    const resolved = path.posix.resolve(base, input);
    const relative = path.posix.relative(base, resolved);
    return insideRelative(relative, path.posix) ? relative || "." : resolved;
  } catch {
    return input;
  }
}

export function resolveDisplayRoot(resolver: DisplayRootResolver | undefined, context: unknown): string | undefined {
  if (resolver) {
    try {
      const value = resolver();
      if (typeof value === "string" && value.length > 0 && (path.isAbsolute(value) || windowsNamespace(value))) return value;
    } catch {
      // Render-only context fallback below remains safe.
    }
  }
  try {
    const value = Reflect.get(context as object, "cwd");
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.floor(width);
  try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
  catch { return ""; }
}

/**
 * Fit one elastic secondary field around pinned recovery fields. Optional
 * telemetry disappears first; only the tool keyword receives primary styling.
 */
export function priorityDisplayRow(
  keyword: string,
  elastic: string,
  pinned: readonly string[],
  optional: readonly string[],
  theme: unknown,
  elasticSeparator = " ",
): DisplayComponent {
  return { render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [""];
    const columns = Math.floor(width);
    const extras = [...optional];
    const suffix = () => [...pinned, ...extras].filter(Boolean);
    const fixedPlain = () => [keyword, ...suffix()].filter(Boolean).join(" · ");
    const fullPlain = () => `${keyword}${elastic ? `${elasticSeparator}${elastic}` : ""}` +
      suffix().map((segment) => ` · ${segment}`).join("");
    try {
      while (extras.length > 0 && visibleWidth(fullPlain()) > columns) extras.pop();
      const reserved = visibleWidth(keyword) + (elastic ? visibleWidth(elasticSeparator) : 0) +
        suffix().length * visibleWidth(" · ") +
        suffix().reduce((sum, segment) => sum + visibleWidth(segment), 0);
      const allowance = Math.max(0, columns - reserved);
      const fittedElastic = allowance > 0 && elastic
        ? (visibleWidth(elastic) > allowance ? truncateToWidth(elastic, allowance, "…") : elastic)
        : "";
      let line = themedFg(theme, "text", keyword);
      if (fittedElastic) line += themedFg(theme, "toolOutput", `${elasticSeparator}${fittedElastic}`);
      for (const segment of pinned) if (segment) line += themedFg(theme, "toolOutput", ` · ${segment}`);
      for (const segment of extras) if (segment) line += themedFg(theme, "muted", ` · ${segment}`);
      return [clamp(line, columns)];
    } catch {
      return [clamp(elastic ? fullPlain() : fixedPlain(), columns)];
    }
  } };
}
