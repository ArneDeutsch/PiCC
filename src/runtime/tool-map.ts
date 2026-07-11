import type { ToolCallDescriptor } from "../types.js";

/**
 * Claude ⇄ Pi tool-name mapping (design doc §3.2).
 *
 * The permission/hook/gating layer operates on Claude tool names; Pi built-ins are
 * lower-case. Our own registered tools keep Claude names verbatim and need no mapping.
 */
const PI_TO_CLAUDE: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

const CLAUDE_TO_PI: Record<string, string[]> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  Bash: ["bash"],
  Grep: ["grep"],
  Glob: ["find", "ls"],
};

export function toClaudeToolName(piName: string): string {
  return PI_TO_CLAUDE[piName] ?? piName;
}

/** Pi built-in names granted by a list of Claude tool names (unknown names pass through). */
export function claudeToolsToPiBuiltins(claudeNames: string[]): string[] {
  const out = new Set<string>();
  for (const name of claudeNames) {
    const base = name.replace(/\(.*\)$/, "").trim();
    if (base === "*") return ["read", "write", "edit", "bash", "grep", "find", "ls"];
    for (const pi of CLAUDE_TO_PI[base] ?? []) out.add(pi);
  }
  return [...out];
}

/**
 * Build a Claude-shaped ToolCallDescriptor from a Pi tool call for permission/hook
 * matching. Pi built-ins use `path`; Claude matchers expect `file_path`.
 */
export function toClaudeCall(
  piToolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ToolCallDescriptor {
  const tool = toClaudeToolName(piToolName);
  const mapped: Record<string, unknown> = { ...input };
  if (mapped.file_path === undefined && typeof mapped.path === "string") {
    mapped.file_path = mapped.path;
  }
  return { tool, input: mapped, cwd };
}

/**
 * Apply a hook's `updatedInput` (Claude-shaped) back onto a live Pi tool input,
 * translating `file_path` back to `path` for Pi built-ins. Mutates `input` in place
 * (Pi's tool_call contract).
 */
export function applyUpdatedInput(
  piToolName: string,
  input: Record<string, unknown>,
  updated: Record<string, unknown>,
): void {
  const isBuiltin = piToolName in PI_TO_CLAUDE;
  for (const [key, value] of Object.entries(updated)) {
    if (isBuiltin && key === "file_path") {
      input.path = value;
    } else {
      input[key] = value;
    }
  }
}

/** File path touched by a tool call (for nested CLAUDE.md / path-scoped rule injection). */
export function touchedFilePath(piToolName: string, input: Record<string, unknown>): string | undefined {
  const tool = toClaudeToolName(piToolName);
  if (["Read", "Write", "Edit"].includes(tool)) {
    const p = input.file_path ?? input.path;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}
