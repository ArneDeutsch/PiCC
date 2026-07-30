import { describe, expect, it } from "vitest";
import {
  parseRemoteMcpFields,
  resolveRemoteMcpFields,
  type RawRemoteMcpFields,
} from "../src/claude/mcp-remote-config.js";

const SERVER = "remote";
const SOURCE = ".mcp.json";

function parse(entry: unknown) {
  return parseRemoteMcpFields(entry, SERVER, SOURCE);
}

function raw(entry: Record<string, unknown>): RawRemoteMcpFields {
  const result = parse(entry);
  expect(result.kind).toBe("supported");
  if (result.kind !== "supported") throw new Error("expected supported remote fields");
  return result.fields;
}

function resolve(fields: RawRemoteMcpFields, env: NodeJS.ProcessEnv = {}) {
  return resolveRemoteMcpFields(fields, env, undefined, SERVER, SOURCE);
}

function diagnosticsOf(entry: unknown, env: NodeJS.ProcessEnv = {}): string[] {
  const parsed = parse(entry);
  if (parsed.kind !== "supported") return "diagnostics" in parsed ? parsed.diagnostics : [];
  return resolve(parsed.fields, env).diagnostics;
}

function expectSecretSafeRejection(
  entry: unknown,
  forbidden: readonly string[],
  env: NodeJS.ProcessEnv = {},
): void {
  const parsed = parse(entry);
  const result = parsed.kind === "supported" ? resolve(parsed.fields, env) : parsed;
  expect(result.kind).toBe("skipped");
  if (result.kind !== "skipped") return;
  expect(result.diagnostics.length).toBeGreaterThan(0);
  const diagnostics = result.diagnostics.join(" ").toLowerCase();
  for (const material of forbidden) expect(diagnostics).not.toContain(material.toLowerCase());
}

