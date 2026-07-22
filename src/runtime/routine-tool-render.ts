import path from "node:path";
import {
  createEditToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
type RoutineToolName = WebToolName | ActivationToolName | MutationToolName | WorktreeToolName;
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
  return `Unfamiliar ${toolName} presentation format`;
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
  method: "fg" | "bold",
  args: readonly string[],
  fallback: string,
): string {
  try {
    const candidate = Reflect.get(theme as object, method);
    if (typeof candidate !== "function") return fallback;
    const rendered = Reflect.apply(candidate, theme, args);
    return typeof rendered === "string" ? rendered : fallback;
  } catch {
    return fallback;
  }
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

function structuredRowComponent(
  literals: readonly string[],
  fields: readonly string[],
  theme: unknown,
): Component {
  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width <= 0) return [""];
      const columns = Math.max(0, Math.floor(width));
      try {
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
        return [clamp(safeThemeMethod(theme, "fg", ["toolOutput", line], line), columns)];
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
  const displayedInvocation = toolName === "WebSearch" ? `“${invocation}”` : invocation;
  const plain = `${toolName} ${displayedInvocation}`;
  return {
    render(width: number): string[] {
      try {
        const title = safeThemeMethod(
          theme,
          "fg",
          ["toolTitle", safeThemeMethod(theme, "bold", [toolName], toolName)],
          toolName,
        );
        const argument = safeThemeMethod(
          theme,
          "fg",
          ["accent", displayedInvocation],
          displayedInvocation,
        );
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

function textContentBlock(value: unknown): boolean {
  const block = plainOwnData(value, ["type", "text"]);
  return block?.type === "text" && typeof block.text === "string";
}

function oneTextContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const length = ownData(value, "length");
    return length === 1 && Reflect.ownKeys(value).length === 2 && textContentBlock(ownData(value, "0"));
  } catch {
    return false;
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
): string | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) {
    return undefined;
  }
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (
    !resultSnapshot ||
    ("isError" in resultSnapshot && resultSnapshot.isError !== false) ||
    !oneTextContent(resultSnapshot.content)
  ) return undefined;

  const argsValue = ownData(context, "args");
  if (toolName === "WebFetch") {
    const argsKeys = plainOwnData(argsValue, ["url"]) ?? plainOwnData(argsValue, ["url", "prompt"]);
    const details = plainOwnData(
      resultSnapshot.details,
      ["url", "finalUrl", "status", "contentType", "truncated"],
    );
    if (!argsKeys || !details || !validFetch(argsKeys, details)) return undefined;
    const invocation = sanitizeText(argsKeys.url, true);
    return invocation.length > 0 ? invocation : undefined;
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
  return invocation.length > 0 ? invocation : undefined;
}

function emptyInvocationReason(toolName: RoutineToolName, context: unknown): string | undefined {
  const args = ownData(context, "args");
  const invocation = ownData(
    args,
    toolName === "WebFetch" ? "url" : toolName === "WebSearch" ? "query" :
      toolName === "Skill" ? "name" : "command",
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
): string | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) {
    return undefined;
  }
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (
    !resultSnapshot ||
    ("isError" in resultSnapshot && resultSnapshot.isError !== false) ||
    !oneTextContent(resultSnapshot.content)
  ) return undefined;
  const details = plainOwnData(resultSnapshot.details, ["skill"]);
  if (!details || typeof details.skill !== "string" || details.skill.length === 0) return undefined;

  const argsValue = ownData(context, "args");
  if (toolName === "SlashCommand") {
    const args = plainOwnData(argsValue, ["command"]);
    if (!args || typeof args.command !== "string") return undefined;
    const requestedName = slashCommandName(args.command);
    if (!requestedName || !activationIdentityMatches(requestedName, details.skill)) return undefined;
    const command = sanitizeText(args.command, true);
    return command.length > 0 ? command : undefined;
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
  return argumentsText.length > 0 ? `${name} — ${argumentsText}` : name;
}

interface WorktreeRow {
  literals: string[];
  fields: string[];
}

function recognizeEnterWorktree(
  result: unknown,
  options: unknown,
  context: unknown,
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
  const worktreePath = sanitizeText(details.worktreePath, true);
  const branch = sanitizeText(details.branch, true);
  const previousPath = hasPrevious ? sanitizeText(details.previousWorktreePath, true) : undefined;
  const previousError = hasPreviousError ? sanitizeText(details.previousKeepError, true) : undefined;
  if (!worktreePath || !branch || (hasPrevious && !previousPath) || (hasPreviousError && !previousError)) {
    return undefined;
  }
  const seededCount = ownData(details.seeded, "length") as number;
  if (!details.created && seededCount !== 0) return undefined;
  const literals = ["EnterWorktree(", ") on branch "];
  const fields = [worktreePath, branch];
  let suffix = seededCount > 0 ? `; seeded ${seededCount} files` : "";
  if (previousPath !== undefined) {
    suffix += "; previous ";
    if (details.previousKeepOutcome === "kept") {
      literals.push(suffix, " kept; unlock attempted");
      fields.push(previousPath);
    } else if (previousError !== undefined) {
      literals.push(suffix, " keep failed: ", "; previous worktree state unknown");
      fields.push(previousPath, previousError);
    } else {
      literals.push(suffix, " keep failed; previous worktree state unknown");
      fields.push(previousPath);
    }
  } else {
    literals.push(suffix);
  }
  return { literals, fields };
}

function recognizeExitWorktree(
  result: unknown,
  options: unknown,
  context: unknown,
): WorktreeRow | undefined {
  if (ownData(options, "isPartial") !== false || ownData(context, "isError") !== false) return undefined;
  const resultSnapshot = plainOwnData(result, ["content", "details"]) ??
    plainOwnData(result, ["content", "details", "isError"]);
  if (!resultSnapshot || ("isError" in resultSnapshot && resultSnapshot.isError !== false) ||
    !oneTextContent(resultSnapshot.content)) return undefined;
  const none = plainOwnData(resultSnapshot.details, ["outcome", "restorePath"]);
  if (none) {
    if (none.outcome !== "none" || typeof none.restorePath !== "string") return undefined;
    const restorePath = sanitizeText(none.restorePath, true);
    return restorePath
      ? { literals: ["ExitWorktree(no active worktree); already at ", ""], fields: [restorePath] }
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
  const worktreePath = sanitizeText(details.worktreePath, true);
  const restorePath = sanitizeText(details.restorePath, true);
  if (!worktreePath || !restorePath) return undefined;
  if (details.outcome === "kept") {
    if (details.ok !== true || details.removed || details.orphaned || "error" in details) return undefined;
    return {
      literals: ["ExitWorktree(", ") kept; restored ", ""],
      fields: [worktreePath, restorePath],
    };
  }
  if (details.outcome === "keep-failed") {
    if (details.ok !== false || details.removed || details.orphaned) return undefined;
    if ("error" in details) {
      const error = sanitizeText(details.error, true);
      if (typeof details.error !== "string" || !error) return undefined;
      return {
        literals: [
          "ExitWorktree(", ") keep failed: ",
          "; worktree state unknown; restored ", "",
        ],
        fields: [worktreePath, error, restorePath],
      };
    }
    return {
      literals: ["ExitWorktree(", ") keep failed; worktree state unknown; restored ", ""],
      fields: [worktreePath, restorePath],
    };
  }
  if (details.outcome === "removed") {
    if (details.ok !== true || details.removed !== true || details.orphaned || "error" in details) return undefined;
    return {
      literals: ["ExitWorktree(", ") removed; restored ", ""],
      fields: [worktreePath, restorePath],
    };
  }
  if (details.outcome === "deferred-removal") {
    if (details.ok !== true || details.removed || details.orphaned !== true || "error" in details) return undefined;
    return {
      literals: ["ExitWorktree(", ") removal deferred; restored ", ""],
      fields: [worktreePath, restorePath],
    };
  }
  if (details.outcome !== "removal-failed" || details.ok !== false || details.removed || details.orphaned) {
    return undefined;
  }
  if ("error" in details) {
    const error = sanitizeText(details.error, true);
    if (typeof details.error !== "string" || !error) return undefined;
    return {
      literals: [
        "ExitWorktree(", ") removal failed: ",
        "; worktree state unknown; restored ", "",
      ],
      fields: [worktreePath, error, restorePath],
    };
  }
  return {
    literals: ["ExitWorktree(", ") removal failed; worktree state unknown; restored ", ""],
    fields: [worktreePath, restorePath],
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
      descriptor.value === "EnterWorktree" || descriptor.value === "ExitWorktree"
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

function editContext(context: unknown, lastComponent: Component | undefined): Record<string, unknown> {
  if (context === null || typeof context !== "object") return { lastComponent };
  try {
    return { ...Object.fromEntries(Object.entries(context)), lastComponent };
  } catch {
    return { lastComponent };
  }
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

function adaptEditCallRenderer(renderer: EditCallRenderer): EditCallRenderer {
  return (args, theme, context): Component => {
    const previousComponent = componentFrom(ownData(context, "lastComponent"));
    const previous = previousComponent && editCallInners.get(previousComponent);
    const inner = renderer(args, theme, editContext(context, previous) as unknown as typeof context);
    const adapted: Component = {
      render(width: number): string[] {
        const lines = inner.render(width);
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
    const path = sanitizeMutationText(boundedRawPath, true, MAX_OVERSIZED_PATH_CHARS) +
      (details.filePath.length > MAX_OVERSIZED_PATH_CHARS ? "…" : "");
    return path.length > 0 ? { kind: "oversized", path } : undefined;
  }
  if (!validateMultiEditEntries(args.edits, editCount)) return undefined;
  const path = sanitizeMutationText(details.filePath, true, MAX_MULTI_EDIT_PATH_CHARS);
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

function multiEditCall(args: unknown, theme: unknown): Component {
  const snapshot = plainOwnData(args, ["file_path", "edits"]);
  const path = sanitizeMutationText(snapshot?.file_path, true, MAX_MULTI_EDIT_PATH_CHARS);
  return commandComponent("MultiEdit", path, theme);
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
    const cwd = sanitizeText(ownData(context, "cwd"), true);
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
          return delegated.render(width);
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

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(tool);
  } catch {
    return tool;
  }
  const originalCall = descriptors.renderCall && "value" in descriptors.renderCall
    ? descriptors.renderCall.value as unknown
    : undefined;
  if (toolName === "edit") {
    if (typeof originalCall !== "function") return tool;
    delete descriptors.renderCall;
    const decoratedEdit = Object.defineProperties({}, descriptors) as T;
    Object.defineProperty(decoratedEdit, "renderCall", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: adaptEditCallRenderer(originalCall as EditCallRenderer),
    });
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
      value(args: unknown, theme: unknown): Component {
        return toolName === "MultiEdit"
          ? multiEditCall(args, theme)
          : { render: () => [] };
      },
    },
    renderResult: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(result: ResultShape, options: unknown, theme: unknown, context: unknown): Component {
        try {
          if (toolName === "MultiEdit") {
            return multiEditResult(result, options, theme, context, dependencies);
          }
          if (toolName === "EnterWorktree" || toolName === "ExitWorktree") {
            const row = toolName === "EnterWorktree"
              ? recognizeEnterWorktree(result, options, context)
              : recognizeExitWorktree(result, options, context);
            return row === undefined
              ? failOpenComponent(result, toolName, theme)
              : structuredRowComponent(row.literals, row.fields, theme);
          }
          const invocation = toolName === "WebFetch" || toolName === "WebSearch"
            ? recognizeWebSuccess(toolName, result, options, context)
            : recognizeActivationSuccess(toolName, result, options, context);
          return invocation === undefined
            ? failOpenComponent(
                result,
                toolName,
                theme,
                emptyInvocationReason(toolName, context),
              )
            : commandComponent(toolName, invocation, theme);
        } catch {
          return failOpenComponent(result, toolName, theme);
        }
      },
    },
  });
  return decorated;
}
