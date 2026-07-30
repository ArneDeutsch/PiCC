import path from "node:path";
import {
  createEditToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { neutralizePiEditBoxBackground, piToolsExpandKeyText } from "./pi-tui-runtime.js";
import { themedFg } from "./render-util.js";
import {
  formatDisplayPathFromRoots,
  formatToolDisplayName,
  priorityDisplayRow,
  semanticDisplayRow,
  resolveDisplayRoots,
  sanitizeInlineDisplay,
  type DisplayRootResolver,
  type DisplayRoots,
} from "./tool-display.js";

interface Component {
  render(width: number): string[];
}

interface ResultShape {
  content?: unknown;
  details?: unknown;
}

type WebToolName = "WebFetch" | "WebSearch";
type ActivationToolName = "Skill" | "SlashCommand";
type MutationToolName = "edit" | "MultiEdit";
type WorktreeToolName = "EnterWorktree" | "ExitWorktree";
type TaskControlToolName = "TaskCreate" | "TaskUpdate" | "TaskGet";
type RoutineToolName = WebToolName | ActivationToolName | MutationToolName | WorktreeToolName | TaskControlToolName;
type DataSnapshot = Record<string, unknown>;

const MAX_FAIL_OPEN_CHARS = 4_096;
const MAX_FAIL_OPEN_LINES = 16;
// These caps are deliberately above routine use while bounding hostile settled-result preprocessing.
const MAX_MULTI_EDIT_COUNT = 1_000;
const MAX_MULTI_EDIT_PATH_CHARS = 16_384;
const MAX_MULTI_EDIT_DIFF_CHARS = 1_000_000;
const MAX_OVERSIZED_PATH_CHARS = 512;
const MAX_WORKTREE_SEEDED_FILES = 1_000;
const MAX_WORKTREE_DIAGNOSTICS = 1_000;
const MUTATION_CONTROL_PLACEHOLDER = "�";
const LINE_BREAK_RE = /\r\n?|\n|\u2028|\u2029/gu;

function unfamiliarFormatLabel(toolName: RoutineToolName): string {
  return `Unfamiliar ${formatToolDisplayName(toolName)} presentation format`;
}

function ownData(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function plainOwnData(
  value: unknown,
  expectedKeys: readonly string[],
): DataSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length !== expectedKeys.length) {
      return undefined;
    }
    const expected = new Set(expectedKeys);
    const snapshot: DataSnapshot = {};
    for (const key of keys) {
      if (typeof key !== "string" || !expected.has(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function exactStringArray(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): boolean {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || !keys.includes("length")) return false;
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function stripTerminalControls(text: string): string {
  return text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu, "")
    .replace(/\u001b(?:[ -/]*[@-~]?|.)?/gu, "");
}

function sanitizeText(
  value: unknown,
  inline: boolean,
  maxRawChars = MAX_FAIL_OPEN_CHARS,
): string {
  if (typeof value !== "string" || maxRawChars <= 0) return "";
  let text: string;
  try {
    text = value.slice(0, maxRawChars).normalize("NFC");
  } catch {
    return "";
  }
  text = stripTerminalControls(text)
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (character) => {
      if (!inline && character === "\n") return "\n";
      return character === "\t" ? "   " : " ";
    });
  return inline ? text.replace(/\s+/gu, " ").trim() : text;
}

function safeThemeMethod(
  theme: unknown,
  _method: "fg",
  args: readonly string[],
  fallback: string,
): string {
  return themedFg(theme, args[0] ?? "text", args[1] ?? fallback);
}

function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  try {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
  } catch {
    const fallback = sanitizeText(line, true);
    return fallback.slice(0, Math.max(0, Math.floor(width)));
  }
}

interface PriorityEvidence {
  warning: string;
  restoration?: string;
  detail?: string;
}

function structuredRowComponent(
  literals: readonly string[],
  fields: readonly string[],
  theme: unknown,
  priorityEvidence: PriorityEvidence | undefined,
): Component {
  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width <= 0) return [""];
      const columns = Math.max(0, Math.floor(width));
      try {
        const fullPlain = (literals[0] ?? "") + fields.map((field, index) =>
          field + (literals[index + 1] ?? "")).join("");
        const firstLiteral = literals[0] ?? "";
        const ordinaryWorktree = priorityEvidence === undefined &&
          /^(?:enter worktree|exit worktree)\($/u.test(firstLiteral) && fields[0];
        if (ordinaryWorktree && visibleWidth(fullPlain) > columns) {
          const keyword = firstLiteral.slice(0, -1);
          const framedRoom = columns - visibleWidth(firstLiteral) - visibleWidth(")");
          if (framedRoom >= 2) {
            const primary = visibleWidth(ordinaryWorktree) > framedRoom
              ? truncateToWidth(ordinaryWorktree, framedRoom, "…")
              : ordinaryWorktree;
            return [clamp(
              themedFg(theme, "text", firstLiteral) + themedFg(theme, "accent", primary) + themedFg(theme, "muted", ")"),
              columns,
            )];
          }
          return [clamp(themedFg(theme, "accent", ordinaryWorktree), columns)];
        }

        const fixedWidth = literals.reduce((sum, literal) => sum + visibleWidth(literal), 0);
        let remaining = Math.max(0, columns - fixedWidth);
        const displayed: string[] = [];
        for (let index = 0; index < fields.length; index++) {
          const fieldCount = fields.length - index;
          const allowance = Math.floor(remaining / fieldCount);
          const field = visibleWidth(fields[index] ?? "") > allowance
            ? truncateToWidth(fields[index] ?? "", allowance, "…")
            : fields[index] ?? "";
          displayed.push(field);
          remaining -= visibleWidth(field);
        }
        let line = literals[0] ?? "";
        for (let index = 0; index < displayed.length; index++) {
          line += (displayed[index] ?? "") + (literals[index + 1] ?? "");
        }
        if (priorityEvidence && visibleWidth(line) > columns) {
          const evidence = themedFg(theme, "warning", priorityEvidence.warning) +
            (priorityEvidence.restoration
              ? themedFg(theme, "muted", `; ${priorityEvidence.restoration}`)
              : "") +
            (priorityEvidence.detail
              ? themedFg(theme, "warning", `; ${priorityEvidence.detail}`)
              : "");
          return [clamp(evidence, columns)];
        }
        const keyword = /^(?:enter worktree|exit worktree)/u.exec(firstLiteral)?.[0] ?? "";
        let styled = themedFg(theme, "text", keyword) + themedFg(theme, "muted", firstLiteral.slice(keyword.length));
        for (let index = 0; index < displayed.length; index++) {
          const preceding = literals[index] ?? "";
          const slot = index === 0 ? "accent" : /fail(?:ed|ure)?:\s*$/iu.test(preceding) ? "warning" : "muted";
          styled += themedFg(theme, slot, displayed[index] ?? "") +
            themedFg(theme, /fail|unknown|deferred/iu.test(literals[index + 1] ?? "") ? "warning" : "muted", literals[index + 1] ?? "");
        }
        return [clamp(styled, columns)];
      } catch {
        let line = literals[0] ?? "";
        for (let index = 0; index < fields.length; index++) {
          line += (fields[index] ?? "") + (literals[index + 1] ?? "");
        }
        return [clamp(line, columns)];
      }
    },
  };
}

