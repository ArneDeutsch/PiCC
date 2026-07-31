import { describe, expect, it } from "vitest";

import {
  capabilityForToolName,
  lookupCapability,
} from "../src/registry/capability-registry.js";

function note(id: string): string {
  const entry = lookupCapability(id);
  expect(entry, id).toBeDefined();
  return entry!.note;
}

describe("MCP prompt and resource capability registry", () => {
  it("classifies shipped prompt and resource surfaces without overstating parity", () => {
    expect(lookupCapability("feature.mcp-prompts")).toMatchObject({ tier: "partial" });
    expect(note("feature.mcp-prompts")).toMatch(/\/mcp__<normalized-server>__<normalized-prompt>/);
    expect(note("feature.mcp-prompts")).toContain("Each UTF-16 code unit outside ASCII letters/digits/_/- becomes `_`");
    expect(note("feature.mcp-prompts")).toContain("an astral symbol therefore becomes `__`");
    expect(note("feature.mcp-prompts")).toContain("frontmatter-only metadata stubs");
    expect(note("feature.mcp-prompts")).toContain("Generated stubs persist metadata only");
    expect(note("feature.mcp-prompts")).toContain("never write prompt bodies or results");
    expect(note("feature.mcp-prompts")).toContain("ordinary conversation/session transcript retention");
    expect(note("feature.mcp-prompts")).toContain("positional in declaration order");
    expect(note("feature.mcp-prompts")).toContain("one bounded user-turn transform");
    expect(note("feature.mcp-prompts")).toContain("NOT model SlashCommand calls");
    expect(note("feature.mcp-prompts")).toContain("native non-text prompt content");
    expect(note("feature.mcp-prompts")).toContain("exact Claude edge formatting");

    expect(lookupCapability("feature.mcp-resources")).toMatchObject({ tier: "partial" });
    expect(note("feature.mcp-resources")).toContain("conditionally expose ListMcpResourcesTool and ReadMcpResourceTool");
    expect(note("feature.mcp-resources")).toContain("advertised-empty or `resources/list`-failed catalog");
    expect(note("feature.mcp-resources")).toContain("remain registered across reconnect and terminal retained states");
    expect(note("feature.mcp-resources")).toContain("absent only when the settled initial snapshots contain no advertised resource capability");
    expect(note("feature.mcp-resources")).toContain("labeled complete base64");
    expect(note("feature.mcp-resources")).toContain("resource `@` attachment/autocomplete");
  });

  it("pins List generic server matching without an MCP server alias", () => {
    expect(capabilityForToolName("ListMcpResourcesTool")).toMatchObject({
      id: "tool.ListMcpResourcesTool", tier: "partial", safetyRelevant: true,
    });
    const list = note("tool.ListMcpResourcesTool");
    expect(list).toContain("generic top-level `server:` deny/ask matching");
    expect(list).toContain("`mcp__server` is NOT an alias");
    expect(list).not.toContain("`uri:` deny/ask matching");
  });

  it("pins Read generic server and URI matching without Read or MCP server aliases", () => {
    expect(capabilityForToolName("ReadMcpResourceTool")).toMatchObject({
      id: "tool.ReadMcpResourceTool", tier: "partial", safetyRelevant: true,
    });
    const read = note("tool.ReadMcpResourceTool");
    expect(read).toContain("generic top-level `server:`/`uri:` deny/ask matching");
    expect(read).toContain("`Read(...)` and `mcp__server` are NOT aliases");
  });

  it("pins resource-tool availability through gating and background removal direction", () => {
    for (const id of ["tool.ListMcpResourcesTool", "tool.ReadMcpResourceTool"]) {
      const toolNote = note(id);
      expect(toolNote).toContain("bare-name and `*` deny");
      expect(toolNote).toContain("tools:/disallowedTools:");
      expect(toolNote).toContain("PreToolUse/PostToolUse/PostToolUseFailure hooks");
      expect(toolNote).toContain("Main sessions, foreground subagents, and genuine conversation forks");
      expect(toolNote).toContain("through normal gating");
      expect(toolNote).toMatch(/removes it from non-fork background subagents|non-fork background subagents do not/);
    }
  });

  it("pins list/read routing, representation, and bounds", () => {
    const list = note("tool.ListMcpResourcesTool");
    expect(list).toContain("settled capability snapshot advertises resources");
    expect(list).toContain("advertised-empty or `resources/list`-failed catalog");
    expect(list).toContain("remains registered across reconnect and terminal retained states");
    expect(list).toContain("one exact `server`");
    expect(list).toContain("256 servers");
    expect(list).toContain("1,024 resources per server");
    expect(list).toContain("complete bounded snapshot");
    expect(list).toContain("clipMaxTokens");

    const read = note("tool.ReadMcpResourceTool");
    expect(read).toContain("settled initial advertised-resource condition");
    expect(read).toContain("retained across reconnect and terminal retained states");
    expect(read).toContain("exact `server` and opaque `uri`");
    expect(read).toContain("may read an unlisted URI");
    expect(read).toContain("complete labeled base64 only when it fits");
    expect(read).toContain("NOT aliases");
    expect(read).toContain("1,024-content safety limit");
    expect(read).toContain("generic tool-result clip backstop");
  });

  it("owns capability discovery retries and immutable catalogs at the cross-transport level", () => {
    const proxy = note("tool.mcp__*");
    expect(proxy).toContain("catalog across remote outages and terminal failure remains immutable");
    expect(proxy).toContain("After aggregate initial settlement, one immutable tool universe is registered");
    expect(proxy).toContain("fresh proxy objects per dispatch over that same universe");
    expect(proxy).toContain("Reconnect never widens it");

    const aggregate = note("feature.mcp");
    expect(aggregate).toContain("Every advertised tools, prompts, or resources capability list");
    expect(aggregate).toContain("one initial attempt plus at most three");
    expect(aggregate).toContain("100/200/400 ms backoff");
    expect(aggregate).toContain("authentication/4xx/request-timeout failures are not retried");
    expect(aggregate).toContain("initial `tools/list` failure is fatal");
    expect(aggregate).toContain("publishes no capability snapshot, `mcp__...` proxies, or fixed resource tools");
    expect(aggregate).toContain("otherwise successfully settled server advertises resources");
    expect(aggregate).toContain("`resources/list` failure retains that advertised capability");
    expect(aggregate).toContain("registers the two fixed resource tools");
    expect(aggregate).toContain("remains attributable in their catalog results");

    const remote = note("feature.mcp-remote-transports");
    expect(remote).toContain("Initial connection");
    expect(remote).toContain("five reconnects");
    expect(remote).toContain("capability-list discovery");
    expect(remote).toContain("belong to feature.mcp");
    expect(remote).not.toContain("discovery retries only network/5xx");

    const listChanged = note("feature.mcp-list-changed");
    expect(listChanged).toContain("tools/list_changed, prompts/list_changed, and resources/list_changed");
    expect(listChanged).toContain("tool, prompt, and resource catalogs remain immutable");
  });

  it("keeps prompt bounds separate from tool-result clipping and the unsupported Claude token cap", () => {
    expect(note("feature.tool-output-clip")).toContain("MCP prompt results do not traverse tool_result");
    expect(note("feature.tool-output-clip")).toContain("separate aggregate transformed-input bound");
    expect(note("feature.mcp-output-token-cap")).toContain("MAX_MCP_OUTPUT_TOKENS — not honored");
    expect(note("feature.mcp-output-token-cap")).toContain("MCP proxy/resource-tool results");
    expect(note("feature.mcp-output-token-cap")).toContain("transformed MCP prompt content");
  });

  it("retains explicit deferred MCP protocol surfaces", () => {
    for (const id of [
      "feature.mcp-resource-templates",
      "feature.mcp-sampling",
      "feature.mcp-elicitation",
      "feature.mcp-roots",
      "feature.mcp-channels",
      "feature.mcp-oauth",
      "feature.mcp-plugin-servers",
    ]) {
      expect(lookupCapability(id), id).toMatchObject({ tier: "not-supported" });
    }
    expect(note("feature.mcp-resource-templates")).toContain("resources/templates/list");
    expect(note("feature.mcp-sampling")).toContain("cannot ask PiCC to run model generations");
  });

  it("distinguishes inherited resource tools from user-only prompt commands", () => {
    const frontmatter = note("agent.frontmatter.mcpServers");
    expect(frontmatter).toContain("gated MCP tool proxies and conditional resource tools");
    expect(frontmatter).toContain("non-fork background subagents");
    expect(frontmatter).toContain("MCP prompt commands are user-input-only");
  });
});
