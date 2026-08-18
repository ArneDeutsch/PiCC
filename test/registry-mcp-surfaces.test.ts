import { describe, expect, it } from "vitest";
import { CAPABILITY_REGISTRY, capabilityForToolName, lookupCapability } from "../src/registry/capability-registry.js";
import type { SupportTier } from "../src/types.js";

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
    expect(note("feature.mcp-resources")).toContain("conditionally exposes ListMcpResourcesTool and ReadMcpResourceTool");
    expect(note("feature.mcp-resources")).toContain("advertised-empty or `resources/list`-failed catalog");
    expect(note("feature.mcp-resources")).toContain("Host registration may persist");
    expect(note("feature.mcp-resources")).toContain("active exposure retires");
    expect(note("feature.mcp-resources")).toContain("labeled complete base64");
    expect(note("feature.mcp-resources")).toContain("resource `@` attachment/autocomplete");
  });

  it("pins List generic server matching without an MCP server alias", () => {
    expect(capabilityForToolName("ListMcpResourcesTool")).toMatchObject({
      id: "tool.ListMcpResourcesTool", tier: "partial", safetyRelevant: false,
    });
    const list = note("tool.ListMcpResourcesTool");
    expect(list).toContain("generic top-level `server:` deny/ask matching");
    expect(list).toContain("`mcp__server` is NOT an alias");
    expect(list).not.toContain("`uri:` deny/ask matching");
  });

  it("pins Read generic server and URI matching without Read or MCP server aliases", () => {
    expect(capabilityForToolName("ReadMcpResourceTool")).toMatchObject({
      id: "tool.ReadMcpResourceTool", tier: "partial", safetyRelevant: false,
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
    expect(list).toContain("live main-session catalog gains an advertised resource capability");
    expect(list).toContain("advertised-empty or `resources/list`-failed catalog");
    expect(list).toContain("Host registration may persist");
    expect(list).toContain("one exact `server`");
    expect(list).toContain("256 servers");
    expect(list).toContain("1,024 resources per server");
    expect(list).toContain("complete bounded snapshot");
    expect(list).toContain("clipMaxTokens");

    const read = note("tool.ReadMcpResourceTool");
    expect(read).toContain("same first-live-capability condition");
    expect(read).toContain("host registration may persist");
    expect(read).toContain("exact `server` and opaque `uri`");
    expect(read).toContain("may read an unlisted URI");
    expect(read).toContain("complete labeled base64 only when it fits");
    expect(read).toContain("NOT aliases");
    expect(read).toContain("1,024-content safety limit");
    expect(read).toContain("generic tool-result clip backstop");
  });

  it("owns capability discovery retries and immutable catalogs at the cross-transport level", () => {
    const proxy = note("tool.mcp__*");
    expect(proxy).toContain("For one exact execution definition, the first successfully discovered name/schema/description catalog remains immutable");
    expect(proxy).toContain("After aggregate initial settlement, the main session can add, retire, or exact-definition-refresh registrations");
    expect(proxy).toContain("Named agents instead compose an immutable dispatch-local universe from borrowed eligible session servers and their own admitted inline runtime");
    expect(proxy).toContain("then restrict/drop it via tools:/disallowedTools:");
    expect(proxy).toContain("parent and sibling inline capabilities do not propagate");
    expect(proxy).toContain("Reconnect never widens a same-definition universe");

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
    expect(remote).toContain("Eligible failed main-session remote servers also expose PiCC-defined manual reconnect");
    expect(remote).toContain("automatic reconnection remains remote-only");
    expect(aggregate).toContain("eligible failed main-session stdio and supported remote servers expose PiCC-defined manual reconnect");
    expect(aggregate).toContain("stdio children do not reconnect automatically");
    expect(remote).toContain("capability-list discovery");
    expect(remote).toContain("belong to feature.mcp");
    expect(remote).not.toContain("discovery retries only network/5xx");

    const listChanged = note("feature.mcp-list-changed");
    expect(listChanged).toContain("tools/list_changed, prompts/list_changed, and resources/list_changed");
    expect(listChanged).toContain("same-definition catalogs remain immutable");
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

  it("pins named-agent gating, background resources, and main-session-only prompt commands", () => {
    const frontmatter = note("agent.frontmatter.mcpServers");
    expect(frontmatter).toContain("omitted or clean-empty declarations, including on nested agents, inherit eligible published main-session routes");
    expect(frontmatter).toContain("references borrow published routes without duplicate clients");
    expect(frontmatter).toContain("inline stdio/HTTP/SSE servers are dispatch-owned and isolated from parents and siblings");
    expect(frontmatter).toContain("Parent-inline routes do not propagate to nested children");
    expect(frontmatter).toContain("non-empty declaration selection and parent-inline non-propagation are inferred, unverified choices");
    expect(frontmatter).not.toContain("only capabilities they independently declare");
    expect(frontmatter).toContain("managed agents remain dispatchable but retain the field only as inert evidence");
    expect(frontmatter).toContain("managed-agent MCP execution");
    expect(frontmatter).not.toContain("managed-agent execution");
    expect(frontmatter).toContain("The combined universe is gated by agent tools:/disallowedTools:, deny permissions, command hooks, timeouts, managed policy, PiCC's exact execution-definition/source-family/agent-owner project review or broad user/managed compatibility approval, the disabledMcpjsonServers compatibility-decline gate, and the existing non-fork background resource-tool filter");
    expect(frontmatter).toContain("Prompt commands remain main-session-only");

    const approval = note("feature.mcp-project-approval");
    expect(approval).toContain("Ordinary pending servers surface as a count-only one-time TUI notice");
    expect(approval).toContain("pointing to `/mcp manage`");
    expect(approval).toContain("Agent-inline static pending declarations appear only in /doctor");
    expect(approval).toContain("dispatch-time setup or cleanup outcomes appear only in bounded Agent/TaskOutput results");
    expect(approval).toContain("agent-inline state is absent from the parent /mcp");
  });
});


describe("MCP administration capability registry", () => {
  it.each([
    ["feature.mcp", [/Same-definition catalogs remain immutable/i, /changed execution definition.*rediscovered/i, /palette stubs remain startup-bounded/i]],
    ["feature.mcp-prompts", [/exact typed routing/i, /palette stubs remain startup-bounded/i, /not dynamically republished/i]],
    ["feature.mcp-resources", [/first gains an advertised resource capability/i, /changed-definition administration/i, /active exposure retires/i]],
    ["feature.mcp-remote-transports", [/manual reconnect/i, /static-header-only/i]],
    ["feature.mcp-cli-management", [/bounded transient health discovery/i, /Dry-run.*without recovery or writes/i, /transaction\/recovery taxonomy/i, /Unscoped remove refuses ambiguity and any inventory with omitted declarations/i, /explicit `--scope`/i, /file\/stdin avoids argv exposure/i, /add-from-claude-desktop import command.*unavailable/i, /Byte-identical output.*unavailable/i]],
    ["feature.mcp-control-status", [/bare \/mcp.*invokes no recovery/i, /TUI-only/i, /headless administration.*no-action/i]],
    ["feature.mcp-runtime-enabled", [/not-supported|never activates/i, /default-off/i]],
    ["feature.mcp-claude-json-scopes", [/project scope writes `\.mcp\.json`/i, /unrelated state is preserved/i]],
    ["feature.mcp-project-approval", [/exact-definition review/i, /Invalid private review state blocks that exact review path/i, /independent trusted broad authority/i]],
    ["setting.enableAllProjectMcpServers", [/blanket approval/i, /user and managed settings/i]],
  ] as const)("pins %s administration semantics without editorial sentence coupling", (id, patterns) => {
    const value = lookupCapability(id);
    expect(value, id).toBeDefined();
    for (const pattern of patterns) expect(value!.note, `${id}: ${pattern.source}`).toMatch(pattern);
  });

  it("distinguishes same-definition immutability from changed-definition host refresh", () => {
    const proxy = note("tool.mcp__*");
    expect(proxy).toContain("changed definition is rediscovered and refreshes main-session host registration");
    expect(proxy).toContain("serialized PiCC-owned active-set merging");
    expect(proxy).toContain("call-time route validation");
    expect(note("feature.mcp-capability-discovery")).toContain("changed definition performs fresh discovery");
    expect(note("feature.mcp-capability-discovery")).toContain("prompt palette stubs remain startup-bounded");
    expect(note("feature.mcp-list-changed")).toContain("not list_changed support");
  });

  it("records scoped CLI, interactive review, runtime toggle, and OAuth limits", () => {
    expect(lookupCapability("feature.mcp-cli-management")).toMatchObject({ tier: "partial" });
    expect(note("feature.mcp-cli-management")).toContain("local/project/user declaration scopes");
    expect(note("feature.mcp-cli-management")).toContain("file/stdin avoids argv exposure");
    expect(note("feature.mcp-cli-management")).toContain("add-from-claude-desktop import command");
    expect(note("feature.mcp-cli-management")).toContain("unavailable");
    expect(note("feature.mcp-project-approval")).toContain("normalized execution definition, source family, linked-checkout family, and agent owner");
    expect(note("feature.mcp-project-approval")).toContain("headless modes never prompt");
    expect(note("feature.mcp-runtime-disabled")).toContain("edits only this list");
    expect(lookupCapability("feature.mcp-runtime-enabled")).toMatchObject({ tier: "not-supported" });
    expect(note("feature.mcp-control-status")).toContain("exact no-tail deep links");
    expect(lookupCapability("feature.mcp-oauth")).toMatchObject({ tier: "not-supported" });
    expect(note("feature.mcp-oauth")).toContain("performs no login, logout, token storage, refresh, or runtime action");
  });

  it("keeps private review distinct from broad compatibility settings", () => {
    expect(note("setting.enableAllProjectMcpServers")).toContain("blanket approval");
    expect(note("setting.enableAllProjectMcpServers")).toContain("user and managed settings");
    expect(note("setting.enabledMcpjsonServers")).toContain("distinct from PiCC private exact-definition review");
    expect(note("setting.disabledMcpjsonServers")).toContain("separate private exact-definition decision");
    expect(note("setting.mcpServers")).toContain("exact PiCC review or a broad user/managed compatibility grant");
    expect(note("agent.frontmatter.mcpServers")).toContain("Checkout-local approval keys never authorize");
    expect(note("agent.frontmatter.mcpServers")).toContain("dynamic host exposure");
    expect(note("agent.frontmatter.mcpServers")).toContain("interactive per-tool permission approval");
  });
});


type AuditSurface = {
  surfaceKey: string;
  page: "MCP reference" | "Settings reference" | "CLI reference" | "Hooks reference" | "Claude Code channels" | "Subagents reference";
  leafDescription: string;
  authorityHeading: string;
  capabilityId: string;
  tier: SupportTier;
  safetyRelevant: boolean;
  evidence: readonly { quality: "documented" | "observed" | "inferred" | "unverified"; source: string; reviewed?: string }[];
};

const GROUPING_RATIONALES: Readonly<Record<string, string>> = {
  "setting.mcpServers": "These config leaves share PiCC's parsed server-entry path, whole-entry precedence, expansion behavior, partial tier, and configuration-file remedy.",
  "feature.mcp-websocket": "The WebSocket transport and its entry fields share PiCC's absent client transport, non-safety conclusion, and supported-transport remedy.",
  "feature.mcp-server-always-load": "The config field and its tool-loading effect are one ignored server field with the same startup/search deficit and do-not-rely remedy.",
  "feature.mcp-claude-json-scopes": "Native local/user loading, targeted mutation, precedence, identity, and recovery share one coherent profile and linked-worktree family boundary.",
  "feature.mcp-cli-management": "The aggregate remains partial because PiCC implements most management leaves with qualified output, scoped reads, and recovery, while the independently audited add-from-claude-desktop leaf is explicitly not supported.",
  "feature.mcp-cli-invocation-controls": "These invocation/loading flags share PiCC's absent Claude CLI parser and non-safety conclusion; normal discovery remains active without --bare's general MCP suppression.",
  "feature.mcp-list-changed": "The three list_changed notifications and failed-refresh retention leaf remain unsupported even though explicit changed-definition administration can refresh host exposure.",
  "feature.mcp-max-result-size-chars": "The metadata and persistence behavior are the same unsupported per-tool text-threshold contract, distinct from generic clipping.",
  "feature.mcp-model-failure-visibility": "Failed-server reporting and tool-search selection dependency share PiCC's partial boundary: main-session failures remain human-only, while bounded named-agent setup and cleanup degradation qualifies child or parent model surfaces at its lifecycle boundary.",
  "feature.mcp-server-instructions": "Instruction forwarding and its truncation rule share one absent model-context behavior and non-safety conclusion.",
  "feature.mcp-managed-config": "The standalone managed source, exclusive/empty behavior, fail-closed hardening, and deferred delivery/source limits form one partial administrator-control boundary." ,
  "feature.mcp-oauth": "OAuth login, logout, and dynamic registration share the absent credential flow, non-safety tier, and static-header remedy.",
  "feature.mcp-roots": "roots/list and roots/list_changed share PiCC's absent workspace-root exposure and non-safety conclusion.",
  "feature.mcp-channels": "Channel behavior and its two channel-specific CLI loading controls are all unavailable because PiCC has no channel loading path.",
  "setting.allowedChannelPlugins": "The allowlist plus replacement, empty-list, and development exception leaves share one inert restriction and the same explicit safety-false conclusion because PiCC cannot load channels.",
  "feature.mcp-auto-background": "The threshold and opt-in/disable controls, execution-context exclusions, and elicitation deferral all govern the same absent MCP auto-background transition and foreground-call remedy.",
  "feature.mcp-hook-matching": "The naming and matcher leaves share one existing matcher behavior, partial tier, and the same unavailable plugin-server boundary.",
  "feature.mcp-plugin-servers": "Plugin server discovery, lifecycle/reload, placeholder substitution, scoped naming, and transport-specific behavior are all absent because PiCC discovers no plugin MCP configs.",
  "hook.event.Elicitation": "The Elicitation event, matcher, input, output, and deny leaves share one never-fired request-hook contract and unsupported server-elicitation remedy.",
  "hook.event.ElicitationResult": "The ElicitationResult event, matcher, input, output, and block leaves share one never-fired result-hook contract and unsupported server-elicitation remedy.",
  "feature.hook-handler.mcp_tool": "The handler fields and lifecycle/error leaves share one absent non-enforcement MCP-tool handler contract and the same visible no-op remedy.",
  "setting.strictPluginOnlyCustomization.mcp": "The managed setting and its MCP restriction leaf are one ignored plugin-only policy whose gap can permit project/settings MCP servers to run.",
  "setting.channelsEnabled": "The setting and its master-disable behavior are one inert restriction with the same explicit safety-false conclusion because PiCC cannot load channels.",
  "feature.mcp-first-byte-timeout": "The first-byte defaults, overrides, floors, and transport exclusions share the same absent timer and aggregate-hard-wall PiCC boundary.",
  "feature.mcp-idle-timeout": "The idle defaults, progress behavior, exclusions, disable control, and per-server floor share one absent idle-timer contract and non-safety remedy.",
  "feature.mcp": "Stdio startup and aggregate tool-call timeout leaves share PiCC's implemented aggregate MCP lifecycle, partial tier, and bounded wall-clock behavior.",
  "feature.mcp-tool-search": "Deferred loading and both documented loading-control environment variables share PiCC's upfront-schema behavior and the same unsupported tool-search remedy.",
  "feature.mcp-capability-discovery": "Capability discovery and failure coupling share PiCC's partial initial publication behavior and the same /mcp visibility remedy.",
  "feature.mcp-remote-transports": "HTTP, deprecated SSE, static headers, and automatic reconnection share PiCC's remote-client implementation, partial transport limits, non-safety conclusion, and remote-config remedy.",
  "setting.allowManagedMcpServersOnly": "The setting, managed-only restriction, invalid-value handling, central admission coverage, and missing-source limits form one partial enterprise gate.",
  "setting.allowedMcpServers": "The soft allowlist, invalid-value active-empty behavior, central admission coverage, hardening, and missing-source limits form one partial managed restriction.",
};

const EXPECTED_RELATED: Readonly<Record<string, readonly string[]>> = {
  "agent.frontmatter.mcpServers": ["feature.mcp","feature.mcp-model-failure-visibility","feature.mcp-project-approval","tool.Agent","tool.TaskOutput","tool.mcp__*"],
  "feature.mcp": ["feature.mcp-capability-discovery","feature.mcp-claude-json-scopes","feature.mcp-managed-config","feature.mcp-remote-transports","setting.mcpServers"],
  "feature.mcp-auto-background": ["feature.mcp-first-byte-timeout","feature.mcp-idle-timeout"],
  "feature.mcp-capability-discovery": ["feature.mcp","feature.mcp-model-failure-visibility","feature.mcp-prompts","feature.mcp-resources"],
  "feature.mcp-channels": ["feature.mcp","setting.allowedChannelPlugins","setting.channelsEnabled"],
  "feature.mcp-child-session-env": ["feature.mcp"],
  "feature.mcp-claude-json-scopes": ["feature.mcp","feature.mcp-connectors","feature.mcp-managed-config","feature.mcp-project-approval","feature.mcp-runtime-disabled","feature.mcp-runtime-enabled","setting.mcpServers"],
  "feature.mcp-cli-invocation-controls": ["setting.disableSideloadFlags","setting.mcpServers"],
  "feature.mcp-cli-management": ["feature.mcp-claude-json-scopes","feature.mcp-control-status","setting.mcpServers"],
  "feature.mcp-connect-timeout-ms": ["feature.mcp-first-byte-timeout","feature.mcp-server-always-load"],
  "feature.mcp-connectors": ["feature.mcp-claude-json-scopes","feature.mcp-oauth","setting.disableClaudeAiConnectors"],
  "feature.mcp-control-status": ["feature.mcp","feature.mcp-cli-management","feature.mcp-managed-config","tool.WaitForMcpServers"],
  "feature.mcp-elicitation": ["hook.event.Elicitation","hook.event.ElicitationResult"],
  "feature.mcp-first-byte-timeout": ["feature.mcp","feature.mcp-auto-background","feature.mcp-connect-timeout-ms"],
  "feature.mcp-headers-helper": ["feature.mcp-oauth","feature.mcp-remote-transports","feature.mcp-websocket"],
  "feature.mcp-url-without-type-validation": ["setting.mcpServers","feature.mcp-remote-transports"],
  "feature.mcp-idle-timeout": ["feature.mcp-auto-background","feature.mcp-remote-transports"],
  "feature.mcp-list-changed": ["feature.mcp-prompts","feature.mcp-resource-subscriptions","feature.mcp-resources"],
  "feature.mcp-managed-config": ["feature.managed-policy","feature.mcp-project-approval","setting.allowManagedMcpServersOnly","setting.allowedMcpServers","setting.deniedMcpServers","setting.mcpServers","setting.strictPluginOnlyCustomization.mcp"],
  "feature.mcp-max-result-size-chars": ["feature.mcp-output-token-cap","feature.tool-output-clip"],
  "feature.mcp-model-failure-visibility": ["feature.mcp-capability-discovery","feature.mcp-tool-search","tool.ToolSearch","tool.WaitForMcpServers"],
  "feature.mcp-oauth": ["feature.mcp-connectors","feature.mcp-remote-transports"],
  "feature.mcp-output-token-cap": ["feature.mcp-max-result-size-chars","feature.tool-output-clip"],
  "feature.mcp-plugin-servers": ["feature.mcp","feature.plugins-content"],
  "feature.mcp-project-approval": ["feature.mcp-claude-json-scopes","feature.mcp-managed-config","feature.mcp-runtime-disabled","feature.mcp-runtime-enabled","setting.disabledMcpjsonServers","setting.enableAllProjectMcpServers","setting.enabledMcpjsonServers"],
  "feature.mcp-prompts": ["feature.mcp-capability-discovery","feature.mcp-list-changed"],
  "feature.mcp-remote-transports": ["feature.mcp","feature.mcp-headers-helper","feature.mcp-oauth","feature.mcp-websocket"],
  "feature.mcp-requires-user-interaction": ["tool.mcp__*"],
  "feature.mcp-resource-subscriptions": ["feature.mcp-list-changed","feature.mcp-resources"],
  "feature.mcp-resource-templates": ["feature.mcp-resources"],
  "feature.mcp-resources": ["feature.mcp-resource-subscriptions","feature.mcp-resource-templates","tool.ListMcpResourcesTool","tool.ReadMcpResourceTool"],
  "feature.mcp-root-schema-combinators": ["tool.mcp__*"],
  "feature.mcp-roots": ["feature.mcp"],
  "feature.mcp-runtime-disabled": ["feature.mcp-claude-json-scopes","feature.mcp-control-status","feature.mcp-managed-config","feature.mcp-project-approval","feature.mcp-runtime-enabled"],
  "feature.mcp-runtime-enabled": ["feature.mcp-control-status","feature.mcp-project-approval","feature.mcp-runtime-disabled"],
  "feature.mcp-sampling": ["feature.mcp"],
  "feature.mcp-server-always-load": ["feature.mcp-connect-timeout-ms","feature.mcp-tool-search","tool.WaitForMcpServers"],
  "feature.mcp-server-instructions": ["feature.mcp"],
  "feature.mcp-server-mode": ["feature.mcp"],
  "feature.mcp-server-role": ["setting.mcpServers"],
  "feature.mcp-shell-prefix": ["feature.mcp"],
  "feature.mcp-tool-always-load": ["feature.mcp-server-always-load","feature.mcp-tool-search"],
  "feature.mcp-tool-search": ["feature.mcp-model-failure-visibility","feature.mcp-server-always-load","feature.mcp-tool-always-load","tool.ToolSearch","tool.WaitForMcpServers"],
  "feature.mcp-websocket": ["feature.mcp-cli-management","feature.mcp-remote-transports"],
  "hook.event.Elicitation": ["feature.mcp-elicitation","hook.event.ElicitationResult"],
  "hook.event.ElicitationResult": ["feature.mcp-elicitation","hook.event.Elicitation"],
  "feature.mcp-hook-matching": ["feature.hook-handler.mcp_tool","feature.hook-handler.mcp_tool-blocking-enforcement","feature.mcp-plugin-servers","tool.mcp__*"],
  "feature.hook-handler.mcp_tool": ["feature.hook-handler.mcp_tool-blocking-enforcement","feature.mcp","feature.mcp-hook-matching"],
  "feature.hook-handler.mcp_tool-blocking-enforcement": ["feature.hook-handler.mcp_tool","feature.mcp","feature.mcp-hook-matching"],
  "setting.allowAllClaudeAiMcps": ["feature.mcp-connectors","setting.disableClaudeAiConnectors"],
  "setting.allowManagedMcpServersOnly": ["feature.mcp-managed-config","setting.allowedMcpServers","setting.deniedMcpServers","setting.strictPluginOnlyCustomization.mcp"],
  "setting.strictPluginOnlyCustomization.mcp": ["feature.mcp-managed-config","feature.mcp-plugin-servers","setting.allowManagedMcpServersOnly"],
  "setting.channelsEnabled": ["feature.mcp-channels","setting.allowedChannelPlugins"],
  "setting.allowedChannelPlugins": ["feature.mcp-channels","setting.channelsEnabled"],
  "setting.allowedMcpServers": ["feature.mcp-managed-config","setting.deniedMcpServers"],
  "setting.deniedMcpServers": ["feature.mcp-managed-config","setting.allowedMcpServers"],
  "setting.disableClaudeAiConnectors": ["feature.mcp-connectors","setting.allowAllClaudeAiMcps"],
  "setting.disableSideloadFlags": ["feature.mcp-cli-invocation-controls"],
  "setting.disabledMcpjsonServers": ["feature.mcp-project-approval","setting.enableAllProjectMcpServers","setting.enabledMcpjsonServers"],
  "setting.enableAllProjectMcpServers": ["feature.mcp-project-approval","setting.disabledMcpjsonServers","setting.enabledMcpjsonServers"],
  "setting.enabledMcpjsonServers": ["feature.mcp-project-approval","setting.disabledMcpjsonServers","setting.enableAllProjectMcpServers"],
  "setting.mcpServers": ["feature.mcp","feature.mcp-claude-json-scopes","feature.mcp-managed-config","feature.mcp-project-approval"],
  "tool.ListMcpResourcesTool": ["feature.mcp-resources","tool.ReadMcpResourceTool"],
  "tool.ReadMcpResourceTool": ["feature.mcp-resources","tool.ListMcpResourcesTool"],
  "tool.ToolSearch": ["feature.mcp-model-failure-visibility","feature.mcp-server-always-load","feature.mcp-tool-always-load","feature.mcp-tool-search"],
  "tool.WaitForMcpServers": ["feature.mcp-control-status","feature.mcp-model-failure-visibility","feature.mcp-server-always-load"],
  "tool.mcp__*": ["feature.mcp-capability-discovery","feature.mcp-max-result-size-chars","feature.mcp-requires-user-interaction"],
};

type AuditSurfaceWithoutEvidence = Omit<AuditSurface, "evidence">;
const s = (surfaceKey: string, page: AuditSurface["page"], leafDescription: string, authorityHeading: string, capabilityId: string, tier: SupportTier, safetyRelevant = false): AuditSurfaceWithoutEvidence => ({
  surfaceKey, page, leafDescription, authorityHeading, capabilityId, tier, safetyRelevant,
});

// Hand-audited closed inventory. Do not derive this policy authority from CAPABILITY_REGISTRY.
const RAW_MCP_SURFACES: readonly AuditSurfaceWithoutEvidence[] = [
  s("transport.stdio", "MCP reference", "Connect to local stdio servers", "Option 3: Add a local stdio server", "feature.mcp", "partial", false),
  s("transport.http", "MCP reference", "Connect to remote HTTP servers", "Option 1: Add a remote HTTP server", "feature.mcp-remote-transports", "partial", false),
  s("transport.sse", "MCP reference", "Deprecated SSE transport", "Option 2: Add a remote SSE server", "feature.mcp-remote-transports", "partial", false),
  s("transport.websocket", "MCP reference", "WebSocket transport", "Option 4: Add a remote WebSocket server", "feature.mcp-websocket", "not-supported"),
  s("transport.websocket-config", "MCP reference", "WebSocket transport configuration", "Option 4: Add a remote WebSocket server", "feature.mcp-websocket", "not-supported"),
  s("config.command-args-env", "MCP reference", "Server configuration", "Installing MCP servers", "setting.mcpServers", "partial", false),
  s("config.startup-timeout", "MCP reference", "MCP_TIMEOUT startup timeout", "Push messages with channels", "feature.mcp", "partial", false),
  s("config.tool-timeout", "MCP reference", "MCP_TOOL_TIMEOUT tool execution timeout", "Push messages with channels", "feature.mcp", "partial", false),
  s("config.first-byte-timeout", "MCP reference", "HTTP/SSE/connector first-response-byte timeout", "Push messages with channels", "feature.mcp-first-byte-timeout", "not-supported", false),
  s("config.connect-timeout", "MCP reference", "Connection timeout", "Push messages with channels", "feature.mcp-connect-timeout-ms", "not-supported", false),
  s("config.environment-expansion", "MCP reference", "Environment variable expansion", "Environment variable expansion in .mcp.json", "setting.mcpServers", "partial", false),
  s("config.empty-url-placeholder", "MCP reference", "Empty URL placeholders", "Installing MCP servers", "setting.mcpServers", "partial", false),
  s("config.url-without-type-validation", "MCP reference", "URL without type is skipped as a configuration error", "Option 1: Add a remote HTTP server", "feature.mcp-url-without-type-validation", "not-supported", false),
  s("config.reserved-server-names", "MCP reference", "Reserved server names", "Installing MCP servers", "setting.mcpServers", "partial", false),
  s("config.role", "MCP reference", "Server role", "Installing MCP servers", "feature.mcp-server-role", "not-supported", false),
  s("config.always-load", "MCP reference", "Server alwaysLoad", "Scale with MCP tool search", "feature.mcp-server-always-load", "not-supported", false),
  s("config.shell-prefix", "MCP reference", "Stdio shell prefix", "Option 3: Add a local stdio server", "feature.mcp-shell-prefix", "not-supported", false),
  s("config.child-session-env", "MCP reference", "Child-session environment", "Option 3: Add a local stdio server", "feature.mcp-child-session-env", "not-supported"),
  s("scope.local", "MCP reference", "Local scope", "Local scope", "feature.mcp-claude-json-scopes", "partial", false),
  s("scope.project", "MCP reference", "Project scope", "Project scope", "feature.mcp-project-approval", "partial", false),
  s("scope.user", "MCP reference", "User scope", "User scope", "feature.mcp-claude-json-scopes", "partial", false),
  s("scope.precedence", "MCP reference", "Scope precedence", "Scope hierarchy and precedence", "feature.mcp-claude-json-scopes", "partial", false),
  s("approval.enable-all", "Settings reference", "enableAllProjectMcpServers", "Available settings", "setting.enableAllProjectMcpServers", "partial"),
  s("approval.enabled-list", "Settings reference", "enabledMcpjsonServers", "Available settings", "setting.enabledMcpjsonServers", "partial"),
  s("approval.disabled-list", "Settings reference", "disabledMcpjsonServers", "Available settings", "setting.disabledMcpjsonServers", "partial"),
  s("agents.mcp-declaration", "Subagents reference", "Named-agent MCP references and inline definitions", "MCP servers", "agent.frontmatter.mcpServers", "partial", false),
  s("runtime.disabled", "MCP reference", "disabledMcpServers", "Disable a server without removing it", "feature.mcp-runtime-disabled", "partial", true),
  s("runtime.enabled", "MCP reference", "enabledMcpServers", "Managing your servers", "feature.mcp-runtime-enabled", "not-supported", false),
  s("management.status", "MCP reference", "/mcp command", "Managing your servers", "feature.mcp-control-status", "partial"),
  s("management.list", "MCP reference", "claude mcp list", "Managing your servers", "feature.mcp-cli-management", "partial", false),
  s("management.get", "MCP reference", "claude mcp get", "Managing your servers", "feature.mcp-cli-management", "partial", false),
  s("management.remove", "MCP reference", "claude mcp remove", "Managing your servers", "feature.mcp-cli-management", "partial", false),
  s("management.reset-project-choices", "MCP reference", "claude mcp reset-project-choices", "Project scope", "feature.mcp-cli-management", "partial", false),
  s("management.add", "MCP reference", "claude mcp add", "Installing MCP servers", "feature.mcp-cli-management", "partial", false),
  s("management.add-json", "MCP reference", "claude mcp add-json", "Add MCP servers from JSON configuration", "feature.mcp-cli-management", "partial", false),
  s("management.add-from-claude-desktop", "MCP reference", "claude mcp add-from-claude-desktop", "Import MCP servers from Claude Desktop", "feature.mcp-cli-management", "not-supported", false),
  s("management.connectors", "MCP reference", "Claude.ai connectors", "Use MCP servers from claude.ai", "feature.mcp-connectors", "not-supported", false),
  s("management.server-mode", "MCP reference", "claude mcp serve", "Use Claude Code as an MCP server", "feature.mcp-server-mode", "not-supported"),
  s("invocation.mcp-config", "CLI reference", "--mcp-config", "CLI flags", "feature.mcp-cli-invocation-controls", "not-supported"),
  s("invocation.strict-mcp-config", "CLI reference", "--strict-mcp-config", "CLI flags", "feature.mcp-cli-invocation-controls", "not-supported"),
  s("invocation.permission-prompt-tool", "CLI reference", "--permission-prompt-tool", "CLI flags", "feature.mcp-cli-invocation-controls", "not-supported"),
  s("invocation.bare", "CLI reference", "--bare", "CLI flags", "feature.mcp-cli-invocation-controls", "not-supported"),
  s("invocation.safe-mode", "CLI reference", "--safe-mode", "CLI flags", "feature.mcp-cli-invocation-controls", "not-supported"),
  s("connection.capability-discovery", "MCP reference", "Connection and capability discovery", "Scale with MCP tool search", "feature.mcp-capability-discovery", "partial"),
  s("connection.failure-visibility", "MCP reference", "Model-visible failed-server and error reporting through ToolSearch", "Scale with MCP tool search", "feature.mcp-model-failure-visibility", "partial"),
  s("connection.automatic-reconnection", "MCP reference", "Automatic reconnection", "Automatic reconnection", "feature.mcp-remote-transports", "partial"),
  s("connection.wait-tool", "MCP reference", "WaitForMcpServers", "Scale with MCP tool search", "tool.WaitForMcpServers", "not-supported"),
  s("dynamic.tools-list-changed", "MCP reference", "tools/list_changed", "Dynamic tool updates", "feature.mcp-list-changed", "not-supported", false),
  s("dynamic.prompts-list-changed", "MCP reference", "prompts/list_changed", "Dynamic tool updates", "feature.mcp-list-changed", "not-supported", false),
  s("dynamic.resources-list-changed", "MCP reference", "resources/list_changed", "Dynamic tool updates", "feature.mcp-list-changed", "not-supported", false),
  s("dynamic.failed-refresh-retains-catalog", "MCP reference", "Failed list_changed refresh retains previous catalogs", "Dynamic tool updates", "feature.mcp-list-changed", "not-supported", false),
  s("channels.behavior", "Claude Code channels", "MCP channels", "Enterprise controls", "feature.mcp-channels", "not-supported"),
  s("channels.load", "CLI reference", "--channels", "CLI flags", "feature.mcp-channels", "not-supported"),
  s("channels.development", "CLI reference", "--dangerously-load-development-channels", "CLI flags", "feature.mcp-channels", "not-supported"),
  s("channels.enabled-setting", "Settings reference", "channelsEnabled", "Available settings", "setting.channelsEnabled", "not-supported"),
  s("channels.master-disable", "Settings reference", "channelsEnabled master disable", "Available settings", "setting.channelsEnabled", "not-supported"),
  s("channels.allowed-plugins", "Settings reference", "allowedChannelPlugins", "Available settings", "setting.allowedChannelPlugins", "not-supported"),
  s("channels.allowlist-replacement-empty", "Settings reference", "allowedChannelPlugins replacement and empty-list semantics", "Available settings", "setting.allowedChannelPlugins", "not-supported"),
  s("channels.development-exception", "Settings reference", "allowedChannelPlugins development exception", "Available settings", "setting.allowedChannelPlugins", "not-supported"),
  s("tools.proxy-registration", "MCP reference", "MCP tools", "Scale with MCP tool search", "tool.mcp__*", "partial", false),
  s("tools.root-combinator-schema", "MCP reference", "Tool schemas with root combinators", "Tool input schemas with a root-level combinator", "feature.mcp-root-schema-combinators", "partial"),
  s("tools.search", "MCP reference", "MCP tool search", "Scale with MCP tool search", "tool.ToolSearch", "not-supported"),
  s("tools.deferred-schema-loading", "MCP reference", "Deferred tool loading", "Scale with MCP tool search", "feature.mcp-tool-search", "not-supported"),
  s("tools.enable-tool-search", "MCP reference", "ENABLE_TOOL_SEARCH", "Scale with MCP tool search", "feature.mcp-tool-search", "not-supported"),
  s("tools.max-before-defer", "MCP reference", "MAX_MCP_TOOLS_BEFORE_DEFER", "Scale with MCP tool search", "feature.mcp-tool-search", "not-supported"),
  s("tools.server-always-load", "MCP reference", "Server alwaysLoad", "Scale with MCP tool search", "feature.mcp-server-always-load", "not-supported", false),
  s("tools.meta-always-load", "MCP reference", "anthropic/alwaysLoad", "Scale with MCP tool search", "feature.mcp-tool-always-load", "not-supported"),
  s("tools.meta-requires-user-interaction", "MCP reference", "anthropic/requiresUserInteraction", "Require approval for a specific tool", "feature.mcp-requires-user-interaction", "not-supported", true),
  s("tools.meta-max-result-size-chars", "MCP reference", "anthropic/maxResultSizeChars", "MCP output limits and warnings", "feature.mcp-max-result-size-chars", "not-supported", false),
  s("tools.long-call-backgrounding", "MCP reference", "Long-running calls", "Automatic backgrounding of long tool calls", "feature.mcp-auto-background", "not-supported"),
  s("tools.auto-background-threshold", "MCP reference", "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS", "Automatic backgrounding of long tool calls", "feature.mcp-auto-background", "not-supported"),
  s("tools.auto-background-disable", "MCP reference", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "Automatic backgrounding of long tool calls", "feature.mcp-auto-background", "not-supported"),
  s("tools.auto-background-noninteractive-opt-in", "MCP reference", "CLAUDE_AUTO_BACKGROUND_TASKS non-interactive opt-in", "Automatic backgrounding of long tool calls", "feature.mcp-auto-background", "not-supported"),
  s("tools.auto-background-exclusions", "MCP reference", "Auto-background subagent, IDE, and noninteractive exclusions", "Automatic backgrounding of long tool calls", "feature.mcp-auto-background", "not-supported"),
  s("tools.auto-background-elicitation-deferral", "MCP reference", "Auto-background elicitation-dialog deferral", "Automatic backgrounding of long tool calls", "feature.mcp-auto-background", "not-supported"),
  s("output.max-mcp-output-tokens", "MCP reference", "MAX_MCP_OUTPUT_TOKENS", "MCP output limits and warnings", "feature.mcp-output-token-cap", "not-supported"),
  s("output.idle-timeout", "MCP reference", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "Push messages with channels", "feature.mcp-idle-timeout", "not-supported"),
  s("output.per-tool-persistence", "MCP reference", "Per-tool result persistence", "MCP output limits and warnings", "feature.mcp-max-result-size-chars", "not-supported", false),
  s("server.instructions", "MCP reference", "Server instructions", "Scale with MCP tool search", "feature.mcp-server-instructions", "not-supported", false),
  s("server.instructions-truncation", "MCP reference", "Server instruction truncation", "Scale with MCP tool search", "feature.mcp-server-instructions", "not-supported", false),
  s("prompts.catalog-and-get", "MCP reference", "MCP prompts", "Use MCP prompts as commands", "feature.mcp-prompts", "partial"),
  s("resources.list", "MCP reference", "List MCP resources", "Use MCP resources", "tool.ListMcpResourcesTool", "partial"),
  s("resources.read", "MCP reference", "Read MCP resources", "Reference MCP resources", "tool.ReadMcpResourceTool", "partial"),
  s("resources.attachments", "MCP reference", "Resource references", "Reference MCP resources", "feature.mcp-resources", "partial"),
  s("resources.templates", "MCP reference", "Resource templates", "Use MCP resources", "feature.mcp-resource-templates", "not-supported", false),
  s("resources.subscriptions", "MCP reference", "Resource subscriptions", "Use MCP resources", "feature.mcp-resource-subscriptions", "not-supported", false),
  s("roots.list", "MCP reference", "roots/list", "Option 3: Add a local stdio server", "feature.mcp-roots", "not-supported", false),
  s("roots.list-changed", "MCP reference", "roots/list_changed", "Option 3: Add a local stdio server", "feature.mcp-roots", "not-supported", false),
  s("elicitation.protocol", "MCP reference", "Elicitation", "Respond to MCP elicitation requests", "feature.mcp-elicitation", "not-supported"),
  s("elicitation.hook-request", "Hooks reference", "Elicitation", "Elicitation", "hook.event.Elicitation", "degraded-noop"),
  s("elicitation.hook-result", "Hooks reference", "ElicitationResult", "ElicitationResult", "hook.event.ElicitationResult", "degraded-noop"),
  s("hooks.match-mcp-tools", "Hooks reference", "Match MCP tools", "Match MCP tools", "feature.mcp-hook-matching", "partial"),
  s("hooks.mcp-tool-handler-type", "Hooks reference", "MCP tool hook handler type", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-handler-server", "Hooks reference", "MCP tool hook handler server", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-handler-tool", "Hooks reference", "MCP tool hook handler tool", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-handler-input", "Hooks reference", "MCP tool hook handler input", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("oauth.login", "MCP reference", "OAuth authentication", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.cli-login", "MCP reference", "claude mcp login", "Authenticate from the command line", "feature.mcp-oauth", "not-supported", false),
  s("oauth.cli-logout", "MCP reference", "claude mcp logout", "Authenticate from the command line", "feature.mcp-oauth", "not-supported", false),
  s("oauth.dynamic-client-registration", "MCP reference", "OAuth dynamic client registration", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.fixed-callback-port", "MCP reference", "OAuth fixed callback port", "Use a fixed OAuth callback port", "feature.mcp-oauth", "not-supported", false),
  s("oauth.preconfigured-client", "MCP reference", "OAuth preconfigured client credentials and CIMD", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.auth-metadata-override", "MCP reference", "OAuth authServerMetadataUrl discovery override", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.scopes", "MCP reference", "OAuth scopes restriction and precedence", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("headers.static", "MCP reference", "Static headers", "Option 1: Add a remote HTTP server", "feature.mcp-remote-transports", "partial", false),
  s("headers.dynamic", "MCP reference", "Dynamic headers", "Use dynamic headers for custom authentication", "feature.mcp-headers-helper", "not-supported"),
  s("plugins.servers", "MCP reference", "Plugin MCP servers", "Plugin-provided MCP servers", "feature.mcp-plugin-servers", "not-supported"),
  s("plugins.lifecycle-reload", "MCP reference", "Plugin MCP server lifecycle and reload behavior", "Plugin-provided MCP servers", "feature.mcp-plugin-servers", "not-supported"),
  s("plugins.placeholder-substitution", "MCP reference", "Plugin MCP placeholder expansion and substitution", "Plugin-provided MCP servers", "feature.mcp-plugin-servers", "not-supported"),
  s("plugins.scoped-naming", "MCP reference", "Plugin-scoped MCP tool and server naming", "Plugin-provided MCP servers", "feature.mcp-plugin-servers", "not-supported"),
  s("plugins.transport-substitution", "MCP reference", "Transport-specific plugin substitution and support behavior", "Plugin-provided MCP servers", "feature.mcp-plugin-servers", "not-supported"),
  s("managed.server-config", "MCP reference", "Managed MCP configuration", "Managed MCP configuration", "feature.mcp-managed-config", "partial", true),
  s("managed.server-config-file", "MCP reference", "managed-mcp.json", "Managed MCP configuration", "feature.mcp-managed-config", "partial", true),
  s("managed.only", "Settings reference", "allowManagedMcpServersOnly", "Available settings", "setting.allowManagedMcpServersOnly", "partial", true),
  s("managed.only-restriction", "Settings reference", "allowManagedMcpServersOnly restriction", "Available settings", "setting.allowManagedMcpServersOnly", "partial", true),
  s("managed.invalid-only-treated-true", "Settings reference", "Invalid allowManagedMcpServersOnly is treated as true", "Invalid entries in managed settings", "setting.allowManagedMcpServersOnly", "partial", true),
  s("managed.strict-plugin-only", "Settings reference", "strictPluginOnlyCustomization with mcp", "Available settings", "setting.strictPluginOnlyCustomization.mcp", "not-supported", true),
  s("managed.allow-claude-ai", "Settings reference", "allowAllClaudeAiMcps", "Available settings", "setting.allowAllClaudeAiMcps", "not-supported"),
  s("managed.disable-connectors", "Settings reference", "disableClaudeAiConnectors", "Available settings", "setting.disableClaudeAiConnectors", "not-supported"),
  s("managed.disable-sideload", "Settings reference", "disableSideloadFlags", "Available settings", "setting.disableSideloadFlags", "not-supported"),
  s("managed.allowlist", "Settings reference", "allowedMcpServers", "Available settings", "setting.allowedMcpServers", "partial", true),
  s("managed.invalid-allowlist-empty", "Settings reference", "Invalid allowedMcpServers becomes an empty allowlist", "Invalid entries in managed settings", "setting.allowedMcpServers", "partial", true),
  s("managed.denylist", "Settings reference", "deniedMcpServers", "Available settings", "setting.deniedMcpServers", "partial", true),
  s("oauth.auth-detection", "MCP reference", "401/403 authentication detection", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.refresh-reconnect-retry", "MCP reference", "automatic token refresh, reconnect, and one retry", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.reauthenticate", "MCP reference", "re-authenticate path", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.clear-authentication", "MCP reference", "Clear authentication path", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.startup-notice", "MCP reference", "startup authentication-needed notice", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.headless-tool-search-visibility", "MCP reference", "headless and print-mode model visibility with tool search", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.authorization-header-suppression", "MCP reference", "static headers.Authorization prevents OAuth fallback", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.no-browser", "MCP reference", "login --no-browser", "Authenticate from the command line", "feature.mcp-oauth", "not-supported", false),
  s("oauth.client-credentials-flags", "MCP reference", "--client-id, masked --client-secret, and MCP_CLIENT_SECRET", "Use pre-configured OAuth credentials", "feature.mcp-oauth", "not-supported", false),
  s("oauth.transport-applicability", "MCP reference", "HTTP/SSE-only OAuth credential applicability", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.offline-access", "MCP reference", "offline_access behavior", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("oauth.insufficient-scope", "MCP reference", "insufficient_scope reauthentication behavior", "Authenticate with remote MCP servers", "feature.mcp-oauth", "not-supported", false),
  s("timeout.tool-hard-wall", "MCP reference", "hard wall-clock tool timeout", "Push messages with channels", "feature.mcp", "partial", false),
  s("timeout.progress-does-not-extend-wall", "MCP reference", "progress notifications do not extend the hard tool timeout", "Push messages with channels", "feature.mcp", "partial", false),
  s("timeout.first-byte-default", "MCP reference", "60-second first-byte default", "Push messages with channels", "feature.mcp-first-byte-timeout", "not-supported", false),
  s("timeout.first-byte-override-floor", "MCP reference", "first-byte asymmetric override and floor rules", "Push messages with channels", "feature.mcp-first-byte-timeout", "not-supported", false),
  s("timeout.first-byte-transport-exclusions", "MCP reference", "no first-byte timer for stdio or WebSocket", "Push messages with channels", "feature.mcp-first-byte-timeout", "not-supported", false),
  s("timeout.idle-transport-defaults", "MCP reference", "idle defaults by transport", "Push messages with channels", "feature.mcp-idle-timeout", "not-supported", false),
  s("timeout.idle-progress-reset", "MCP reference", "progress notifications reset or avoid idle expiry", "Push messages with channels", "feature.mcp-idle-timeout", "not-supported", false),
  s("timeout.idle-in-process-exclusions", "MCP reference", "IDE and SDK in-process idle exclusions", "Push messages with channels", "feature.mcp-idle-timeout", "not-supported", false),
  s("timeout.idle-disable-zero", "MCP reference", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0 disables idle timeout", "Push messages with channels", "feature.mcp-idle-timeout", "not-supported", false),
  s("timeout.per-server-idle-floor", "MCP reference", "per-server timeout acts as idle-timeout floor", "Push messages with channels", "feature.mcp-idle-timeout", "not-supported", false),
  s("hooks.match-patterns", "Hooks reference", "MCP tool naming, matcher patterns, and plugin-scoped names", "Match MCP tools", "feature.mcp-hook-matching", "partial", false),
  s("hooks.mcp-tool-connected", "Hooks reference", "mcp_tool already-connected requirement and no connection or OAuth initiation", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-plugin-server", "Hooks reference", "plugin-scoped server naming", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-text-output", "Hooks reference", "text output interpretation, including valid deny/block decisions, as command-hook stdout", "MCP tool hook fields", "feature.hook-handler.mcp_tool-blocking-enforcement", "degraded-noop", true),
  s("hooks.mcp-tool-errors", "Hooks reference", "disconnected server and isError non-blocking behavior", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-all-events", "Hooks reference", "mcp_tool availability across all hook events", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.mcp-tool-early-race", "Hooks reference", "SessionStart and Setup early connection race", "MCP tool hook fields", "feature.hook-handler.mcp_tool", "degraded-noop", false),
  s("hooks.elicitation-matcher", "Hooks reference", "Elicitation server-name matcher", "Elicitation", "hook.event.Elicitation", "degraded-noop", false),
  s("hooks.elicitation-input", "Hooks reference", "Elicitation input contract", "Elicitation", "hook.event.Elicitation", "degraded-noop", false),
  s("hooks.elicitation-output", "Hooks reference", "Elicitation output and deny behavior", "Elicitation", "hook.event.Elicitation", "degraded-noop", false),
  s("hooks.elicitation-result-matcher", "Hooks reference", "ElicitationResult server-name matcher", "ElicitationResult", "hook.event.ElicitationResult", "degraded-noop", false),
  s("hooks.elicitation-result-input", "Hooks reference", "ElicitationResult input contract", "ElicitationResult", "hook.event.ElicitationResult", "degraded-noop", false),
  s("hooks.elicitation-result-output", "Hooks reference", "ElicitationResult output and block-to-decline behavior", "ElicitationResult", "hook.event.ElicitationResult", "degraded-noop", false),
  s("tools.search-default", "MCP reference", "tool search is default where supported", "Scale with MCP tool search", "feature.mcp-tool-search", "not-supported", false),
  s("tools.search-unsupported-paths", "MCP reference", "unsupported model, provider, deployment, and upfront-loading paths", "Scale with MCP tool search", "feature.mcp-tool-search", "not-supported", false),
  s("tools.search-wait-selection", "MCP reference", "ToolSearch versus WaitForMcpServers selection and fallback", "Scale with MCP tool search", "feature.mcp-tool-search", "not-supported", false),
  s("tools.search-failure-dependency", "MCP reference", "tool-search connection-failure visibility dependency", "Scale with MCP tool search", "feature.mcp-model-failure-visibility", "partial", false),
  s("managed.strict-plugin-membership", "Settings reference", "strictPluginOnlyCustomization includes mcp", "Available settings", "setting.strictPluginOnlyCustomization.mcp", "not-supported", true),
  s("managed.strict-plugin-restriction", "Settings reference", "plugin-only result excludes user, local, project, manual, and CLI-configured MCP sources", "Available settings", "setting.strictPluginOnlyCustomization.mcp", "not-supported", true),
  s("sampling.server-request", "MCP reference", "Sampling", "Scale with MCP tool search", "feature.mcp-sampling", "not-supported", false),
];

const EXPECTED_EVIDENCE: Readonly<Record<string, readonly AuditSurface["evidence"][number][]>> = {
  "agent.frontmatter.mcpServers": [{"quality":"documented","source":"Subagents reference — MCP servers","reviewed":"2026-07-31"}],
  "feature.hook-handler.mcp_tool": [{"quality":"documented","source":"Hooks reference \u2014 MCP tool hook fields","reviewed":"2026-07-31"}],
  "feature.hook-handler.mcp_tool-blocking-enforcement": [{"quality":"documented","source":"Hooks reference \u2014 MCP tool hook fields","reviewed":"2026-07-31"}],
  "feature.mcp": [{"quality":"documented","source":"MCP reference — Option 3: Add a local stdio server","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Push messages with channels","reviewed":"2026-07-31"}],
  "feature.mcp-auto-background": [{"quality":"documented","source":"MCP reference — Automatic backgrounding of long tool calls","reviewed":"2026-07-31"}],
  "feature.mcp-capability-discovery": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"},{"quality":"unverified","source":"MCP reference — Scale with MCP tool search (cross-capability failure coupling is not specified)","reviewed":"2026-07-31"}],
  "feature.mcp-channels": [{"quality":"documented","source":"Claude Code channels \u2014 Enterprise controls","reviewed":"2026-07-31"},{"quality":"documented","source":"CLI reference \u2014 CLI flags","reviewed":"2026-07-31"}],
  "feature.mcp-child-session-env": [{"quality":"observed","source":"Claude Code 2.1.218 binary — observed stdio environment sanitization path"},{"quality":"documented","source":"MCP reference — Option 3: Add a local stdio server","reviewed":"2026-07-31"}],
  "feature.mcp-claude-json-scopes": [{"quality":"documented","source":"MCP reference — Local scope","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Scope hierarchy and precedence","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — User scope","reviewed":"2026-07-31"},{"quality":"documented","source":"Settings reference — Environment variables","reviewed":"2026-07-31"},{"quality":"inferred","source":"Private native state — physical .claude.json shape is not documented"}],
  "feature.mcp-cli-invocation-controls": [{"quality":"documented","source":"CLI reference \u2014 CLI flags","reviewed":"2026-07-31"}],
  "feature.mcp-cli-management": [{"quality":"documented","source":"MCP reference — Add MCP servers from JSON configuration","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Import MCP servers from Claude Desktop","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Installing MCP servers","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Managing your servers","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Project scope","reviewed":"2026-07-31"}],
  "feature.mcp-connect-timeout-ms": [{"quality":"observed","source":"Claude Code 2.1.218 binary — observed 5000 ms default on one connect path"},{"quality":"documented","source":"MCP reference — Push messages with channels","reviewed":"2026-07-31"}],
  "feature.mcp-connectors": [{"quality":"documented","source":"MCP reference — Use MCP servers from claude.ai","reviewed":"2026-07-31"}],
  "feature.mcp-control-status": [{"quality":"documented","source":"MCP reference — Managing your servers","reviewed":"2026-07-31"}],
  "feature.mcp-elicitation": [{"quality":"documented","source":"MCP reference — Respond to MCP elicitation requests","reviewed":"2026-07-31"}],
  "feature.mcp-first-byte-timeout": [{"quality":"documented","source":"MCP reference — Push messages with channels","reviewed":"2026-07-31"}],
  "feature.mcp-headers-helper": [{"quality":"documented","source":"MCP reference — Use dynamic headers for custom authentication","reviewed":"2026-07-31"}],
  "feature.mcp-url-without-type-validation": [{"quality":"documented","source":"MCP reference — Option 1: Add a remote HTTP server","reviewed":"2026-07-31"}],
  "feature.mcp-hook-matching": [{"quality":"documented","source":"Hooks reference \u2014 Match MCP tools","reviewed":"2026-07-31"}],
  "feature.mcp-idle-timeout": [{"quality":"documented","source":"MCP reference — Push messages with channels","reviewed":"2026-07-31"}],
  "feature.mcp-list-changed": [{"quality":"documented","source":"MCP reference — Dynamic tool updates","reviewed":"2026-07-31"}],
  "feature.mcp-managed-config": [{"quality":"documented","source":"MCP reference \u2014 Managed MCP configuration","reviewed":"2026-07-31"}],
  "feature.mcp-max-result-size-chars": [{"quality":"documented","source":"MCP reference \u2014 MCP output limits and warnings","reviewed":"2026-07-31"}],
  "feature.mcp-model-failure-visibility": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "feature.mcp-oauth": [{"quality":"documented","source":"MCP reference — Authenticate from the command line","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Authenticate with remote MCP servers","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Use a fixed OAuth callback port","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Use pre-configured OAuth credentials","reviewed":"2026-07-31"}],
  "feature.mcp-output-token-cap": [{"quality":"documented","source":"MCP reference \u2014 MCP output limits and warnings","reviewed":"2026-07-31"}],
  "feature.mcp-plugin-servers": [{"quality":"documented","source":"MCP reference — Plugin-provided MCP servers","reviewed":"2026-07-31"}],
  "feature.mcp-project-approval": [{"quality":"documented","source":"MCP reference — Project scope","reviewed":"2026-07-31"}],
  "feature.mcp-prompts": [{"quality":"documented","source":"MCP reference — Use MCP prompts as commands","reviewed":"2026-07-31"}],
  "feature.mcp-remote-transports": [{"quality":"documented","source":"MCP reference — Automatic reconnection","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Option 1: Add a remote HTTP server","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Option 2: Add a remote SSE server","reviewed":"2026-07-31"}],
  "feature.mcp-requires-user-interaction": [{"quality":"documented","source":"MCP reference — Require approval for a specific tool","reviewed":"2026-07-31"}],
  "feature.mcp-resource-subscriptions": [{"quality":"unverified","source":"MCP reference \u2014 Use MCP resources","reviewed":"2026-07-31"}],
  "feature.mcp-resource-templates": [{"quality":"unverified","source":"MCP reference \u2014 Use MCP resources","reviewed":"2026-07-31"}],
  "feature.mcp-resources": [{"quality":"documented","source":"MCP reference — Reference MCP resources","reviewed":"2026-07-31"}],
  "feature.mcp-root-schema-combinators": [{"quality":"documented","source":"MCP reference — Tool input schemas with a root-level combinator","reviewed":"2026-07-31"}],
  "feature.mcp-roots": [{"quality":"documented","source":"MCP reference \u2014 Option 3: Add a local stdio server","reviewed":"2026-07-31"}],
  "feature.mcp-runtime-disabled": [{"quality":"documented","source":"MCP reference — Disable a server without removing it","reviewed":"2026-07-31"},{"quality":"inferred","source":"Private native state — disabledMcpServers persistence and list interpretation are not documented"}],
  "feature.mcp-runtime-enabled": [{"quality":"documented","source":"MCP reference — Managing your servers","reviewed":"2026-07-31"},{"quality":"inferred","source":"Private native state — enabledMcpServers persistence and list interpretation are not documented"}],
  "feature.mcp-sampling": [{"quality":"unverified","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "feature.mcp-server-always-load": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "feature.mcp-server-instructions": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "feature.mcp-server-mode": [{"quality":"documented","source":"MCP reference — Use Claude Code as an MCP server","reviewed":"2026-07-31"}],
  "feature.mcp-server-role": [{"quality":"unverified","source":"MCP reference — Installing MCP servers","reviewed":"2026-07-31"}],
  "feature.mcp-shell-prefix": [{"quality":"observed","source":"Claude Code 2.1.218 binary — observed stdio spawn prefix path"},{"quality":"documented","source":"MCP reference — Option 3: Add a local stdio server","reviewed":"2026-07-31"}],
  "feature.mcp-tool-always-load": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"},{"quality":"unverified","source":"MCP reference — Scale with MCP tool search (server-startup-barrier coupling for the per-tool form is not specified)","reviewed":"2026-07-31"}],
  "feature.mcp-tool-search": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "feature.mcp-websocket": [{"quality":"documented","source":"MCP reference — Option 4: Add a remote WebSocket server","reviewed":"2026-07-31"}],
  "hook.event.Elicitation": [{"quality":"documented","source":"Hooks reference \u2014 Elicitation","reviewed":"2026-07-31"}],
  "hook.event.ElicitationResult": [{"quality":"documented","source":"Hooks reference \u2014 ElicitationResult","reviewed":"2026-07-31"}],
  "setting.allowAllClaudeAiMcps": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.allowManagedMcpServersOnly": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"},{"quality":"documented","source":"Settings reference \u2014 Invalid entries in managed settings","reviewed":"2026-07-31"}],
  "setting.allowedChannelPlugins": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.allowedMcpServers": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"},{"quality":"documented","source":"Settings reference \u2014 Invalid entries in managed settings","reviewed":"2026-07-31"}],
  "setting.channelsEnabled": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.deniedMcpServers": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.disableClaudeAiConnectors": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.disableSideloadFlags": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.disabledMcpjsonServers": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.enableAllProjectMcpServers": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.enabledMcpjsonServers": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "setting.mcpServers": [{"quality":"documented","source":"MCP reference — Environment variable expansion in .mcp.json","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Installing MCP servers","reviewed":"2026-07-31"},{"quality":"documented","source":"MCP reference — Scope hierarchy and precedence","reviewed":"2026-07-31"}],
  "setting.strictPluginOnlyCustomization.mcp": [{"quality":"documented","source":"Settings reference \u2014 Available settings","reviewed":"2026-07-31"}],
  "tool.ListMcpResourcesTool": [{"quality":"documented","source":"MCP reference \u2014 Use MCP resources","reviewed":"2026-07-31"}],
  "tool.ReadMcpResourceTool": [{"quality":"documented","source":"MCP reference — Reference MCP resources","reviewed":"2026-07-31"}],
  "tool.ToolSearch": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "tool.WaitForMcpServers": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
  "tool.mcp__*": [{"quality":"documented","source":"MCP reference — Scale with MCP tool search","reviewed":"2026-07-31"}],
};


const MCP_SURFACES: readonly AuditSurface[] = RAW_MCP_SURFACES.map((row) => {
  const evidence = EXPECTED_EVIDENCE[row.capabilityId];
  if (evidence === undefined) throw new Error(`Missing independent evidence policy for ${row.capabilityId}`);
  return { ...row, evidence };
});

const EXPECTED_SURFACE_KEYS = [
  "agents.mcp-declaration", "approval.disabled-list", "approval.enable-all", "approval.enabled-list", "channels.allowed-plugins", "channels.allowlist-replacement-empty", "channels.behavior", "channels.development", "channels.development-exception", "channels.enabled-setting", "channels.load", "channels.master-disable", "config.always-load", "config.child-session-env", "config.command-args-env", "config.connect-timeout", "config.empty-url-placeholder", "config.environment-expansion", "config.first-byte-timeout", "config.reserved-server-names", "config.role", "config.shell-prefix", "config.startup-timeout", "config.tool-timeout", "config.url-without-type-validation", "connection.automatic-reconnection", "connection.capability-discovery", "connection.failure-visibility", "connection.wait-tool", "dynamic.failed-refresh-retains-catalog", "dynamic.prompts-list-changed", "dynamic.resources-list-changed", "dynamic.tools-list-changed", "elicitation.hook-request", "elicitation.hook-result", "elicitation.protocol", "headers.dynamic", "headers.static", "hooks.elicitation-input", "hooks.elicitation-matcher", "hooks.elicitation-output", "hooks.elicitation-result-input", "hooks.elicitation-result-matcher", "hooks.elicitation-result-output", "hooks.match-mcp-tools", "hooks.match-patterns", "hooks.mcp-tool-all-events", "hooks.mcp-tool-connected", "hooks.mcp-tool-early-race", "hooks.mcp-tool-errors", "hooks.mcp-tool-handler-input", "hooks.mcp-tool-handler-server", "hooks.mcp-tool-handler-tool", "hooks.mcp-tool-handler-type", "hooks.mcp-tool-plugin-server", "hooks.mcp-tool-text-output", "invocation.bare", "invocation.mcp-config", "invocation.permission-prompt-tool", "invocation.safe-mode", "invocation.strict-mcp-config", "managed.allow-claude-ai", "managed.allowlist", "managed.denylist", "managed.disable-connectors", "managed.disable-sideload", "managed.invalid-allowlist-empty", "managed.invalid-only-treated-true", "managed.only", "managed.only-restriction", "managed.server-config", "managed.server-config-file", "managed.strict-plugin-membership", "managed.strict-plugin-only", "managed.strict-plugin-restriction", "management.add", "management.add-from-claude-desktop", "management.add-json", "management.connectors", "management.get", "management.list", "management.remove", "management.reset-project-choices", "management.server-mode", "management.status", "oauth.auth-detection", "oauth.auth-metadata-override", "oauth.authorization-header-suppression", "oauth.clear-authentication", "oauth.cli-login", "oauth.cli-logout", "oauth.client-credentials-flags", "oauth.dynamic-client-registration", "oauth.fixed-callback-port", "oauth.headless-tool-search-visibility", "oauth.insufficient-scope", "oauth.login", "oauth.no-browser", "oauth.offline-access", "oauth.preconfigured-client", "oauth.reauthenticate", "oauth.refresh-reconnect-retry", "oauth.scopes", "oauth.startup-notice", "oauth.transport-applicability", "output.idle-timeout", "output.max-mcp-output-tokens", "output.per-tool-persistence", "plugins.lifecycle-reload", "plugins.placeholder-substitution", "plugins.scoped-naming", "plugins.servers", "plugins.transport-substitution", "prompts.catalog-and-get", "resources.attachments", "resources.list", "resources.read", "resources.subscriptions", "resources.templates", "roots.list", "roots.list-changed", "runtime.disabled", "runtime.enabled", "sampling.server-request", "scope.local", "scope.precedence", "scope.project", "scope.user", "server.instructions", "server.instructions-truncation", "timeout.first-byte-default", "timeout.first-byte-override-floor", "timeout.first-byte-transport-exclusions", "timeout.idle-disable-zero", "timeout.idle-in-process-exclusions", "timeout.idle-progress-reset", "timeout.idle-transport-defaults", "timeout.per-server-idle-floor", "timeout.progress-does-not-extend-wall", "timeout.tool-hard-wall", "tools.auto-background-disable", "tools.auto-background-elicitation-deferral", "tools.auto-background-exclusions", "tools.auto-background-noninteractive-opt-in", "tools.auto-background-threshold", "tools.deferred-schema-loading", "tools.enable-tool-search", "tools.long-call-backgrounding", "tools.max-before-defer", "tools.meta-always-load", "tools.meta-max-result-size-chars", "tools.meta-requires-user-interaction", "tools.proxy-registration", "tools.root-combinator-schema", "tools.search", "tools.search-default", "tools.search-failure-dependency", "tools.search-unsupported-paths", "tools.search-wait-selection", "tools.server-always-load", "transport.http", "transport.sse", "transport.stdio", "transport.websocket", "transport.websocket-config"
] as const;

const ALLOWED_QUALITIES = new Set(["documented", "observed", "inferred", "unverified"]);

// This frozen exception keeps one independently audited unsupported leaf distinct from its aggregate.
const EXPECTED_TIER_MISMATCHES = new Map<string, { readonly capabilityId: string; readonly leaf: SupportTier; readonly aggregate: SupportTier }>([
  ["management.add-from-claude-desktop", { capabilityId: "feature.mcp-cli-management", leaf: "not-supported", aggregate: "partial" }],
]);

describe("dated Claude Code MCP surface audit", () => {
  it("pins the closed independent surface-key inventory without duplicates", () => {
    const keys = MCP_SURFACES.map((row) => row.surfaceKey).sort();
    expect(keys).toEqual([...EXPECTED_SURFACE_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(EXPECTED_EVIDENCE).sort()).toEqual([...new Set(MCP_SURFACES.map((row) => row.capabilityId))].sort());
  });

  it("maps every surface exactly once to truthful registry metadata", () => {
    const counts = new Map<string, number>();
    for (const row of MCP_SURFACES) counts.set(row.surfaceKey, (counts.get(row.surfaceKey) ?? 0) + 1);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);

    const rowsByCapability = new Map<string, AuditSurface[]>();
    for (const row of MCP_SURFACES) {
      const rows = rowsByCapability.get(row.capabilityId) ?? [];
      rows.push(row);
      rowsByCapability.set(row.capabilityId, rows);
    }
    for (const row of MCP_SURFACES) {
      expect(row.page.trim(), row.surfaceKey).not.toBe("");
      expect(row.leafDescription.trim(), row.surfaceKey).not.toBe("");
      expect(row.authorityHeading.trim(), row.surfaceKey).not.toBe("");
      const entry = lookupCapability(row.capabilityId);
      expect(entry, row.surfaceKey).toBeDefined();
      const mismatch = EXPECTED_TIER_MISMATCHES.get(row.surfaceKey);
      expect(entry?.tier, row.surfaceKey).toBe(mismatch?.aggregate ?? row.tier);
      if (mismatch !== undefined) expect(row).toMatchObject({ capabilityId: mismatch.capabilityId, tier: mismatch.leaf });
      expect(Object.hasOwn(entry!, "safetyRelevant"), `${row.surfaceKey}: explicit safety`).toBe(true);
      expect(entry?.safetyRelevant, row.surfaceKey).toBe(row.safetyRelevant);
      expect(entry?.evidence, `${row.surfaceKey}: complete exact evidence policy`).toEqual(row.evidence);
      expect(
        row.evidence.some((record) => record.source === `${row.page} — ${row.authorityHeading}`),
        `${row.surfaceKey}: exact page/section authority record`,
      ).toBe(true);
      const expectedRelated = EXPECTED_RELATED[row.capabilityId];
      expect(expectedRelated, `${row.surfaceKey}: independent relationship policy`).toBeDefined();
      expect([...(entry?.related ?? [])].sort(), `${row.surfaceKey}: exact relationships`).toEqual([...expectedRelated!].sort());
      if ((rowsByCapability.get(row.capabilityId)?.length ?? 0) > 1) {
        const rationale = GROUPING_RATIONALES[row.capabilityId];
        expect(rationale?.length, `${row.surfaceKey}: substantive grouping rationale`).toBeGreaterThan(40);
        expect(rationale, row.surfaceKey).not.toContain("Shares one PiCC behavior");
      }
    }
  });

  it("pins the sole exact aggregate/leaf tier mismatch", () => {
    expect([...EXPECTED_TIER_MISMATCHES]).toEqual([["management.add-from-claude-desktop", {
      capabilityId: "feature.mcp-cli-management", leaf: "not-supported", aggregate: "partial",
    }]]);
    const actual = MCP_SURFACES.flatMap((row) => {
      const aggregate = lookupCapability(row.capabilityId)?.tier;
      return aggregate === row.tier ? [] : [[row.surfaceKey, { capabilityId: row.capabilityId, leaf: row.tier, aggregate }]];
    });
    expect(actual).toEqual([...EXPECTED_TIER_MISMATCHES]);
    expect(note("feature.mcp-cli-management")).toMatch(/add-from-claude-desktop import command.*unavailable/i);
  });

  it("enforces evidence and relationship invariants for audited capabilities", () => {
    const auditedIds = new Set(MCP_SURFACES.map((row) => row.capabilityId));
    const registryIds = new Set(CAPABILITY_REGISTRY.map((entry) => entry.id));
    for (const id of auditedIds) {
      const entry = lookupCapability(id)!;
      for (const evidence of entry.evidence ?? []) {
        expect(ALLOWED_QUALITIES.has(evidence.quality), `${id}: ${evidence.quality}`).toBe(true);
        expect(evidence.source.trim().length, `${id}: evidence source`).toBeGreaterThan(0);
        if (evidence.quality === "documented" || evidence.quality === "unverified") expect(evidence.reviewed, id).toBe("2026-07-31");
        else expect(evidence.reviewed, `${id}: non-document review date`).toBeUndefined();
        if (evidence.quality === "observed") {
          expect(evidence.source, id).toMatch(/Claude Code \d+\.\d+\.\d+ .*observed .*path/i);
        }
      }
      const related = entry.related ?? [];
      expect(new Set(related).size, `${id}: duplicate relationship`).toBe(related.length);
      for (const target of related) {
        expect(target, `${id}: self relationship`).not.toBe(id);
        expect(registryIds.has(target), `${id}: dangling relationship ${target}`).toBe(true);
      }
    }
  });

  it("pins the material safety and uncertainty decisions", () => {
    expect(lookupCapability("feature.mcp-requires-user-interaction")).toMatchObject({ tier: "not-supported", safetyRelevant: true });
    expect(lookupCapability("feature.mcp-managed-config")).toMatchObject({ tier: "partial", safetyRelevant: true });
    expect(lookupCapability("feature.mcp-runtime-disabled")).toMatchObject({ tier: "partial", safetyRelevant: true });
    expect(note("feature.mcp-runtime-disabled")).toContain("final pre-expansion deny");
    expect(note("feature.mcp-runtime-disabled")).toContain("does not disable settings-extension winners");
    expect(lookupCapability("feature.mcp-runtime-enabled")).toMatchObject({ tier: "not-supported", safetyRelevant: false });
    expect(lookupCapability("feature.mcp-model-failure-visibility")).toMatchObject({ tier: "partial", safetyRelevant: false });
    const failureVisibility = note("feature.mcp-model-failure-visibility");
    expect(failureVisibility).toContain("Main-session startup failures are not injected into MAIN-SESSION model context, and raw failure details are not model-reported");
    expect(failureVisibility).toContain("explicit named-agent reference to a configured route that is unpublished at dispatch may instead receive bounded PiCC-defined unavailability wording");
    expect(failureVisibility).toContain("direct named-agent inline setup degradation settles before the first child provider request");
    expect(failureVisibility).toContain("one bounded PiCC-defined warning reaches that child and later qualifies Agent/TaskOutput");
    expect(failureVisibility).toContain("Cleanup degradation is discovered only after child work and therefore qualifies the parent-facing result, not the already-finished child request");
    expect(failureVisibility).toContain("No warning exposes raw config or runtime errors");
    const aggregate = note("feature.mcp");
    expect(aggregate).toContain("main-session startup failures are not injected into MAIN-SESSION model context, and raw failure details are not model-reported");
    expect(aggregate).toContain("explicit named-agent reference to a configured route that is unpublished at dispatch may receive bounded PiCC-defined unavailability wording");
    expect(aggregate).toContain("direct named-agent inline setup degradation receives bounded warning context before that child's first provider request");
    expect(note("feature.mcp-websocket")).toContain("stdio, HTTP, and SSE alternatives");
    expect(note("feature.mcp-websocket")).toContain("no unchanged-project PiCC path");
    expect(note("feature.mcp-server-always-load")).toContain("Check `/mcp` readiness");
    expect(note("feature.mcp-server-always-load")).toContain("use Claude Code if the startup guarantee is required");
    expect(note("feature.mcp-url-without-type-validation")).toContain("valid `command` as stdio and ignore its URL");
    expect(note("feature.mcp-url-without-type-validation")).toContain("set an explicit `type`");
    expect(note("feature.mcp-list-changed")).toContain("retains previous catalogs when a list_changed refresh fails");
    expect(note("feature.mcp-plugin-servers")).toContain("lifecycle and reload behavior");
    expect(note("feature.mcp-plugin-servers")).toContain("placeholder expansion/substitution");
    expect(note("feature.mcp-plugin-servers")).toContain("transport-specific substitution/support behavior");
    expect(lookupCapability("feature.hook-handler.mcp_tool")).toMatchObject({ safetyRelevant: false });
    expect(lookupCapability("feature.hook-handler.mcp_tool-blocking-enforcement")).toMatchObject({ safetyRelevant: true });
    expect(note("feature.hook-handler.mcp_tool-blocking-enforcement")).toContain("cannot enforce valid deny/block output");
    expect(note("feature.hook-handler.mcp_tool-blocking-enforcement")).toContain("For events where PiCC enforces command-hook blocking results");
    expect(note("feature.hook-handler.mcp_tool-blocking-enforcement")).toContain("WorktreeCreate creation-time enforcement or other unavailable enforcement");
    for (const id of ["feature.mcp-managed-config", "setting.allowManagedMcpServersOnly", "setting.allowedMcpServers", "setting.deniedMcpServers"]) {
      expect(lookupCapability(id), id).toMatchObject({ tier: "partial", safetyRelevant: true });
    }
    expect(note("setting.strictPluginOnlyCustomization.mcp")).toContain("Do not use PiCC where this enterprise policy is required");
    expect(note("setting.channelsEnabled")).toContain("master switch");
    expect(note("setting.channelsEnabled")).toContain("PiCC cannot load channels");
    expect(note("setting.allowedChannelPlugins")).toContain("replacement and empty-list semantics");
    expect(note("setting.allowedChannelPlugins")).toContain("development-channel exception");
    expect(note("feature.mcp-first-byte-timeout")).toContain("aggregate hard wall-clock bounds, not first-byte timers");
    for (const id of ["tool.ToolSearch", "tool.WaitForMcpServers", "feature.mcp-tool-always-load", "feature.mcp-max-result-size-chars", "feature.mcp-sampling", "feature.mcp-resource-subscriptions", "setting.allowAllClaudeAiMcps", "setting.disableClaudeAiConnectors"]) {
      expect(lookupCapability(id), id).toMatchObject({ tier: "not-supported", safetyRelevant: false });
    }
    expect(lookupCapability("feature.mcp-server-role")?.evidence?.map((e) => e.quality)).toEqual(["unverified"]);
    expect(lookupCapability("feature.mcp-resource-templates")?.evidence?.map((e) => e.quality)).toEqual(["unverified"]);
    expect(lookupCapability("feature.mcp-sampling")?.evidence?.map((e) => e.quality)).toEqual(["unverified"]);
    expect(lookupCapability("feature.mcp-tool-always-load")?.evidence?.map((e) => e.quality)).toEqual(["documented", "unverified"]);
    expect(lookupCapability("feature.mcp-root-schema-combinators")).toMatchObject({ tier: "partial", safetyRelevant: false });
    expect(note("feature.mcp-root-schema-combinators")).toContain("valid bounded compileable root anyOf, oneOf, and allOf");
    expect(note("feature.mcp-root-schema-combinators")).toContain("$ref");
    expect(lookupCapability("hook.event.mcp__elicitation")).toMatchObject({ tier: "degraded-noop", safetyRelevant: false });
    expect(note("hook.event.mcp__elicitation")).toContain("historical PiCC compatibility alias");
  });
});
