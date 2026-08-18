import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMcpStartupNotice } from "../src/index.js";
import {
  buildCompatReport,
  renderDoctorReport,
  renderMcpStatusReport,
  type McpServerLiveState,
} from "../src/registry/compat-report.js";
import type {
  ClaudeProject,
  ClaudeSettings,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from "../src/types.js";

function server(
  name: string,
  status: ResolvedMcpServer["status"],
  overrides: Partial<ResolvedMcpServer> = {},
): ResolvedMcpServer {
  if (status !== "enabled") {
    return {
      name,
      status,
      source: "settings-user",
      transport: "stdio",
      diagnostics: [],
      ...overrides,
    } as ResolvedMcpServer;
  }
  return {
    name,
    status,
    source: "settings-user",
    transport: "stdio",
    command: "/COMMAND_CANARY/bin",
    args: ["ARG_CANARY"],
    env: { TOKEN: "ENV_CANARY" },
    rawCommand: "RAW_COMMAND_CANARY",
    diagnostics: [],
    ...overrides,
  } as ResolvedMcpServer;
}

function config(
  servers: ResolvedMcpServer[] = [],
  diagnostics: string[] = [],
): ResolvedMcpConfig {
  return { servers, diagnostics };
}

function settings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 1,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

function project(mcp: ResolvedMcpConfig): ClaudeProject {
  const root = path.join(os.tmpdir(), "picc-mcp-status-test");
  return {
    root,
    cwd: root,
    userDir: path.join(root, ".claude"),
    settings: settings(),
    skills: [],
    agents: [],
    rules: [],
    claudeMd: [],
    diagnostics: [],
    mcp,
  };
}

function doctor(mcp: ResolvedMcpConfig, live: McpServerLiveState[] = []): string {
  const loaded = project(mcp);
  return renderDoctorReport(loaded, buildCompatReport(loaded), undefined, undefined, live);
}

function mcpGuidanceSegment(report: string): string {
  if (report.startsWith("MCP status (read-only)")) return report;
  const segment = report.split("\n").find((line) => line.includes("MCP servers:"));
  if (segment === undefined) throw new Error("Expected an MCP server segment in the doctor report");
  return segment;
}

function detailRows(report: string): string[] {
  return report.split("\n").filter((line) => line.startsWith("- "));
}

const UNSAFE_CANARIES = [
  "SOURCE_PATH_CANARY",
  "COMMAND_CANARY",
  "ARG_CANARY",
  "ENV_CANARY",
  "RAW_COMMAND_CANARY",
  "STDERR_CANARY",
  "EXCEPTION_CANARY",
  "DIAGNOSTIC_SECRET_CANARY",
];

describe("renderMcpStatusReport", () => {
  it("distinguishes safe native sources, runtime disablement, unsupported enablement, and fail-closed recovery", () => {
    const native = config([
      server("local", "enabled", { source: "native-local" }),
      server("project", "pending-approval", { source: "project-mcpjson", inactiveReason: "mcpjson-unapproved" }),
      server("user", "disabled", { source: "native-user", inactiveReason: "native-runtime-disabled" }),
    ], ["Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled"]);
    const report = renderMcpStatusReport(native, []);
    expect(report).toContain('"local": enabled; runtime state unavailable [source: native local]');
    expect(report).toContain('"project": pending approval [source: .mcp.json]');
    expect(report).toContain('"user": disabled — native disabledMcpServers; use Claude Code with the same active user profile for this project to remove the exact disabled name if trusted, then run /reload or restart PiCC [source: native user]');
    expect(report).toContain("PiCC does not support this enablement capability; the list does not authorize default-off runtime servers. The resolved rows above determine actual status");
    expect(report).not.toContain("SOURCE_PATH_CANARY");

    const closed = renderMcpStatusReport({
      servers: [],
      diagnostics: ["SECRET_COMMAND SECRET_URL SECRET_HEADER /private/profile"],
      failClosed: "native-state-unusable",
      failClosedProfile: "picc-override",
    }, []);
    expect(closed).toContain("fail closed because native Claude state is unusable");
    expect(closed).toContain("Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the .claude.json inside the user profile directory selected by PICC_CLAUDE_USER_DIR to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.");
    expect(closed).not.toMatch(/SECRET_|\/private/u);
  });

  it("reports enabledMcpServers-only state as unsupported rather than malformed or unusable", () => {
    const report = renderMcpStatusReport(config([], [
      "Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled",
    ]), []);
    expect(report).toContain("No MCP servers are configured.");
    expect(report).toContain("PiCC does not support this enablement capability");
    expect(report).not.toMatch(/effective rows above|resolved rows above|malformed|ignored|unusable/u);
  });

  it.each([
    ["default", "the default native state file (~/.claude.json)"],
    ["picc-override", "the .claude.json inside the user profile directory selected by PICC_CLAUDE_USER_DIR"],
    ["claude-config", "the .claude.json inside the user profile directory selected by CLAUDE_CONFIG_DIR"],
    ["explicit", "the .claude.json inside the explicitly selected Claude user profile directory"],
  ] as const)("uses shell-neutral, path-redacted %s fail-closed recovery on /mcp and /doctor", (profile, hint) => {
    const mcp: ResolvedMcpConfig = {
      servers: [],
      diagnostics: ["SECRET_COMMAND https://user:pass@example.test C:/resolved/private/.claude.json"],
      failClosed: "native-state-unusable",
      failClosedProfile: profile,
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      expect(report).toContain(`Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use ${hint} to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.`);
      expect(report).not.toMatch(/SECRET_COMMAND|user:pass|resolved\/private/u);
    }
  });

  it("keeps /doctor native source, runtime gates, failures, and hostile names safe and actionable", () => {
    const hostile = `bad\n\u001b]0;title\u0007${"x".repeat(500)}`;
    const mcp = config([
      server(hostile, "enabled", { source: "native-local" }),
      server("runtime-off", "disabled", { source: "native-user", inactiveReason: "native-runtime-disabled" }),
      server("unsupported", "skipped", { source: "project-mcpjson", diagnostics: ["SECRET_HEADER Bearer hunter2"] }),
    ], ["Native Claude enabledMcpServers is unsupported; SECRET_TOKEN must not appear"]);
    const report = doctor(mcp, [{
      name: hostile,
      state: "failed",
      diagnostic: "SECRET_STDERR /private/log",
    }]);
    const posture = report.split("\n").find((line) => line.startsWith("MCP servers:"))!;
    expect(posture).toContain('[source: native local]');
    expect(posture).toContain('[source: native user]');
    expect(posture).toContain('[source: .mcp.json]');
    expect(posture.match(/\[source:/gu)).toHaveLength(3);
    expect(posture).toContain("native disabledMcpServers");
    expect(posture).toContain("use Claude Code with the same active user profile for this project to remove the exact disabled name if trusted");
    expect(posture).toContain("configuration is unusable; check the MCP configuration and logs");
    expect(posture).toContain("check the server configuration and logs, then run /reload or restart PiCC");
    expect(posture).not.toMatch(/SECRET_|hunter2|\/private\/log|[\u0000-\u001f\u007f-\u009f]/u);
    expect(posture.length).toBeLessThanOrEqual(16_384);
    expect(posture).toMatch(/^MCP servers: "bad/u);
    expect(posture).not.toContain("Sources:");
    expect(report).toContain("- feature.mcp-runtime-enabled — the selected native project's `enabledMcpServers` list");
    expect(report).toContain("evidence: Native enabledMcpServers was recognized, but PiCC does not support this enablement capability");
    expect(buildCompatReport(project(mcp)).findings.some((finding) =>
      finding.capability.id === "feature.mcp" && finding.evidence.includes("enabledMcpServers")
    )).toBe(false);
    expect(report).not.toContain("SECRET_TOKEN");
  });

  it("covers every state in configured order and ignores duplicate or extra live states", () => {
    const mcp = config([
      server("enabled", "enabled"),
      server("connecting", "enabled"),
      server("connected-zero", "enabled"),
      server("connected-one", "enabled"),
      server("failed", "enabled"),
      server("pending", "pending-approval"),
      server("disabled", "disabled"),
      server("skipped", "skipped"),
    ]);
    const live: McpServerLiveState[] = [
      { name: "connecting", state: "connecting" },
      { name: "connected-zero", state: "connected", toolCount: 0 },
      { name: "connected-one", state: "connected", toolCount: 1 },
      {
        name: "failed",
        state: "failed",
        diagnostic: "STDERR_CANARY /private/path",
        statusSummary: "Authentication failed safely.",
      },
      { name: "failed", state: "connected", toolCount: 99 },
      { name: "extra", state: "connected", toolCount: 10 },
    ];

    const report = renderMcpStatusReport(mcp, live);
    expect(detailRows(report)).toEqual([
      '- "enabled": enabled; runtime state unavailable [source: settings user extension]',
      '- "connecting": connecting [source: settings user extension]',
      '- "connected-zero": connected (0 tools) [source: settings user extension]',
      '- "connected-one": connected (1 tool) [source: settings user extension]',
      '- "failed": failed — Authentication failed safely. [source: settings user extension]',
      '- "pending": pending approval [source: settings user extension]',
      '- "disabled": disabled — settings disabledMcpjsonServers rejection [source: settings user extension]',
      '- "skipped": skipped — configuration is unusable; run /doctor for details [source: settings user extension]',
    ]);
    expect(report).not.toContain("STDERR_CANARY");
    expect(report).not.toContain("extra");
  });

  it("renders remote retry/reconnect attempts, retained tools, deprecation, and not-configured", () => {
    const mcp = config([
      server("retry", "enabled", { transport: "http" }),
      server("recover", "enabled", { transport: "http" }),
      server("legacy", "enabled", { transport: "sse", configuredType: "sse" }),
      server("empty", "not-configured", { transport: "http", configuredType: "http" }),
    ]);
    const report = renderMcpStatusReport(mcp, [
      { name: "retry", transport: "http", state: "retrying", attempt: 3, attemptLimit: 4 },
      { name: "recover", transport: "http", state: "reconnecting", attempt: 2, attemptLimit: 5, toolCount: 4 },
      { name: "legacy", transport: "sse", state: "connected", toolCount: 1 },
    ]);
    expect(report).toContain("Resolved server entries: 4");
    expect(report).not.toContain("Configured servers:");
    expect(report).toContain('"retry": retrying via http (attempt 3/4)');
    expect(report).toContain('"recover": reconnecting via http (attempt 2/5) (4 retained tools)');
    expect(report).toContain('"legacy": connected via sse (deprecated; use http) (1 tool)');
    expect(report).toContain('"empty": not configured');
  });

  it("labels SSE as deprecated with its replacement in every lifecycle and inactive state", () => {
    const states = ["connecting", "retrying", "connected", "reconnecting", "failed"] as const;
    for (const state of states) {
      const report = renderMcpStatusReport(
        config([server(state, "enabled", { transport: "sse", configuredType: "sse" })]),
        [{
          name: state,
          transport: "sse",
          state,
          ...(state === "retrying" || state === "reconnecting"
            ? { attempt: 1, attemptLimit: state === "retrying" ? 4 : 5 }
            : {}),
          ...(state === "connected" || state === "reconnecting" || state === "failed"
            ? { toolCount: 1 }
            : {}),
          ...(state === "failed" ? { statusSummary: "Safe failure." } : {}),
        }],
      );
      expect(report).toContain("sse (deprecated; use http)");
    }
    const runtimeUnavailable = server("enabled", "enabled", {
      transport: "sse",
      configuredType: "sse",
    });
    expect(renderMcpStatusReport(config([runtimeUnavailable]), [])).toContain(
      '"enabled": enabled via sse (deprecated; use http); runtime state unavailable',
    );
    expect(doctor(config([runtimeUnavailable]))).toContain(
      '"enabled": enabled via sse (deprecated; use http)',
    );
    for (const status of ["pending-approval", "disabled", "not-configured", "skipped"] as const) {
      const entry = server(status, status, { transport: "sse", configuredType: "sse" });
      expect(renderMcpStatusReport(config([entry]), [])).toContain("sse (deprecated; use http)");
      expect(doctor(config([entry]))).toContain("sse (deprecated; use http)");
    }
  });

  it("handles absent and empty configuration clearly", () => {
    expect(renderMcpStatusReport(undefined, [])).toBe(
      "MCP status (read-only)\nNo MCP servers are configured.",
    );
    expect(renderMcpStatusReport(config(), [{ name: "extra", state: "failed" }])).toBe(
      "MCP status (read-only)\nNo MCP servers are configured.",
    );
  });

  it("uses only statusSummary for failures and a generic fallback when absent", () => {
    const report = renderMcpStatusReport(
      config([server("with-summary", "enabled"), server("without-summary", "enabled")]),
      [
        {
          name: "with-summary",
          state: "failed",
          diagnostic: "STDERR_CANARY EXCEPTION_CANARY C:/private/file",
          statusSummary: "Safe failure class",
        },
        {
          name: "without-summary",
          state: "failed",
          diagnostic: "DIAGNOSTIC_SECRET_CANARY",
        },
      ],
    );
    expect(report).toContain('"with-summary": failed — Safe failure class');
    expect(report).toContain(
      '"without-summary": failed — Connection failed; no safe summary is available; run /doctor for details.',
    );
    for (const canary of UNSAFE_CANARIES) expect(report).not.toContain(canary);
    const doctorReport = doctor(config([server("without-summary", "enabled")]), [{
      name: "without-summary",
      state: "failed",
      diagnostic: "DIAGNOSTIC_SECRET_CANARY /private/runtime/path",
    }]);
    expect(doctorReport).toContain("check the server configuration and logs, then run /reload or restart PiCC");
    expect(doctorReport).not.toMatch(/DIAGNOSTIC_SECRET_CANARY|\/private\/runtime/u);
  });

  it("distinguishes unresolved diagnostic-bearing configuration from an empty configuration", () => {
    const report = renderMcpStatusReport(
      config([], ["DIAGNOSTIC_SECRET_CANARY C:/private/settings.json"]),
      [],
    );
    expect(report).toContain("No usable MCP servers were resolved.");
    expect(report).not.toContain("No MCP servers are configured.");
    expect(report).toContain("run /doctor for details");
    expect(report).not.toContain("DIAGNOSTIC_SECRET_CANARY");
  });

  it("uses fixed diagnostic guidance without copying config, skipped, or source detail", () => {
    const report = renderMcpStatusReport(
      config(
        [
          server("connected", "enabled", { diagnostics: ["DIAGNOSTIC_SECRET_CANARY"] }),
          server("pending", "pending-approval"),
          server("disabled", "disabled"),
          server("skipped", "skipped", {
            diagnostics: ["DIAGNOSTIC_SECRET_CANARY /absolute/private/path"],
          }),
        ],
        ["CONFIG_SECRET_CANARY /another/private/path"],
      ),
      [{ name: "connected", state: "connected", toolCount: 2 }],
    );
    expect(report).toContain(
      "Some MCP configuration was malformed, ignored, or unusable; run /doctor for details.",
    );
    expect(report).not.toContain("DIAGNOSTIC_SECRET_CANARY");
    expect(report).not.toContain("CONFIG_SECRET_CANARY");
    for (const canary of UNSAFE_CANARIES) expect(report).not.toContain(canary);
    expect(doctor(config([server("skipped", "skipped", { diagnostics: ["DIAGNOSTIC_SECRET_CANARY"] })])))
      .not.toContain("DIAGNOSTIC_SECRET_CANARY");
  });

  it("replaces adjacent isolated surrogates while preserving valid astral characters", () => {
    const adjacentLow = `low-\udc00\udc01`;
    const adjacentHigh = `high-\ud800\ud801`;
    const astral = "astral-😀";
    const report = renderMcpStatusReport(
      config([
        server(adjacentLow, "disabled"),
        server(adjacentHigh, "disabled"),
        server(astral, "disabled"),
      ]),
      [],
    );
    expect(report).toContain('"low-��": disabled');
    expect(report).toContain('"high-��": disabled');
    expect(report).toContain('"astral-😀": disabled');
    expect(report).not.toContain(adjacentLow);
    expect(report).not.toContain(adjacentHigh);
  });

  it("normalizes, quotes, and bounds hostile configured names and summaries to terminal-safe lines", () => {
    const hostileName = `name\n\t\u001b]0;title\u0007\u009b31m\u200b${"x".repeat(500)}\ud800`;
    const hostileSummary = `summary\r\n\t\u001b[31m\u0007\u0085\u2060${"y".repeat(500)}\udc00`;
    const report = renderMcpStatusReport(config([server(hostileName, "enabled")]), [
      { name: hostileName, state: "failed", statusSummary: hostileSummary },
    ]);
    expect(report.split("\n")).toHaveLength(3);
    expect(report).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u2060]/u);
    expect(report).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(report.length).toBeLessThan(500);
    expect(detailRows(report)[0]).toMatch(/^- ".*": failed —/u);
    expect(detailRows(report)[0]?.length).toBeLessThanOrEqual(340);
    expect(detailRows(report)[0]).toContain("… [source: settings user extension]");
  });

  it("structurally quotes punctuation that attempts row-delimiter and guidance spoofing", () => {
    const names = [
      "forged: connected (99 tools)",
      "fake — run /doctor for details",
      'quote" \\ disabled: pending approval',
    ];
    const report = renderMcpStatusReport(
      config(names.map((name) => server(name, "disabled"))),
      [],
    );
    expect(detailRows(report)).toEqual(
      names.map((name) => `- ${JSON.stringify(name)}: disabled — settings disabledMcpjsonServers rejection [source: settings user extension]`),
    );
  });

  it("escapes bidi formatting controls in blocked names before trusted startup and report suffixes", () => {
    const blockedName = `managed"\\\u202Ereorder\u2066-${"x".repeat(160)}`;
    const escapeBidi = (text: string): string =>
      text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (control) =>
        `\\u${control.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`
      );
    const noticeQuoted = JSON.stringify(escapeBidi(`${blockedName.slice(0, 39)}…`));
    const reportSafeName = escapeBidi(blockedName);
    const reportQuoted = JSON.stringify(`${reportSafeName.slice(0, 120)}…`);
    const mcp = config([server(blockedName, "blocked", {
      source: "managed-mcp",
      inactiveReason: "policy-denied",
    })]);

    const notice = buildMcpStartupNotice(mcp, undefined);
    expect(notice).toContain(`MCP policy blocked 1 server(s): ${noticeQuoted}; run /mcp or /doctor`);
    expect(notice).toContain("\\\\u202E");
    expect(notice).toContain("\\\\u2066");

    const reports = [renderMcpStatusReport(mcp, []), doctor(mcp)];
    for (const report of reports) {
      expect(report).toContain(`${reportQuoted}: blocked`);
      expect(report).toContain("\\\\u202E");
      expect(report).toContain("\\\\u2066");
    }
    for (const output of [notice, ...reports]) {
      expect(output).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    }
  });

  it.each([31, 32, 33, 5000])(
    "details at most 32 of %i servers and stays within the aggregate ceiling",
    (count) => {
      const servers = Array.from({ length: count }, (_, index) =>
        server(`server-${String(index).padStart(4, "0")}`, "enabled"),
      );
      const states: McpServerLiveState[] = servers.map((entry, index) => ({
        name: entry.name,
        state: index % 3 === 0 ? "connected" : index % 3 === 1 ? "failed" : "connecting",
        toolCount: index,
        statusSummary: "Fixed safe failure summary",
      }));
      const first = renderMcpStatusReport(config(servers), states);
      const second = renderMcpStatusReport(config(servers), states);
      expect(first).toBe(second);
      expect(detailRows(first)).toHaveLength(Math.min(count, 32));
      expect(first.length).toBeLessThanOrEqual(16_384);
      if (count <= 32) {
        for (let index = 0; index < count; index += 1) {
          expect(detailRows(first)[index]).toContain(`server-${String(index).padStart(4, "0")}`);
        }
      } else {
        // Failed/retrying/reconnecting rows are selected before healthy/config-order rows.
        expect(detailRows(first)[0]).toContain("failed");
        expect(first).toContain(`Omitted ${count - 32} servers (`);
        expect(first).toContain("run /doctor for bounded details");
      }
    },
  );

  it("prioritizes every actionable retry, reconnect, skip, auth, not-found, and failure row past 32", () => {
    const healthy = Array.from({ length: 32 }, (_, index) => server(`healthy-${index}`, "enabled"));
    const actionable = [
      server("retrying", "enabled", { transport: "http" }),
      server("reconnecting", "enabled", { transport: "http" }),
      server("skipped", "skipped", { transport: "http" }),
      server("auth", "enabled", { transport: "http" }),
      server("not-found", "enabled", { transport: "http" }),
      server("failed", "enabled", { transport: "http" }),
    ];
    const report = renderMcpStatusReport(config([...healthy, ...actionable]), [
      ...healthy.map((entry) => ({ name: entry.name, state: "connected" as const, toolCount: 1 })),
      { name: "retrying", transport: "http", state: "retrying", attempt: 2, attemptLimit: 4 },
      { name: "reconnecting", transport: "http", state: "reconnecting", attempt: 3, attemptLimit: 5, toolCount: 1 },
      { name: "auth", transport: "http", state: "failed", statusSummary: "Authentication failed; check configured static headers." },
      { name: "not-found", transport: "http", state: "failed", statusSummary: "Endpoint was not found; check the configured URL." },
      { name: "failed", transport: "http", state: "failed", statusSummary: "Recovery exhausted; check endpoint and network availability, then reload or start a new session." },
    ]);
    const rows = detailRows(report).join("\n");
    for (const name of ["retrying", "reconnecting", "skipped", "auth", "not-found", "failed"]) {
      expect(rows).toContain(`"${name}"`);
    }
    expect(report).toContain("run /doctor for bounded details");
    expect(report).not.toContain("https://");
  });

  it("keeps character-budget omissions truthful without truncating status or inline source rows", () => {
    const total = 40;
    const servers = Array.from({ length: total }, (_, index) =>
      server(`failed-${String(index).padStart(2, "0")}-${"n".repeat(140)}`, "enabled", {
        source: "native-local",
        transport: "http",
      })
    );
    const live: McpServerLiveState[] = servers.map((entry) => ({
      name: entry.name,
      transport: "http",
      state: "failed",
      toolsAdvertised: true,
      promptsAdvertised: true,
      resourcesAdvertised: true,
      toolDiscoveryError: "DIAGNOSTIC_SECRET_CANARY",
      promptDiscoveryError: "SOURCE_PATH_CANARY",
      resourceDiscoveryError: "STDERR_CANARY",
      statusSummary: `Bounded safe failure summary ${"s".repeat(400)}`,
    }));

    const posture = doctor(config(servers), live).split("\n").find((line) => line.startsWith("MCP servers:"))!;
    const renderedRows = posture.match(/: failed via http .*? \[source: native local\]/gu) ?? [];
    const renderedNames = posture.match(/"failed-\d{2}-n+…"/gu) ?? [];
    const sourceStarts = posture.match(/\[source:/gu) ?? [];
    const omitted = Number(posture.match(/; (\d+) additional server name\(s\) omitted/u)?.[1]);
    const failureSummary = `Bounded safe failure summary ${"s".repeat(400)}`;
    const expectedRowEnding = ": failed via http (tools: advertised, discovery failed, prompts: advertised, discovery failed, resources: advertised, discovery failed; check the server configuration and logs, then restart PiCC) — " +
      `${failureSummary.slice(0, 240)}… [source: native local]`;

    expect(posture.length).toBeLessThanOrEqual(16_384);
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(32);
    expect(renderedNames).toEqual(Array.from({ length: renderedRows.length }, (_, index) =>
      `"failed-${String(index).padStart(2, "0")}-${"n".repeat(110)}…"`
    ));
    for (let index = 32; index < total; index += 1) {
      expect(posture).not.toContain(`failed-${String(index).padStart(2, "0")}`);
    }
    for (const row of renderedRows) expect(row).toBe(expectedRowEnding);
    expect(sourceStarts).toHaveLength(renderedRows.length);
    expect(posture.match(/\[source: native local\]/gu)).toHaveLength(renderedRows.length);
    expect(posture).toMatch(/additional server name\(s\) omitted — inspect the MCP configuration for complete detail\.$/u);
    expect(omitted).toBe(total - renderedRows.length);
    for (const canary of UNSAFE_CANARIES) expect(posture).not.toContain(canary);
  });

  it("groups omitted servers accurately by effective rendered state", () => {
    const displayed = Array.from({ length: 32 }, (_, index) => server(`shown-${index}`, "disabled"));
    const omitted = [
      server("e", "enabled"),
      server("c1", "enabled"),
      server("c2", "enabled"),
      server("f", "enabled"),
      server("p", "pending-approval"),
      server("d", "disabled"),
      server("s", "skipped"),
    ];
    const report = renderMcpStatusReport(config([...displayed, ...omitted]), [
      { name: "c1", state: "connected", toolCount: 1 },
      { name: "c2", state: "connecting" },
      { name: "f", state: "failed", statusSummary: "safe" },
    ]);
    expect(report).toContain(
      "Omitted 7 servers (enabled: 1, connecting: 1, connected: 1, disabled: 4); run /doctor for bounded details.",
    );
  });
});

describe("MCP pending guidance", () => {
  const blanketProhibition =
    'Do not set "enableAllProjectMcpServers": true as a shortcut: it approves all current and future project servers.';

  it.each([1, 9, 33])("is least-authority and bounded for %i pending servers", (count) => {
    const names = Array.from({ length: count }, (_, index) => `pending-${index}`);
    const mcp = config(names.map((name) => server(name, "pending-approval")));
    const status = renderMcpStatusReport(mcp, []);
    expect(status).toContain("Use interactive `/mcp manage` to review exact execution definitions.");
    expect(status).toContain("enabledMcpjsonServers");
    expect(status).toContain("broader per-name compatibility approval");
    expect(status).toContain("user or managed settings only");
    expect(status).toContain("disabledMcpjsonServers");
    expect(status).toContain("in an applicable settings scope to decline");
    expect(status).not.toContain("settings.local.json");
    expect(status).toContain('Each UTF-16 code unit outside ASCII letters, digits, "_", and "-" becomes "_"');
    expect(status).toContain('an astral symbol therefore becomes "__"');
    expect(status).toContain("One persisted named approval can therefore match a differently named current or future server");
    expect(status).toContain("re-review aliases when project MCP names change");
    expect(status).toMatch(/reload|new session/);
    expect(status).toContain(blanketProhibition);
    expect(status).not.toMatch(/add\s+"enableAllProjectMcpServers"/iu);
    expect(status).not.toMatch(/set\s+"enableAllProjectMcpServers"(?![^.]*as a shortcut)/iu);
    expect(status).not.toContain("/doctor shows");
    if (count === 1) expect(status).toContain(JSON.stringify(names));
    else expect(status).not.toContain(JSON.stringify(names));
    expect(status.length).toBeLessThanOrEqual(16_384);
  });

  it("preserves a valid 128-character identifier exactly in a copyable allowlist", () => {
    const name = "a".repeat(128);
    const report = renderMcpStatusReport(
      config([server(name, "pending-approval")]),
      [],
    );
    const allowlistLine = report
      .split("\n")
      .find((line) => line.includes(`"enabledMcpjsonServers"`));
    expect(allowlistLine).toContain(JSON.stringify([name]));
    expect(allowlistLine).not.toContain("…");
  });

  it.each([
    ["controls and format characters", `control\n\t\u001bformat\u200b`],
    ["an overlength name", "x".repeat(500)],
    ["malformed surrogate sequences", `surrogates-\ud800\ud801\udc00\udc01`],
  ])("uses generic guidance with no allowlist value for %s", (_case, name) => {
    const report = renderMcpStatusReport(
      config([server(name, "pending-approval")]),
      [],
    );
    expect(report).toContain("Inspect your MCP configuration");
    expect(report).not.toMatch(/"enabledMcpjsonServers"\s*:/u);
    expect(report).not.toContain(JSON.stringify([name]));
    expect(report).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b]/u);
    expect(report).not.toMatch(/\p{Cs}/u);
    expect(report.length).toBeLessThan(2_000);
  });

  it("preserves raw colliding aliases and proves the exact ASCII matching boundary", () => {
    const names = ["team.alpha", "team/alpha", "téam.alpha", "t_am/alpha", "keep_under-score"];
    const report = renderMcpStatusReport(
      config(names.map((name) => server(name, "pending-approval"))),
      [],
    );
    expect(report).toContain(`"enabledMcpjsonServers": ${JSON.stringify(names)}`);
    expect(report).toContain('Each UTF-16 code unit outside ASCII letters, digits, "_", and "-" becomes "_"');
    expect(report).toContain('an astral symbol therefore becomes "__"');
    expect(report).toContain("One persisted named approval can therefore match a differently named current or future server");
    expect(report).toContain("re-review aliases when project MCP names change");
    expect(report).not.toContain("Inspect your MCP configuration");
  });

  it("keeps startup review notices count-only, model-inert, and bounded", () => {
    const secretName = `pending-${"x".repeat(300)}-TAIL_CANARY\n\u001b`;
    const one = buildCompatReport(
      project(config([server(secretName, "pending-approval")])),
    ).mcpPendingNotice!;
    expect(one).toBe("MCP: 1 server(s) need review — run /mcp manage.");
    expect(one).not.toContain("TAIL_CANARY");
    expect(one).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);

    const names = Array.from({ length: 33 }, (_, index) => `pending-${index}`);
    const notice = buildCompatReport(
      project(config(names.map((name) => server(name, "pending-approval")))),
    ).mcpPendingNotice!;
    expect(notice).toBe("MCP: 33 server(s) need review — run /mcp manage.");
    for (const name of names) expect(notice).not.toContain(name);
    expect(notice.length).toBeLessThan(128);
  });

  it("prioritizes and enumerates a small pending set even when healthy names are omitted", () => {
    const names = ["pending-a", "pending-b"];
    const mcp = config([
      ...Array.from({ length: 32 }, (_, index) => server(`enabled-${index}`, "enabled")),
      ...names.map((name) => server(name, "pending-approval")),
    ]);
    const report = renderMcpStatusReport(mcp, []);
    expect(report).toContain(JSON.stringify(names));
    expect(report).not.toContain("Inspect your MCP configuration");
    expect(report).toContain("Omitted 2 servers (enabled: 2)");
  });

  it("keeps tracked-local diagnostics out of /mcp and never recommends local approval", () => {
    const secretPath = "C:/TRACKED_LOCAL_PATH_CANARY/.claude/settings.local.json";
    const mcp = config(
      [server("pending", "pending-approval")],
      [`tracked local configuration at ${secretPath}`],
    );
    const report = renderMcpStatusReport(mcp, []);
    expect(report).toContain("Use interactive `/mcp manage` to review exact execution definitions.");
    expect(report).toContain("user or managed settings only");
    expect(report).not.toContain("settings.local.json");
    expect(report).not.toContain("TRACKED_LOCAL_PATH_CANARY");
    const doctorReport = doctor(mcp);
    expect(doctorReport).toContain("use interactive `/mcp manage` to review exact execution definitions");
    expect(doctorReport).toContain("user or managed settings only");
    expect(doctorReport).not.toContain("settings.local.json");
    expect(doctorReport).not.toContain("TRACKED_LOCAL_PATH_CANARY");
  });
});

