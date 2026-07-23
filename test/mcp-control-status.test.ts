import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
  return {
    name,
    status,
    source: "/SOURCE_PATH_CANARY/settings.json",
    command: "/COMMAND_CANARY/bin",
    args: ["ARG_CANARY"],
    env: { TOKEN: "ENV_CANARY" },
    rawCommand: "RAW_COMMAND_CANARY",
    diagnostics: [],
    ...overrides,
  };
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

function doctor(mcp: ResolvedMcpConfig): string {
  const loaded = project(mcp);
  return renderDoctorReport(loaded, buildCompatReport(loaded));
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
      '- "enabled": enabled; runtime state unavailable',
      '- "connecting": connecting',
      '- "connected-zero": connected (0 tools)',
      '- "connected-one": connected (1 tool)',
      '- "failed": failed — Authentication failed safely.',
      '- "pending": pending approval',
      '- "disabled": disabled',
      '- "skipped": skipped — configuration is unusable; run /doctor for details',
    ]);
    expect(report).not.toContain("STDERR_CANARY");
    expect(report).not.toContain("extra");
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
      .toContain("DIAGNOSTIC_SECRET_CANARY");
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
    expect(detailRows(report)[0]?.length).toBeLessThanOrEqual(320);
    expect(detailRows(report)[0]?.endsWith("…")).toBe(true);
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
      names.map((name) => `- ${JSON.stringify(name)}: disabled`),
    );
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
      for (let index = 0; index < Math.min(count, 32); index += 1) {
        expect(detailRows(first)[index]).toContain(`server-${String(index).padStart(4, "0")}`);
      }
      if (count > 32) expect(first).toContain(`Omitted ${count - 32} servers (`);
    },
  );

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
      "Omitted 7 servers (enabled: 1, connecting: 1, connected: 1, failed: 1, pending approval: 1, disabled: 1, skipped: 1).",
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
    expect(status).toContain("enabledMcpjsonServers");
    expect(status).toContain("disabledMcpjsonServers");
    expect(status).toContain("user settings or a clean, user-controlled, untracked .claude/settings.local.json");
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

  it("keeps startup pending notices truthful, structurally quoted, and bounded", () => {
    const oneName = "pending: fake — run /doctor for details";
    const one = buildCompatReport(
      project(config([server(oneName, "pending-approval")])),
    ).mcpPendingNotice!;
    expect(one).toContain("1 server(s) pending approval");
    expect(one).toContain(JSON.stringify(oneName));

    const longName = `pending-${"x".repeat(300)}-TAIL_CANARY\n\u001b`;
    const bounded = buildCompatReport(
      project(config([server(longName, "pending-approval")])),
    ).mcpPendingNotice!;
    expect(bounded).toContain('("pending-');
    expect(bounded).toContain("…");
    expect(bounded).not.toContain("TAIL_CANARY");
    expect(bounded).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(bounded.length).toBeLessThan(512);
    expect(bounded).not.toContain("settings.local.json");

    const names = Array.from({ length: 33 }, (_, index) => `pending-${index}`);
    const notice = buildCompatReport(
      project(config(names.map((name) => server(name, "pending-approval")))),
    ).mcpPendingNotice!;
    expect(notice).toContain("33 server(s) pending approval");
    for (const name of names.slice(0, 3)) expect(notice).toContain(JSON.stringify(name));
    expect(notice).not.toContain(JSON.stringify(names[3]));
    expect(notice.match(/and 30 more/gu)).toHaveLength(1);
    expect(notice).toContain("enabledMcpjsonServers");
    expect(notice).toContain("disabledMcpjsonServers");
    expect(notice).toContain("run /doctor for safe settings guidance");
    expect(notice).not.toContain("settings.local.json");
    expect(notice).not.toContain("alias");
    expect(notice.length).toBeLessThan(512);
    expect(notice).not.toContain("exact edit");
    expect(notice.length).toBeLessThan(1_500);
  });

  it("does not enumerate a small pending set when any name is omitted", () => {
    const names = ["pending-a", "pending-b"];
    const mcp = config([
      ...Array.from({ length: 32 }, (_, index) => server(`enabled-${index}`, "enabled")),
      ...names.map((name) => server(name, "pending-approval")),
    ]);
    const report = renderMcpStatusReport(mcp, []);
    expect(report).not.toContain(JSON.stringify(names));
    expect(report).toContain("Inspect your MCP configuration");
  });

  it("keeps tracked-local diagnostics out of /mcp while retaining safe guidance", () => {
    const secretPath = "C:/TRACKED_LOCAL_PATH_CANARY/.claude/settings.local.json";
    const mcp = config(
      [server("pending", "pending-approval")],
      [`tracked local configuration at ${secretPath}`],
    );
    const report = renderMcpStatusReport(mcp, []);
    expect(report).toContain("user settings or a clean, user-controlled, untracked .claude/settings.local.json");
    expect(report).not.toContain("TRACKED_LOCAL_PATH_CANARY");
    const doctorReport = doctor(mcp);
    expect(doctorReport).toContain("user settings or a clean, user-controlled, untracked .claude/settings.local.json");
    expect(doctorReport).toContain("TRACKED_LOCAL_PATH_CANARY");
  });
});