function commandComponent(toolName: RoutineToolName, invocation: string, theme: unknown): Component {
  const displayName = formatToolDisplayName(toolName);
  const displayedInvocation = toolName === "WebSearch" ? `“${invocation}”` : invocation;
  const plain = `${displayName} ${displayedInvocation}`;
  return {
    render(width: number): string[] {
      try {
        const title = safeThemeMethod(theme, "fg", ["text", displayName], displayName);
        const argument = safeThemeMethod(theme, "fg", ["accent", displayedInvocation], displayedInvocation);
        const styled = `${title} ${argument}`;
        try {
          visibleWidth(styled);
          return [clamp(styled, width)];
        } catch {
          return [clamp(plain, width)];
        }
      } catch {
        return [clamp(plain, width)];
      }
    },
  };
}

function routineSummaryComponent(
  toolName: WebToolName | ActivationToolName,
  invocation: string,
  theme: unknown,
  cue?: string,
): Component {
  const displayedInvocation = toolName === "WebSearch" ? `“${invocation}”` : invocation;
  return semanticDisplayRow({
    action: formatToolDisplayName(toolName),
    primary: displayedInvocation,
    ...(cue ? { cue, compactCue: cue.endsWith(" to expand") ? cue.slice(0, -" to expand".length) : cue } : {}),
  }, theme);
}

interface RoutineSuccess {
  invocation: string;
  retainedText: string;
  retainedOwner: object;
}

interface RoutineDetailCache {
  readonly owner: object;
  readonly source: string;
  sanitized?: string;
  readonly wrapped: Map<number, string[]>;
}

interface RoutineDisplayLifecycle {
  invocation?: string;
  success?: RoutineSuccess;
  cache?: RoutineDetailCache;
  reveal: boolean;
  cue?: string;
  theme?: unknown;
  call?: Component;
}

const routineDetailCaches = new WeakMap<Component, RoutineDetailCache>();

function sanitizeRetainedText(source: string): string {
  let text = source;
  try { text = text.normalize("NFC"); } catch { /* Keep the original complete text. */ }
  return stripTerminalControls(text)
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (character) => {
      if (character === "\n") return "\n";
      return character === "\t" ? "   " : " ";
    });
}

function routineDetailCache(
  success: RoutineSuccess,
  prior?: RoutineDetailCache,
): RoutineDetailCache {
  return prior?.owner === success.retainedOwner && prior.source === success.retainedText
    ? prior
    : { owner: success.retainedOwner, source: success.retainedText, wrapped: new Map<number, string[]>() };
}

function retainedRoutineDetail(cache: RoutineDetailCache, theme: unknown, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const columns = Math.max(1, Math.floor(width));
  let detailLines = cache.wrapped.get(columns);
  if (!detailLines) {
    cache.sanitized ??= sanitizeRetainedText(cache.source);
    detailLines = [];
    for (const sourceLine of cache.sanitized.split("\n")) {
      const styled = safeThemeMethod(theme, "fg", ["toolOutput", sourceLine], sourceLine);
      const wrapped = wrapTextWithAnsi(styled, columns);
      if (wrapped.length === 0) detailLines.push("");
      else for (const line of wrapped) detailLines.push(clamp(line, columns));
    }
    cache.wrapped.set(columns, detailLines);
  }
  return detailLines;
}

function lazyRoutineSuccessComponent(
  toolName: WebToolName | ActivationToolName,
  success: RoutineSuccess,
  expanded: boolean,
  theme: unknown,
  cue: string | undefined,
  previous: Component | undefined,
): Component {
  const summary = routineSummaryComponent(toolName, success.invocation, theme, cue);
  const cache = routineDetailCache(success, previous && routineDetailCaches.get(previous));
  const component: Component = {
    render(width: number): string[] {
      const summaryLines = summary.render(width);
      return !expanded || success.retainedText.length === 0
        ? summaryLines
        : [...summaryLines, ...retainedRoutineDetail(cache, theme, width)];
    },
  };
  routineDetailCaches.set(component, cache);
  return component;
}

function boundedCanonicalText(
  result: unknown,
  toolName: RoutineToolName,
  reason?: string,
): string[] {
  const label = unfamiliarFormatLabel(toolName);
  const content = ownData(result, "content");
  if (!Array.isArray(content)) return [reason ?? label];
  const texts: string[] = reason ? [reason] : [];
  let accumulated = reason?.length ?? 0;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(content, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : 0;
    if (!Number.isSafeInteger(length) || length < 1) return texts.length > 0 ? texts : [label];
    for (let index = 0; index < length && accumulated < MAX_FAIL_OPEN_CHARS; index++) {
      const separatorLength = texts.length > 0 ? 1 : 0;
      const remaining = MAX_FAIL_OPEN_CHARS - accumulated - separatorLength;
      if (remaining <= 0) break;
      const block = ownData(content, String(index));
      const type = ownData(block, "type");
      const text = ownData(block, "text");
      const fragment = type === "text" && typeof text === "string"
        ? sanitizeText(text, false, remaining)
        : label;
      if (fragment.length === 0) {
        accumulated += Math.max(1, Math.min(typeof text === "string" ? text.length : 1, remaining));
        continue;
      }
      const boundedFragment = fragment.slice(0, remaining);
      texts.push(boundedFragment);
      accumulated += separatorLength + boundedFragment.length;
    }
  } catch {
    return texts.length > 0 ? texts : [label];
  }
  if (texts.length === 0) return [label];
  const lines = texts.join("\n").split(LINE_BREAK_RE).slice(0, MAX_FAIL_OPEN_LINES);
  return lines.some((line) => line.length > 0) ? lines : [label];
}

function failOpenComponent(
  result: unknown,
  toolName: RoutineToolName,
  theme: unknown,
  reason?: string,
): Component {
  const snapshot = boundedCanonicalText(result, toolName, reason);
  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width <= 0) return [""];
      try {
        const lines: string[] = [];
        for (const source of snapshot) {
          const styled = safeThemeMethod(theme, "fg", ["toolOutput", source], source);
          for (const line of wrapTextWithAnsi(styled, Math.max(1, Math.floor(width)))) {
            lines.push(clamp(line, width));
            if (lines.length >= MAX_FAIL_OPEN_LINES) return lines;
          }
        }
        return lines.length > 0 ? lines : [clamp(unfamiliarFormatLabel(toolName), width)];
      } catch {
        return snapshot.slice(0, MAX_FAIL_OPEN_LINES).map((line) => clamp(line, width));
      }
    },
  };
}

function oneTextContent(
  value: unknown,
): Pick<RoutineSuccess, "retainedText" | "retainedOwner"> | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = ownData(value, "length");
    if (length !== 1 || Reflect.ownKeys(value).length !== 2) return undefined;
    const retainedOwner = ownData(value, "0");
    const block = plainOwnData(retainedOwner, ["type", "text"]);
    return block?.type === "text" && typeof block.text === "string" &&
      retainedOwner !== null && typeof retainedOwner === "object"
      ? { retainedText: block.text, retainedOwner }
      : undefined;
  } catch {
    return undefined;
  }
}