describe("parseRemoteMcpFields", () => {
  it("distinguishes non-remote entries", () => {
    expect(parse({ command: "mcp" })).toEqual({ kind: "not-remote" });
    expect(parse({ type: "stdio", command: "mcp", url: "https://ignored.test" })).toEqual({
      kind: "not-remote",
    });
    expect(parse(null)).toEqual({ kind: "not-remote" });
  });

  it.each([
    ["http", "http"],
    ["streamable-http", "http"],
  ] as const)("accepts %s and normalizes its runtime kind to %s", (configuredType, transportKind) => {
    const result = parse({ type: configuredType, url: "https://example.test/mcp" });
    expect(result.kind).toBe("supported");
    if (result.kind !== "supported") return;
    expect(result.fields).toMatchObject({ configuredType, transportKind });
    expect(result.fields.sseDeprecation).toBeUndefined();
    expect(Object.getPrototypeOf(result.fields.rawHeaders)).toBeNull();
  });

  it("accepts SSE while retaining typed deprecation metadata", () => {
    const result = parse({ type: "sse", url: "https://example.test/events" });
    expect(result.kind).toBe("supported");
    if (result.kind !== "supported") return;
    expect(result.fields.transportKind).toBe("sse");
    expect(result.fields.sseDeprecation).toEqual({ deprecated: true, replacement: "http" });
  });

  it("quietly treats an explicit supported type with an empty URL as not configured", () => {
    for (const type of ["http", "streamable-http", "sse"]) {
      expect(parse({ type, url: "", headersHelper: "must-not-run" })).toEqual({
        kind: "not-configured",
        configuredType: type,
        diagnostics: [],
      });
    }
  });

  it("rejects bare URLs with explicit-type guidance and WebSockets as unsupported", () => {
    const bare = parse({ url: "https://bare-canary.test/mcp" });
    expect(bare.kind).toBe("skipped");
    if (bare.kind === "skipped") {
      expect(bare.diagnostics.join(" ")).toContain("explicit");
      expect(bare.diagnostics.join(" ")).not.toContain("bare-canary");
    }
    const ws = parse({ type: "ws", url: "wss://websocket-canary.test" });
    expect(ws.kind).toBe("skipped");
    if (ws.kind === "skipped") {
      expect(ws.diagnostics.join(" ")).toContain("WebSocket");
      expect(ws.diagnostics.join(" ")).not.toContain("websocket-canary");
    }
  });

  it("rejects missing, non-string, and unsupported explicit remote URL shapes", () => {
    for (const entry of [
      { type: "http" },
      { type: "sse", url: 42 },
      { type: "carrier-pigeon", url: "https://secret-shape.test" },
    ]) {
      const result = parse(entry);
      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") expect(result.diagnostics).toHaveLength(1);
    }
  });

  it("fails closed on headersHelper without executing or stringifying it", () => {
    let touched = false;
    const helper = {
      toString() {
        touched = true;
        return "dynamic-helper-canary";
      },
    };
    const result = parse({ type: "http", url: "https://example.test", headersHelper: helper });
    expect(result.kind).toBe("skipped");
    expect(touched).toBe(false);
    if (result.kind === "skipped") {
      expect(result.diagnostics.join(" ")).toContain("headersHelper");
      expect(result.diagnostics.join(" ")).not.toContain("dynamic-helper-canary");
    }
  });

  it("copies valid raw headers into a null-prototype record", () => {
    const sourceHeaders = { Authorization: "Bearer ${TOKEN}", "X-Api-Key": "${KEY:-fallback}" };
    const fields = raw({ type: "http", url: "https://example.test", headers: sourceHeaders });
    expect(fields.rawHeaders).toEqual(sourceHeaders);
    expect(Object.getPrototypeOf(fields.rawHeaders)).toBeNull();
    sourceHeaders.Authorization = "changed";
    expect(fields.rawHeaders.Authorization).toBe("Bearer ${TOKEN}");
  });

  it.each([
    ["array", []],
    ["null", null],
    ["non-string value", { "X-Ok": 1 }],
    ["prototype-shaped object", Object.assign(Object.create({ inherited: "bad" }), { "X-Ok": "v" })],
  ])("rejects a %s headers shape as a whole-entry failure", (_label, headers) => {
    const result = parse({ type: "http", url: "https://example.test", headers });
    expect(result.kind).toBe("skipped");
    expect(result).not.toHaveProperty("fields");
  });

  it("enforces header count, name, and value caps at their boundaries", () => {
    const atCount = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`X-${i}`, "v"]));
    expect(parse({ type: "http", url: "https://example.test", headers: atCount }).kind).toBe("supported");
    expect(
      parse({ type: "http", url: "https://example.test", headers: { ...atCount, "X-Overflow": "v" } }).kind,
    ).toBe("skipped");

    expect(
      parse({ type: "http", url: "https://example.test", headers: { ["x".repeat(256)]: "v" } }).kind,
    ).toBe("supported");
    expect(
      parse({ type: "http", url: "https://example.test", headers: { ["x".repeat(257)]: "v" } }).kind,
    ).toBe("skipped");
    expect(
      parse({ type: "http", url: "https://example.test", headers: { "X-Long": "v".repeat(8192) } }).kind,
    ).toBe("supported");
    expect(
      parse({ type: "http", url: "https://example.test", headers: { "X-Long": "v".repeat(8193) } }).kind,
    ).toBe("skipped");
  });

  it("rejects case-insensitive duplicates with a value-free one-based position", () => {
    const headers = JSON.parse('{"X-Secret-One":"alpha-canary","x-secret-one":"beta-canary"}') as object;
    const result = parse({ type: "http", url: "https://example.test", headers });
    expect(result.kind).toBe("skipped");
    if (result.kind !== "skipped") return;
    expect(result.diagnostics[0]).toContain("entry 2");
    expect(result.diagnostics[0]).toContain("duplicate");
    expect(result.diagnostics[0]).not.toMatch(/X-Secret|alpha-canary|beta-canary/i);
  });

  it.each([
    "Host",
    "Content-Length",
    "Transfer-Encoding",
    "Connection",
    "Keep-Alive",
    "TE",
    "Trailer",
    "Upgrade",
    "Proxy-Authenticate",
    "Proxy-Authorization",
    "Accept",
    "Content-Type",
    "Mcp-Session-Id",
    "Mcp-Protocol-Version",
    "Last-Event-ID",
  ])("rejects reserved header %s without disclosing its name", (name) => {
    const result = parse({ type: "http", url: "https://example.test", headers: { [name]: "secret" } });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.diagnostics[0]).toContain("entry 1");
      expect(result.diagnostics[0]).not.toContain(name);
      expect(result.diagnostics[0]).not.toContain("secret");
    }
  });

  it("allows Authorization and ordinary API-key headers", () => {
    expect(
      parse({
        type: "http",
        url: "https://example.test",
        headers: { Authorization: "Bearer secret", "X-Api-Key": "key" },
      }).kind,
    ).toBe("supported");
  });

  it("never expands header names and rejects expansion-shaped names during parsing", () => {
    const entry = {
      type: "http",
      url: "https://example.test",
      headers: { "X-${HEADER_NAME}": "header-value-canary" },
    };
    const result = parse(entry);
    expect(result.kind).toBe("skipped");
    expect(result).not.toHaveProperty("fields");
    expectSecretSafeRejection(entry, ["HEADER_NAME", "Expanded-Valid-Name", "header-value-canary"], {
      HEADER_NAME: "Expanded-Valid-Name",
    });
  });

  it.each([
    ["line break in name", { "X-Bad\nName": "value-canary" }],
    ["line break in value", { "X-Good": "value-canary\r\nInjected: yes" }],
    ["invalid Headers syntax", { "Bad Header": "value-canary" }],
  ])("rejects %s with positional diagnostics and no header material", (_label, headers) => {
    const result = parse({ type: "http", url: "https://example.test", headers });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.diagnostics[0]).toContain("entry 1");
      expect(result.diagnostics[0]).not.toMatch(/X-Bad|X-Good|Bad Header|value-canary|Injected/);
    }
  });
});

