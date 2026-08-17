import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/engine/permissions.js";
import {
  SELECTED_MAIN_AGENT_ADMISSION_RECOVERY,
  SelectedMainAgentActiveToolReconciler,
  SelectedMainAgentToolPolicy,
  createSelectedMainAgentRuntimeSnapshot,
} from "../src/runtime/selected-main-agent-runtime.js";
import type { SelectedMainAgentResolution } from "../src/runtime/selected-main-agent-selection.js";
import type { ClaudeAgent, PermissionRules, ToolCallDescriptor } from "../src/types.js";

const CWD = process.cwd();

function agent(overrides: Partial<ClaudeAgent> = {}): ClaudeAgent {
  return {
    name: "reviewer",
    description: "reviewer description",
    body: "reviewer body",
    metadata: { nested: { retained: true } },
    source: { path: "/project/.claude/agents/reviewer.md", scope: "project" },
    unknownKeys: [],
    diagnostics: [],
    toolRestrictionValidation: { tools: "absent", disallowedTools: "absent" },
    ...overrides,
  };
}

function selected(definition = agent()): SelectedMainAgentResolution {
  return {
    kind: "selected",
    source: "cli",
    requestedName: definition.name,
    agent: definition,
    appendSelectionEntry: true,
  };
}

function rules(partial: Partial<PermissionRules> = {}): PermissionRules {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], ...partial };
}

function policy(
  definition: ClaudeAgent,
  options: { permissionRules?: Partial<PermissionRules>; subagentTypes?: string[] } = {},
): SelectedMainAgentToolPolicy {
  const snapshot = createSelectedMainAgentRuntimeSnapshot(selected(definition));
  if (snapshot === undefined) throw new Error("expected selected snapshot");
  return new SelectedMainAgentToolPolicy(
    snapshot,
    new PermissionEngine(rules(options.permissionRules), { cwd: CWD }),
    options.subagentTypes ?? ["general-purpose", "reviewer", "writer"],
  );
}

function call(tool: string, input: Record<string, unknown> = {}): ToolCallDescriptor {
  return { tool, input, cwd: CWD };
}

