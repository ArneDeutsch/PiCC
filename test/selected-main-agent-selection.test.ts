import { describe, expect, it } from "vitest";
import {
  SELECTED_MAIN_AGENT_BRANCH_MAX_ENTRIES,
  SELECTED_MAIN_AGENT_ENTRY,
  SELECTED_MAIN_AGENT_INITIAL_PROMPT,
  SELECTED_MAIN_AGENT_NAME_MAX_CHARS,
  observeSelectedMainAgentBranch,
  resolveSelectedMainAgentSelection,
  selectedMainAgentInitialPromptDelivered,
  type SelectedMainAgentBranchObservation,
} from "../src/runtime/selected-main-agent-selection.js";
import type { ClaudeAgent } from "../src/types.js";

function agent(name: string, body = `${name} body`): ClaudeAgent {
  return {
    name,
    description: `${name} description`,
    body,
    metadata: {},
    source: { path: `<${name}>`, scope: name.includes(":") ? "plugin" : "project" },
    unknownKeys: [],
    diagnostics: [],
  };
}

function marker(data: unknown): Record<string, unknown> {
  return { type: "custom", customType: SELECTED_MAIN_AGENT_ENTRY, data };
}

function validMarker(requestedName: string): Record<string, unknown> {
  return marker({ version: 1, requestedName });
}

function resolve(
  branchObservation: SelectedMainAgentBranchObservation,
  options: { cliName?: string; settingName?: string; agents?: ClaudeAgent[] } = {},
) {
  return resolveSelectedMainAgentSelection({
    branchObservation,
    agents: options.agents ?? [agent("cli"), agent("persisted"), agent("setting")],
    ...(options.cliName === undefined ? {} : { cliName: options.cliName }),
    ...(options.settingName === undefined ? {} : { settingName: options.settingName }),
  });
}

describe("selected main-agent branch observation", () => {
  it("distinguishes no record and the newest valid matching record", () => {
    expect(observeSelectedMainAgentBranch([])).toEqual({ kind: "no-record" });
    expect(observeSelectedMainAgentBranch([
      validMarker("older"),
      { type: "custom", customType: "other-extension", data: { version: 1 } },
      validMarker("newest"),
    ])).toEqual({ kind: "persisted", requestedName: "newest" });
  });

  it("never resurrects an older identity when the newest reserved evidence is malformed", () => {
    const malformedEvidence = [
      marker({ version: 1, requestedName: ["malformed"] }),
      { customType: SELECTED_MAIN_AGENT_ENTRY, data: { version: 1, requestedName: "missing-type" } },
      { type: 7, customType: SELECTED_MAIN_AGENT_ENTRY, data: { version: 1, requestedName: "malformed-type" } },
      { type: "custom_message", customType: SELECTED_MAIN_AGENT_ENTRY, data: { version: 1, requestedName: "wrong-type" } },
    ];
    for (const evidence of malformedEvidence) {
      expect(observeSelectedMainAgentBranch([validMarker("older"), evidence]))
        .toEqual({ kind: "persisted-uncertain" });
    }
  });

  it("treats non-array, throwing, accessor, and prototype-hostile branch evidence as uncertain", () => {
    const throwingBranch = new Proxy([], {
      getPrototypeOf() { throw new Error("branch trap"); },
    });
    const accessorEntry = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorEntry, "type", { get() { throw new Error("entry trap"); } });
    const hostileEntry = Object.create({ inherited: true }) as Record<string, unknown>;
    hostileEntry.type = "custom";
    hostileEntry.customType = SELECTED_MAIN_AGENT_ENTRY;
    hostileEntry.data = { version: 1, requestedName: "unsafe" };

    for (const branch of [{}, throwingBranch, [accessorEntry], [hostileEntry]]) {
      expect(observeSelectedMainAgentBranch(branch)).toEqual({ kind: "persisted-uncertain" });
    }
  });

  it("makes sparse and primitive branch entries uncertain rather than falling through", () => {
    const sparse = new Array(2);
    sparse[0] = validMarker("older");
    for (const branch of [[validMarker("older"), 7], sparse]) {
      const observation = observeSelectedMainAgentBranch(branch);
      expect(observation).toEqual({ kind: "persisted-uncertain" });
      expect(resolve(observation, { settingName: "setting" })).toEqual({ kind: "persisted-uncertain" });
    }
  });

  it("accepts exact name and branch boundaries with O(1)-style newest evidence", () => {
    const boundaryName = "a".repeat(SELECTED_MAIN_AGENT_NAME_MAX_CHARS);
    expect(observeSelectedMainAgentBranch([validMarker(boundaryName)]))
      .toEqual({ kind: "persisted", requestedName: boundaryName });
    expect(observeSelectedMainAgentBranch([validMarker(`${boundaryName}x`)]))
      .toEqual({ kind: "persisted-uncertain" });

    const boundaryBranch = new Array(SELECTED_MAIN_AGENT_BRANCH_MAX_ENTRIES);
    boundaryBranch[SELECTED_MAIN_AGENT_BRANCH_MAX_ENTRIES - 1] = validMarker("newest");
    expect(observeSelectedMainAgentBranch(boundaryBranch))
      .toEqual({ kind: "persisted", requestedName: "newest" });
    expect(observeSelectedMainAgentBranch(new Array(SELECTED_MAIN_AGENT_BRANCH_MAX_ENTRIES + 1)))
      .toEqual({ kind: "persisted-uncertain" });
  });
});

