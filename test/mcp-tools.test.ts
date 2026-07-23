import { describe, expect, it, vi } from "vitest";
import { buildMcpProxyTools, normalizeMcpSchema, type McpToolSource } from "../src/runtime/mcp-tools.js";
import type { McpToolInfo } from "../src/runtime/mcp.js";

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
// Result display rendering
// ---------------------------------------------------------------------------

describe("buildMcpProxyTools renderResult", () => {
  it("strips ESC/OSC sequences from the display while the model-facing result keeps the original bytes", async () => {
    // 7-bit OSC (title write), 7-bit CSI (color), and an 8-bit C1 OSC/ST pair
    // that survives Pi's generic fallback stripping. Built from char codes so
    // no raw control byte hides invisibly in this source file.
    const [ESC, BEL, CSI8, OSC8, ST8] = [0x1b, 0x07, 0x9b, 0x9d, 0x9c].map((code) =>
      String.fromCharCode(code),
    ) as [string, string, string, string, string];
    const hostile = `lead ${ESC}]0;owned${BEL}mid ${ESC}[31mred ${OSC8}clip${ST8} tail`;
    const source = sourceFor([toolInfo()], async () => ({
      content: [{ type: "text", text: hostile }],
    }));
    const [proxy] = buildMcpProxyTools(source);
    const result = await proxy!.execute("id-1", {}, undefined, undefined, {} as never);
    // Round trip to the model stays verbatim (Claude parity).
    expect((result.content[0] as { text: string }).text).toBe(hostile);
    const theme = { fg: (_color: string, text: string) => text };
    const display = proxy!
      .renderResult!(result as never, { expanded: true, isPartial: false }, theme as never, {} as never)
      .render(120)
      .join("\n");
    for (const visible of ["lead", "mid", "red", "tail"]) expect(display).toContain(visible);
    // No live escape introducer or terminator reaches the terminal.
    for (const control of [ESC, BEL, CSI8, OSC8, ST8]) expect(display).not.toContain(control);
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

  it("the permissive fallback itself survives the validator's Compile", async () => {
    const { Compile } = await import("typebox/compile");
    const result = normalizeMcpSchema(["not-a-schema"], label);
    const validator = Compile(result.schema as never);
    expect(validator.Check({ anything: 1 })).toBe(true);
  });
});