describe("selected main-agent runtime snapshots", () => {
  it("copies and freezes every retained selected capability without mutating the definition", () => {
    const tools = ["Bash(git *)", "Agent(reviewer)"];
    const disallowedTools = ["Write"];
    const skills = ["audit"];
    const metadata = { nested: { retained: true } };
    const memory = { project: [{ path: "MEMORY.md" }] };
    const hooks = {
      PreToolUse: [{
        matcher: "Read",
        hooks: [{ type: "command" as const, command: "check", raw: { command: "check" } }],
      }],
    };
    const agentMcp = {
      scope: "project" as const,
      items: [{ kind: "reference" as const, name: "server" }],
      diagnostics: [],
      diagnosticOwnership: [{ kind: "server" as const, serverName: "server" }],
    };
    const source = { path: "/project/.claude/agents/reviewer.md", scope: "project" as const };
    const definition = agent({
      tools,
      disallowedTools,
      toolRestrictionValidation: { tools: "valid", disallowedTools: "valid" },
      model: "openai/gpt-5",
      effort: "high",
      permissionMode: "default",
      skills,
      memory,
      hooks,
      agentMcp,
      initialPrompt: "begin",
      metadata,
      maxTurns: 3,
      background: false,
      isolation: "worktree",
      color: "blue",
      source,
    });

    const snapshot = createSelectedMainAgentRuntimeSnapshot(selected(definition));
    expect(snapshot).toMatchObject({
      kind: "selected",
      requestedName: "reviewer",
      resolvedName: "reviewer",
      selectorSource: "cli",
      body: "reviewer body",
      tools,
      disallowedTools,
      model: "openai/gpt-5",
      effort: "high",
      permissionMode: "default",
      skills: ["audit"],
      initialPrompt: "begin",
      unsupported: [
        "max-turns-unsupported-for-main",
        "background-unsupported-for-main",
        "isolation-unsupported-for-main",
        "color-unsupported-for-main",
      ],
      diagnostic: { reason: "selected-agent-active", agentIdentity: "reviewer" },
    });
    tools.push("Write");
    disallowedTools.push("Read");
    skills.push("write");
    metadata.nested.retained = false;
    memory.project[0]!.path = "changed.md";
    hooks.PreToolUse[0]!.hooks[0]!.command = "changed";
    agentMcp.items[0]!.name = "changed";
    source.path = "/changed";
    expect(snapshot?.kind === "selected" && snapshot.tools).toEqual(["Bash(git *)", "Agent(reviewer)"]);
    expect(snapshot?.kind === "selected" && snapshot.disallowedTools).toEqual(["Write"]);
    expect(snapshot?.kind === "selected" && snapshot.skills).toEqual(["audit"]);
    expect(snapshot?.kind === "selected" && snapshot.metadata).toEqual({ nested: { retained: true } });
    expect(snapshot?.kind === "selected" && snapshot.memory).toEqual({ project: [{ path: "MEMORY.md" }] });
    expect(snapshot?.kind === "selected" && snapshot.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe("check");
    expect(snapshot?.kind === "selected" && snapshot.agentMcp?.items[0]).toMatchObject({ name: "server" });
    expect(snapshot?.kind === "selected" && snapshot.source.path).toBe("/project/.claude/agents/reviewer.md");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.tools)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.disallowedTools)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.skills)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.unsupported)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.diagnostic)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.metadata)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen((snapshot.metadata as any).nested)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.memory)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen((snapshot.memory as any).project)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen((snapshot.memory as any).project[0])).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.hooks)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.hooks?.PreToolUse)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.hooks?.PreToolUse?.[0]?.hooks[0])).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.agentMcp)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.agentMcp?.items)).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.agentMcp?.items[0])).toBe(true);
    expect(snapshot?.kind === "selected" && Object.isFrozen(snapshot.source)).toBe(true);
  });

  it("maps persisted recovery to no-tools fallback without stale selected fields", () => {
    for (const resolution of [
      { kind: "missing-persisted", requestedName: "removed" } as const,
      { kind: "persisted-uncertain" } as const,
    ]) {
      const snapshot = createSelectedMainAgentRuntimeSnapshot(resolution);
      expect(snapshot).toMatchObject({
        kind: "safe-fallback",
        tools: [],
        subagentTypes: [],
      });
      for (const field of [
        "body", "model", "effort", "permissionMode", "hooks", "agentMcp", "skills", "memory",
        "initialPrompt", "unsupported", "disallowedTools",
      ]) expect(snapshot).not.toHaveProperty(field);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot?.tools)).toBe(true);
      expect(snapshot?.kind === "safe-fallback" || snapshot?.kind === "admission-denied").toBe(true);
      if (snapshot?.kind === "safe-fallback" || snapshot?.kind === "admission-denied") {
        expect(Object.isFrozen(snapshot.subagentTypes)).toBe(true);
      }
      expect(Object.isFrozen(snapshot?.diagnostic)).toBe(true);
    }
  });

  it("blocks provider input for a missing fresh selection with immutable recovery state", () => {
    const snapshot = createSelectedMainAgentRuntimeSnapshot({
      kind: "missing-fresh",
      source: "settings",
      requestedName: "missing",
    });
    expect(snapshot).toMatchObject({
      kind: "admission-denied",
      providerInputBlocked: true,
      recoveryText: SELECTED_MAIN_AGENT_ADMISSION_RECOVERY,
      tools: [],
      subagentTypes: [],
    });
    for (const field of [
      "body", "model", "effort", "permissionMode", "hooks", "agentMcp", "skills", "memory",
      "initialPrompt", "unsupported", "disallowedTools",
    ]) expect(snapshot).not.toHaveProperty(field);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot?.kind === "admission-denied" && Object.isFrozen(snapshot.tools)).toBe(true);
    expect(snapshot?.kind === "admission-denied" && Object.isFrozen(snapshot.subagentTypes)).toBe(true);
    expect(Object.isFrozen(snapshot?.diagnostic)).toBe(true);
    expect(createSelectedMainAgentRuntimeSnapshot({ kind: "none" })).toBeUndefined();
  });

  it.each(["tools", "disallowedTools"] as const)(
    "fails closed for every %s restriction-provenance contradiction",
    (field) => {
      const validation = (
        value: "valid" | "invalid" | "absent",
      ): NonNullable<ClaudeAgent["toolRestrictionValidation"]> => field === "tools"
        ? { tools: value, disallowedTools: "absent" }
        : { tools: "absent", disallowedTools: value };
      const cases: Array<{ label: string; definition: ClaudeAgent; reason: string }> = [
        {
          label: "invalid",
          definition: agent({
            [field]: ["Read"],
            toolRestrictionValidation: validation("invalid"),
          }),
          reason: "selected-agent-tool-restrictions-invalid",
        },
        {
          label: "missing validation",
          definition: agent({ [field]: ["Read"], toolRestrictionValidation: undefined }),
          reason: "selected-agent-tool-restrictions-uncertain",
        },
        {
          label: "valid with absent value",
          definition: agent({
            [field]: undefined,
            toolRestrictionValidation: validation("valid"),
          }),
          reason: "selected-agent-tool-restrictions-uncertain",
        },
        {
          label: "valid with non-string value",
          definition: agent({
            [field]: ["Read", 42] as unknown as string[],
            toolRestrictionValidation: validation("valid"),
          }),
          reason: "selected-agent-tool-restrictions-uncertain",
        },
        {
          label: "absent with present value",
          definition: agent({
            [field]: ["Read"],
            toolRestrictionValidation: validation("absent"),
          }),
          reason: "selected-agent-tool-restrictions-uncertain",
        },
      ];
      for (const { label, definition, reason } of cases) {
        const snapshot = createSelectedMainAgentRuntimeSnapshot(selected(definition));
        expect(snapshot, label).toMatchObject({
          kind: "admission-denied",
          providerInputBlocked: true,
          recoveryText: SELECTED_MAIN_AGENT_ADMISSION_RECOVERY,
          tools: [],
          subagentTypes: [],
          diagnostic: { reason },
        });
        expect(Object.isFrozen(snapshot), label).toBe(true);
        expect(snapshot?.kind === "admission-denied" && Object.isFrozen(snapshot.tools), label).toBe(true);
        expect(snapshot?.kind === "admission-denied" && Object.isFrozen(snapshot.subagentTypes), label).toBe(true);
        expect(Object.isFrozen(snapshot?.diagnostic), label).toBe(true);
        for (const stale of [
          "body", "model", "effort", "permissionMode", "hooks", "agentMcp", "skills", "memory",
          "initialPrompt", "unsupported", "disallowedTools",
        ]) expect(snapshot, label).not.toHaveProperty(stale);
      }
    },
  );

  it("bounds and sanitizes diagnostic identity without forwarding project diagnostics", () => {
    const name = `${"😀".repeat(130)}\u202Ehidden\u200B\nSECRET`;
    const snapshot = createSelectedMainAgentRuntimeSnapshot(selected(agent({ name })));
    const identity = snapshot?.diagnostic.agentIdentity ?? "";
    expect(Array.from(identity)).toHaveLength(128);
    expect(identity).not.toMatch(/[\n\u202E\u200B]/u);
    expect(identity.endsWith("…")).toBe(true);
    expect(snapshot).not.toHaveProperty("diagnostics");
  });
});