function validFetch(args: DataSnapshot, details: DataSnapshot): boolean {
  return typeof args.url === "string" &&
    (args.prompt === undefined || typeof args.prompt === "string") &&
    details.url === args.url &&
    typeof details.finalUrl === "string" &&
    typeof details.status === "number" && Number.isSafeInteger(details.status) &&
    details.status >= 200 && details.status < 400 &&
    typeof details.contentType === "string" &&
    typeof details.truncated === "boolean";
}

function validSearch(args: DataSnapshot, details: DataSnapshot): boolean {
  return typeof args.query === "string" &&
    (args.allowed_domains === undefined || exactStringArray(args.allowed_domains)) &&
    (args.blocked_domains === undefined || exactStringArray(args.blocked_domains)) &&
    details.query === args.query &&
    (details.backend === "brave" || details.backend === "duckduckgo") &&
    typeof details.resultCount === "number" && Number.isSafeInteger(details.resultCount) &&
    details.resultCount >= 0 && details.resultCount <= 8 &&
    typeof details.truncated === "boolean";
}

function recognizeWebSuccess(
  toolName: WebToolName,
  result: unknown,
  options: unknown,
  context: unknown,
): RoutineSuccess | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) {
    return undefined;
  }
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (!resultSnapshot || ("isError" in resultSnapshot && resultSnapshot.isError !== false)) {
    return undefined;
  }
  const body = oneTextContent(resultSnapshot.content);
  if (!body) return undefined;

  const argsValue = ownData(context, "args");
  if (toolName === "WebFetch") {
    const argsKeys = plainOwnData(argsValue, ["url"]) ?? plainOwnData(argsValue, ["url", "prompt"]);
    const details = plainOwnData(
      resultSnapshot.details,
      ["url", "finalUrl", "status", "contentType", "truncated"],
    );
    if (!argsKeys || !details || !validFetch(argsKeys, details)) return undefined;
    const invocation = sanitizeText(argsKeys.url, true);
    return invocation.length > 0 ? { invocation, ...body } : undefined;
  }

  const possibleKeys = [
    ["query"],
    ["query", "allowed_domains"],
    ["query", "blocked_domains"],
    ["query", "allowed_domains", "blocked_domains"],
  ] as const;
  let args: DataSnapshot | undefined;
  for (const keys of possibleKeys) args ??= plainOwnData(argsValue, keys);
  const details = plainOwnData(
    resultSnapshot.details,
    ["query", "backend", "resultCount", "truncated"],
  );
  if (!args || !details || !validSearch(args, details)) return undefined;
  const invocation = sanitizeText(args.query, true);
  return invocation.length > 0 ? { invocation, ...body } : undefined;
}

function emptyInvocationReason(toolName: RoutineToolName, context: unknown): string | undefined {
  const args = ownData(context, "args");
  const invocation = ownData(
    args,
    toolName === "WebFetch" ? "url" : toolName === "WebSearch" ? "query" :
      toolName === "Skill" ? "name" : toolName === "SlashCommand" ? "command" : "subject",
  );
  return typeof invocation === "string" && sanitizeText(invocation, true).length === 0
    ? unfamiliarFormatLabel(toolName)
    : undefined;
}

function exactDataArray(value: unknown, maxLength: number): boolean {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const length = ownData(value, "length");
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxLength) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== (length as number) + 1 || !keys.includes("length")) return false;
    for (let index = 0; index < (length as number); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function activationIdentityMatches(requestedName: string, canonicalName: string): boolean {
  return requestedName === canonicalName ||
    (!requestedName.includes(":") && canonicalName.endsWith(`:${requestedName}`));
}

function slashCommandName(command: string): string | undefined {
  let trimmed: string;
  try {
    trimmed = command.trim();
  } catch {
    return undefined;
  }
  const match = /^\/?([A-Za-z0-9][\w-]*(?::[\w-]+)*)(?=[ \t]|$)/.exec(trimmed);
  return match?.[1];
}

function recognizeActivationSuccess(
  toolName: ActivationToolName,
  result: unknown,
  options: unknown,
  context: unknown,
): RoutineSuccess | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) {
    return undefined;
  }
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (!resultSnapshot || ("isError" in resultSnapshot && resultSnapshot.isError !== false)) {
    return undefined;
  }
  const body = oneTextContent(resultSnapshot.content);
  if (!body) return undefined;
  const details = plainOwnData(resultSnapshot.details, ["skill"]);
  if (!details || typeof details.skill !== "string" || details.skill.length === 0) return undefined;

  const argsValue = ownData(context, "args");
  if (toolName === "SlashCommand") {
    const args = plainOwnData(argsValue, ["command"]);
    if (!args || typeof args.command !== "string") return undefined;
    const requestedName = slashCommandName(args.command);
    if (!requestedName || !activationIdentityMatches(requestedName, details.skill)) return undefined;
    const command = sanitizeText(args.command, true);
    return command.length > 0 ? { invocation: command, ...body } : undefined;
  }

  const args = plainOwnData(argsValue, ["name"]) ??
    plainOwnData(argsValue, ["name", "arguments"]);
  if (
    !args ||
    typeof args.name !== "string" ||
    ("arguments" in args && typeof args.arguments !== "string") ||
    !activationIdentityMatches(args.name, details.skill)
  ) return undefined;
  const name = sanitizeText(args.name, true);
  if (name.length === 0) return undefined;
  const argumentsText = sanitizeText(args.arguments, true);
  return { invocation: argumentsText.length > 0 ? `${name} — ${argumentsText}` : name, ...body };
}

function routineInvocation(
  toolName: WebToolName | ActivationToolName,
  value: unknown,
): string | undefined {
  if (toolName === "WebFetch") {
    const args = plainOwnData(value, ["url"]) ?? plainOwnData(value, ["url", "prompt"]);
    if (!args || typeof args.url !== "string" ||
      ("prompt" in args && typeof args.prompt !== "string")) return undefined;
    const invocation = sanitizeText(args.url, true);
    return invocation || undefined;
  }
  if (toolName === "WebSearch") {
    const possibleKeys = [
      ["query"],
      ["query", "allowed_domains"],
      ["query", "blocked_domains"],
      ["query", "allowed_domains", "blocked_domains"],
    ] as const;
    let args: DataSnapshot | undefined;
    for (const keys of possibleKeys) args ??= plainOwnData(value, keys);
    if (!args || typeof args.query !== "string" ||
      ("allowed_domains" in args && !exactStringArray(args.allowed_domains)) ||
      ("blocked_domains" in args && !exactStringArray(args.blocked_domains))) return undefined;
    const invocation = sanitizeText(args.query, true);
    return invocation || undefined;
  }
  if (toolName === "SlashCommand") {
    const args = plainOwnData(value, ["command"]);
    if (!args || typeof args.command !== "string" || !slashCommandName(args.command)) return undefined;
    const invocation = sanitizeText(args.command, true);
    return invocation || undefined;
  }
  const args = plainOwnData(value, ["name"]) ?? plainOwnData(value, ["name", "arguments"]);
  if (!args || typeof args.name !== "string" ||
    ("arguments" in args && typeof args.arguments !== "string")) return undefined;
  const name = sanitizeText(args.name, true);
  if (!name) return undefined;
  const argumentsText = sanitizeText(args.arguments, true);
  return argumentsText ? `${name} — ${argumentsText}` : name;
}

