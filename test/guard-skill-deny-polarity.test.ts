import { describe, expect, it } from "vitest";
import { createGuardExtension } from "../src/runtime/guard.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import type { HookRunner } from "../src/engine/hook-runner.js";

/**
 * REGRESSION (scenario review 2026-07-12): active-skill `disallowed-tools`
 * rules are DENY rules and must be evaluated with the same deny-direction
 * options PermissionEngine.evaluate uses (`{ anySegment: true, deny: true,
 * anchor }`) — allow-polarity matching would let a chained command
 * (`echo hi && rm -rf x`, every-segment semantics) or a leading env
 * assignment (`FOO=1 rm -rf x`, no assignment stripping) evade a
 * disallowed-tools `Bash(rm *)`. guard.ts#denyByExtraRules now passes the
 * deny-direction options; these tests pin that polarity.
 */

const noHooks = {
  fire: async () => ({ block: false, askDowngraded: false, diagnostics: [] }),
} as unknown as HookRunner;

function guardWithSkillDeny(rules: string[]) {
  const engine = new PermissionEngine(
    { allow: [], deny: [], ask: [], additionalDirectories: [] },
    { cwd: process.cwd() },
  );
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const pi = {
    on: (ev: string, fn: (e: unknown, c: unknown) => unknown) =>
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    sendMessage: () => undefined,
  };
  createGuardExtension({
    engine,
    hooks: noHooks,
    getCwd: () => process.cwd(),
    extraDenyRules: () => rules,
  })(pi);
  return async (toolName: string, input: Record<string, unknown>) => {
    let result: any;
    for (const fn of handlers.get("tool_call") ?? []) {
      const r = await fn({ toolName, toolCallId: "t", input }, {});
      if (r !== undefined) result = r;
    }
    return result;
  };
}

function guardWithSettingsDeny(deny: string[]) {
  const engine = new PermissionEngine(
    { allow: [], deny, ask: [], additionalDirectories: [] },
    { cwd: process.cwd() },
  );
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const pi = {
    on: (ev: string, fn: (e: unknown, c: unknown) => unknown) =>
      handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    sendMessage: () => undefined,
  };
  createGuardExtension({ engine, hooks: noHooks, getCwd: () => process.cwd() })(pi);
  return async (toolName: string, input: Record<string, unknown>) => {
    let result: any;
    for (const fn of handlers.get("tool_call") ?? []) {
      const r = await fn({ toolName, toolCallId: "t", input }, {});
      if (r !== undefined) result = r;
    }
    return result;
  };
}

describe("guard surfaces the Read-deny-blocks-Edit signal (v2.1.208)", () => {
  it("a Read deny blocking an Edit yields the 'Read deny rule' signal", async () => {
    const fire = guardWithSettingsDeny(["Read(secrets/**)"]);
    const blocked = await fire("Edit", { file_path: "secrets/creds.json" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("Read deny rule");
  });

  it("a MultiEdit under a Read deny yields the same signal", async () => {
    const fire = guardWithSettingsDeny(["Read(secrets/**)"]);
    const blocked = await fire("MultiEdit", { file_path: "secrets/creds.json" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("Read deny rule");
  });

  it("a skill disallow Read(...) blocking an Edit yields the same signal", async () => {
    const fire = guardWithSkillDeny(["Read(secrets/**)"]);
    const blocked = await fire("Edit", { file_path: "secrets/creds.json" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("Read deny rule");
  });

  it("an ordinary deny keeps the generic message (no false signal)", async () => {
    const fire = guardWithSettingsDeny(["Read(secrets/**)"]);
    const blocked = await fire("Read", { file_path: "secrets/creds.json" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).not.toContain("Read deny rule");
  });

  it("an Edit blocked by an Edit deny keeps the generic message (signal is Read-rule-specific)", async () => {
    const fire = guardWithSettingsDeny(["Edit(secrets/**)"]);
    const blocked = await fire("Edit", { file_path: "secrets/creds.json" });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).not.toContain("Read deny rule");
    expect(blocked?.reason).toContain("permission deny rule");
  });
});

describe("active-skill disallowed-tools must use deny polarity (guard.ts denyByExtraRules)", () => {
  it("baseline: the direct command IS blocked", async () => {
    const fire = guardWithSkillDeny(["Bash(rm *)"]);
    const direct = await fire("bash", { command: "rm -rf junk" });
    expect(direct?.block).toBe(true);
  });

  it("a chained command must not evade the rule (any-segment deny)", async () => {
    const fire = guardWithSkillDeny(["Bash(rm *)"]);
    const chained = await fire("bash", { command: "echo hi && rm -rf junk" });
    expect(chained?.block).toBe(true);
  });

  it("a leading env assignment must not evade the rule", async () => {
    const fire = guardWithSkillDeny(["Bash(rm *)"]);
    const prefixed = await fire("bash", { command: "FOO=1 rm -rf junk" });
    expect(prefixed?.block).toBe(true);
  });

  it("contrast: the SAME rule in settings deny blocks both evasion forms", async () => {
    const engine = new PermissionEngine(
      { allow: [], deny: ["Bash(rm *)"], ask: [], additionalDirectories: [] },
      { cwd: process.cwd() },
    );
    expect(
      engine.evaluate({ tool: "Bash", input: { command: "echo hi && rm -rf junk" }, cwd: process.cwd() }).decision,
    ).toBe("deny");
    expect(
      engine.evaluate({ tool: "Bash", input: { command: "FOO=1 rm -rf junk" }, cwd: process.cwd() }).decision,
    ).toBe("deny");
  });
});
