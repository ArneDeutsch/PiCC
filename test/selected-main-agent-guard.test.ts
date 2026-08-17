import path from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/engine/permissions.js";
import { createGuardExtension } from "../src/runtime/guard.js";
import {
  SelectedMainAgentToolPolicy,
  createSelectedMainAgentRuntimeSnapshot,
} from "../src/runtime/selected-main-agent-runtime.js";
import type { ClaudeAgent, PermissionRules } from "../src/types.js";

const CWD = process.cwd();

function rules(): PermissionRules {
  return { allow: [], deny: [], ask: [], additionalDirectories: [] };
}

function agent(overrides: Partial<ClaudeAgent>): ClaudeAgent {
  return {
    name: "selected",
    description: "selected",
    body: "selected body",
    metadata: {},
    source: { path: "/project/.claude/agents/selected.md", scope: "project" },
    unknownKeys: [],
    diagnostics: [],
    toolRestrictionValidation: { tools: "absent", disallowedTools: "absent" },
    ...overrides,
  };
}

function selectedPolicy(definition: ClaudeAgent): SelectedMainAgentToolPolicy {
  const snapshot = createSelectedMainAgentRuntimeSnapshot({
    kind: "selected",
    source: "settings",
    requestedName: definition.name,
    agent: definition,
    appendSelectionEntry: true,
  })!;
  return new SelectedMainAgentToolPolicy(
    snapshot,
    new PermissionEngine(rules(), { cwd: CWD }),
    ["general-purpose", "reviewer"],
  );
}

function guardHarness(
  policy: SelectedMainAgentToolPolicy,
  updatedInput?: Record<string, unknown>,
  contextForTouchedFile?: (filePath: string) => string | undefined,
) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let hookCalls = 0;
  const hooks = {
    fire: async () => {
      hookCalls += 1;
      return updatedInput === undefined ? {} : { updatedInput };
    },
  };
  createGuardExtension({
    engine: new PermissionEngine(rules(), { cwd: CWD }),
    hooks: hooks as never,
    getCwd: () => CWD,
    selectedSessionPolicy: (call) => policy.evaluateCall(call),
    contextForTouchedFile,
  })({
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: () => undefined,
  });
  return {
    invoke: async (toolName: string, input: Record<string, unknown>) =>
      handlers.get("tool_call")!({ toolName, input }, {}),
    hookCalls: () => hookCalls,
  };
}