describe("resolveRemoteMcpFields", () => {
  it("expands URL and header values while retaining raw identity and null-prototype copies", () => {
    const fields = raw({
      type: "streamable-http",
      url: "https://${HOST}/mcp/${PATH:-default}",
      headers: { "X-Api-Key": "pre-${TOKEN}-post" },
    });
    const result = resolve(fields, { HOST: "example.test", TOKEN: "secret", PATH: "" });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.fields.url).toBe("https://example.test/mcp/");
    expect(result.fields.headers["X-Api-Key"]).toBe("pre-secret-post");
    expect(result.fields.rawUrl).toBe("https://${HOST}/mcp/${PATH:-default}");
    expect(result.fields.rawHeaders["X-Api-Key"]).toBe("pre-${TOKEN}-post");
    expect(Object.getPrototypeOf(result.fields.headers)).toBeNull();
  });

  it("uses defaults only for unset variables and retains unset literals", () => {
    const fields = raw({
      type: "http",
      url: "https://example.test/${SET}/${EMPTY:-wrong}/${UNSET:-fallback}/${LITERAL}",
      headers: { "X-Value": "${LITERAL}" },
    });
    const calls: string[] = [];
    const result = resolveRemoteMcpFields(
      fields,
      { SET: "configured-value-canary", EMPTY: "" },
      (name) => calls.push(name),
      SERVER,
      SOURCE,
    );
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.fields.url).toBe("https://example.test/configured-value-canary//fallback/${LITERAL}");
    expect(result.fields.headers["X-Value"]).toBe("${LITERAL}");
    expect(calls).toEqual(["LITERAL", "LITERAL"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain("LITERAL");
    expect(result.diagnostics[0]).not.toContain("configured-value-canary");
  });

  it("expands values only and preserves function-replacer dollar canaries", () => {
    const dollarCanary = "$&-$`-$'-$1-$$";
    const fields = raw({
      type: "http",
      url: "https://example.test/${PATH}",
      headers: { "X-Variable-Name": "${TOKEN}" },
    });
    const result = resolve(fields, { PATH: dollarCanary, TOKEN: dollarCanary });
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(decodeURIComponent(new URL(result.fields.url).pathname.slice(1))).toBe(dollarCanary);
    expect(result.fields.headers).toEqual({ "X-Variable-Name": dollarCanary });
    expect(Object.keys(result.fields.headers)).toEqual(["X-Variable-Name"]);
  });

  it.each([
    ["malformed", "not a URL at secret-url-canary", "malformed"],
    ["unsupported scheme", "file:///secret-url-canary", "non-HTTP"],
    ["userinfo", "https://user:password-canary@example.test/mcp", "credentials"],
  ])("rejects a %s URL with a fixed value-free diagnostic", (_label, url, reason) => {
    const result = resolve(raw({ type: "http", url }));
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.diagnostics[0]).toContain(reason);
      expect(result.diagnostics[0]).not.toMatch(/secret-url-canary|password-canary|example\.test/);
    }
  });

  it("enforces the post-expansion URL cap at 8192 UTF-16 code units", () => {
    const prefix = "https://example.test/";
    const atLimit = prefix + "a".repeat(8192 - prefix.length);
    expect(resolve(raw({ type: "http", url: atLimit })).kind).toBe("resolved");
    const over = raw({ type: "http", url: "https://example.test/${TAIL}" });
    const result = resolve(over, { TAIL: "secret-url-canary" + "a".repeat(8192) });
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.diagnostics.join(" ")).not.toContain("secret-url-canary");
  });

  it("enforces post-expansion header value validation at 8192/8193 and for NUL", () => {
    const fields = raw({
      type: "http",
      url: "https://example.test",
      headers: { "X-Value": "${VALUE}" },
    });
    const atLimit = resolve(fields, { VALUE: "v".repeat(8192) });
    expect(atLimit.kind).toBe("resolved");
    if (atLimit.kind === "resolved") expect(atLimit.fields.headers["X-Value"]).toHaveLength(8192);

    const overLimitCanary = "expanded-header-canary";
    for (const value of [
      overLimitCanary + "v".repeat(8193 - overLimitCanary.length),
      "expanded-header-canary\0suffix",
      "expanded-header-canary\r\nInjected: yes",
    ]) {
      const result = resolve(fields, { VALUE: value });
      expect(result.kind).toBe("skipped");
      expect(result).not.toHaveProperty("fields");
      if (result.kind === "skipped") {
        expect(result.diagnostics.join(" ")).not.toMatch(/expanded-header-canary|Injected|suffix/);
      }
    }
  });

  it("keeps every parse and resolve rejection arm free of configuration canaries", () => {
    const rawCanary = "raw-secret-canary";
    const expandedCanary = "expanded-secret-canary";
    const secretHeaderName = "X-Secret-Canary";
    const parseCases: Array<{
      label: string;
      entry: unknown;
      forbidden?: readonly string[];
    }> = [
      { label: "bare URL", entry: { url: `https://${rawCanary}.test` } },
      { label: "WebSocket", entry: { type: "ws", url: `wss://${rawCanary}.test` } },
      {
        label: "unsupported explicit type",
        entry: { type: "carrier-pigeon", url: `https://${rawCanary}.test` },
      },
      {
        label: "non-string explicit type",
        entry: { type: { secret: rawCanary }, url: `https://${rawCanary}.test` },
      },
      { label: "missing URL", entry: { type: "http", headers: { [secretHeaderName]: rawCanary } } },
      { label: "non-string URL", entry: { type: "http", url: { secret: rawCanary } } },
      {
        label: "deferred headersHelper",
        entry: { type: "http", url: "https://example.test", headersHelper: { secret: rawCanary } },
      },
      {
        label: "header shape",
        entry: { type: "http", url: "https://example.test", headers: [rawCanary] },
      },
      {
        label: "non-string header value",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [secretHeaderName]: { secret: rawCanary } },
        },
      },
      {
        label: "header count cap",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [`${secretHeaderName}-${index}`, rawCanary]),
          ),
        },
      },
      {
        label: "header name cap",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [`${secretHeaderName}${rawCanary.repeat(30)}`]: "value" },
        },
      },
      {
        label: "header value cap",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [secretHeaderName]: rawCanary.repeat(600) },
        },
      },
      {
        label: "duplicate header",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: JSON.parse(
            `{"${secretHeaderName}":"${rawCanary}","x-secret-canary":"second-secret"}`,
          ),
        },
        forbidden: ["second-secret"],
      },
      {
        label: "reserved header",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { "Proxy-Authorization": rawCanary },
        },
        forbidden: ["Proxy-Authorization"],
      },
      {
        label: "header line break",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [secretHeaderName]: `${rawCanary}\r\nInjected: yes` },
        },
        forbidden: ["Injected"],
      },
      {
        label: "invalid header syntax",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [`Bad ${secretHeaderName}`]: rawCanary },
        },
      },
    ];
    for (const testCase of parseCases) {
      expectSecretSafeRejection(testCase.entry, [
        rawCanary,
        secretHeaderName,
        ...(testCase.forbidden ?? []),
      ]);
    }

    const resolveCases: Array<{
      label: string;
      entry: Record<string, unknown>;
      env: NodeJS.ProcessEnv;
      forbidden?: readonly string[];
    }> = [
      {
        label: "URL cap",
        entry: { type: "http", url: "https://example.test/${TAIL}" },
        env: { TAIL: expandedCanary.repeat(600) },
      },
      {
        label: "malformed URL",
        entry: { type: "http", url: "${URL}" },
        env: { URL: `not-a-url-${expandedCanary}` },
      },
      {
        label: "unsupported URL scheme",
        entry: { type: "http", url: "${URL}" },
        env: { URL: `file:///${expandedCanary}` },
      },
      {
        label: "URL userinfo",
        entry: { type: "http", url: "${URL}" },
        env: { URL: `https://user:${expandedCanary}@example.test` },
      },
      {
        label: "expanded header value cap",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [secretHeaderName]: "${VALUE}" },
        },
        env: { VALUE: expandedCanary.repeat(600) },
      },
      {
        label: "expanded header line break",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [secretHeaderName]: "${VALUE}" },
        },
        env: { VALUE: `${expandedCanary}\r\nInjected: yes` },
        forbidden: ["Injected"],
      },
      {
        label: "expanded invalid Headers value",
        entry: {
          type: "http",
          url: "https://example.test",
          headers: { [secretHeaderName]: "${VALUE}" },
        },
        env: { VALUE: `${expandedCanary}\0suffix` },
        forbidden: ["suffix"],
      },
    ];
    for (const testCase of resolveCases) {
      expectSecretSafeRejection(testCase.entry, [
        expandedCanary,
        secretHeaderName,
        ...(testCase.forbidden ?? []),
      ], testCase.env);
    }
  });

  it("limits unset-variable diagnostics to variable names, not surrounding secret material", () => {
    const variableName = "UNSET_VARIABLE_NAME";
    const rawUrlCanary = "raw-url-canary";
    const rawHeaderCanary = "raw-header-canary";
    const secretHeaderName = "X-Unset-Secret";
    const diagnostics = diagnosticsOf({
      type: "http",
      url: `https://example.test/${rawUrlCanary}-\${${variableName}}`,
      headers: { [secretHeaderName]: `${rawHeaderCanary}-\${${variableName}}` },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(variableName);
    expect(diagnostics[0]).not.toMatch(/raw-url-canary|raw-header-canary|X-Unset-Secret/);
  });
});