interface OrdinaryWorktreeRow {
  kind: "ordinary";
  action: "enter worktree" | "exit worktree";
  primary: string;
  metadata: string[];
}

interface ExceptionalWorktreeRow {
  kind: "exceptional";
  literals: string[];
  fields: string[];
  priorityEvidence?: PriorityEvidence;
}

type WorktreeRow = OrdinaryWorktreeRow | ExceptionalWorktreeRow;

function recognizeEnterWorktree(
  result: unknown,
  options: unknown,
  context: unknown,
  displayRoots: DisplayRoots,
): WorktreeRow | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) return undefined;
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (!resultSnapshot || ("isError" in resultSnapshot && resultSnapshot.isError !== false) ||
    !oneTextContent(resultSnapshot.content)) return undefined;
  const baseKeys = ["worktreePath", "branch", "created", "seeded", "previousUnlockAttempted"];
  const previousKeys = [...baseKeys, "previousWorktreePath", "previousKeepOutcome"];
  const details = plainOwnData(resultSnapshot.details, baseKeys) ??
    plainOwnData(resultSnapshot.details, previousKeys) ??
    plainOwnData(resultSnapshot.details, [...previousKeys, "previousKeepError"]);
  if (!details || typeof details.worktreePath !== "string" || typeof details.branch !== "string" ||
    typeof details.created !== "boolean" ||
    !exactStringArray(details.seeded, MAX_WORKTREE_SEEDED_FILES) ||
    typeof details.previousUnlockAttempted !== "boolean") return undefined;
  const argsValue = ownData(context, "args");
  const nameArgs = plainOwnData(argsValue, ["name"]);
  const pathArgs = plainOwnData(argsValue, ["path"]);
  if ((nameArgs && typeof nameArgs.name !== "string") ||
    (pathArgs && typeof pathArgs.path !== "string") ||
    (!nameArgs && !pathArgs) || (pathArgs && details.created)) return undefined;
  if (pathArgs) {
    try {
      if (path.resolve(pathArgs.path as string) !== path.resolve(details.worktreePath)) return undefined;
    } catch {
      return undefined;
    }
  }
  const hasPrevious = "previousWorktreePath" in details;
  const hasPreviousOutcome = "previousKeepOutcome" in details;
  const hasPreviousError = "previousKeepError" in details;
  if (hasPrevious !== details.previousUnlockAttempted || hasPrevious !== hasPreviousOutcome ||
    (hasPrevious && typeof details.previousWorktreePath !== "string") ||
    (hasPreviousOutcome && details.previousKeepOutcome !== "kept" &&
      details.previousKeepOutcome !== "keep-failed") ||
    (hasPreviousError && (details.previousKeepOutcome !== "keep-failed" ||
      typeof details.previousKeepError !== "string"))) return undefined;
  const worktreePath = sanitizeInlineDisplay(formatDisplayPathFromRoots(details.worktreePath, displayRoots));
  const branch = sanitizeText(details.branch, true);
  const previousPath = hasPrevious
    ? sanitizeInlineDisplay(formatDisplayPathFromRoots(details.previousWorktreePath, displayRoots))
    : undefined;
  const previousError = hasPreviousError ? sanitizeText(details.previousKeepError, true) : undefined;
  if (!worktreePath || !branch || (hasPrevious && !previousPath) || (hasPreviousError && !previousError)) {
    return undefined;
  }
  const seededCount = ownData(details.seeded, "length") as number;
  if (!details.created && seededCount !== 0) return undefined;
  if (details.previousKeepOutcome !== "keep-failed") {
    return {
      kind: "ordinary",
      action: "enter worktree",
      primary: worktreePath,
      metadata: [
        `branch ${branch}`,
        ...(seededCount > 0 ? [`seeded ${seededCount} files`] : []),
        ...(previousPath ? [`previous ${previousPath} kept`, "unlock attempted"] : []),
      ],
    };
  }
  const seededFact = seededCount > 0 ? `; seeded ${seededCount} files` : "";
  const literals = ["enter worktree(", `) on branch ${branch}${seededFact}; previous `];
  const fields = [worktreePath, previousPath ?? ""];
  if (previousError !== undefined) {
    literals.push(" keep failed: ", "; previous worktree state unknown");
    fields.push(previousError);
  } else {
    literals.push(" keep failed; previous worktree state unknown");
  }
  return {
    kind: "exceptional",
    literals,
    fields,
    priorityEvidence: {
      warning: "entered; prior keep failed; state unknown",
      ...(previousError ? { detail: `prior error: ${previousError}` } : {}),
    },
  };
}

