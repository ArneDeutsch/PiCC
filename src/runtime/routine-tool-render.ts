import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
type RoutineToolName = WebToolName | ActivationToolName;
type DataSnapshot = Record<string, unknown>;

const MAX_FAIL_OPEN_CHARS = 4_096;
const MAX_FAIL_OPEN_LINES = 16;
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

function exactStringArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return false;
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) return false;
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

function routineToolName(tool: unknown): RoutineToolName | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  try {
    if (Object.getPrototypeOf(tool) !== Object.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(tool, "name");
    if (!descriptor || !("value" in descriptor)) return undefined;
    return descriptor.value === "WebFetch" || descriptor.value === "WebSearch" ||
      descriptor.value === "Skill" || descriptor.value === "SlashCommand"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Add guarded human-only routine presentation without changing canonical tool execution/results. */
export function withRoutineToolRendering<T extends ToolDefinition>(tool: T): T {
  const toolName = routineToolName(tool);
  if (!toolName) return tool;

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(tool);
  } catch {
    return tool;
  }
  delete descriptors.renderCall;
  delete descriptors.renderResult;
  const decorated = Object.defineProperties({}, descriptors) as T;
  Object.defineProperties(decorated, {
    renderCall: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(): Component {
        return { render: () => [] };
      },
    },
    renderResult: {
      configurable: true,
      enumerable: true,
      writable: true,
      value(result: ResultShape, options: unknown, theme: unknown, context: unknown): Component {
        try {
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
