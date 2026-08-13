import { describe, expect, it } from "vitest";
import {
  MCP_POLICY_LIMITS,
  admitMcpCandidate,
  compileMcpPolicy,
  evaluateMcpPolicy,
  type CompileMcpPolicyInput,
} from "../src/engine/mcp-policy.js";
import type { McpPolicySettingsEntry, McpPolicySourceFailure, RawMcpPolicyCandidate } from "../src/types.js";

function entry(
  scope: McpPolicySettingsEntry["scope"],
  order: number,
  fields: Partial<McpPolicySettingsEntry>,
): McpPolicySettingsEntry {
  return { scope, order, sourcePath: `PATH_CANARY_${order}`, valid: true, ...fields };
}

function stdio(overrides: Partial<RawMcpPolicyCandidate> = {}): RawMcpPolicyCandidate {
  return { name: "tools", source: "settings-user", transport: "stdio", command: "node", args: ["server.js"], ...overrides };
}

function remote(overrides: Partial<RawMcpPolicyCandidate> = {}): RawMcpPolicyCandidate {
  return { name: "remote", source: "settings-user", transport: "http", url: "https://api.example.com/v1", ...overrides };
}

function decision(input: CompileMcpPolicyInput, candidate: RawMcpPolicyCandidate) {
  return evaluateMcpPolicy(compileMcpPolicy(input), candidate);
}

const EXPECTED_LIMITS = {
  settingsEntries: 256,
  sourceFailures: 64,
  environmentEntries: 512,
  environmentChars: 262_144,
  rulesPerField: 512,
  ruleChars: 4_096,
  aggregateRuleChars: 524_288,
  commandVector: 128,
  candidateNameChars: 1_024,
  candidateUrlChars: 16_384,
  candidateCommandChars: 4_096,
  candidateArgs: 128,
  candidateAggregateArgChars: 262_144,
} as const;

const failure = {
  kind: "unreadable",
  sourceClass: "system-drop-in",
  authority: "administrator-controlled",
  remediation: "repair-administrator-policy",
} as const;