describe("managed MCP policy status foundation", () => {
  it.each([
    ["active-rules", "Managed MCP policy: active rules."],
    ["managed-only", "Managed MCP policy: managed-only"],
    ["exclusive", "exclusive administrator server set is active"],
    ["exclusive-empty", "exclusive administrator server set is empty; all MCP is disabled"],
    ["fail-closed", "Managed MCP policy: fail closed; no candidate can start"],
  ] as const)("renders the %s posture on /mcp and /doctor", (policyPosture, expected) => {
    const mcp: ResolvedMcpConfig = {
      servers: [server("ordinary", "blocked", { inactiveReason: "policy-allow-miss" })],
      diagnostics: [],
      policyPosture,
      policyAuthority: "administrator-controlled",
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      expect(report).toContain(expected);
      if (policyPosture === "exclusive-empty") {
        expect(report).toContain("If access is expected, request an administrator policy change.");
      }
      expect(report).not.toMatch(/COMMAND_CANARY|ARG_CANARY|ENV_CANARY|RAW_COMMAND_CANARY/u);
    }
    if (["exclusive", "exclusive-empty", "fail-closed"].includes(policyPosture)) {
      expect(renderMcpStatusReport(mcp, [])).not.toContain('"ordinary":');
      expect(doctor(mcp)).not.toContain('"ordinary":');
    }
  });

  it.each([
    ["policy-denied", "denied by MCP policy"],
    ["policy-allow-miss", "not present in the effective MCP allowlist"],
    ["policy-managed-only", "not present in the effective managed allow contributions"],
  ] as const)("renders blocked reason %s without project-approval guidance", (inactiveReason, expected) => {
    const mcp: ResolvedMcpConfig = {
      servers: [server("blocked", "blocked", { inactiveReason })],
      diagnostics: [],
      policyPosture: "active-rules",
      policyAuthority: "administrator-controlled",
    };
    const status = renderMcpStatusReport(mcp, []);
    expect(status).toContain(expected);
    expect(status).not.toMatch(/enabledMcpjsonServers|settings\.local\.json|approve/iu);
    const doctorReport = doctor(mcp);
    expect(doctorReport).toContain("If access is expected, request an administrator policy change");
    expect(mcpGuidanceSegment(doctorReport)).not.toMatch(/repair|recover/iu);
  });

  it("diagnoses pending administration recovery explicitly while keeping declarations hidden", () => {
    const mcp: ResolvedMcpConfig = {
      servers: [server("HIDDEN_NAME_CANARY", "enabled")],
      diagnostics: ["MCP administration recovery is pending; run an MCP administration action to complete rollback before startup"],
      failClosed: "administration-recovery-pending",
      policyPosture: "fail-closed",
      policyAuthority: "user-controlled",
    };
    const status = renderMcpStatusReport(mcp, []);
    expect(status).toContain("declarations are hidden and startup is fail closed because administration rollback is pending");
    expect(status).toContain("Open `/mcp manage` in an interactive TUI to retry service-owned rollback");
    expect(status).toContain("Preserve configuration and inspect the bounded `/doctor` diagnosis if it remains pending");
    expect(status).not.toContain("HIDDEN_NAME_CANARY");

    const doctorReport = doctor(mcp);
    expect(doctorReport).toContain("declarations are hidden and startup is fail closed because MCP administration rollback is pending");
    expect(doctorReport).toContain("Use interactive `/mcp manage` to retry service-owned rollback");
    expect(doctorReport).toContain("Preserve configuration if it remains pending; bounded recovery diagnosis follows below");
    expect(doctorReport).toContain("MCP administration rollback remains pending, so declarations are hidden and startup is fail closed");
    expect(doctorReport).not.toContain("inspect the bounded `/doctor` diagnosis");
    expect(doctorReport).not.toContain("HIDDEN_NAME_CANARY");
  });

  it("prioritizes native-state recovery over generic policy fail-closed prose", () => {
    const mcp: ResolvedMcpConfig = {
      servers: [], diagnostics: [],
      failClosed: "native-state-unusable",
      failClosedProfile: "default",
      policyPosture: "fail-closed",
      policyAuthority: "administrator-controlled",
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      expect(report).toContain("native Claude state is unusable");
      expect(report).toContain("known-good backup");
      expect(report).not.toContain("repair or recover the applicable managed MCP policy input");
    }
  });

  it.each([
    ["standalone managed", "managed-mcp", "ask the administrator to repair the managed MCP server configuration"],
    ["managed settings", "settings-managed", "ask the administrator to repair the managed MCP server configuration"],
    ["ordinary project", "settings-project", "repair the MCP server configuration"],
    ["ordinary native", "native-user", "repair the MCP server configuration"],
  ] as const)("renders $0 candidate-invalid with source-aware configuration repair on both surfaces", (_label, source, expected) => {
    const mcp: ResolvedMcpConfig = {
      servers: [server("invalid", "blocked", { source, inactiveReason: "policy-candidate-invalid" })],
      diagnostics: [],
      policyPosture: source === "managed-mcp" ? "exclusive" : "active-rules",
      policyAuthority: source === "managed-mcp" || source === "settings-managed" ? "administrator-controlled" : "user-controlled",
      ...(source === "managed-mcp" ? { policyOrdinarySourcesSuppressed: true } : {}),
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      expect(report).toContain("configured identity is invalid, ambiguous, or over the admission limit");
      expect(report).toContain(`${expected}, then run /reload or restart PiCC`);
      if (source === "managed-mcp" || source === "settings-managed") {
        expect(report).not.toContain("; repair the MCP server configuration");
      } else {
        expect(report).not.toContain("ask the administrator to repair the managed MCP server configuration");
      }
      expect(report).not.toMatch(/allowlist|policy change|pending approval|enabledMcpjsonServers/iu);
    }
  });

  it("renders populated exclusive managed rows while suppressing ordinary rows", () => {
    const mcp: ResolvedMcpConfig = {
      servers: [
        server("enabled-managed", "enabled", { source: "managed-mcp" }),
        server("denied-managed", "blocked", { source: "managed-mcp", inactiveReason: "policy-denied" }),
        server("invalid-managed", "blocked", { source: "managed-mcp", inactiveReason: "policy-candidate-invalid" }),
        server("skipped-managed", "skipped", { source: "managed-mcp" }),
        server("ordinary-canary", "enabled", { source: "settings-user" }),
      ],
      diagnostics: [], policyPosture: "exclusive", policyAuthority: "administrator-controlled",
      policyOrdinarySourcesSuppressed: true,
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      for (const name of ["enabled-managed", "denied-managed", "invalid-managed", "skipped-managed"]) {
        expect(report).toContain(name);
      }
      expect(report).not.toContain("ordinary-canary");
    }
  });

  it.each([
    ["user-controlled", "Repair or recover the applicable user-controlled MCP policy input"],
    ["administrator-controlled", "Ask the administrator to repair or recover the applicable managed MCP policy input"],
    ["mixed", "Repair or recover user-controlled policy inputs and ask the administrator"],
  ] as const)("uses fixed %s remediation", (policyAuthority, expected) => {
    const mcp: ResolvedMcpConfig = {
      servers: [], diagnostics: [], policyPosture: "fail-closed", policyAuthority,
    };
    expect(renderMcpStatusReport(mcp, [])).toContain(expected);
    expect(doctor(mcp)).toContain(expected);
  });

  it("renders bounded fixed compiler observations and omits value/path/error canaries", () => {
    const observations = [
      "invalid-managed-allow-active-empty",
      "invalid-managed-deny-dropped",
      "invalid-managed-only-treated-true",
      "invalid-non-managed-projection",
      "invalid-rule-stripped",
      "unset-environment-variable",
      "allow-over-limit-active-empty",
      "restrictive-material-omitted",
      "source-failure-fail-closed",
      "compiler-uncertainty-fail-closed",
      "candidate-over-limit-blocked",
      "identity-ambiguity-blocked",
    ] as const;
    const mcp: ResolvedMcpConfig = {
      servers: [],
      diagnostics: ["ERROR_VALUE_CANARY C:/SOURCE_PATH_CANARY SECRET_URL_CANARY"],
      policyPosture: "fail-closed",
      policyAuthority: "mixed",
      policyObservations: [...observations, ...observations],
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      expect(report).toContain("Policy observations:");
      expect(report).toContain("invalid managed allow field became an empty allowlist");
      expect(report).toContain("the affected allow contribution supplied no authorization and was active-empty");
      expect(report).toContain("an applicable policy source failed");
      expect(report).not.toContain("applicable managed policy source");
      expect(report).toContain("ambiguous candidate identity was blocked");
      expect(report).not.toContain("additional observation(s) omitted");
      expect(report.length).toBeLessThanOrEqual(16_384);
      expect(report).not.toMatch(/ERROR_VALUE_CANARY|SOURCE_PATH_CANARY|SECRET_URL_CANARY/u);
    }
  });

  it.each([
    ["user-controlled", "Review the applicable user-controlled MCP policy."],
    ["administrator-controlled", "If access is expected, request an administrator policy change."],
    ["mixed", "Review the applicable user-controlled policy and, if access is expected, request an administrator policy change."],
  ] as const)("uses intentional-enforcement guidance for every %s authority on /mcp and /doctor", (policyAuthority, action) => {
    const reasons = [
      ["policy-denied", "denied by MCP policy"],
      ["policy-allow-miss", "not present in the effective MCP allowlist"],
      ["policy-managed-only", "not present in the effective managed allow contributions"],
    ] as const;
    for (const [inactiveReason, wording] of reasons) {
      const mcp: ResolvedMcpConfig = {
        servers: [server("STATUS_NAME_CANARY", "blocked", { source: "managed-mcp", inactiveReason })],
        diagnostics: [], policyPosture: "active-rules", policyAuthority,
      };
      for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
        expect(report).toContain(wording);
        expect(report).toContain(action);
        expect(report).toContain("[source: exclusive managed MCP]");
        expect(mcpGuidanceSegment(report)).not.toMatch(/repair|recover|pending approval|enabledMcpjsonServers/iu);
        expect(report).not.toMatch(/COMMAND_CANARY|ARG_CANARY|ENV_CANARY|RAW_COMMAND_CANARY/u);
      }
    }
  });

  it("uses authority-aware headings and states managed-only semantics without classifying candidate sources", () => {
    const cases = [
      ["user-controlled", "User-controlled MCP policy: active rules."],
      ["administrator-controlled", "Managed MCP policy: active rules."],
      ["mixed", "MCP policy (user and managed): active rules."],
    ] as const;
    for (const [policyAuthority, heading] of cases) {
      const mcp: ResolvedMcpConfig = { servers: [], diagnostics: [], policyPosture: "active-rules", policyAuthority };
      expect(renderMcpStatusReport(mcp, [])).toContain(heading);
      expect(doctor(mcp)).toContain(heading);
    }
    const only: ResolvedMcpConfig = { servers: [], diagnostics: [], policyPosture: "managed-only", policyAuthority: "administrator-controlled" };
    for (const report of [renderMcpStatusReport(only, []), doctor(only)]) {
      expect(report).toContain("only managed allow contributions remain effective");
      expect(report).not.toContain("non-managed candidates");
    }
  });

  it("renders exclusive aggregate claims only from established suppression evidence and emits no pending guidance", () => {
    const retained = server("pending-canary", "pending-approval", { source: "project-mcpjson", inactiveReason: "mcpjson-unapproved" });
    const unknown: ResolvedMcpConfig = {
      servers: [retained], diagnostics: [], policyPosture: "exclusive", policyAuthority: "administrator-controlled",
    };
    const established: ResolvedMcpConfig = { ...unknown, policyOrdinarySourcesSuppressed: true };
    for (const report of [renderMcpStatusReport(unknown, []), doctor(unknown)]) {
      expect(report).not.toContain("ordinary sources were suppressed");
      expect(report).not.toContain("Resolved server entries");
      expect(report).not.toMatch(/pending approval|enabledMcpjsonServers/iu);
    }
    for (const report of [renderMcpStatusReport(established, []), doctor(established)]) {
      expect(report).toContain("ordinary sources were suppressed");
      expect(report).not.toMatch(/pending approval|enabledMcpjsonServers/iu);
    }
  });

  it("renders bounded redacted failure evidence consistently for malformed, unreadable, omitted, and compiler uncertainty", () => {
    const policyFailures = [
      { kind: "malformed", sourceClass: "standalone-mcp", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      { kind: "unreadable", sourceClass: "system-file", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      { kind: "unreadable", sourceClass: "system-drop-in", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      { kind: "omitted", sourceClass: "override", authority: "mixed", remediation: "repair-mixed-policy" },
    ] as const;
    const mcp: ResolvedMcpConfig = {
      servers: [server("STATUS_CANARY", "blocked", { inactiveReason: "policy-denied" })],
      diagnostics: ["RAW_ERROR_CANARY /SOURCE_PATH_CANARY"],
      policyPosture: "fail-closed",
      policyAuthority: "mixed",
      policyFailures,
      policyObservations: ["compiler-uncertainty-fail-closed"],
    };
    for (const report of [renderMcpStatusReport(mcp, []), doctor(mcp)]) {
      expect(report).toContain("standalone managed MCP file was malformed");
      expect(report).toContain("managed-settings system file was unreadable");
      expect(report).toContain("administrator system drop-in was unreadable");
      expect(report).toContain("managed-settings override was omitted");
      expect(report).toContain("policy compilation was uncertain");
      expect(report.match(/Repair or recover user-controlled policy inputs and ask the administrator/gu)).toHaveLength(1);
      expect(report).not.toMatch(/RAW_ERROR_CANARY|SOURCE_PATH_CANARY|COMMAND_CANARY|ARG_CANARY|ENV_CANARY/u);
    }
  });

  it("renders an explicit absent posture exactly like legacy absence", () => {
    const explicit: ResolvedMcpConfig = { servers: [], diagnostics: [], policyPosture: "absent" };
    expect(renderMcpStatusReport(explicit, [])).toBe("MCP status (read-only)\nNo MCP servers are configured.");
    expect(doctor(explicit)).toContain("MCP: no servers configured.");
  });

  it("keeps legacy absent-policy output stable", () => {
    const legacy = config();
    expect(renderMcpStatusReport(legacy, [])).toBe("MCP status (read-only)\nNo MCP servers are configured.");
    expect(doctor(legacy)).toContain("MCP: no servers configured.");
    expect(doctor(legacy)).not.toContain("Managed MCP policy:");
  });
});

describe("capability-aware MCP live reports", () => {
  it("names prompt/resource surfaces, advertised empties, discovery failures, and retained catalogs in /mcp and /doctor", () => {
    const mcp = config([
      server("prompt", "enabled"),
      server("resource", "enabled"),
      server("mixed", "enabled", { transport: "http", url: "https://safe.invalid" }),
      server("empty", "enabled"),
      server("failed-list", "enabled"),
      server("recover", "enabled", { transport: "http", url: "https://safe.invalid" }),
      server("terminal", "enabled", { transport: "http", url: "https://safe.invalid" }),
      server("fatal-tools-list", "enabled"),
    ]);
    const live: McpServerLiveState[] = [
      { name: "prompt", transport: "stdio", state: "connected", toolsAdvertised: false, promptsAdvertised: true, resourcesAdvertised: false, promptCount: 2 },
      { name: "resource", transport: "stdio", state: "connected", toolsAdvertised: false, promptsAdvertised: false, resourcesAdvertised: true, resourceCount: 0 },
      { name: "mixed", transport: "http", state: "connected", toolsAdvertised: true, promptsAdvertised: true, resourcesAdvertised: true, toolCount: 1, promptCount: 2, resourceCount: 3 },
      { name: "empty", transport: "stdio", state: "connected", toolsAdvertised: false, promptsAdvertised: false, resourcesAdvertised: false },
      { name: "failed-list", transport: "stdio", state: "connected", toolsAdvertised: false, promptsAdvertised: true, resourcesAdvertised: true, promptCount: 0, resourceCount: 0, resourceDiscoveryError: "SERVER_SPEECH_CANARY" },
      { name: "recover", transport: "http", state: "reconnecting", toolsAdvertised: false, promptsAdvertised: true, resourcesAdvertised: true, promptCount: 2, resourceCount: 0 },
      { name: "terminal", transport: "http", state: "failed", toolsAdvertised: false, promptsAdvertised: true, resourcesAdvertised: true, promptCount: 2, resourceCount: 1, statusSummary: "Safe terminal summary." },
      { name: "fatal-tools-list", transport: "stdio", state: "failed", initialToolDiscoveryFailed: true, statusSummary: "Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC." },
    ];
    const status = renderMcpStatusReport(mcp, live);
    expect(status).toContain('"prompt": connected (prompts: 2)');
    expect(status).toContain('"resource": connected (resources: 0)');
    expect(status).toContain('tools: 1, prompts: 2, resources: 3');
    expect(status).toContain('no tool, prompt, or resource capabilities advertised');
    expect(status).toContain('resources: advertised, discovery failed; check the server configuration and logs, then restart PiCC');
    expect(status).toContain('prompts: 2 retained, resources: 0 retained');
    expect(status).toContain('prompts: 2 retained, resources: 1 retained');
    expect(status).toContain('Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC.');
    expect(status).not.toContain("SERVER_SPEECH_CANARY");

    const doctor = renderDoctorReport(project(mcp), buildCompatReport(project(mcp)), undefined, undefined, live);
    expect(doctor).toContain('"prompt": connected (prompts: 2)');
    expect(doctor).toContain('"resource": connected (resources: 0)');
    expect(doctor).toContain("resources: advertised, discovery failed; check the server configuration and logs, then restart PiCC");
    expect(doctor).toContain("prompts: 2 retained, resources: 1 retained");
    expect(doctor).toContain("Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC.");
    expect(doctor).not.toContain("SERVER_SPEECH_CANARY");
  });
});