function recognizeExitWorktree(
  result: unknown,
  options: unknown,
  context: unknown,
  displayRoots: DisplayRoots,
): WorktreeRow | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) return undefined;
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (!resultSnapshot || ("isError" in resultSnapshot && resultSnapshot.isError !== false) ||
    !oneTextContent(resultSnapshot.content)) return undefined;
  const none = plainOwnData(resultSnapshot.details, ["outcome", "restorePath"]);
  if (none) {
    if (none.outcome !== "none" || typeof none.restorePath !== "string") return undefined;
    const restorePath = sanitizeInlineDisplay(formatDisplayPathFromRoots(none.restorePath, displayRoots));
    return restorePath
      ? { kind: "exceptional", literals: ["exit worktree (no active worktree); already at ", ""], fields: [restorePath] }
      : undefined;
  }
  const baseKeys = [
    "worktreePath", "outcome", "restorePath", "ok", "removed", "orphaned", "diagnostics",
  ];
  const details = plainOwnData(resultSnapshot.details, baseKeys) ??
    plainOwnData(resultSnapshot.details, [...baseKeys, "error"]);
  if (!details || typeof details.worktreePath !== "string" || typeof details.restorePath !== "string" ||
    typeof details.ok !== "boolean" || typeof details.removed !== "boolean" ||
    typeof details.orphaned !== "boolean" ||
    !exactDataArray(details.diagnostics, MAX_WORKTREE_DIAGNOSTICS)) return undefined;
  const worktreePath = sanitizeInlineDisplay(formatDisplayPathFromRoots(details.worktreePath, displayRoots));
  const restorePath = sanitizeInlineDisplay(formatDisplayPathFromRoots(details.restorePath, displayRoots));
  if (!worktreePath || !restorePath) return undefined;
  if (details.outcome === "kept") {
    if (details.ok !== true || details.removed || details.orphaned || "error" in details) return undefined;
    return {
      kind: "ordinary",
      action: "exit worktree",
      primary: worktreePath,
      metadata: ["kept", `restored ${restorePath}`],
    };
  }
  if (details.outcome === "keep-failed") {
    if (details.ok !== false || details.removed || details.orphaned) return undefined;
    if ("error" in details) {
      const error = sanitizeText(details.error, true);
      if (typeof details.error !== "string" || !error) return undefined;
      return {
        kind: "exceptional",
        literals: [
          "exit worktree(", ") keep failed: ",
          "; worktree state unknown; restored ", "",
        ],
        fields: [worktreePath, error, restorePath],
        priorityEvidence: {
          warning: "keep failed; state unknown",
          restoration: "restored",
          detail: `error: ${error}`,
        },
      };
    }
    return {
      kind: "exceptional",
      literals: ["exit worktree(", ") keep failed; worktree state unknown; restored ", ""],
      fields: [worktreePath, restorePath],
      priorityEvidence: { warning: "keep failed; state unknown", restoration: "restored" },
    };
  }
  if (details.outcome === "removed") {
    if (details.ok !== true || details.removed !== true || details.orphaned || "error" in details) return undefined;
    return {
      kind: "ordinary",
      action: "exit worktree",
      primary: worktreePath,
      metadata: ["removed", `restored ${restorePath}`],
    };
  }
  if (details.outcome === "deferred-removal") {
    if (details.ok !== true || details.removed || details.orphaned !== true || "error" in details) return undefined;
    return {
      kind: "exceptional",
      literals: ["exit worktree(", ") removal deferred; restored ", ""],
      fields: [worktreePath, restorePath],
      priorityEvidence: { warning: "removal deferred", restoration: "restored" },
    };
  }
  if (details.outcome !== "removal-failed" || details.ok !== false || details.removed || details.orphaned) {
    return undefined;
  }
  if ("error" in details) {
    const error = sanitizeText(details.error, true);
    if (typeof details.error !== "string" || !error) return undefined;
    return {
      kind: "exceptional",
      literals: [
        "exit worktree(", ") removal failed: ",
        "; worktree state unknown; restored ", "",
      ],
      fields: [worktreePath, error, restorePath],
      priorityEvidence: {
        warning: "removal failed; state unknown",
        restoration: "restored",
        detail: `error: ${error}`,
      },
    };
  }
  return {
    kind: "exceptional",
    literals: ["exit worktree(", ") removal failed; worktree state unknown; restored ", ""],
    fields: [worktreePath, restorePath],
    priorityEvidence: { warning: "removal failed; state unknown", restoration: "restored" },
  };
}