describe("selected main-agent guard", () => {
  it("blocks visible-but-scoped ordinary and MCP calls before hooks", async () => {
    const policy = selectedPolicy(agent({
      tools: ["Bash(git *)", "mcp__github__read_*"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    const harness = guardHarness(policy);

    await expect(harness.invoke("bash", { command: "npm test" })).resolves.toMatchObject({
      block: true,
      reason: "PiCC: blocked by selected main-session capability policy",
    });
    await expect(harness.invoke("mcp__github__write_issue", { title: "hostile" }))
      .resolves.toMatchObject({ block: true });
    expect(harness.hookCalls()).toBe(0);

    await expect(harness.invoke("bash", { command: "git status" })).resolves.toBeUndefined();
    await expect(harness.invoke("mcp__github__read_issue", { issue: 1 })).resolves.toBeUndefined();
    expect(harness.hookCalls()).toBe(2);
  });

  it("uses either selected alias for every Agent/Task omitted and explicit type combination", async () => {
    for (const declaredAlias of ["Agent", "Task"]) {
      const policy = selectedPolicy(agent({
        tools: [`${declaredAlias}(general-purpose, reviewer)`],
        toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
      }));
      const harness = guardHarness(policy);
      for (const invokedAlias of ["Agent", "Task"]) {
        await expect(harness.invoke(invokedAlias, {})).resolves.toBeUndefined();
        await expect(harness.invoke(invokedAlias, { subagent_type: "reviewer" })).resolves.toBeUndefined();
      }
      await expect(harness.invoke("Agent", { subagent_type: "writer" }))
        .resolves.toMatchObject({ block: true });
      await expect(harness.invoke("Task", { subagent_type: { toString: () => "reviewer" } }))
        .resolves.toMatchObject({ block: true });
      expect(harness.hookCalls()).toBe(4);
    }
  });

  it("uses only the executor-consumed built-in path before hooks", async () => {
    const policy = selectedPolicy(agent({
      tools: ["Read(public/**)"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    const harness = guardHarness(policy);
    const publicPath = path.join(CWD, "public", "safe.txt");
    const secretPath = path.join(CWD, "secret", "key.txt");

    await expect(harness.invoke("read", { path: publicPath, file_path: secretPath }))
      .resolves.toBeUndefined();
    await expect(harness.invoke("read", { path: secretPath, file_path: publicPath }))
      .resolves.toMatchObject({ block: true });
    await expect(harness.invoke("read", { file_path: publicPath }))
      .resolves.toMatchObject({ block: true });
    await expect(harness.invoke("read", { path: 42, file_path: publicPath }))
      .resolves.toMatchObject({ block: true });
    await expect(harness.invoke("Read", { file_path: publicPath }))
      .resolves.toBeUndefined();
    expect(harness.hookCalls()).toBe(2);
  });

  it("never uses conflicting built-in path aliases for touched-file context", async () => {
    const policy = selectedPolicy(agent({}));
    const publicPath = path.join(CWD, "public", "safe.txt");
    const secretPath = path.join(CWD, "secret", "key.txt");
    const touchedBefore: string[] = [];
    const before = guardHarness(policy, undefined, (filePath) => {
      touchedBefore.push(filePath);
      return `context:${filePath}`;
    });
    const staleInput = { path: publicPath, file_path: secretPath };
    await expect(before.invoke("read", staleInput)).resolves.toBeUndefined();
    expect(touchedBefore).toEqual([publicPath]);

    const touchedAfter: string[] = [];
    const after = guardHarness(policy, {
      file_path: secretPath,
      path: publicPath,
    }, (filePath) => {
      touchedAfter.push(filePath);
      return `context:${filePath}`;
    });
    const rewrittenInput: Record<string, unknown> = { path: publicPath, file_path: secretPath };
    await expect(after.invoke("read", rewrittenInput)).resolves.toBeUndefined();
    expect(touchedAfter).toEqual([publicPath]);
    expect(rewrittenInput).toEqual({ path: publicPath });
  });

  it("uses the final executor path after conflicting hook updatedInput aliases", async () => {
    const definition = agent({
      tools: ["Read(public/**)"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    });
    const publicPath = path.join(CWD, "public", "safe.txt");
    const secretPath = path.join(CWD, "secret", "key.txt");

    const denied = guardHarness(selectedPolicy(definition), {
      file_path: publicPath,
      path: secretPath,
    });
    await expect(denied.invoke("read", { path: publicPath })).resolves.toMatchObject({
      block: true,
      reason: "PiCC: blocked by selected main-session capability policy (after PreToolUse updatedInput)",
    });

    const allowed = guardHarness(selectedPolicy(definition), {
      file_path: secretPath,
      path: publicPath,
    });
    await expect(allowed.invoke("read", { path: publicPath })).resolves.toBeUndefined();

    const denyDefinition = agent({
      disallowedTools: ["Read(secret/**)"],
      toolRestrictionValidation: { tools: "absent", disallowedTools: "valid" },
    });
    const denyConflict = guardHarness(selectedPolicy(denyDefinition), {
      file_path: publicPath,
      path: secretPath,
    });
    await expect(denyConflict.invoke("read", { path: publicPath })).resolves.toMatchObject({
      block: true,
      reason: "PiCC: blocked by selected main-session capability policy (after PreToolUse updatedInput)",
    });
    const denyAliasIgnored = guardHarness(selectedPolicy(denyDefinition), {
      file_path: secretPath,
      path: publicPath,
    });
    await expect(denyAliasIgnored.invoke("read", { path: publicPath })).resolves.toBeUndefined();
  });

  it.each([
    {
      label: "Bash command",
      definition: agent({
        tools: ["Bash(git *)"],
        toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
      }),
      toolName: "bash",
      input: { command: "git status" },
      updatedInput: { command: "rm -rf output" },
    },
    {
      label: "file path",
      definition: agent({
        tools: ["Read(public/**)"],
        toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
      }),
      toolName: "read",
      input: { path: path.join(CWD, "public", "safe.txt") },
      updatedInput: { file_path: path.join(CWD, "secret", "key.txt") },
    },
    {
      label: "Agent type",
      definition: agent({
        tools: ["Agent(general-purpose)"],
        toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
      }),
      toolName: "Agent",
      input: {},
      updatedInput: { subagent_type: "reviewer" },
    },
  ])("rechecks a hook rewrite of an allowed $label call", async ({ definition, toolName, input, updatedInput }) => {
    const harness = guardHarness(selectedPolicy(definition), updatedInput);
    await expect(harness.invoke(toolName, input)).resolves.toEqual({
      block: true,
      reason: "PiCC: blocked by selected main-session capability policy (after PreToolUse updatedInput)",
    });
    expect(harness.hookCalls()).toBe(1);
  });

  it("fails closed when the installed policy callback throws and does not run hooks", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let hookCalls = 0;
    createGuardExtension({
      engine: new PermissionEngine(rules(), { cwd: CWD }),
      hooks: { fire: async () => { hookCalls += 1; return {}; } } as never,
      getCwd: () => CWD,
      selectedSessionPolicy: () => { throw new Error("hostile policy"); },
    })({
      on: (event, handler) => handlers.set(event, handler),
      sendMessage: () => undefined,
    });
    await expect(handlers.get("tool_call")!({ toolName: "read", input: {} }, {}))
      .resolves.toMatchObject({ block: true });
    expect(hookCalls).toBe(0);
  });
});
