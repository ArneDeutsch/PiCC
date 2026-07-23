// Shared validation and ANSI tinting for Claude agent frontmatter colors.

// Pi's closed semantic theme roles cannot represent this fixed agent palette;
// fromCharCode keeps the required ANSI introducer out of the source as a literal ESC byte.
const ESC = String.fromCharCode(27);
const FG_RESET = `${ESC}[39m`;

const AGENT_COLOR_NAME_LIST = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export type AgentColorName = (typeof AGENT_COLOR_NAME_LIST)[number];
export const AGENT_COLOR_NAMES: ReadonlySet<AgentColorName> = new Set(AGENT_COLOR_NAME_LIST);

export const AGENT_COLOR_ANSI: Readonly<Record<AgentColorName, string>> = Object.freeze({
  red: `${ESC}[31m`,
  blue: `${ESC}[34m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  purple: `${ESC}[35m`,
  orange: `${ESC}[38;5;208m`,
  pink: `${ESC}[38;5;205m`,
  cyan: `${ESC}[36m`,
});

/** Return a normalized fixed-palette name; arbitrary and inherited values are ignored. */
export function normalizeAgentColor(value: unknown): AgentColorName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return Object.hasOwn(AGENT_COLOR_ANSI, normalized)
    ? (normalized as AgentColorName)
    : undefined;
}

/** Apply only the validated fixed foreground palette, resetting foreground before adjacent text. */
export function tintAgentColor(value: unknown, text: string): string {
  const color = normalizeAgentColor(value);
  if (!color || !Object.hasOwn(AGENT_COLOR_ANSI, color)) return text;
  return `${AGENT_COLOR_ANSI[color]}${text}${FG_RESET}`;
}