function routineToolName(tool: unknown): RoutineToolName | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  try {
    if (Object.getPrototypeOf(tool) !== Object.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(tool, "name");
    if (!descriptor || !("value" in descriptor)) return undefined;
    return descriptor.value === "WebFetch" || descriptor.value === "WebSearch" ||
      descriptor.value === "Skill" || descriptor.value === "SlashCommand" ||
      descriptor.value === "edit" || descriptor.value === "MultiEdit" ||
      descriptor.value === "EnterWorktree" || descriptor.value === "ExitWorktree" ||
      descriptor.value === "TaskCreate" || descriptor.value === "TaskUpdate" || descriptor.value === "TaskGet"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

const editCallInners = new WeakMap<Component, Component>();
const editResultInners = new WeakMap<Component, Component>();
type PublicEditDefinition = ReturnType<typeof createEditToolDefinition>;
type PublicEditCallRenderer = NonNullable<PublicEditDefinition["renderCall"]>;
type PublicEditResultRenderer = NonNullable<PublicEditDefinition["renderResult"]>;
type EditCallRenderer = (...args: Parameters<PublicEditCallRenderer>) => Component;
type EditResultRenderer = (...args: Parameters<PublicEditResultRenderer>) => Component;
type EditRendererDefinition = {
  renderCall?: EditCallRenderer;
  renderResult?: EditResultRenderer;
};

export interface RoutineRenderingDependencies {
  createEditDefinition?: (cwd: string) => EditRendererDefinition;
  resolveEditRenderCwd?: () => unknown;
  resolveDisplayRoot?: DisplayRootResolver;
  repositoryRoot?: string;
}

function componentFrom(value: unknown): Component | undefined {
  return value !== null && typeof value === "object" && typeof (value as Component).render === "function"
    ? value as Component
    : undefined;
}

/** Read preview-failure evidence retained by this module's Edit call adapter. */
export function adaptedEditPreviewError(value: unknown): string | undefined {
  const component = componentFrom(value);
  const inner = component && editCallInners.get(component);
  const preview = inner && ownData(inner, "preview");
  const error = ownData(preview, "error");
  return typeof error === "string" ? error : undefined;
}

function editContext(
  context: unknown,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  if (context === null || typeof context !== "object") return overrides;
  try {
    return { ...Object.fromEntries(Object.entries(context)), ...overrides };
  } catch {
    return overrides;
  }
}

function usableAbsoluteCwd(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value)
    ? value
    : undefined;
}

interface LiveEditRenderLifecycle {
  delegatedState: object;
  activated: boolean;
  previewResolutionDone: boolean;
  previewCwd?: string;
  previewStarted: boolean;
  executionResolutionDone: boolean;
  executionCwd?: string;
  suppressPreview: boolean;
}

interface LiveEditCallBinding {
  context: Record<string, unknown>;
  rotated: boolean;
}

function resolveEditRenderCwd(resolver: () => unknown): string | undefined {
  try {
    return usableAbsoluteCwd(resolver());
  } catch {
    return undefined;
  }
}

function liveEditState(context: unknown): object | undefined {
  const state = ownData(context, "state");
  return state !== null && (typeof state === "object" || typeof state === "function")
    ? state
    : undefined;
}

function bindLiveEditCallContext(
  context: unknown,
  lifecycles: WeakMap<object, LiveEditRenderLifecycle>,
  resolver: () => unknown,
): LiveEditCallBinding {
  const state = liveEditState(context);
  if (!state) return { context: editContext(context, {}), rotated: false };

  let lifecycle = lifecycles.get(state);
  const argsComplete = ownData(context, "argsComplete") === true;
  const executionStarted = ownData(context, "executionStarted") === true;
  if (!lifecycle) {
    if (argsComplete || executionStarted) {
      return { context: editContext(context, {}), rotated: false };
    }
    lifecycle = {
      delegatedState: state,
      activated: false,
      previewResolutionDone: false,
      previewStarted: false,
      executionResolutionDone: false,
      suppressPreview: false,
    };
    lifecycles.set(state, lifecycle);
  }

  if (argsComplete && !executionStarted && !lifecycle.previewResolutionDone) {
    lifecycle.activated = true;
    lifecycle.previewResolutionDone = true;
    lifecycle.previewCwd = resolveEditRenderCwd(resolver);
    lifecycle.previewStarted = lifecycle.previewCwd !== undefined;
    lifecycle.suppressPreview = !lifecycle.previewStarted;
  }

  let rotated = false;
  if (executionStarted && !lifecycle.executionResolutionDone) {
    lifecycle.activated = true;
    lifecycle.executionResolutionDone = true;
    lifecycle.executionCwd = resolveEditRenderCwd(resolver);
    if (!lifecycle.previewStarted || lifecycle.executionCwd !== lifecycle.previewCwd) {
      if (lifecycle.previewStarted) {
        // Pi keys async Edit previews by arguments, not cwd; reuse admits stale completion while replacement preview would race execution.
        lifecycle.delegatedState = {};
        rotated = true;
      }
      lifecycle.suppressPreview = true;
    }
  }

  const cwd = executionStarted
    ? lifecycle.executionCwd ?? ownData(context, "cwd")
    : lifecycle.previewCwd ?? ownData(context, "cwd");
  return {
    context: editContext(context, {
      state: lifecycle.delegatedState,
      cwd,
      argsComplete: lifecycle.suppressPreview ? false : argsComplete,
    }),
    rotated,
  };
}

function bindLiveEditResultContext(
  context: unknown,
  lifecycle: LiveEditRenderLifecycle,
): Record<string, unknown> {
  return editContext(context, {
    state: lifecycle.delegatedState,
    cwd: lifecycle.executionCwd ?? ownData(context, "cwd"),
    argsComplete: lifecycle.suppressPreview ? false : ownData(context, "argsComplete"),
  });
}

function knownEditPadding(line: string, width: number): boolean {
  if (!Number.isFinite(width) || width < 0) return false;
  const columns = Math.floor(width);
  try {
    return visibleWidth(line) === columns && stripTerminalControls(line) === " ".repeat(columns);
  } catch {
    return false;
  }
}

function renderNeutralEditBox(component: Component, width: number): string[] {
  neutralizePiEditBoxBackground(component);
  return component.render(width);
}

function adaptEditCallRenderer(
  renderer: EditCallRenderer,
  resolver?: () => unknown,
  lifecycles?: WeakMap<object, LiveEditRenderLifecycle>,
): EditCallRenderer {
  return (args, theme, context): Component => {
    const binding = resolver && lifecycles
      ? bindLiveEditCallContext(context, lifecycles, resolver)
      : { context: editContext(context, {}), rotated: false };
    const previousComponent = componentFrom(ownData(context, "lastComponent"));
    const previous = binding.rotated
      ? undefined
      : previousComponent && editCallInners.get(previousComponent);
    const inner = renderer(
      args,
      theme,
      editContext(binding.context, { lastComponent: previous }) as unknown as typeof context,
    );
    const adapted: Component = {
      render(width: number): string[] {
        const lines = renderNeutralEditBox(inner, width);
        return lines.length >= 2 &&
          knownEditPadding(lines[0] ?? "", width) &&
          knownEditPadding(lines[lines.length - 1] ?? "", width)
          ? lines.slice(1, -1)
          : lines;
      },
    };
    editCallInners.set(adapted, inner);
    return adapted;
  };
}

function adaptEditResultRenderer(
  renderer: EditResultRenderer,
  lifecycles: WeakMap<object, LiveEditRenderLifecycle>,
): EditResultRenderer {
  return (result, options, theme, context): Component => {
    const state = liveEditState(context);
    const lifecycle = state && lifecycles.get(state);
    if (!lifecycle?.activated) return renderer(result, options, theme, context);

    const previousComponent = componentFrom(ownData(context, "lastComponent"));
    const previous = previousComponent && editResultInners.get(previousComponent);
    const delegatedContext = bindLiveEditResultContext(context, lifecycle);
    const inner = renderer(
      result,
      options,
      theme,
      editContext(delegatedContext, { lastComponent: previous }) as unknown as typeof context,
    );
    const adapted: Component = { render: (width) => inner.render(width) };
    editResultInners.set(adapted, inner);
    return adapted;
  };
}

function sanitizeMutationText(value: unknown, inline: boolean, maxRawChars: number): string {
  if (typeof value !== "string" || maxRawChars <= 0) return "";
  let text: string;
  try {
    text = value.slice(0, maxRawChars).normalize("NFC").replace(/\r\n?/gu, "\n");
  } catch {
    return "";
  }
  let safe = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    const isCsi = code === 0x9b || (code === 0x1b && next === 0x5b);
    const isOsc = code === 0x9d || (code === 0x1b && next === 0x5d);
    if (isCsi || isOsc) {
      index += code === 0x1b ? 2 : 1;
      while (index < text.length && text[index] !== "\n") {
        const current = text.charCodeAt(index);
        if (isCsi && current >= 0x40 && current <= 0x7e) {
          index++;
          break;
        }
        if (isOsc && (current === 0x07 || current === 0x9c)) {
          index++;
          break;
        }
        if (isOsc && current === 0x1b && text.charCodeAt(index + 1) === 0x5c) {
          index += 2;
          break;
        }
        index++;
      }
      safe += MUTATION_CONTROL_PLACEHOLDER;
      continue;
    }
    const character = text[index] ?? "";
    if (code === 0x1b || code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character)) {
      if (character === "\n") safe += inline ? " " : "\n";
      else if (character === "\t") safe += "   ";
      else safe += MUTATION_CONTROL_PLACEHOLDER;
      index++;
      continue;
    }
    safe += character;
    index++;
  }
  return inline ? safe.replace(/\s+/gu, " ").trim() : safe;
}

function multiEditArrayLength(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = ownData(value, "length");
    return Number.isSafeInteger(length) && (length as number) >= 1 ? length as number : undefined;
  } catch {
    return undefined;
  }
}

