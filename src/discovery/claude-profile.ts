import os from "node:os";
import path from "node:path";
import type { ClaudeProfileSource } from "../types.js";

export interface ClaudeProfile {
  userDir: string;
  nativeStatePath: string;
  source: ClaudeProfileSource;
}

export interface ResolveClaudeProfileOptions {
  userDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/** Resolve one coherent Claude profile without reading any profile contents. */
export function resolveClaudeProfile(options: ResolveClaudeProfileOptions = {}): ClaudeProfile {
  const env = options.env ?? process.env;
  const explicit = nonEmpty(options.userDir);
  const piccOverride = nonEmpty(env.PICC_CLAUDE_USER_DIR);
  const claudeConfig = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const home = path.resolve(options.homeDir ?? os.homedir());
  const selected = explicit ?? piccOverride ?? claudeConfig;
  if (selected !== undefined) {
    const userDir = path.resolve(selected);
    return {
      userDir,
      nativeStatePath: path.join(userDir, ".claude.json"),
      source: explicit !== undefined
        ? "explicit"
        : piccOverride !== undefined
          ? "picc-override"
          : "claude-config",
    };
  }
  return {
    userDir: path.join(home, ".claude"),
    nativeStatePath: path.join(home, ".claude.json"),
    source: "default",
  };
}