describe("selected main-agent tool policy", () => {
  it("keeps scoped grants visible while enforcing bare, wildcard, scoped, and MCP calls", () => {
    const scoped = policy(agent({
      tools: ["Bash(git *)", "Read", "mcp__github", "Agent(reviewer)"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    expect(scoped.activeToolNames(["bash", "read", "mcp__github__issue", "Agent", "write"]))
      .toEqual(["bash", "read", "mcp__github__issue", "Agent"]);
    expect(scoped.evaluateCall(call("Bash", { command: "git status" })).allowed).toBe(true);
    expect(scoped.evaluateCall(call("Bash", { command: "npm test" })).allowed).toBe(false);
    expect(scoped.evaluateCall(call("Read", { file_path: "a.ts" })).allowed).toBe(true);
    expect(scoped.evaluateCall(call("mcp__github__issue", { title: "x" })).allowed).toBe(true);

    const wildcard = policy(agent({
      tools: ["*"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    expect(wildcard.evaluateCall(call("Write", { file_path: "a" })).allowed).toBe(true);
  });

  it("uses deny-direction scoped matching and permission bare-deny removal", () => {
    const selectedPolicy = policy(agent({
      disallowedTools: ["Bash(rm *)", "Read(secret/**)"],
      toolRestrictionValidation: { tools: "absent", disallowedTools: "valid" },
    }), { permissionRules: { deny: ["Write"] } });
    expect(selectedPolicy.activeToolNames(["bash", "read", "write", "edit"]))
      .toEqual(["bash", "read", "edit"]);
    expect(selectedPolicy.evaluateCall(call("Bash", { command: "echo ok && rm -rf out" })).allowed).toBe(false);
    expect(selectedPolicy.evaluateCall(call("Read", { file_path: "secret/key" })).allowed).toBe(false);
    expect(selectedPolicy.evaluateCall(call("Read", { file_path: "public/key" })).allowed).toBe(true);
    expect(selectedPolicy.evaluateCall(call("Write", { file_path: "public/key" })).allowed).toBe(false);
  });

  it("derives one aliased Agent/Task type set from comma, whitespace, wildcard, and omitted forms", () => {
    const selectedPolicy = policy(agent({
      tools: ["Task(general-purpose, review* writer)"],
      disallowedTools: ["Agent(writer)"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "valid" },
    }));
    expect(selectedPolicy.activeToolNames(["Agent", "Task", "read"])).toEqual(["Agent", "Task"]);
    expect(selectedPolicy.catalogSubagentTypes()).toEqual(["general-purpose", "reviewer"]);
    for (const tool of ["Agent", "Task"]) {
      expect(selectedPolicy.evaluateCall(call(tool, {})).allowed).toBe(true);
      expect(selectedPolicy.evaluateCall(call(tool, { subagent_type: "reviewer" })).allowed).toBe(true);
      expect(selectedPolicy.evaluateCall(call(tool, { subagent_type: "writer" })).allowed).toBe(false);
    }
    expect(selectedPolicy.evaluateCall(call("Agent", { subagent_type: ["reviewer"] })).allowed).toBe(false);
    expect(selectedPolicy.evaluateCall(call("Task", { subagent_type: "not-in-catalog" })).allowed).toBe(false);
  });

  it("keeps parameter-scoped Agent grants in the catalog and enforces concrete parameters", () => {
    const selectedPolicy = policy(agent({
      tools: ["Agent(run_in_background:false)"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    expect(selectedPolicy.activeToolNames(["Agent", "Task", "read"])).toEqual(["Agent", "Task"]);
    expect(selectedPolicy.catalogSubagentTypes()).toEqual(["general-purpose", "reviewer", "writer"]);
    for (const tool of ["Agent", "Task"]) {
      expect(selectedPolicy.evaluateCall(call(tool, { run_in_background: false })).allowed).toBe(true);
      expect(selectedPolicy.evaluateCall(call(tool, {
        subagent_type: "reviewer",
        run_in_background: false,
      })).allowed).toBe(true);
      expect(selectedPolicy.evaluateCall(call(tool, { run_in_background: true })).allowed).toBe(false);
      expect(selectedPolicy.evaluateCall(call(tool, {})).allowed).toBe(false);
    }

    const parameterDeny = policy(agent({
      disallowedTools: ["Task(run_in_background:true)"],
      toolRestrictionValidation: { tools: "absent", disallowedTools: "valid" },
    }));
    expect(parameterDeny.catalogSubagentTypes()).toEqual(["general-purpose", "reviewer", "writer"]);
    expect(parameterDeny.evaluateCall(call("Agent", { run_in_background: false })).allowed).toBe(true);
    expect(parameterDeny.evaluateCall(call("Task", { run_in_background: true })).allowed).toBe(false);
  });

  it("applies selected bare and scoped-wildcard disallowed rules to both Agent aliases", () => {
    const bare = policy(agent({
      disallowedTools: ["Agent"],
      toolRestrictionValidation: { tools: "absent", disallowedTools: "valid" },
    }));
    expect(bare.activeToolNames(["Agent", "Task", "read"])).toEqual(["read"]);
    expect(bare.catalogSubagentTypes()).toEqual([]);
    expect(bare.evaluateCall(call("Task", {})).allowed).toBe(false);

    const wildcard = policy(agent({
      disallowedTools: ["Task(*)"],
      toolRestrictionValidation: { tools: "absent", disallowedTools: "valid" },
    }));
    expect(wildcard.activeToolNames(["Agent", "Task"])).toEqual(["Agent", "Task"]);
    expect(wildcard.catalogSubagentTypes()).toEqual([]);
    expect(wildcard.evaluateCall(call("Agent", {})).allowed).toBe(false);
    expect(wildcard.evaluateCall(call("Task", { subagent_type: "reviewer" })).allowed).toBe(false);
  });

  it("makes fallback and admission-denied snapshots deny every active name and call", () => {
    for (const resolution of [
      { kind: "persisted-uncertain" } as const,
      { kind: "missing-fresh", source: "cli", requestedName: "gone" } as const,
    ]) {
      const snapshot = createSelectedMainAgentRuntimeSnapshot(resolution)!;
      const selectedPolicy = new SelectedMainAgentToolPolicy(
        snapshot,
        new PermissionEngine(rules(), { cwd: CWD }),
        ["general-purpose"],
      );
      expect(selectedPolicy.activeToolNames(["bash", "Agent"])).toEqual([]);
      expect(selectedPolicy.catalogSubagentTypes()).toEqual([]);
      expect(selectedPolicy.evaluateCall(call("Read", {})).allowed).toBe(false);
    }
  });
});

describe("selected main-agent active-tool reconciliation", () => {
  function successfulActive(result: ReturnType<SelectedMainAgentActiveToolReconciler["reconcile"]>) {
    expect(result.ok).toBe(true);
    return result.ok ? result.activeTools : [];
  }

  function host(initial: string[]) {
    let active = [...initial];
    return {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = [...names]; },
      active: () => [...active],
      userSet: (names: string[]) => { active = [...names]; },
    };
  }

  it("preserves the initial CLI ceiling, exclusions, and no-tools state", () => {
    const bashOnly = policy(agent({
      tools: ["Bash"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    const cliHost = host(["bash", "read"]);
    const reconciler = new SelectedMainAgentActiveToolReconciler(cliHost, bashOnly);
    expect(successfulActive(reconciler.reconcile(["bash", "read", "write"]))).toEqual(["bash"]);
    reconciler.setPolicy(undefined);
    expect(successfulActive(reconciler.reconcile(["bash", "read", "write"]))).toEqual(["bash", "read"]);

    const noToolsHost = host([]);
    const noTools = new SelectedMainAgentActiveToolReconciler(noToolsHost, bashOnly);
    expect(successfulActive(noTools.reconcile(["bash", "read"]))).toEqual([]);
  });

  it("captures active late registration and restores only observable ceiling names across swaps", () => {
    const bashOnly = policy(agent({
      tools: ["Bash"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    const readOnly = policy(agent({
      tools: ["Read"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    const pi = host(["bash", "read"]);
    const reconciler = new SelectedMainAgentActiveToolReconciler(pi, bashOnly);
    expect(successfulActive(reconciler.reconcile(["bash", "read", "mcp__srv__tool"]))).toEqual(["bash"]);

    pi.userSet(["bash", "mcp__srv__tool"]);
    expect(successfulActive(reconciler.reconcile(["bash", "read", "mcp__srv__tool"]))).toEqual(["bash"]);
    reconciler.setPolicy(readOnly);
    expect(successfulActive(reconciler.reconcile(["bash", "read", "mcp__srv__tool"]))).toEqual(["read"]);
    reconciler.setPolicy(undefined);
    expect(successfulActive(reconciler.reconcile(["bash", "read", "mcp__srv__tool"]))).toEqual([
      "bash", "read", "mcp__srv__tool",
    ]);
  });

  it("observes disabling a visible tool but does not invent provenance for a hidden one", () => {
    const unrestricted = policy(agent());
    const pi = host(["bash", "read"]);
    const reconciler = new SelectedMainAgentActiveToolReconciler(pi, unrestricted);
    reconciler.reconcile(["bash", "read"]);
    pi.userSet(["bash"]);
    expect(successfulActive(reconciler.reconcile(["bash", "read"]))).toEqual(["bash"]);
    reconciler.setPolicy(undefined);
    expect(successfulActive(reconciler.reconcile(["bash", "read"]))).toEqual(["bash"]);
  });

  it.each(["before", "after"] as const)(
    "settles a setter throw-%s-apply transaction before retry success and restoration",
    (throwPoint) => {
      const bashOnly = policy(agent({
        tools: ["Bash"],
        toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
      }));
      let active = ["bash", "read"];
      let firstSet = true;
      const reconciler = new SelectedMainAgentActiveToolReconciler({
        getActiveTools: () => [...active],
        setActiveTools: (names) => {
          if (firstSet) {
            firstSet = false;
            if (throwPoint === "after") active = [...names];
            throw new Error(`throw ${throwPoint} apply`);
          }
          active = [...names];
        },
      }, bashOnly);

      expect(reconciler.reconcile(["bash", "read"])).toEqual({
        ok: false,
        failure: "set-active-tools",
        lastApplied: ["bash", "read"],
      });
      expect(successfulActive(reconciler.reconcile(["bash", "read"]))).toEqual(["bash"]);
      reconciler.setPolicy(undefined);
      expect(successfulActive(reconciler.reconcile(["bash", "read"]))).toEqual(["bash", "read"]);
    },
  );

  it("settles a pending attempt before applying a replacement policy", () => {
    const bashOnly = policy(agent({
      tools: ["Bash"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    const readOnly = policy(agent({
      tools: ["Read"],
      toolRestrictionValidation: { tools: "valid", disallowedTools: "absent" },
    }));
    let active = ["bash", "read"];
    let firstSet = true;
    const attempts: string[][] = [];
    const reconciler = new SelectedMainAgentActiveToolReconciler({
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        attempts.push([...names]);
        if (firstSet) {
          firstSet = false;
          throw new Error("uncertain before apply");
        }
        active = [...names];
      },
    }, bashOnly);

    expect(reconciler.reconcile(["bash", "read"]).ok).toBe(false);
    reconciler.setPolicy(readOnly);
    expect(successfulActive(reconciler.reconcile(["bash", "read"]))).toEqual(["read"]);
    expect(active).toEqual(["read"]);
    expect(attempts).toEqual([["bash"], ["bash"], ["read"]]);
  });

  it("reports initial and later get failures without throwing or claiming unrestricted success", () => {
    let getCalls = 0;
    const failing = {
      getActiveTools: () => {
        getCalls += 1;
        if (getCalls <= 2) throw new Error("unavailable");
        return ["bash"];
      },
      setActiveTools: () => undefined,
    };
    const reconciler = new SelectedMainAgentActiveToolReconciler(failing);
    let initialResult: ReturnType<typeof reconciler.reconcile> | undefined;
    expect(() => { initialResult = reconciler.reconcile(["bash"]); }).not.toThrow();
    expect(initialResult).toEqual({
      ok: false,
      failure: "get-active-tools",
      lastApplied: [],
    });
    expect(reconciler.reconcile(["bash"])).toEqual({
      ok: false,
      failure: "get-active-tools",
      lastApplied: [],
    });
    expect(successfulActive(reconciler.reconcile(["bash"]))).toEqual(["bash"]);
  });

  it("reports policy and set failures as discriminated no-throw results", () => {
    const pi = host(["bash"]);
    const reconciler = new SelectedMainAgentActiveToolReconciler(pi);
    reconciler.setPolicy({
      activeToolNames: () => { throw new Error("policy failed"); },
    } as unknown as SelectedMainAgentToolPolicy);
    expect(reconciler.reconcile(["bash"])).toEqual({
      ok: false,
      failure: "policy-evaluation",
      lastApplied: ["bash"],
    });

    const setFailure = new SelectedMainAgentActiveToolReconciler({
      getActiveTools: () => ["bash"],
      setActiveTools: () => { throw new Error("set failed"); },
    });
    expect(() => setFailure.reconcile([])).not.toThrow();
    expect(setFailure.reconcile([])).toEqual({
      ok: false,
      failure: "set-active-tools",
      lastApplied: ["bash"],
    });
  });
});
