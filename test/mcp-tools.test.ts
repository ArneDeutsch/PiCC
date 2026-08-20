import { describe, expect, it, vi } from "vitest";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { buildMcpProxyTool, buildMcpProxyTools, normalizeMcpSchema, type McpToolSource } from "../src/runtime/mcp-tools.js";
import type { McpToolInfo } from "../src/runtime/mcp.js";

const bindingDefinitions = {
  ...TUI_KEYBINDINGS,
  "app.tools.expand": { defaultKeys: "ctrl+o" as const, description: "Toggle tool output" },
};
const plainTheme = { fg: (_slot: string, text: string) => text };

function withBinding<T>(keys: string[], run: () => T): T {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager(bindingDefinitions, { "app.tools.expand": keys as never }));
  try { return run(); } finally { setKeybindings(previous); }
}

// ---------------------------------------------------------------------------
// Fixture source (structural McpToolSource — no servers spawned at this layer)
// ---------------------------------------------------------------------------

function sourceFor(
  tools: McpToolInfo[],
  callTool: McpToolSource["callTool"] = async () => ({ content: [] }),
): McpToolSource {
  return { tools: () => tools, callTool };
}

function toolInfo(over: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    serverName: "srv",
    toolName: "echo",
    description: "echoes text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Proxy construction
// ---------------------------------------------------------------------------

describe("buildMcpProxyTools proxy construction", () => {
  it("builds one exact late-exposure definition without widening to sibling catalog entries", () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const proxy = buildMcpProxyTool(toolInfo({ toolName: "late" }), { callTool });
    expect(proxy?.name).toBe("mcp__srv__late");
  });

  it("names proxies mcp__<server>__<tool> and carries the runtime's bounded description", () => {
    const [proxy] = buildMcpProxyTools(
      sourceFor([toolInfo({ serverName: "files", toolName: "list-dir", description: "lists a dir" })]),
    );
    expect(proxy?.name).toBe("mcp__files__list-dir");
    expect(proxy?.label).toBe("list-dir (files MCP)");
    expect(proxy?.description).toBe("lists a dir");
  });

  it("derives labels from authoritative component metadata, including ambiguous wire names", () => {
    const components = [
      { serverName: "Srv.Name_", toolName: "_find__Item-", label: "_find__Item- (Srv.Name_ MCP)" },
      { serverName: "srv_", toolName: "echo", label: "echo (srv_ MCP)" },
      { serverName: "srv", toolName: "_echo", label: "_echo (srv MCP)" },
    ];
    const proxies = buildMcpProxyTools(sourceFor(components.map((component) => toolInfo(component))));
    expect(proxies.map(({ name, label }) => ({ name, label }))).toEqual([
      { name: "mcp__Srv.Name____find__Item-", label: "_find__Item- (Srv.Name_ MCP)" },
      { name: "mcp__srv___echo", label: "echo (srv_ MCP)" },
      { name: "mcp__srv___echo", label: "_echo (srv MCP)" },
    ]);
  });

  it("never sets promptSnippet or promptGuidelines (zero-context hard invariant)", () => {
    const proxies = buildMcpProxyTools(
      sourceFor([toolInfo(), toolInfo({ toolName: "other", inputSchema: undefined })]),
    );
    expect(proxies).toHaveLength(2);
    for (const proxy of proxies) {
      expect("promptSnippet" in proxy).toBe(false);
      expect("promptGuidelines" in proxy).toBe(false);
      expect(proxy.promptSnippet).toBeUndefined();
      expect(proxy.promptGuidelines).toBeUndefined();
    }
  });

  it("builds fresh instances per call", () => {
    const source = sourceFor([toolInfo()]);
    const first = buildMcpProxyTools(source);
    const second = buildMcpProxyTools(source);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]?.name).toBe(second[0]?.name);
  });

  it("drops a tool whose registered name exceeds 64 chars, with a bounded diagnostic and unharmed siblings", () => {
    // The runtime KEEPS long names (Claude-parity sanitize-not-drop), so the
    // wire bound must live here: one over-long function name would 400 every
    // subsequent model request.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const longName = "t".repeat(300);
      const proxies = buildMcpProxyTools(
        sourceFor([toolInfo({ toolName: longName }), toolInfo({ toolName: "short" })]),
      );
      expect(proxies.map((p) => p.name)).toEqual(["mcp__srv__short"]);
      const line = errors.find((e) => e.includes("64-char"));
      expect(line).toBeDefined();
      expect(line).toContain("dropped");
      // Bounded quoting: the 300-char name never rides the stderr line in full.
      expect(line).not.toContain(longName);
      expect(line!.length).toBeLessThanOrEqual(400);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a name at exactly the 64-char bound", () => {
    const toolName = "t".repeat(64 - "mcp__srv__".length);
    const proxies = buildMcpProxyTools(sourceFor([toolInfo({ toolName })]));
    expect(proxies).toHaveLength(1);
    expect(proxies[0]!.name).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// Execute delegation
// ---------------------------------------------------------------------------

describe("buildMcpProxyTools execute", () => {
  it("delegates to callTool with server, tool, and args, joining text content", async () => {
    const calls: Array<{ server: string; tool: string; args: unknown }> = [];
    const source = sourceFor([toolInfo()], async (server, tool, args) => {
      calls.push({ server, tool, args });
      return { content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] };
    });
    const [proxy] = buildMcpProxyTools(source);
    const result = await proxy!.execute("id-1", { text: "hi" }, undefined, undefined, {} as never);
    expect(calls).toEqual([{ server: "srv", tool: "echo", args: { text: "hi" } }]);
    expect(result.content).toEqual([{ type: "text", text: "one\ntwo" }]);
    expect(result.details).toEqual({ server: "srv", tool: "echo" });
  });

  it("degrades non-text content blocks to a single bounded note", async () => {
    const source = sourceFor([toolInfo()], async () => ({
      content: [
        { type: "text", text: "kept" },
        { type: "image", data: "Zm9v", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///x" } },
      ],
    }));
    const [proxy] = buildMcpProxyTools(source);
    const result = await proxy!.execute("id-1", {}, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("kept");
    expect(text).toContain("2 non-text MCP content block(s) omitted");
  });

  it("maps an embedded text resource block to a labeled resource line (no omission note)", async () => {
    const source = sourceFor([toolInfo()], async () => ({
      content: [
        { type: "text", text: "lead" },
        { type: "resource", resource: { uri: "file:///data.txt", mimeType: "text/plain", text: "resource body" } },
      ],
    }));
    const [proxy] = buildMcpProxyTools(source);
    const result = await proxy!.execute("id-1", {}, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("lead\n[Resource from srv at file:///data.txt] resource body");
  });

  it("maps a resource_link block to a labeled link line (no omission note)", async () => {
    const source = sourceFor([toolInfo()], async () => ({
      content: [
        { type: "resource_link", name: "spec", uri: "https://example.test/spec", description: "the spec" },
      ],
    }));
    const [proxy] = buildMcpProxyTools(source);
    const result = await proxy!.execute("id-1", {}, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("[Resource link: spec] https://example.test/spec (the spec)");
  });

  it("still routes a BLOB (text-less) resource block to the omission note", async () => {
    const source = sourceFor([toolInfo()], async () => ({
      content: [{ type: "resource", resource: { uri: "file:///img.png", blob: "Zm9v" } }],
    }));
    const [proxy] = buildMcpProxyTools(source);
    const result = await proxy!.execute("id-1", {}, undefined, undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1 non-text MCP content block(s) omitted");
  });

  it("throws on an MCP isError result so Pi renders an error tool result", async () => {
    const source = sourceFor([toolInfo()], async () => ({
      isError: true,
      content: [{ type: "text", text: "server-side failure detail" }],
    }));
    const [proxy] = buildMcpProxyTools(source);
    await expect(
      proxy!.execute("id-1", {}, undefined, undefined, {} as never),
    ).rejects.toThrow("server-side failure detail");
  });

  it("propagates callTool rejections (timeouts included) as descriptive errors", async () => {
    const source = sourceFor([toolInfo()], async () => {
      throw new Error('MCP tool "echo" on server "srv" timed out after 1000 ms');
    });
    const [proxy] = buildMcpProxyTools(source);
    await expect(
      proxy!.execute("id-1", {}, undefined, undefined, {} as never),
    ).rejects.toThrow(/timed out after 1000 ms/);
  });

  it("maps only fixed runtime outage errors to retry or repair guidance while preserving protocol speech", async () => {
    const canary = "https://token.example/SECRET_HEADER_CANARY";
    const messages = [
      'MCP server "srv" is temporarily unavailable while reconnecting',
      'MCP server "srv" is unavailable because its remote connection failed',
    ];
    const expected = [
      /was not called.*temporarily unavailable.*Retry later/,
      /was not called.*recovery has stopped.*\/mcp or \/doctor.*reload or start a new session/,
    ];
    for (let index = 0; index < messages.length; index += 1) {
      const [proxy] = buildMcpProxyTools(sourceFor([toolInfo()], async () => {
        throw new Error(messages[index]!);
      }));
      await expect(proxy!.execute("id-1", {}, undefined, undefined, {} as never))
        .rejects.toThrow(expected[index]);
    }

    const protocolSpeech = `protocol failure ${canary}`;
    const [protocolProxy] = buildMcpProxyTools(sourceFor([toolInfo()], async () => {
      throw new Error(protocolSpeech);
    }));
    await expect(protocolProxy!.execute("id-3", {}, undefined, undefined, {} as never))
      .rejects.toThrow(protocolSpeech);
  });

  it("substitutes {} for a non-object params value before delegating", async () => {
    const seen: unknown[] = [];
    const source = sourceFor([toolInfo()], async (_s, _t, args) => {
      seen.push(args);
      return { content: [] };
    });
    const [proxy] = buildMcpProxyTools(source);
    await proxy!.execute("id-1", undefined as never, undefined, undefined, {} as never);
    expect(seen).toEqual([{}]);
  });
});

// ---------------------------------------------------------------------------
// MCP-owned interactive presentation
// ---------------------------------------------------------------------------

type RenderProxy = NonNullable<ReturnType<typeof buildMcpProxyTools>[number]>;

function exactResult(text: string, server = "srv", tool = "echo"): Record<string, unknown> {
  return { content: [{ type: "text", text }], details: { server, tool }, isError: false };
}

function renderLifecycle(
  proxy: RenderProxy,
  result: unknown,
  options: { expanded?: boolean; partial?: boolean; error?: boolean; width?: number; state?: object } = {},
  theme: unknown = plainTheme,
): { call: string; result: string; lines: string[]; context: Record<string, unknown> } {
  const state = options.state ?? {};
  const context = { state, isPartial: true, isError: false, argsComplete: true };
  proxy.renderCall!({ secret: "/private/arbitrary/value" }, theme as never, context as never);
  context.isPartial = options.partial ?? false;
  context.isError = options.error ?? false;
  const call = proxy.renderCall!({ secret: "/private/arbitrary/value" }, theme as never, context as never);
  const resultComponent = proxy.renderResult!(
    result as never,
    { expanded: options.expanded ?? false, isPartial: options.partial ?? false },
    theme as never,
    context as never,
  );
  const width = options.width ?? 120;
  const lines = call.render(width);
  return { call: lines.join("\n"), result: resultComponent.render(width).join("\n"), lines, context };
}

describe("buildMcpProxyTools MCP-owned presentation", () => {
  it("renders semantic pending → collapsed → expanded → recollapsed lifecycle without arguments", () => withBinding(["alt+e"], () => {
    const [proxy] = buildMcpProxyTools(sourceFor([toolInfo()]));
    const state = {};
    const pendingContext = { state, isPartial: true, isError: false };
    const call = proxy!.renderCall!({ path: "/private/secret.txt", huge: "x".repeat(10_000) }, plainTheme as never, pendingContext as never);
    expect(call.render(120).join("\n")).toBe("mcp echo · server srv");
    expect(call.render(120).join("\n")).not.toMatch(/private|secret|huge/u);

    const settledContext = { ...pendingContext, isPartial: false };
    const settledCall = proxy!.renderCall!({}, plainTheme as never, settledContext as never);
    const canonical = Object.freeze({
      content: Object.freeze([Object.freeze({ type: "text", text: "complete retained body" })]),
      details: Object.freeze({ server: "srv", tool: "echo" }), isError: false,
    });
    const before = JSON.stringify(canonical);
    for (const [expanded, bodyVisible, cueVisible] of [[false, false, true], [true, true, false], [false, false, true]] as const) {
      const detail = proxy!.renderResult!(canonical as never, { expanded, isPartial: false }, plainTheme as never, settledContext as never);
      expect(detail.render(120)).toEqual([]);
      const text = settledCall.render(120).join("\n");
      expect(text).toContain("mcp echo · server srv");
      expect(text.includes("complete retained body")).toBe(bodyVisible);
      expect(text.includes("alt+e to expand")).toBe(cueVisible);
    }
    expect(JSON.stringify(canonical)).toBe(before);
  }));

  it("recognizes only exact closure-correlated final single-text results and otherwise fails open visibly", () => {
    const [proxy] = buildMcpProxyTools(sourceFor([toolInfo()]));
    const inherited = Object.create({ server: "srv", tool: "echo" });
    const accessor = Object.defineProperties({}, {
      server: { enumerable: true, get: () => "srv" },
      tool: { enumerable: true, value: "echo" },
    });
    const revokedResult = Proxy.revocable({}, {});
    revokedResult.revoke();
    const revokedDetails = Proxy.revocable({ server: "srv", tool: "echo" }, {});
    revokedDetails.revoke();
    const revokedContent = Proxy.revocable([{ type: "text", text: "revoked content body" }], {});
    revokedContent.revoke();
    const revokedBlock = Proxy.revocable({ type: "text", text: "revoked block body" }, {});
    revokedBlock.revoke();
    const throwing = (target: object, trap: "getPrototypeOf" | "ownKeys" | "getOwnPropertyDescriptor") =>
      new Proxy(target, { [trap]: () => { throw new Error(`${trap} blocked`); } });
    const cases: Array<[string, unknown, { partial?: boolean; error?: boolean }?]> = [
      ["mismatch", exactResult("mismatch body", "other", "echo")],
      ["bounded mismatch", exactResult(`bounded body ${"x".repeat(10_000)}`, "other", "echo")],
      ["extra", { ...exactResult("extra body"), details: { server: "srv", tool: "echo", extra: true } }],
      ["inherited", { ...exactResult("inherited body"), details: inherited }],
      ["accessor", { ...exactResult("accessor body"), details: accessor }],
      ["multiple", { ...exactResult("unused"), content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }],
      ["image", { ...exactResult("unused"), content: [{ type: "image", data: "AAAA" }] }],
      ["partial", exactResult("partial body"), { partial: true }],
      ["error", exactResult("error body"), { error: true }],
      ["revoked result", revokedResult.proxy],
      ["result descriptor", throwing(exactResult("result descriptor body"), "getOwnPropertyDescriptor")],
      ["revoked details", { ...exactResult("revoked details body"), details: revokedDetails.proxy }],
      ["details prototype", { ...exactResult("details prototype body"), details: throwing({ server: "srv", tool: "echo" }, "getPrototypeOf") }],
      ["details keys", { ...exactResult("details keys body"), details: throwing({ server: "srv", tool: "echo" }, "ownKeys") }],
      ["details descriptor", { ...exactResult("details descriptor body"), details: throwing({ server: "srv", tool: "echo" }, "getOwnPropertyDescriptor") }],
      ["revoked content array", { ...exactResult("unused"), content: revokedContent.proxy }],
      ["content prototype", { ...exactResult("unused"), content: throwing([{ type: "text", text: "content prototype body" }], "getPrototypeOf") }],
      ["content keys", { ...exactResult("unused"), content: throwing([{ type: "text", text: "content keys body" }], "ownKeys") }],
      ["content descriptor", { ...exactResult("unused"), content: throwing([{ type: "text", text: "content descriptor body" }], "getOwnPropertyDescriptor") }],
      ["revoked block", { ...exactResult("unused"), content: [revokedBlock.proxy] }],
      ["block prototype", { ...exactResult("unused"), content: [throwing({ type: "text", text: "block prototype body" }, "getPrototypeOf")] }],
      ["block keys", { ...exactResult("unused"), content: [throwing({ type: "text", text: "block keys body" }, "ownKeys")] }],
      ["block descriptor", { ...exactResult("unused"), content: [throwing({ type: "text", text: "block descriptor body" }, "getOwnPropertyDescriptor")] }],
    ];
    for (const [name, value, flags] of cases) {
      const row = renderLifecycle(proxy!, value, flags);
      const rendered = `${row.call}\n${row.result}`;
      expect(rendered, name).not.toContain("ctrl+o to expand");
      expect(rendered, name).toMatch(/body|one|non-text|Unfamiliar/u);
      expect(rendered.length, name).toBeLessThan(5_000);
    }

    const foreign = buildMcpProxyTools(sourceFor([toolInfo({ serverName: "other", toolName: "echo" })]))[0]!;
    const foreignRendered = renderLifecycle(foreign, exactResult("closure mismatch body")).result;
    expect(foreignRendered).toContain("closure mismatch body");
  });

  it("shows no false cue for exact empty output and reveals detail immediately when expansion is unbound", () => {
    const [proxy] = buildMcpProxyTools(sourceFor([toolInfo()]));
    const empty = withBinding(["ctrl+o"], () => renderLifecycle(proxy!, exactResult("")));
    expect(empty.call).toBe("mcp echo · server srv");
    expect(empty.result).toBe("");
    expect(empty.call).not.toContain("expand");

    const unbound = withBinding([], () => renderLifecycle(proxy!, exactResult("reachable without binding")));
    expect(unbound.call).toContain("reachable without binding");
    expect(unbound.call).not.toContain("expand");
  });

  it("isolates interleaved rows of the same proxy and replaces retained source without stale detail", () => withBinding(["ctrl+o"], () => {
    const [proxy] = buildMcpProxyTools(sourceFor([toolInfo()]));
    const firstState = {};
    const secondState = {};
    expect(renderLifecycle(proxy!, exactResult("first retained body"), { state: firstState }).call).not.toContain("first retained body");
    expect(renderLifecycle(proxy!, exactResult("second retained body"), { state: secondState }).call).not.toContain("second retained body");

    const firstExpanded = renderLifecycle(proxy!, exactResult("first retained body"), { state: firstState, expanded: true }).call;
    expect(firstExpanded).toContain("first retained body");
    expect(firstExpanded).not.toMatch(/second retained body|to expand/u);
    const secondExpanded = renderLifecycle(proxy!, exactResult("second retained body"), { state: secondState, expanded: true }).call;
    expect(secondExpanded).toContain("second retained body");
    expect(secondExpanded).not.toMatch(/first retained body|to expand/u);
    const firstRecollapsed = renderLifecycle(proxy!, exactResult("first retained body"), { state: firstState }).call;
    expect(firstRecollapsed).not.toContain("first retained body");
    expect(firstRecollapsed).toContain("ctrl+o to expand");
    expect(renderLifecycle(proxy!, exactResult("second retained body"), { state: secondState, expanded: true }).call)
      .not.toContain("to expand");

    const replacement = exactResult("replacement retained body");
    const replacementCollapsed = renderLifecycle(proxy!, replacement, { state: firstState }).call;
    expect(replacementCollapsed).toContain("ctrl+o to expand");
    expect(replacementCollapsed).not.toMatch(/first retained body|replacement retained body/u);
    const replacementExpanded = renderLifecycle(proxy!, replacement, { state: firstState, expanded: true }).call;
    expect(replacementExpanded).toContain("replacement retained body");
    expect(replacementExpanded).not.toMatch(/first retained body|second retained body/u);
    expect(renderLifecycle(proxy!, exactResult("second retained body"), { state: secondState, expanded: true }).call)
      .not.toContain("replacement retained body");
  }));

  it("keeps collapsed repaints body-blind and sanitizes once before width-cached wrapping", () => withBinding(["ctrl+o"], () => {
    const [ESC, BEL, OSC8, ST8] = [0x1b, 0x07, 0x9d, 0x9c].map((code) => String.fromCharCode(code)) as [string, string, string, string];
    const body = `HEAD e\u0301 ${ESC}]0;owned${BEL}${"segment ".repeat(2_000)} ${OSC8}clip${ST8} TAIL`;
    let blockDescriptorReads = 0;
    let bodyThemeCalls = 0;
    let bodyNormalizeCalls = 0;
    const block = new Proxy({ type: "text", text: body }, {
      getOwnPropertyDescriptor(target, key) {
        blockDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const theme = { fg(slot: string, text: string) { if (slot === "toolOutput") bodyThemeCalls += 1; return text; } };
    const originalNormalize = String.prototype.normalize;
    const normalizeSpy = vi.spyOn(String.prototype, "normalize").mockImplementation(function(this: string, form) {
      if (String(this) === body) bodyNormalizeCalls += 1;
      return originalNormalize.call(String(this), form);
    });
    try {
      const [proxy] = buildMcpProxyTools(sourceFor([toolInfo()]));
      const state = {};
      const context = { state, isPartial: false, isError: false };
      const call = proxy!.renderCall!({}, theme as never, context as never);
      const result = { content: [block], details: { server: "srv", tool: "echo" }, isError: false };
      proxy!.renderResult!(result as never, { expanded: false, isPartial: false }, theme as never, context as never);
      const descriptorsAfterRecognition = blockDescriptorReads;
      expect(call.render(120).join("\n")).not.toContain("HEAD");
      expect(call.render(37).join("\n")).not.toContain("HEAD");
      expect({ blockDescriptorReads, bodyNormalizeCalls, bodyThemeCalls }).toEqual({
        blockDescriptorReads: descriptorsAfterRecognition, bodyNormalizeCalls: 0, bodyThemeCalls: 0,
      });

      proxy!.renderResult!(result as never, { expanded: true, isPartial: false }, theme as never, context as never);
      expect(bodyNormalizeCalls).toBe(0);
      expect(bodyThemeCalls).toBe(0);
      const descriptorsBeforePaint = blockDescriptorReads;
      const expanded = call.render(37).join("\n");
      expect(expanded).toContain("HEAD é");
      expect(expanded).toContain("TAIL");
      expect(expanded).not.toMatch(/[\u001b\u0007\u009d\u009c]/u);
      expect(bodyNormalizeCalls).toBe(1);
      expect(bodyThemeCalls).toBeGreaterThan(0);
      const themeCallsAfterPaint = bodyThemeCalls;
      expect(call.render(37).join("\n")).toBe(expanded);
      expect({ blockDescriptorReads, bodyNormalizeCalls, bodyThemeCalls }).toEqual({
        blockDescriptorReads: descriptorsBeforePaint, bodyNormalizeCalls: 1, bodyThemeCalls: themeCallsAfterPaint,
      });
      const changedWidth = call.render(41);
      expect(bodyNormalizeCalls).toBe(1);
      expect(bodyThemeCalls).toBeGreaterThan(themeCallsAfterPaint);
      expect(blockDescriptorReads).toBe(descriptorsBeforePaint);
      for (const line of changedWidth) expect(visibleWidth(line)).toBeLessThanOrEqual(41);
    } finally {
      normalizeSpy.mockRestore();
    }
  }));

  it("uses semantic theme roles and contains hostile theme/renderer faults with visible evidence", () => {
    const slots: string[] = [];
    const theme = { fg(slot: string, text: string) { slots.push(slot); return text; } };
    const [proxy] = buildMcpProxyTools(sourceFor([toolInfo({ serverName: "srv\u001b]0;x\u0007", toolName: "echo\u001b[31m" })]));
    const pending = proxy!.renderCall!({ ignored: true }, theme as never, { state: {}, isPartial: true } as never).render(120).join("\n");
    expect(slots).toEqual(expect.arrayContaining(["text", "accent", "muted"]));
    expect(pending).not.toMatch(/[\u001b\u0007]/u);

    const throwingTheme = Object.defineProperty({}, "fg", { get() { throw new Error("theme fault"); } });
    const visible = renderLifecycle(proxy!, { content: [{ type: "text", text: "visible renderer fault evidence" }], details: {} }, {}, throwingTheme);
    expect(`${visible.call}\n${visible.result}`).toContain("visible renderer fault evidence");
    for (const width of [1, 8, 25]) {
      for (const line of renderLifecycle(proxy!, exactResult("body"), { width }, throwingTheme).lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Schema normalization matrix
// ---------------------------------------------------------------------------

describe("normalizeMcpSchema", () => {
  const label = "mcp__srv__tool";

  it("passes a plain object schema through byte-identical (same reference, no diagnostic)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    };
    const before = JSON.stringify(schema);
    const result = normalizeMcpSchema(schema, label);
    expect(result.schema).toBe(schema);
    expect(result.diagnostic).toBeUndefined();
    expect(JSON.stringify(result.schema)).toBe(before);
  });

  it("adds type:'object' to a type-less, combinator-less root and keeps the rest", () => {
    const schema = { properties: { a: { type: "string" } } };
    const result = normalizeMcpSchema(schema, label);
    expect(result.diagnostic).toBeUndefined();
    expect(result.schema).toEqual({ type: "object", properties: { a: { type: "string" } } });
    // The original is never mutated.
    expect("type" in schema).toBe(false);
  });

  it("accepts a root anyOf as-is (Pi's validator handles root combinators)", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    };
    const result = normalizeMcpSchema(schema, label);
    expect(result.schema).toBe(schema);
    expect(result.diagnostic).toBeUndefined();
  });

  it("strips $schema without touching anything else", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { type: "string" } },
    };
    const result = normalizeMcpSchema(schema, label);
    expect(result.diagnostic).toBeUndefined();
    expect(result.schema).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("falls back to the permissive schema for a $ref-bearing schema, with a diagnostic", () => {
    // Deliberately a schema whose $ref RESOLVES under typebox — the fallback is
    // policy (the validator cannot reliably resolve refs), not a compile probe.
    const schema = {
      type: "object",
      properties: { x: { $ref: "#/$defs/thing" } },
      $defs: { thing: { type: "number" } },
    };
    const result = normalizeMcpSchema(schema, label);
    expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(result.diagnostic).toContain(label);
    expect(result.diagnostic).toContain("$ref");
  });

  it("finds a deeply nested $ref without overflowing", () => {
    let leaf: Record<string, unknown> = { $ref: "#/nope" };
    for (let i = 0; i < 500; i++) leaf = { allOfInner: leaf };
    const schema = { type: "object", properties: { deep: leaf } };
    const result = normalizeMcpSchema(schema, label);
    expect(result.diagnostic).toContain("$ref");
  });

  it("degrades an unserializable (stringify-breaking) schema to the permissive fallback", () => {
    // Deep enough that JSON.stringify itself gives up — the serializability
    // gate has to catch it before any recursive walk could run.
    let leaf: Record<string, unknown> = { $ref: "#/nope" };
    for (let i = 0; i < 20_000; i++) leaf = { allOfInner: leaf };
    const schema = { type: "object", properties: { deep: leaf } };
    const result = normalizeMcpSchema(schema, label);
    expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(result.diagnostic).toBeDefined();
  });

  it("caps oversized schemas with a diagnostic naming the size", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 2_000; i++) {
      properties[`property_${i}`] = { type: "string", description: "x".repeat(20) };
    }
    const schema = { type: "object", properties };
    const result = normalizeMcpSchema(schema, label);
    expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(result.diagnostic).toMatch(/\d+ chars serialized/);
  });

  it("falls back for a non-object root type instead of mis-wrapping it", () => {
    const result = normalizeMcpSchema({ type: "array", items: { type: "string" } }, label);
    expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(result.diagnostic).toContain('"array"');
  });

  it("falls back for a non-object schema value with a diagnostic", () => {
    for (const bad of [true, 42, "schema", ["a"]]) {
      const result = normalizeMcpSchema(bad, label);
      expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
      expect(result.diagnostic).toContain("not an object");
    }
  });

  it("uses the permissive schema silently for a schema-less tool", () => {
    for (const absent of [undefined, null]) {
      const result = normalizeMcpSchema(absent, label);
      expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
      expect(result.diagnostic).toBeUndefined();
    }
  });

  it("probes with the pinned typebox Compile: a compile-throwing schema falls back", () => {
    // `pattern: "["` compiles to an invalid RegExp — this exact schema only
    // fails at Compile time, so the fallback firing proves the probe runs
    // against the same pinned typebox Pi validates with.
    const schema = { type: "object", properties: { x: { type: "string", pattern: "[" } } };
    const result = normalizeMcpSchema(schema, label);
    expect(result.schema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    expect(result.diagnostic).toContain("compile probe");
  });

  it("validates an untrusted nullable-array schema at PiCC's compile boundary", async () => {
    const { Compile } = await import("typebox/compile");
    const result = normalizeMcpSchema({
      type: "object",
      properties: {
        tags: { type: ["array", "null"], items: { type: "string" } },
      },
      required: ["tags"],
      additionalProperties: false,
    }, label);
    const validator = Compile(result.schema as never);

    expect(result.diagnostic).toBeUndefined();
    expect(validator.Check({ tags: null })).toBe(true);
    expect(validator.Check({ tags: ["one", "two"] })).toBe(true);
    expect(validator.Check({ tags: ["one", 2] })).toBe(false);
    expect(validator.Check({ tags: 2 })).toBe(false);
  });

  it("the permissive fallback itself survives the validator's Compile", async () => {
    const { Compile } = await import("typebox/compile");
    const result = normalizeMcpSchema(["not-a-schema"], label);
    const validator = Compile(result.schema as never);
    expect(validator.Check({ anything: 1 })).toBe(true);
  });
});