describe("selected main-agent initial-prompt proof", () => {
  const proof = (selectedName: string) => ({
    type: "custom_message",
    customType: SELECTED_MAIN_AGENT_INITIAL_PROMPT,
    content: "the actual initial user turn",
    display: true,
    details: { version: 1, selectedName },
  });

  it("proves delivery only for the requested name on the supplied branch", () => {
    const alphaBranch = [proof("alpha")];
    const selectedBranchWithoutProof: unknown[] = [];
    const separateBranchWithSameName = [proof("alpha")];
    expect(selectedMainAgentInitialPromptDelivered(alphaBranch, "alpha")).toBe(true);
    expect(selectedMainAgentInitialPromptDelivered(separateBranchWithSameName, "alpha")).toBe(true);
    expect(selectedMainAgentInitialPromptDelivered(selectedBranchWithoutProof, "alpha")).toBe(false);
    expect(selectedMainAgentInitialPromptDelivered(alphaBranch, "beta")).toBe(false);
  });

  it("requires own data-valued string content and valid details", () => {
    const contentAccessor = proof("alpha");
    Object.defineProperty(contentAccessor, "content", { get() { throw new Error("content trap"); } });
    const { content: _omitted, ...missingContent } = proof("alpha");
    for (const candidate of [
      missingContent,
      contentAccessor,
      { ...proof("alpha"), content: 7 },
      { ...proof("alpha"), details: { version: 2, selectedName: "alpha" } },
    ]) {
      expect(selectedMainAgentInitialPromptDelivered([candidate], "alpha")).toBe(false);
    }
  });

  it("fails closed for hostile branch entries", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "type", { get() { throw new Error("message trap"); } });
    expect(selectedMainAgentInitialPromptDelivered([proof("alpha"), accessor], "alpha")).toBe(false);
  });
});

describe("selected main-agent resolution", () => {
  it("applies CLI over persisted over settings, including CLI over uncertain persistence", () => {
    expect(resolve({ kind: "persisted", requestedName: "persisted" }, {
      cliName: "cli", settingName: "setting",
    })).toMatchObject({ kind: "selected", source: "cli", requestedName: "cli", appendSelectionEntry: true });
    expect(resolve({ kind: "persisted-uncertain" }, {
      cliName: "cli", settingName: "setting",
    })).toMatchObject({ kind: "selected", source: "cli", requestedName: "cli", appendSelectionEntry: true });
    expect(resolve({ kind: "persisted", requestedName: "persisted" }, {
      settingName: "setting",
    })).toMatchObject({ kind: "selected", source: "persisted", requestedName: "persisted", appendSelectionEntry: false });
    expect(resolve({ kind: "no-record" }, { settingName: "setting" }))
      .toMatchObject({ kind: "selected", source: "settings", requestedName: "setting", appendSelectionEntry: true });
  });

  it("does not append a duplicate marker when CLI repeats the valid persisted selector", () => {
    expect(resolve({ kind: "persisted", requestedName: "cli" }, { cliName: "cli" }))
      .toMatchObject({ kind: "selected", source: "cli", appendSelectionEntry: false });
  });

  it("returns none, fresh-missing, persisted-missing, and persisted-uncertain recovery outcomes", () => {
    expect(resolve({ kind: "no-record" })).toEqual({ kind: "none" });
    expect(resolve({ kind: "no-record" }, { settingName: "missing", agents: [] }))
      .toEqual({ kind: "missing-fresh", source: "settings", requestedName: "missing" });
    expect(resolve({ kind: "no-record" }, { cliName: "missing", agents: [] }))
      .toEqual({ kind: "missing-fresh", source: "cli", requestedName: "missing" });
    expect(resolve({ kind: "persisted", requestedName: "missing" }, { agents: [] }))
      .toEqual({ kind: "missing-persisted", requestedName: "missing" });
    expect(resolve({ kind: "persisted-uncertain" }, { settingName: "setting" }))
      .toEqual({ kind: "persisted-uncertain" });
  });

  it("uses existing exact, unique-suffix, and ambiguous findByName semantics", () => {
    const exact = agent("review", "exact body");
    const alpha = agent("alpha:review", "alpha body");
    const beta = agent("beta:review", "beta body");
    expect(resolve({ kind: "no-record" }, { cliName: "review", agents: [alpha] }))
      .toMatchObject({ kind: "selected", agent: { name: "alpha:review", body: "alpha body" } });
    expect(resolve({ kind: "no-record" }, { cliName: "review", agents: [alpha, exact] }))
      .toMatchObject({ kind: "selected", agent: { name: "review", body: "exact body" } });
    expect(resolve({ kind: "no-record" }, { cliName: "review", agents: [alpha, beta] }))
      .toEqual({ kind: "missing-fresh", source: "cli", requestedName: "review" });
  });

  it("rejects fresh over-limit selectors without retaining hostile text", () => {
    const oversized = "x".repeat(SELECTED_MAIN_AGENT_NAME_MAX_CHARS + 1);
    expect(resolve({ kind: "no-record" }, { cliName: oversized, agents: [agent(oversized)] }))
      .toEqual({ kind: "missing-fresh", source: "cli" });
  });
});