describe("managed MCP policy compiler and evaluator", () => {
  it("pins independently authored conservative limit literals", () => {
    expect(MCP_POLICY_LIMITS).toEqual(EXPECTED_LIMITS);
  });
  it("permits every valid candidate when policy is absent", () => {
    const policy = compileMcpPolicy({ env: {} });
    expect(policy.posture).toBe("absent");
    expect(evaluateMcpPolicy(policy, stdio())).toMatchObject({ status: "allowed", reason: "allowed" });
  });

  it("applies deny first across exact names, commands, and URLs", () => {
    const settings = [entry("managed", 1, {
      allowedMcpServers: [{ serverName: "tools" }, { serverName: "remote" }],
      deniedMcpServers: [
        { serverName: "named" },
        { serverCommand: ["node", "server.js"] },
        { serverUrl: "https://*.example.com/v*" },
      ],
    })];
    expect(decision({ settings }, stdio())).toMatchObject({ status: "blocked", reason: "denied" });
    expect(decision({ settings }, remote())).toMatchObject({ status: "blocked", reason: "denied" });
    expect(decision({ settings }, stdio({ name: "named", command: "other", args: [] }))).toMatchObject({ status: "blocked", reason: "denied" });
  });

  it("admits subagent-inline identities through the same deny-first and managed-only evaluator", () => {
    const candidate = stdio({ source: "subagent-inline", name: "agent-tools" });
    expect(decision({ settings: [entry("managed", 1, {
      allowedMcpServers: [{ serverCommand: ["node", "server.js"] }],
      deniedMcpServers: [{ serverName: "agent-tools" }],
    })] }, candidate)).toMatchObject({ status: "blocked", reason: "denied" });
    expect(decision({ settings: [entry("managed", 1, {
      allowManagedMcpServersOnly: true,
      allowedMcpServers: [{ serverName: "other" }],
    })] }, candidate)).toMatchObject({ status: "blocked", reason: "managed-only" });
    expect(decision({ settings: [entry("managed", 1, {
      allowedMcpServers: [{ serverCommand: ["node", "server.js"] }],
    })] }, candidate)).toMatchObject({ status: "allowed" });
  });

  it("uses transport-specific allow rules before names and never lets irrelevant kinds authorize", () => {
    const settings = [entry("managed", 1, { allowedMcpServers: [
      { serverName: "tools" },
      { serverName: "remote" },
      { serverCommand: ["different"] },
      { serverUrl: "https://allowed.example.com/*" },
    ] })];
    expect(decision({ settings }, stdio())).toMatchObject({ status: "blocked", reason: "allow-miss" });
    expect(decision({ settings }, remote())).toMatchObject({ status: "blocked", reason: "allow-miss" });
    expect(decision({ settings }, stdio({ command: "different", args: [] }))).toMatchObject({ status: "allowed" });
    expect(decision({ settings }, remote({ url: "https://allowed.example.com/x" }))).toMatchObject({ status: "allowed" });
  });

  it("treats absent allow as permissive and present empty allow as zero admission", () => {
    expect(decision({ settings: [entry("managed", 1, { deniedMcpServers: [] })] }, stdio()).status).toBe("allowed");
    expect(decision({ settings: [entry("managed", 1, { allowedMcpServers: [] })] }, stdio())).toMatchObject({ status: "blocked", reason: "allow-miss" });
  });

  it("soft-merges and deduplicates valid allow contributions unless managed-only is effective", () => {
    const settings = [
      entry("user", 1, { allowedMcpServers: [{ serverName: "user-name" }] }),
      entry("managed", 2, { allowedMcpServers: [{ serverName: "managed-name" }, { serverName: "managed-name" }] }),
    ];
    expect(decision({ settings }, stdio({ name: "user-name", command: "x", args: [] })).status).toBe("allowed");
    expect(decision({ settings }, stdio({ name: "managed-name", command: "x", args: [] })).status).toBe("allowed");
    const only = [...settings, entry("managed", 3, { allowManagedMcpServersOnly: true })];
    expect(decision({ settings: only }, stdio({ name: "user-name", command: "x", args: [] }))).toMatchObject({ status: "blocked", reason: "managed-only" });
    expect(decision({ settings: only }, stdio({ name: "managed-name", source: "managed-mcp", command: "x", args: [] })).status).toBe("allowed");
  });

  it.each([
    [[true, false], false],
    [[false, true], true],
    [["invalid", false], false],
    [[false, "invalid"], true],
  ] as const)("uses the highest-precedence managed-only occurrence for %j", (values, expected) => {
    const settings = values.map((value, index) => entry("managed", index, { allowManagedMcpServersOnly: value }));
    expect(compileMcpPolicy({ settings }).posture).toBe(expected ? "managed-only" : "absent");
  });

  it.each([Number.NaN, Number.MAX_SAFE_INTEGER + 1])("fails closed on non-safe managed-only order %s without losing administrator authority", (invalidOrder) => {
    const policy = compileMcpPolicy({ settings: [
      entry("managed", 1, { allowManagedMcpServersOnly: false }),
      entry("managed", invalidOrder, { allowManagedMcpServersOnly: true }),
    ] });
    expect(policy).toMatchObject({ posture: "fail-closed", authority: "administrator-controlled" });
    expect(policy.observations).toContain("compiler-uncertainty-fail-closed");
    expect(evaluateMcpPolicy(policy, stdio())).toMatchObject({
      status: "blocked",
      reason: "fail-closed",
      authority: "administrator-controlled",
    });
  });

  it("implements tolerant managed validation without letting malformed non-managed input authorize", () => {
    const managed = compileMcpPolicy({ settings: [entry("managed", 1, {
      allowedMcpServers: "bad",
      deniedMcpServers: "bad",
      allowManagedMcpServersOnly: "bad",
    })] });
    expect(managed.posture).toBe("managed-only");
    expect(managed.observations).toEqual(expect.arrayContaining([
      "invalid-managed-allow-active-empty",
      "invalid-managed-deny-dropped",
      "invalid-managed-only-treated-true",
    ]));
    expect(evaluateMcpPolicy(managed, stdio({ source: "managed-mcp" }))).toMatchObject({ status: "blocked", reason: "managed-only" });

    const malformed = entry("user", 1, { valid: false, allowedMcpServers: [{ serverName: "tools" }] });
    expect(decision({ settings: [malformed] }, stdio())).toMatchObject({ status: "blocked", reason: "allow-miss" });
  });

  it("validates name alphabets and exact command arrays", () => {
    const settings = [entry("managed", 1, { allowedMcpServers: [
      { serverName: "valid_Name-9" },
      { serverName: "not.valid" },
      { serverCommand: ["node", "a", "b"] },
    ], deniedMcpServers: [{ serverName: "deny any punctuation !" }] })];
    expect(decision({ settings }, stdio({ name: "valid_Name-9", command: "x", args: [] })).status).toBe("blocked");
    expect(decision({ settings }, stdio({ command: "node", args: ["a", "b"] })).status).toBe("allowed");
    expect(decision({ settings }, stdio({ command: "node", args: ["b", "a"] })).reason).toBe("allow-miss");
    expect(decision({ settings }, stdio({ name: "deny any punctuation !", command: "x", args: [] })).reason).toBe("denied");
  });

  it("anchors URL wildcards, folds host case and one trailing dot, and preserves path case", () => {
    const settings = [entry("managed", 1, { allowedMcpServers: [{ serverUrl: "https://*.Example.COM./Api*" }] })];
    expect(decision({ settings }, remote({ url: "https://sub.example.com/Api/v1" })).status).toBe("allowed");
    expect(decision({ settings }, remote({ url: "https://sub.example.com/api/v1" })).reason).toBe("allow-miss");
    expect(decision({ settings }, remote({ url: "https://evilsub.example.com.invalid/Api" })).reason).toBe("allow-miss");
    const hostOnly = [entry("managed", 1, { allowedMcpServers: [{ serverUrl: "https://example.com" }] })];
    expect(decision({ settings: hostOnly }, remote({ url: "https://EXAMPLE.COM./anything" })).status).toBe("allowed");
  });

  it("expands rule and candidate identities against a frozen own-property-safe environment", () => {
    const hostile = Object.create({ TOKEN: "prototype" }) as Record<string, string>;
    hostile.HOST = "example.com";
    hostile.CMD = "node";
    const policy = compileMcpPolicy({ env: hostile, settings: [entry("managed", 1, { allowedMcpServers: [
      { serverUrl: "https://${HOST}/v1" },
      { serverCommand: ["${CMD}", "${MISSING:-fallback}"] },
    ] })] });
    hostile.HOST = "mutated.invalid";
    expect(evaluateMcpPolicy(policy, remote({ url: "https://${HOST}/v1" }))).toMatchObject({ status: "allowed" });
    expect(evaluateMcpPolicy(policy, stdio({ command: "${CMD}", args: ["${MISSING:-fallback}"] }))).toMatchObject({ status: "allowed" });
    const unset = compileMcpPolicy({ env: {}, settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: ["${UNSET}"] }] })] });
    expect(unset.observations).toContain("unset-environment-variable");
    expect(evaluateMcpPolicy(unset, stdio({ command: "${UNSET}", args: [] })).status).toBe("allowed");
  });

  it("keeps applicable source failure globally dominant beside valid rules and exclusive control", () => {
    const policy = compileMcpPolicy({
      settings: [entry("managed", 1, { allowedMcpServers: [{ serverName: "tools" }] })],
      sourceFailures: [{ kind: "unreadable", sourceClass: "system-file", authority: "administrator-controlled", remediation: "repair-administrator-policy" }],
      exclusiveManagedServerCount: 2,
    });
    expect(policy.posture).toBe("fail-closed");
    expect(evaluateMcpPolicy(policy, stdio({ source: "managed-mcp" }))).toMatchObject({ status: "blocked", reason: "fail-closed" });
    expect(JSON.stringify(policy)).not.toMatch(/PATH_CANARY|node|server\.js/u);
  });

  it("uses aggregate exclusive posture and suppresses ordinary candidates, including an empty set", () => {
    const exclusive = compileMcpPolicy({ exclusiveManagedServerCount: 1 });
    expect(exclusive.posture).toBe("exclusive");
    expect(evaluateMcpPolicy(exclusive, stdio())).toMatchObject({ status: "blocked", reason: "exclusive-control" });
    expect(evaluateMcpPolicy(exclusive, stdio({ source: "managed-mcp" })).status).toBe("allowed");
    expect(compileMcpPolicy({ exclusiveManagedServerCount: 0 }).posture).toBe("exclusive-empty");
  });

  it("blocks ambiguous and over-limit candidates without reflecting values", () => {
    const policy = compileMcpPolicy({});
    const ambiguous = evaluateMcpPolicy(policy, stdio({ identityAmbiguous: true, name: "SECRET_CANARY" }));
    expect(ambiguous).toMatchObject({ status: "blocked", reason: "candidate-invalid" });
    expect(ambiguous.observations).toContain("identity-ambiguity-blocked");
    const over = evaluateMcpPolicy(policy, remote({ url: "x".repeat(MCP_POLICY_LIMITS.candidateUrlChars + 1) }));
    expect(over.observations).toContain("candidate-over-limit-blocked");
    expect(JSON.stringify([ambiguous, over])).not.toContain("SECRET_CANARY");
  });

  it("tests each rule budget at limit and limit plus one without erasing later restrictions", () => {
    const atLimit = Array.from({ length: MCP_POLICY_LIMITS.rulesPerField }, (_, index) => ({ serverName: `n${index}` }));
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: atLimit })] }).posture).toBe("active-rules");
    const over = [...atLimit, { serverName: "overflow" }];
    const narrowed = compileMcpPolicy({ settings: [entry("user", 1, { allowedMcpServers: over }), entry("managed", 2, {
      deniedMcpServers: [{ serverName: "blocked" }],
    })] });
    expect(narrowed.observations).toContain("allow-over-limit-active-empty");
    expect(evaluateMcpPolicy(narrowed, stdio({ name: "blocked" })).reason).toBe("denied");
    expect(evaluateMcpPolicy(narrowed, stdio({ name: "overflow" })).reason).toBe("allow-miss");
  });

  it("checks candidate scalar and array limits at the boundary and one past it", () => {
    const policy = compileMcpPolicy({});
    const cases: Array<[RawMcpPolicyCandidate, RawMcpPolicyCandidate]> = [
      [stdio({ name: "n".repeat(MCP_POLICY_LIMITS.candidateNameChars) }), stdio({ name: "n".repeat(MCP_POLICY_LIMITS.candidateNameChars + 1) })],
      [stdio({ command: "c".repeat(MCP_POLICY_LIMITS.candidateCommandChars), args: [] }), stdio({ command: "c".repeat(MCP_POLICY_LIMITS.candidateCommandChars + 1), args: [] })],
      [stdio({ args: Array.from({ length: MCP_POLICY_LIMITS.candidateArgs }, () => "a") }), stdio({ args: Array.from({ length: MCP_POLICY_LIMITS.candidateArgs + 1 }, () => "a") })],
      [remote({ url: `https://example.com/${"u".repeat(MCP_POLICY_LIMITS.candidateUrlChars - 20)}` }), remote({ url: "u".repeat(MCP_POLICY_LIMITS.candidateUrlChars + 1) })],
    ];
    for (const [atLimit, overLimit] of cases) {
      expect(evaluateMcpPolicy(policy, atLimit).status).toBe("allowed");
      expect(evaluateMcpPolicy(policy, overLimit)).toMatchObject({ status: "blocked", reason: "candidate-invalid" });
    }
  });

  it("narrows over-limit rule strings and aggregate allow material", () => {
    const exact = "c".repeat(MCP_POLICY_LIMITS.ruleChars);
    const exactPolicy = compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: [exact] }] })] });
    expect(evaluateMcpPolicy(exactPolicy, stdio({ command: exact, args: [] })).status).toBe("allowed");
    expect(exactPolicy.observations).not.toContain("invalid-rule-stripped");
    const overString = compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: [`${exact}x`] }] })] });
    expect(evaluateMcpPolicy(overString, stdio()).reason).toBe("allow-miss");
    expect(overString.observations).toContain("allow-over-limit-active-empty");

    const largeRule = { serverCommand: ["c".repeat(1_100)] };
    const aggregate = Array.from({ length: MCP_POLICY_LIMITS.rulesPerField }, () => largeRule);
    const overAggregate = compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: aggregate })] });
    expect(overAggregate.observations).toContain("allow-over-limit-active-empty");
    expect(evaluateMcpPolicy(overAggregate, stdio()).reason).toBe("allow-miss");
  });

  it("fails closed when entry or restrictive budgets report omitted material", () => {
    const atLimit = Array.from({ length: MCP_POLICY_LIMITS.settingsEntries }, (_, index) =>
      entry("user", index, { allowedMcpServers: [] }));
    expect(compileMcpPolicy({ settings: atLimit }).posture).not.toBe("fail-closed");
    const tooMany = [...atLimit, entry("managed", MCP_POLICY_LIMITS.settingsEntries, { deniedMcpServers: [] })];
    expect(compileMcpPolicy({ settings: tooMany }).posture).toBe("fail-closed");
    expect(compileMcpPolicy({ restrictiveMaterialOmitted: true }).posture).toBe("fail-closed");
    const malformedDeny = entry("user", 1, { valid: false, deniedMcpServers: "lost" });
    expect(compileMcpPolicy({ settings: [malformedDeny] }).posture).toBe("fail-closed");
  });

  it("accepts only Claude's single-key command vector and compares case, order, and count exactly", () => {
    const settings = [entry("managed", 1, { allowedMcpServers: [
      { serverCommand: ["Node", "a", "b"] },
      { command: "Node", args: ["a", "b"] },
      { serverCommand: [] },
      { serverCommand: ["Node"], extra: true },
    ] })];
    expect(decision({ settings }, stdio({ command: "Node", args: ["a", "b"] })).status).toBe("allowed");
    expect(decision({ settings }, stdio({ command: "node", args: ["a", "b"] })).reason).toBe("allow-miss");
    expect(decision({ settings }, stdio({ command: "Node", args: ["b", "a"] })).reason).toBe("allow-miss");
    expect(decision({ settings }, stdio({ command: "Node", args: ["a"] })).reason).toBe("allow-miss");
    expect(compileMcpPolicy({ settings }).observations).toContain("invalid-rule-stripped");
  });

  it("covers HTTP and SSE transport fallback, name fallback, and irrelevant command rules", () => {
    const names = [entry("managed", 1, { allowedMcpServers: [{ serverName: "remote" }, { serverCommand: ["remote"] }] })];
    expect(decision({ settings: names }, remote()).status).toBe("allowed");
    expect(decision({ settings: names }, remote({ transport: "sse" })).status).toBe("allowed");
    expect(decision({ settings: names }, remote({ name: "REMOTE" })).reason).toBe("allow-miss");
    const urls = [entry("managed", 1, { allowedMcpServers: [{ serverName: "remote" }, { serverUrl: "https://other.example/*" }] })];
    expect(decision({ settings: urls }, remote()).reason).toBe("allow-miss");
  });

  it("keeps names literal, case-sensitive, and unexpanded", () => {
    const settings = [entry("managed", 1, { allowedMcpServers: [{ serverName: "${NAME}" }, { serverName: "Exact" }] })];
    expect(decision({ settings, env: { NAME: "Exact" } }, stdio({ name: "Exact", command: "x", args: [] })).status).toBe("allowed");
    expect(decision({ settings, env: { NAME: "Exact" } }, stdio({ name: "exact", command: "x", args: [] })).reason).toBe("allow-miss");
    expect(decision({ settings, env: { NAME: "Exact" } }, stdio({ name: "${NAME}", command: "x", args: [] })).reason).toBe("allow-miss");
  });

  it("matches wildcards in scheme and internal URL positions while folding only host case", () => {
    const settings = [entry("managed", 1, { allowedMcpServers: [{ serverUrl: "*t*://api.*xample.com:8*/A*i" }] })];
    expect(decision({ settings }, remote({ url: "https://API.example.com:8443/Api" })).status).toBe("allowed");
    expect(decision({ settings }, remote({ url: "http://api.example.com:8443/Api" })).status).toBe("allowed");
    expect(decision({ settings }, remote({ url: "HTTPS://api.example.com:8443/Api" })).reason).toBe("candidate-invalid");
    expect(decision({ settings }, remote({ url: "https://api.example.com:8443/api" })).reason).toBe("allow-miss");
    expect(decision({ settings }, remote({ url: "https://api.example.com:9443/Api" })).reason).toBe("allow-miss");
  });

  it("normalizes one host dot and classifies ambiguous URL identities separately from overflow", () => {
    const settings = [entry("managed", 1, { deniedMcpServers: [{ serverUrl: "https://example.com/private*" }] })];
    expect(decision({ settings }, remote({ url: "https://EXAMPLE.COM./private" })).reason).toBe("denied");
    expect(decision({ settings }, remote({ url: "https://example.com../private" })).reason).toBe("allowed");
    for (const url of [
      "https://example.com\\.evil/private",
      "https://User@example.com/private",
      "https://example.com/private?q=1",
      "https://example.com/private#x",
      "https://example.com/%70rivate",
      "https://example.com/a/../private",
      "https://[::1]/private",
      "https://éxample.com/private",
    ]) {
      const rejected = decision({ settings: [entry("managed", 1, { deniedMcpServers: [] })] }, remote({ url }));
      expect(rejected).toMatchObject({ status: "blocked", reason: "candidate-invalid" });
      expect(rejected.observations).toContain("identity-ambiguity-blocked");
      expect(rejected.observations).not.toContain("candidate-over-limit-blocked");
    }
    const overflow = decision({}, remote({ url: "x".repeat(MCP_POLICY_LIMITS.candidateUrlChars + 1) }));
    expect(overflow.observations).toContain("candidate-over-limit-blocked");
    expect(overflow.observations).not.toContain("identity-ambiguity-blocked");
  });

  it("merges deny rules across scopes and retains valid restrictions beside malformed deny rules", () => {
    const settings = [
      entry("user", 1, { deniedMcpServers: [{ serverName: "user" }] }),
      entry("project", 2, { deniedMcpServers: [{ serverName: "project" }, { serverCommand: "bad" }] }),
      entry("managed", 3, { deniedMcpServers: [{ serverName: "managed" }] }),
    ];
    for (const name of ["user", "project", "managed"]) {
      expect(decision({ settings }, stdio({ name, command: "x", args: [] })).reason).toBe("denied");
    }
    expect(compileMcpPolicy({ settings }).posture).toBe("active-rules");
  });

  it("managed-only retains all denies, ignores non-managed flags, and derives allow presence only from managed contributions", () => {
    const base = [
      entry("user", 1, { allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverName: "user" }], deniedMcpServers: [{ serverName: "denied" }] }),
      entry("managed", 2, { allowManagedMcpServersOnly: true }),
    ];
    const invalidFlagOnly = entry("user", 0, { valid: false, allowManagedMcpServersOnly: true });
    const ignoredInvalidFlag = compileMcpPolicy({ settings: [invalidFlagOnly] });
    expect(ignoredInvalidFlag.posture).toBe("absent");
    expect(ignoredInvalidFlag.observations).toEqual([]);
    expect(evaluateMcpPolicy(ignoredInvalidFlag, stdio()).status).toBe("allowed");
    expect(decision({ settings: base }, stdio({ name: "free", command: "x", args: [] })).status).toBe("allowed");
    expect(decision({ settings: base }, stdio({ name: "denied", command: "x", args: [] })).reason).toBe("denied");
    expect(decision({ settings: [base[0]!] }, stdio({ name: "free", command: "x", args: [] })).reason).toBe("allow-miss");
    expect(decision({ settings: [...base, entry("managed", 3, { allowedMcpServers: [] })] }, stdio({ name: "free", command: "x", args: [] })).reason).toBe("managed-only");
    expect(decision({ settings: [...base, entry("managed", 3, { allowedMcpServers: [{ serverName: "managed" }] })] }, stdio({ name: "managed", command: "x", args: [] })).status).toBe("allowed");
  });

  it("exclusive-empty admits neither ordinary nor managed candidates and invalid exclusive counts fail closed", () => {
    const empty = compileMcpPolicy({ exclusiveManagedServerCount: 0 });
    expect(evaluateMcpPolicy(empty, stdio()).status).toBe("blocked");
    expect(evaluateMcpPolicy(empty, stdio({ source: "managed-mcp" })).status).toBe("blocked");
    expect(compileMcpPolicy({ exclusiveManagedServerCount: -1 }).posture).toBe("fail-closed");
    expect(evaluateMcpPolicy({ ...empty, compiled: {} }, stdio()).reason).toBe("fail-closed");
  });

  it("accepts every retained source-failure class and rejects unknown classes", () => {
    const retained = [
      { sourceClass: "standalone-mcp", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      { sourceClass: "system-file", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      { sourceClass: "system-drop-in", authority: "administrator-controlled", remediation: "repair-administrator-policy" },
      { sourceClass: "override", authority: "user-controlled", remediation: "repair-user-policy" },
    ] as const;
    for (const source of retained) {
      const policy = compileMcpPolicy({ sourceFailures: [{ kind: "unreadable", ...source }] });
      expect(policy).toMatchObject({ posture: "fail-closed", authority: source.authority });
      expect(policy.failures).toContainEqual(expect.objectContaining({ sourceClass: source.sourceClass }));
    }
    const invalid = compileMcpPolicy({ sourceFailures: [{ ...failure, sourceClass: "future-source" }] as unknown as readonly McpPolicySourceFailure[] });
    expect(invalid).toMatchObject({ posture: "fail-closed", authority: "mixed", failures: [] });
  });

  it("makes source failures globally dominant with truthful user, administrator, mixed, and combined authority", () => {
    const userFailure = {
      ...failure,
      sourceClass: "override",
      authority: "user-controlled",
      remediation: "repair-user-policy",
    } as const;
    const mixedFailure = { ...failure, authority: "mixed", remediation: "repair-mixed-policy" } as const;
    const cases: Array<[CompileMcpPolicyInput, "user-controlled" | "administrator-controlled" | "mixed"]> = [
      [{ sourceFailures: [userFailure] }, "user-controlled"],
      [{ sourceFailures: [failure] }, "administrator-controlled"],
      [{ sourceFailures: [mixedFailure] }, "mixed"],
      [{ sourceFailures: [userFailure, failure] }, "mixed"],
      [{ settings: [entry("user", 1, {}), entry("managed", 2, {})], sourceFailures: [failure], exclusiveManagedServerCount: 2 }, "mixed"],
    ];
    for (const [input, authority] of cases) {
      const policy = compileMcpPolicy(input);
      expect(policy).toMatchObject({ posture: "fail-closed", authority });
      expect(evaluateMcpPolicy(policy, stdio({ source: "managed-mcp" }))).toMatchObject({
        status: "blocked",
        reason: "fail-closed",
        authority,
      });
    }
    // Settings and failures are separate attributed lists, so cross-list ordering is intentionally non-representable.
  });

  it("copies and freezes policy inputs, environment, failures, rules, and returned decisions", () => {
    const vector = ["node", "a"];
    const rules = [{ serverCommand: vector }];
    const env = { CMD: "node" };
    const failures: McpPolicySourceFailure[] = [failure];
    const policy = compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: rules })], env });
    vector[0] = "mutated";
    rules.push({ serverCommand: ["other"] });
    env.CMD = "mutated";
    expect(evaluateMcpPolicy(policy, stdio({ command: "node", args: ["a"] })).status).toBe("allowed");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.observations)).toBe(true);
    const closed = compileMcpPolicy({ sourceFailures: failures });
    const retainedFailure = closed.failures[0]!;
    failures[0] = { ...failure, kind: "malformed" };
    expect(closed.failures[0]?.kind).toBe("unreadable");
    expect(Object.isFrozen(closed.failures)).toBe(true);
    expect(Object.isFrozen(retainedFailure)).toBe(true);
    expect(() => { (retainedFailure as { kind: string }).kind = "malformed"; }).toThrow();
    expect(closed.failures[0]?.kind).toBe("unreadable");
    const admission = evaluateMcpPolicy(policy, stdio());
    expect(Object.isFrozen(admission)).toBe(true);
    expect(Object.isFrozen(admission.observations)).toBe(true);
    expect(() => { (admission.observations as string[]).push("compiler-uncertainty-fail-closed"); }).toThrow();
    expect(admission.observations).not.toContain("compiler-uncertainty-fail-closed");
  });

  it("enforces settings, source-failure, and environment count limits at literal boundaries", () => {
    const settingsAt = Array.from({ length: 256 }, (_, index) => entry("user", index, {}));
    expect(compileMcpPolicy({ settings: settingsAt }).posture).not.toBe("fail-closed");
    expect(compileMcpPolicy({ settings: [...settingsAt, entry("managed", 257, {})] }).posture).toBe("fail-closed");
    const failuresAt = Array.from({ length: 64 }, () => failure);
    const atFailureLimit = compileMcpPolicy({ sourceFailures: failuresAt });
    expect(atFailureLimit.failures).toHaveLength(64);
    expect(atFailureLimit.observations).not.toContain("restrictive-material-omitted");
    const overFailureLimit = compileMcpPolicy({ sourceFailures: [...failuresAt, failure] });
    expect(overFailureLimit.posture).toBe("fail-closed");
    expect(overFailureLimit.failures).toHaveLength(0);
    expect(overFailureLimit.observations).toContain("restrictive-material-omitted");
    const envAt = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`V${index}`, ""]));
    expect(compileMcpPolicy({ env: envAt }).posture).toBe("absent");
    expect(compileMcpPolicy({ env: { ...envAt, EXTRA: "" } }).posture).toBe("fail-closed");
  });

  it("enforces environment aggregate characters at literal boundaries", () => {
    const key = "V";
    expect(compileMcpPolicy({ env: { [key]: "x".repeat(262_143) } }).posture).toBe("absent");
    expect(compileMcpPolicy({ env: { [key]: "x".repeat(262_144) } }).posture).toBe("fail-closed");
  });

  it("enforces rule count, scalar, aggregate, and command-vector limits independently", () => {
    const namesAt = Array.from({ length: 512 }, (_, index) => ({ serverName: `n${index}` }));
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: namesAt })] }).observations).not.toContain("allow-over-limit-active-empty");
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: [...namesAt, { serverName: "over" }] })] }).observations).toContain("allow-over-limit-active-empty");
    const urlAt = `https://example.com/${"x".repeat(4_076)}`;
    expect(urlAt).toHaveLength(4_096);
    expect(decision({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverUrl: urlAt }] })] }, remote({ url: urlAt })).status).toBe("allowed");
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverUrl: `${urlAt}x` }] })] }).observations).toContain("allow-over-limit-active-empty");
    const vectorAt = Array.from({ length: 128 }, () => "x");
    expect(decision({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: vectorAt }] })] }, stdio({ command: "x", args: vectorAt.slice(1) })).status).toBe("allowed");
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: [...vectorAt, "x"] }] })] }).observations).toContain("allow-over-limit-active-empty");
    const restrictiveTail = entry("managed", 2, { deniedMcpServers: [{ serverName: "tail" }] });
    const denyVectorAt = compileMcpPolicy({ settings: [entry("user", 1, { deniedMcpServers: [{ serverCommand: vectorAt }] }), restrictiveTail] });
    expect(denyVectorAt.posture).toBe("active-rules");
    expect(evaluateMcpPolicy(denyVectorAt, stdio({ name: "tail" })).reason).toBe("denied");
    expect(compileMcpPolicy({ settings: [entry("user", 1, { deniedMcpServers: [{ serverCommand: [...vectorAt, "x"] }] }), restrictiveTail] }).posture).toBe("fail-closed");
    const aggregateAt = Array.from({ length: 128 }, () => "x".repeat(4_096));
    expect(aggregateAt.reduce((sum, part) => sum + part.length, 0)).toBe(524_288);
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: aggregateAt }] })] }).observations).not.toContain("allow-over-limit-active-empty");
    expect(compileMcpPolicy({ settings: [
      entry("user", 1, { allowedMcpServers: [{ serverCommand: aggregateAt }] }),
      entry("managed", 2, { allowedMcpServers: [{ serverName: "x" }] }),
    ] }).observations).toContain("allow-over-limit-active-empty");
    expect(compileMcpPolicy({ settings: [entry("managed", 1, { deniedMcpServers: [{ serverCommand: ["x".repeat(4_097)] }] })] }).posture).toBe("fail-closed");
    const denyAt = Array.from({ length: 512 }, (_, index) => ({ serverName: `deny-${index}` }));
    const denyAtPolicy = compileMcpPolicy({ settings: [entry("user", 1, { deniedMcpServers: denyAt }), restrictiveTail] });
    expect(denyAtPolicy.posture).toBe("active-rules");
    expect(evaluateMcpPolicy(denyAtPolicy, stdio({ name: "tail" })).reason).toBe("denied");
    expect(compileMcpPolicy({ settings: [entry("user", 1, { deniedMcpServers: [...denyAt, { serverName: "over" }] }), restrictiveTail] }).posture).toBe("fail-closed");
    expect(compileMcpPolicy({ settings: [
      entry("user", 1, { deniedMcpServers: [{ serverCommand: aggregateAt }] }),
      restrictiveTail,
    ] }).posture).toBe("fail-closed");
  });

  it("treats expansion at literal limits as valid and overflow as allow active-empty, deny fail-closed, and candidate invalid", () => {
    const env = { AT: "x".repeat(4_096), BIG: "x".repeat(4_097) };
    const allowAt = compileMcpPolicy({ env, settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: ["${AT}"] }] })] });
    expect(evaluateMcpPolicy(allowAt, stdio({ command: "${AT}", args: [] })).status).toBe("allowed");
    const allowOver = compileMcpPolicy({ env, settings: [entry("managed", 1, { allowedMcpServers: [{ serverCommand: ["${BIG}"] }] })] });
    expect(allowOver.observations).toContain("allow-over-limit-active-empty");
    const denyAt = compileMcpPolicy({ env, settings: [entry("managed", 1, { deniedMcpServers: [{ serverCommand: ["${AT}"] }] })] });
    expect(evaluateMcpPolicy(denyAt, stdio({ command: "${AT}", args: [] })).reason).toBe("denied");
    const denyOver = compileMcpPolicy({ env, settings: [entry("managed", 1, { deniedMcpServers: [{ serverCommand: ["${BIG}"] }] })] });
    expect(denyOver.posture).toBe("fail-closed");
    const noRules = compileMcpPolicy({ env, settings: [entry("managed", 1, { deniedMcpServers: [] })] });
    expect(evaluateMcpPolicy(noRules, stdio({ command: "${AT}", args: [] })).status).toBe("allowed");
    expect(evaluateMcpPolicy(noRules, stdio({ command: "${BIG}", args: [] })).reason).toBe("candidate-invalid");
  });

  it("enforces candidate name, URL, command, argument count, and aggregate argument limits", () => {
    const policy = compileMcpPolicy({});
    const urlAt = `https://example.com/${"x".repeat(16_364)}`;
    expect(urlAt).toHaveLength(16_384);
    const pairs: Array<[RawMcpPolicyCandidate, RawMcpPolicyCandidate]> = [
      [stdio({ name: "n".repeat(1_024) }), stdio({ name: "n".repeat(1_025) })],
      [remote({ url: urlAt }), remote({ url: `${urlAt}x` })],
      [stdio({ command: "c".repeat(4_096), args: [] }), stdio({ command: "c".repeat(4_097), args: [] })],
      [stdio({ args: Array.from({ length: 128 }, () => "") }), stdio({ args: Array.from({ length: 129 }, () => "") })],
      [stdio({ args: Array.from({ length: 128 }, () => "x".repeat(2_048)) }), stdio({ args: [...Array.from({ length: 127 }, () => "x".repeat(2_048)), "x".repeat(2_049)] })],
    ];
    for (const [at, over] of pairs) {
      expect(evaluateMcpPolicy(policy, at).status).toBe("allowed");
      expect(evaluateMcpPolicy(policy, over).reason).toBe("candidate-invalid");
    }
  });

  it("never throws at exported boundaries and returns a frozen redacted emergency decision", () => {
    const malformedInputs: unknown[] = [null, undefined, 0, "bad", true];
    for (const malformed of malformedInputs) {
      const policy = compileMcpPolicy(malformed as CompileMcpPolicyInput);
      expect(policy).toMatchObject({ posture: "fail-closed", authority: "mixed" });
      expect(() => admitMcpCandidate(malformed as CompileMcpPolicyInput, null as unknown as RawMcpPolicyCandidate)).not.toThrow();
    }
    const nonArray = compileMcpPolicy({ settings: "SETTINGS_CANARY" as unknown as readonly McpPolicySettingsEntry[] });
    expect(nonArray).toMatchObject({ posture: "fail-closed", authority: "mixed" });
    expect(nonArray.observations).toEqual(["compiler-uncertainty-fail-closed"]);

    const throwing = new Proxy({}, { get() { throw new Error("GETTER_CANARY"); } });
    const forgedPolicies = [
      { compiled: {}, posture: "absent", authority: "user-controlled", observations: undefined, failures: [] },
      { compiled: {}, posture: "absent", authority: "administrator-controlled", observations: "bad", failures: [] },
    ];
    const candidates = [null, undefined, 1, "candidate", throwing] as unknown[];
    for (const [index, candidate] of candidates.entries()) {
      const result = evaluateMcpPolicy(forgedPolicies[index % forgedPolicies.length] as unknown as ReturnType<typeof compileMcpPolicy>, candidate as RawMcpPolicyCandidate);
      expect(result).toEqual({
        status: "blocked", reason: "fail-closed", authority: "mixed",
        observations: ["compiler-uncertainty-fail-closed"],
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.observations)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/GETTER_CANARY|SETTINGS_CANARY/u);
    }
    const authentic = compileMcpPolicy({});
    expect(evaluateMcpPolicy(authentic, null as unknown as RawMcpPolicyCandidate)).toMatchObject({ status: "blocked", reason: "candidate-invalid" });
    for (const observations of [undefined, "bad"]) {
      const result = evaluateMcpPolicy({ ...authentic, authority: "mixed", observations } as unknown as ReturnType<typeof compileMcpPolicy>, stdio());
      expect(result).toMatchObject({ status: "allowed", reason: "allowed", authority: "user-controlled", observations: [] });
      expect(Object.isFrozen(result.observations)).toBe(true);
    }
    expect(evaluateMcpPolicy(throwing as unknown as ReturnType<typeof compileMcpPolicy>, stdio())).toMatchObject({ status: "blocked", reason: "fail-closed", authority: "mixed" });
    expect(admitMcpCandidate({}, "bad" as unknown as RawMcpPolicyCandidate)).toMatchObject({ status: "blocked", reason: "candidate-invalid" });
    expect(() => compileMcpPolicy(throwing as CompileMcpPolicyInput)).not.toThrow();
    expect(() => admitMcpCandidate(throwing as CompileMcpPolicyInput, throwing as RawMcpPolicyCandidate)).not.toThrow();
  });

  it("derives conservative authority from exclusive and provenance-loss evidence", () => {
    expect(compileMcpPolicy({ exclusiveManagedServerCount: 1 }).authority).toBe("administrator-controlled");
    expect(compileMcpPolicy({ exclusiveManagedServerCount: 0 }).authority).toBe("administrator-controlled");
    expect(compileMcpPolicy({ exclusiveManagedServerCount: -1 }).authority).toBe("administrator-controlled");
    expect(compileMcpPolicy({ exclusiveManagedServerCount: 1, settings: [entry("user", 1, {})] }).authority).toBe("mixed");
    expect(compileMcpPolicy({ restrictiveMaterialOmitted: true }).authority).toBe("mixed");
    expect(compileMcpPolicy({ settings: "bad" as unknown as readonly McpPolicySettingsEntry[] }).authority).toBe("mixed");
    expect(compileMcpPolicy({ settings: Array.from({ length: 257 }, (_, index) => entry("user", index, {})) }).authority).toBe("mixed");
    expect(compileMcpPolicy({ sourceFailures: "bad" as unknown as readonly McpPolicySourceFailure[] }).authority).toBe("mixed");
    expect(compileMcpPolicy({ sourceFailures: [{ ...failure, authority: "unknown" }] as unknown as readonly McpPolicySourceFailure[] }).authority).toBe("mixed");
    expect(compileMcpPolicy({ sourceFailures: Array.from({ length: 65 }, () => failure) }).authority).toBe("mixed");
    expect(compileMcpPolicy({ env: 1 as unknown as Readonly<Record<string, string>> }).authority).toBe("user-controlled");
    expect(compileMcpPolicy({ settings: [null as unknown as McpPolicySettingsEntry] }).authority).toBe("mixed");
    const unknownScope = { ...entry("user", 1, {}), scope: "unknown" } as unknown as McpPolicySettingsEntry;
    expect(compileMcpPolicy({ settings: [unknownScope] })).toMatchObject({ posture: "fail-closed", authority: "mixed" });
  });

  it("uses runtime port aliases only for deny matching and rejects ambiguous URL spellings", () => {
    const deny = [entry("managed", 1, { deniedMcpServers: [
      { serverUrl: "https://secure.example:0443" },
      { serverUrl: "http://plain.example" },
      { serverUrl: "https://service.example:8080" },
    ] })];
    expect(decision({ settings: deny }, remote({ url: "https://secure.example/x" })).reason).toBe("denied");
    expect(decision({ settings: deny }, remote({ url: "https://secure.example:443/x" })).reason).toBe("denied");
    expect(decision({ settings: deny }, remote({ url: "http://plain.example:080/x" })).reason).toBe("denied");
    expect(decision({ settings: deny }, remote({ url: "https://service.example:08080/x" })).reason).toBe("denied");
    expect(decision({ settings: deny }, remote({ url: "https://secure.example:65536/x" })).reason).toBe("candidate-invalid");
    expect(decision({ settings: deny }, remote({ url: "https://example.com\\.evil/private" })).reason).toBe("candidate-invalid");
    const rejectedPolicyBackslash = compileMcpPolicy({ settings: [entry("managed", 1, { deniedMcpServers: [{ serverUrl: "https://example.com\\private" }] })] });
    expect(rejectedPolicyBackslash.observations).toContain("invalid-rule-stripped");

    const allow = [entry("managed", 1, { allowedMcpServers: [{ serverUrl: "https://secure.example:443" }] })];
    expect(decision({ settings: allow }, remote({ url: "https://secure.example/x" })).reason).toBe("allow-miss");
    expect(decision({ settings: allow }, remote({ url: "https://secure.example:0443/x" })).reason).toBe("allow-miss");
  });

  it("blocks raw paths whose WHATWG serialization differs from encoded deny intent", () => {
    for (const [encoded, raw] of [["%20", " "], ["%22", '"'], ["%7B", "{"]] as const) {
      const settings = [entry("managed", 1, {
        deniedMcpServers: [{ serverUrl: `https://example.com/private${encoded}path` }],
      })];
      const result = decision({ settings }, remote({ url: `https://example.com/private${raw}path` }));
      expect(result, raw).toMatchObject({ status: "blocked", reason: "candidate-invalid" });
      expect(result.observations, raw).toContain("identity-ambiguity-blocked");
    }
    expect(decision({}, remote({ url: "https://example.com/ordinary-path" })).status).toBe("allowed");
  });

  it("authorizes stdio name fallback and SSE URL rules with misses", () => {
    const stdioNames = [entry("managed", 1, { allowedMcpServers: [{ serverName: "tools" }] })];
    expect(decision({ settings: stdioNames }, stdio()).status).toBe("allowed");
    expect(decision({ settings: stdioNames }, stdio({ name: "other" })).reason).toBe("allow-miss");
    const sseUrls = [entry("managed", 1, { allowedMcpServers: [{ serverUrl: "https://events.example/*" }] })];
    expect(decision({ settings: sseUrls }, remote({ transport: "sse", url: "https://events.example/feed" })).status).toBe("allowed");
    expect(decision({ settings: sseUrls }, remote({ transport: "sse", url: "https://other.example/feed" })).reason).toBe("allow-miss");
  });

  it("keeps distinct sensitive policy and candidate canaries off all returned surfaces", () => {
    const env = { SECRET_ENV_CANARY: "ENV_VALUE_CANARY" };
    const settings = [entry("managed", 1, {
      allowedMcpServers: [
        { serverUrl: "https://POLICY_URL_CANARY.invalid/${SECRET_ENV_CANARY}" },
        { serverCommand: ["POLICY_COMMAND_CANARY", "POLICY_ARG_CANARY"] },
      ],
    })];
    const policy = compileMcpPolicy({ settings, env, sourceFailures: [failure] });
    const decisions = [
      evaluateMcpPolicy(policy, remote({ url: "https://CANDIDATE_URL_CANARY.invalid/x" })),
      evaluateMcpPolicy(policy, stdio({ command: "CANDIDATE_COMMAND_CANARY", args: ["CANDIDATE_ARG_CANARY"] })),
    ];
    const surface = JSON.stringify([policy, decisions]);
    for (const canary of ["POLICY_URL_CANARY", "POLICY_COMMAND_CANARY", "POLICY_ARG_CANARY", "ENV_VALUE_CANARY", "CANDIDATE_URL_CANARY", "CANDIDATE_COMMAND_CANARY", "CANDIDATE_ARG_CANARY", "PATH_CANARY"]) {
      expect(surface).not.toContain(canary);
    }
  });
});