function validateMultiEditEntries(value: unknown, length: number): boolean {
  if (!Array.isArray(value) || length > MAX_MULTI_EDIT_COUNT) return false;
  try {
    if (Reflect.ownKeys(value).length !== length + 1) return false;
    for (let index = 0; index < length; index++) {
      const entry = plainOwnData(ownData(value, String(index)), ["old_string", "new_string"]) ??
        plainOwnData(ownData(value, String(index)), ["old_string", "new_string", "replace_all"]);
      if (!entry || typeof entry.old_string !== "string" || typeof entry.new_string !== "string" ||
        ("replace_all" in entry && typeof entry.replace_all !== "boolean")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface MultiEditSnapshot {
  kind: "displayable";
  path: string;
  diff: string;
  firstChangedLine: number | undefined;
  editCount: number;
  canonicalText: string;
}

export interface OversizedMultiEditSnapshot {
  kind: "oversized";
  path: string;
}

export type MultiEditSuccess = MultiEditSnapshot | OversizedMultiEditSnapshot;

function boundedPathMatches(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  if (left.length <= MAX_MULTI_EDIT_PATH_CHARS) return left === right;
  const tailOffset = left.length - MAX_OVERSIZED_PATH_CHARS;
  return left.startsWith(right.slice(0, MAX_OVERSIZED_PATH_CHARS)) &&
    left.endsWith(right.slice(tailOffset));
}

function canonicalMultiEditTextMatches(
  text: string,
  path: string,
  editCount: number,
  created: boolean,
): boolean {
  const prefix = created ? "Created " : `Successfully applied ${editCount} edit(s) to `;
  const suffix = created ? ` with ${editCount} edit(s).` : ".";
  if (text.length !== prefix.length + path.length + suffix.length ||
    !text.startsWith(prefix) || !text.endsWith(suffix)) return false;
  if (path.length <= MAX_MULTI_EDIT_PATH_CHARS) return text.startsWith(path, prefix.length);
  const head = path.slice(0, MAX_OVERSIZED_PATH_CHARS);
  const tail = path.slice(path.length - MAX_OVERSIZED_PATH_CHARS);
  return text.startsWith(head, prefix.length) &&
    text.startsWith(tail, prefix.length + path.length - tail.length);
}

export function recognizeMultiEditSuccess(
  result: unknown,
  options: unknown,
  context: unknown,
): MultiEditSuccess | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isPartial") !== false ||
    ownData(context, "isError") !== false) return undefined;
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (!resultSnapshot || ("isError" in resultSnapshot && resultSnapshot.isError !== false) ||
    !oneTextContent(resultSnapshot.content)) return undefined;
  const args = plainOwnData(ownData(context, "args"), ["file_path", "edits"]);
  const details = plainOwnData(
    resultSnapshot.details,
    ["filePath", "edits", "created", "diff", "firstChangedLine"],
  );
  const contentBlock = ownData(resultSnapshot.content, "0");
  const canonicalText = ownData(contentBlock, "text");
  const editCount = args ? multiEditArrayLength(args.edits) : undefined;
  if (!args || !details || typeof args.file_path !== "string" ||
    typeof details.filePath !== "string" || !boundedPathMatches(details.filePath, args.file_path) ||
    typeof details.edits !== "number" || !Number.isSafeInteger(details.edits) || details.edits < 1 ||
    editCount !== details.edits || typeof details.created !== "boolean" ||
    typeof details.diff !== "string" || typeof canonicalText !== "string" ||
    !canonicalMultiEditTextMatches(canonicalText, details.filePath, details.edits, details.created)) {
    return undefined;
  }
  const firstChangedLine = details.firstChangedLine;
  if (details.diff.length === 0) {
    if (details.created || firstChangedLine !== undefined) return undefined;
  } else if (!Number.isSafeInteger(firstChangedLine) || (firstChangedLine as number) < 1) {
    return undefined;
  }
  const oversized = editCount > MAX_MULTI_EDIT_COUNT ||
    details.filePath.length > MAX_MULTI_EDIT_PATH_CHARS ||
    details.diff.length > MAX_MULTI_EDIT_DIFF_CHARS;
  if (oversized) {
    const boundedRawPath = details.filePath.slice(0, MAX_OVERSIZED_PATH_CHARS);
    const path = sanitizeInlineDisplay(boundedRawPath, MAX_OVERSIZED_PATH_CHARS) +
      (details.filePath.length > MAX_OVERSIZED_PATH_CHARS ? "…" : "");
    return path.length > 0 ? { kind: "oversized", path } : undefined;
  }
  if (!validateMultiEditEntries(args.edits, editCount)) return undefined;
  const path = sanitizeInlineDisplay(details.filePath, MAX_MULTI_EDIT_PATH_CHARS);
  const diff = sanitizeMutationText(details.diff, false, MAX_MULTI_EDIT_DIFF_CHARS);
  if (path.length === 0 || (details.diff.length > 0 && diff.length === 0)) return undefined;
  return {
    kind: "displayable",
    path,
    diff,
    firstChangedLine: firstChangedLine as number | undefined,
    editCount: details.edits,
    canonicalText: details.created
      ? `Created ${path} with ${details.edits} edit(s).`
      : `Successfully applied ${details.edits} edit(s) to ${path}.`,
  };
}

function multiEditCall(displayPath: string, theme: unknown): Component {
  return commandComponent("MultiEdit", displayPath, theme);
}

function textComponent(text: string, theme: unknown): Component {
  return {
    render(width: number): string[] {
      return [clamp(safeThemeMethod(theme, "fg", ["toolOutput", text], text), width)];
    },
  };
}

function multiEditResult(
  result: unknown,
  options: unknown,
  theme: unknown,
  context: unknown,
  dependencies: RoutineRenderingDependencies,
): Component {
  const snapshot = recognizeMultiEditSuccess(result, options, context);
  if (!snapshot) return failOpenComponent(result, "MultiEdit", theme);
  if (snapshot.kind === "oversized") {
    return textComponent(`Diff too large to display for ${snapshot.path}`, theme);
  }
  if (snapshot.diff.length === 0) {
    return textComponent(`No net change (${snapshot.editCount} edits applied)`, theme);
  }
  const fallback = failOpenComponent(result, "MultiEdit", theme);
  try {
    const cwd = sanitizeInlineDisplay(ownData(context, "cwd"));
    const createDefinition: (cwd: string) => EditRendererDefinition =
      dependencies.createEditDefinition ??
      ((definitionCwd) => createEditToolDefinition(definitionCwd) as unknown as EditRendererDefinition);
    const definition = createDefinition(cwd);
    if (typeof definition.renderResult !== "function") return fallback;
    const previousComponent = componentFrom(ownData(context, "lastComponent"));
    const previous = previousComponent && editResultInners.get(previousComponent);
    const detachedResult: Parameters<EditResultRenderer>[0] = {
      content: [{ type: "text", text: snapshot.canonicalText }],
      details: { diff: snapshot.diff, patch: "", firstChangedLine: snapshot.firstChangedLine },
    };
    const detachedOptions = {
      expanded: ownData(options, "expanded") === true,
      isPartial: false,
    };
    const detachedContext = {
      args: { path: snapshot.path, edits: [] },
      toolCallId: "MultiEdit-display",
      invalidate() {},
      state: {},
      lastComponent: previous,
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: detachedOptions.expanded,
      showImages: false,
      isError: false,
    } as unknown as Parameters<EditResultRenderer>[3];
    const delegated = definition.renderResult(
      detachedResult,
      detachedOptions,
      theme as Parameters<EditResultRenderer>[2],
      detachedContext,
    );
    const adapted: Component = {
      render(width: number): string[] {
        try {
          return renderNeutralEditBox(delegated, width);
        } catch {
          return fallback.render(width);
        }
      },
    };
    editResultInners.set(adapted, delegated);
    return adapted;
  } catch {
    return fallback;
  }
}

/** Add guarded human-only routine presentation without changing canonical tool execution/results. */
export function withRoutineToolRendering<T extends ToolDefinition>(
  tool: T,
  dependencies: RoutineRenderingDependencies = {},
): T {
  const toolName = routineToolName(tool);
  if (!toolName) return tool;
  const rootSnapshots = new WeakMap<object, DisplayRoots>();
  const htmlCallStates = new WeakSet<object>();
  const interactiveCallStates = new WeakSet<object>();
  const routineLifecycles = new WeakMap<object, RoutineDisplayLifecycle>();
  const displayRootsFor = (context: unknown): DisplayRoots => {
    const state = liveEditState(context);
    const resolved = () => resolveDisplayRoots(
      dependencies.resolveDisplayRoot,
      dependencies.repositoryRoot,
      context,
    );
    if (!state || ownData(context, "argsComplete") === false) return resolved();
    if (!rootSnapshots.has(state)) rootSnapshots.set(state, resolved());
    return rootSnapshots.get(state) ?? {};
  };

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(tool);
  } catch {
    return tool;
  }
  if (toolName === "TaskCreate" || toolName === "TaskUpdate" || toolName === "TaskGet") {
    const argsKey = toolName === "TaskCreate" ? "subject" : "taskId";
    delete descriptors.renderCall;
    const decoratedTask = Object.defineProperties({}, descriptors) as T;
    Object.defineProperty(decoratedTask, "renderCall", {
      configurable: true,
      enumerable: true,
      writable: true,
      value(args: unknown, theme: unknown): Component {
        const value = ownData(args, argsKey);
        const primary = sanitizeText(value, true);
        if (typeof value !== "string" || !primary) return commandComponent(toolName, "?", theme);
        const optional = toolName === "TaskUpdate" && typeof ownData(args, "status") === "string"
          ? [sanitizeText(ownData(args, "status"), true)]
          : [];
        return priorityDisplayRow(formatToolDisplayName(toolName), primary, [], optional, "", theme);
      },
    });
    return decoratedTask;
  }
  const originalCall = descriptors.renderCall && "value" in descriptors.renderCall
    ? descriptors.renderCall.value as unknown
    : undefined;
  if (toolName === "edit") {
    if (typeof originalCall !== "function") return tool;
    const originalResult = descriptors.renderResult && "value" in descriptors.renderResult
      ? descriptors.renderResult.value as unknown
      : undefined;
    const resolver = dependencies.resolveEditRenderCwd;
    const lifecycles = resolver ? new WeakMap<object, LiveEditRenderLifecycle>() : undefined;
    delete descriptors.renderCall;
    if (resolver && typeof originalResult === "function") delete descriptors.renderResult;
    const decoratedEdit = Object.defineProperties({}, descriptors) as T;
    Object.defineProperty(decoratedEdit, "renderCall", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: adaptEditCallRenderer(originalCall as EditCallRenderer, resolver, lifecycles),
    });
    if (resolver && lifecycles && typeof originalResult === "function") {
      Object.defineProperty(decoratedEdit, "renderResult", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: adaptEditResultRenderer(originalResult as EditResultRenderer, lifecycles),
      });
    }
    return decoratedEdit;
  }

  delete descriptors.renderCall;
  delete descriptors.renderResult;
  const decorated = Object.defineProperties({}, descriptors) as T;
  Object.defineProperties(decorated, {
    renderCall: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(args: unknown, theme: unknown, context: unknown): Component {
        const displayRoots = displayRootsFor(context);
        if (toolName === "WebFetch" || toolName === "WebSearch" || toolName === "Skill" || toolName === "SlashCommand") {
          const state = liveEditState(context);
          // ToolExecution initializes this state before execution; HTML's independent call pass arrives already complete.
          if (state && (interactiveCallStates.has(state) || ownData(context, "argsComplete") !== true ||
            ownData(context, "executionStarted") !== true)) interactiveCallStates.add(state);
          const partialCall = ownData(context, "isPartial") === true;
          const htmlStatic = partialCall && state !== undefined && !interactiveCallStates.has(state);
          if (state) {
            if (htmlStatic) htmlCallStates.add(state);
            else htmlCallStates.delete(state);
          }
          const invocation = routineInvocation(toolName, args);
          if (htmlStatic || !state || !invocation) return { render: () => [] };
          let lifecycle = routineLifecycles.get(state);
          if (!lifecycle) {
            lifecycle = { reveal: false };
            routineLifecycles.set(state, lifecycle);
          }
          lifecycle.invocation = invocation;
          lifecycle.theme = theme;
          lifecycle.call ??= {
            render(width: number): string[] {
              const activeInvocation = lifecycle?.success?.invocation ?? lifecycle?.invocation ?? invocation;
              const lines = routineSummaryComponent(toolName, activeInvocation, lifecycle?.theme, lifecycle?.cue).render(width);
              return lifecycle?.success && lifecycle.reveal && lifecycle.success.retainedText.length > 0 && lifecycle.cache
                ? [...lines, ...retainedRoutineDetail(lifecycle.cache, lifecycle.theme, width)]
                : lines;
            },
          };
          return lifecycle.call;
        }
        if (toolName !== "MultiEdit") return { render: () => [] };
        const snapshot = plainOwnData(args, ["file_path", "edits"]);
        const displayPath = snapshot
          ? sanitizeInlineDisplay(formatDisplayPathFromRoots(snapshot.file_path, displayRoots))
          : "";
        return multiEditCall(displayPath, theme);
      },
    },
    renderResult: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(result: ResultShape, options: unknown, theme: unknown, context: unknown): Component {
        try {
          const displayRoots = displayRootsFor(context);
          if (toolName === "MultiEdit") {
            return multiEditResult(result, options, theme, context, dependencies);
          }
          if (toolName === "EnterWorktree" || toolName === "ExitWorktree") {
            const row = toolName === "EnterWorktree"
              ? recognizeEnterWorktree(result, options, context, displayRoots)
              : recognizeExitWorktree(result, options, context, displayRoots);
            if (row === undefined) return failOpenComponent(result, toolName, theme);
            return row.kind === "ordinary"
              ? semanticDisplayRow({ action: row.action, primary: row.primary, optional: row.metadata }, theme)
              : structuredRowComponent(row.literals, row.fields, theme, row.priorityEvidence);
          }
          const success = toolName === "WebFetch" || toolName === "WebSearch"
            ? recognizeWebSuccess(toolName, result, options, context)
            : recognizeActivationSuccess(toolName, result, options, context);
          if (success === undefined) {
            const state = liveEditState(context);
            const lifecycle = state && routineLifecycles.get(state);
            if (lifecycle) {
              lifecycle.success = undefined;
              lifecycle.cache = undefined;
              lifecycle.reveal = false;
              lifecycle.cue = undefined;
            }
            return failOpenComponent(
              result,
              toolName,
              theme,
              emptyInvocationReason(toolName, context),
            );
          }
          const expansion = piToolsExpandKeyText();
          const binding = expansion.available ? sanitizeText(expansion.value, true, 512) : "";
          const state = liveEditState(context);
          const html = state !== undefined && htmlCallStates.has(state);
          const requestedExpanded = ownData(options, "expanded") === true;
          const expanded = requestedExpanded || !expansion.available || !binding;
          if (html) {
            const cue = success.retainedText.length > 0 && !expanded ? "click to show detail" : undefined;
            const previous = componentFrom(ownData(context, "lastComponent"));
            return lazyRoutineSuccessComponent(toolName, success, expanded, theme, cue, previous);
          }
          const lifecycle = state && routineLifecycles.get(state);
          if (lifecycle) {
            lifecycle.success = success;
            lifecycle.cache = routineDetailCache(success, lifecycle.cache);
            lifecycle.reveal = expanded;
            lifecycle.cue = success.retainedText.length > 0 && !expanded ? `${binding} to expand` : undefined;
            lifecycle.theme = theme;
            return { render: () => [] };
          }
          const cue = success.retainedText.length > 0 && !expanded ? `${binding} to expand` : undefined;
          const previous = componentFrom(ownData(context, "lastComponent"));
          return lazyRoutineSuccessComponent(toolName, success, expanded, theme, cue, previous);
        } catch {
          return failOpenComponent(result, toolName, theme);
        }
      },
    },
  });
  return decorated;
}
