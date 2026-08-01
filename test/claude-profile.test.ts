import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveClaudeProfile } from "../src/discovery/claude-profile.js";

const HOME = path.resolve("/injected/home");
const PICC = path.resolve("/profiles/picc");
const CLAUDE = path.resolve("/profiles/claude-config");
const EXPLICIT = path.resolve("/profiles/explicit");

describe("resolveClaudeProfile", () => {
  it.each([
    ["PiCC override", { PICC_CLAUDE_USER_DIR: PICC, CLAUDE_CONFIG_DIR: CLAUDE }, PICC, "picc-override"],
    ["Claude config directory", { CLAUDE_CONFIG_DIR: CLAUDE }, CLAUDE, "claude-config"],
    ["default home", {}, path.join(HOME, ".claude"), "default"],
  ] as const)("selects %s with one coherent user directory", (_label, env, userDir, source) => {
    const result = resolveClaudeProfile({ env, homeDir: HOME });
    expect(result).toMatchObject({ userDir, source });
    expect(result.nativeStatePath).toBe(
      source === "default" ? path.join(HOME, ".claude.json") : path.join(userDir, ".claude.json"),
    );
  });

  it("treats an explicit project-loader directory like the PiCC override", () => {
    expect(resolveClaudeProfile({
      userDir: EXPLICIT,
      env: { PICC_CLAUDE_USER_DIR: PICC, CLAUDE_CONFIG_DIR: CLAUDE },
      homeDir: HOME,
    })).toEqual({
      userDir: EXPLICIT,
      nativeStatePath: path.join(EXPLICIT, ".claude.json"),
      source: "explicit",
    });
  });

  it.each([
    ["empty CLAUDE_CONFIG_DIR", undefined, { CLAUDE_CONFIG_DIR: "" }, path.join(HOME, ".claude"), path.join(HOME, ".claude.json"), "default"],
    ["both environment overrides empty", undefined, { PICC_CLAUDE_USER_DIR: "  ", CLAUDE_CONFIG_DIR: "" }, path.join(HOME, ".claude"), path.join(HOME, ".claude.json"), "default"],
    ["empty explicit falls through to PiCC", "", { PICC_CLAUDE_USER_DIR: PICC, CLAUDE_CONFIG_DIR: CLAUDE }, PICC, path.join(PICC, ".claude.json"), "picc-override"],
    ["whitespace explicit falls through to Claude config", "  ", { PICC_CLAUDE_USER_DIR: "", CLAUDE_CONFIG_DIR: CLAUDE }, CLAUDE, path.join(CLAUDE, ".claude.json"), "claude-config"],
    ["empty explicit and overrides fall through home", "", { PICC_CLAUDE_USER_DIR: "", CLAUDE_CONFIG_DIR: " " }, path.join(HOME, ".claude"), path.join(HOME, ".claude.json"), "default"],
  ] as const)("handles %s", (_label, userDir, env, expectedUserDir, nativeStatePath, source) => {
    expect(resolveClaudeProfile({ userDir, env, homeDir: HOME })).toEqual({
      userDir: expectedUserDir,
      nativeStatePath,
      source,
    });
  });

  it("never selects lower-priority canary locations", () => {
    const selected = resolveClaudeProfile({
      env: { PICC_CLAUDE_USER_DIR: PICC, CLAUDE_CONFIG_DIR: CLAUDE },
      homeDir: HOME,
    });
    expect(JSON.stringify(selected)).not.toContain(CLAUDE);
    expect(JSON.stringify(selected)).not.toContain(HOME);
  });
});
