import { describe, expect, it } from "vitest";
import type { PluginInventoryItem, PluginInventorySnapshot } from "../src/plugin-inventory.js";
import type { PluginResolutionStatus } from "../src/types.js";
import {
  PLUGIN_INVENTORY_ARGV_USAGE,
  PLUGIN_INVENTORY_SLASH_USAGE,
  formatPluginInventoryDisplayLocation,
  sanitizePluginInventoryDisplayText,
  parsePluginInventoryArgv,
  parsePluginInventorySlash,
  projectPluginInventoryDoctor,
  projectPluginInventoryStartup,
  renderPluginInventoryDetails,
  renderPluginInventoryList,
  renderPluginInventoryOperation,
} from "../src/runtime/plugin-inventory-text.js";
import { formatPluginInventoryStructuredSource } from "../src/runtime/plugin-inventory-display.js";

function item(qualifiedIdentity: string, overrides: Partial<PluginInventoryItem> = {}): PluginInventoryItem {
  const separator = qualifiedIdentity.lastIndexOf("@");
  return {
    qualifiedIdentity,
    lifecycleName: qualifiedIdentity.slice(0, separator),
    marketplaceName: qualifiedIdentity.slice(separator + 1),
    catalogPresence: false,
    installations: [],
    catalogDeclarations: [],
    dependencies: [],
    renames: [],
    components: [],
    executionRisk: [],
    diagnostics: [],
    ...overrides,
  };
}

function snapshot(items: readonly PluginInventoryItem[] = [], overrides: Partial<PluginInventorySnapshot> = {}): PluginInventorySnapshot {
  const values = [...items];
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    lifetime: "session",
    refreshGuidance: "untrusted caller wording",
    installedStateStatus: "valid",
    items: values,
    marketplaces: [],
    marketplaceCatalogs: [],
    allowlistObservations: [],
    conflictObservations: [],
    policyObservations: [],
    diagnostics: [],
    capabilityEvidence: [],
    omissions: {},
    find: (identity) => values.find((value) => value.qualifiedIdentity === identity),
    ...overrides,
  };
}

function expectSafeText(value: string): void {
  for (const line of value.split("\n")) expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(value).not.toMatch(/\p{M}/u);
  expect(value).not.toContain("hunter2");
  expect(value).not.toContain("abc123");
  expect(value).not.toContain("C:\\Users\\private");
  expect(value).not.toContain("/home/private");
}

const STATUS_EXPECTATIONS = {
  loaded: false,
  disabled: false,
  "enabled-but-uninstalled": true,
  unsupported: true,
  ambiguous: true,
  blocked: true,
  malformed: true,
  rejected: true,
} as const satisfies Record<PluginResolutionStatus, boolean>;

describe("plugin inventory operation grammar", () => {
  it("uses one strict operation vocabulary through separate slash and argv adapters", () => {
    expect(parsePluginInventorySlash("\t/plugin   list \t")).toEqual({ kind: "operation", operation: { kind: "list" } });
    expect(parsePluginInventorySlash("/plugin details same@official")).toEqual({ kind: "operation", operation: { kind: "details", qualifiedIdentity: "same@official" } });
    expect(parsePluginInventoryArgv(["list"])).toEqual({ kind: "operation", operation: { kind: "list" } });
    expect(parsePluginInventoryArgv(["details", "same@official"])).toEqual({ kind: "operation", operation: { kind: "details", qualifiedIdentity: "same@official" } });
    const canonicalMax = `${"p".repeat(190)}@${"m".repeat(65)}`;
    expect(canonicalMax).toHaveLength(256);
    expect(parsePluginInventorySlash(`/plugin details ${canonicalMax}`)).toEqual({ kind: "operation", operation: { kind: "details", qualifiedIdentity: canonicalMax } });
    expect(parsePluginInventoryArgv(["details", canonicalMax])).toEqual({ kind: "operation", operation: { kind: "details", qualifiedIdentity: canonicalMax } });
    const credentialShaped = ["password@official", "api_key@official"];
    const state = snapshot([item(canonicalMax), ...credentialShaped.map((identity) => item(identity))]);
    expect(renderPluginInventoryList(state)).toContain(`Plugin: ${canonicalMax}`);
    expect(renderPluginInventoryDetails(state, canonicalMax)).toContain(`Plugin: ${canonicalMax}`);
    for (const identity of credentialShaped) {
      expect(parsePluginInventoryArgv(["details", identity])).toEqual({ kind: "operation", operation: { kind: "details", qualifiedIdentity: identity } });
      expect(renderPluginInventoryList(state)).toContain(`Plugin: ${identity}`);
      expect(renderPluginInventoryDetails(state, identity)).toContain(`Plugin: ${identity}`);
    }
  });

  it("rejects missing, extra, unqualified, ambiguous, control, option, and mutation-looking forms without reflection", () => {
    const slashValues = ["/plugin", "/plugin details", "/plugin details same", "/plugin details same@one extra", "/plugin install same@one", "/plugin --help", "/plugin list\ninstall evil", `/plugin details ${"a".repeat(520)}@m`];
    const argvValues = [[], ["details"], ["details", "same"], ["details", "same@one", "extra"], ["install", "same@one"], ["--help"], ["details", "same@one\nremove"]];
    for (const value of slashValues) expect(parsePluginInventorySlash(value)).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
    for (const value of argvValues) expect(parsePluginInventoryArgv(value)).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
    expect(PLUGIN_INVENTORY_SLASH_USAGE).not.toContain("evil");
    expect(PLUGIN_INVENTORY_ARGV_USAGE).not.toContain("remove");
  });

  it("treats argv as exact tokens and slash whitespace as spaces or tabs only", () => {
    expect(parsePluginInventoryArgv(["details same@official"])).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
    expect(parsePluginInventoryArgv(["details", "same@official*"])).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
    expect(parsePluginInventoryArgv(["details", "same/name@official"])).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
    expect(parsePluginInventorySlash("/plugin\vlist")).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
    expect(parsePluginInventorySlash("/plugin details $NAME")).toEqual({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
  });
});

describe("plugin inventory shared display safety", () => {
  it("exports the fail-closed generic-text and structured-location policy for every human surface", () => {
    expect(sanitizePluginInventoryDisplayText("ａｐｉ＿ｋｅｙ＝SECRET-COMPAT")).toBe("<redacted-field>");
    expect(sanitizePluginInventoryDisplayText("Authorization Bearer SECRET-BEARER")).toBe("<redacted-field>");
    expect(sanitizePluginInventoryDisplayText("https://user:pass@example.test/safe")).toBe("<redacted-url>");
    expect(sanitizePluginInventoryDisplayText("https://example.test/%2561pi%252Ekey/SECRET-ENCODED")).toBe("<redacted-url>");
    expect(sanitizePluginInventoryDisplayText("ordinary composed café")).toBe("ordinary composed café");
    expect(formatPluginInventoryDisplayLocation({ kind: "project", display: "<project>/plugins/safe" })).toBe("<project>/plugins/safe");
    expect(formatPluginInventoryDisplayLocation({ kind: "project", display: "<project>/./secret" })).toBe("<external>");
    expect(formatPluginInventoryDisplayLocation({ kind: "project", display: "<project>/../secret" })).toBe("<external>");
    expect(formatPluginInventoryStructuredSource({ kind: "github", repo: "owner/repo", url: "https://example.test/source?token=hidden", secret: "SECRET" })).toBe("kind=github, repo=owner/repo, url=https://example.test/source");
    expect(formatPluginInventoryStructuredSource({ kind: "github\u001b[31m", repo: "../private", url: "https://user:pass@example.test/source" })).toBe("kind=github, repo=<redacted>, url=<redacted>");
    expect(formatPluginInventoryStructuredSource({ kind: "relative", value: "./plugins/safe-name" })).toBe("kind=relative, value=plugins/safe-name");
    expect(formatPluginInventoryStructuredSource({ kind: "git", url: "https://example.test/releases/safe-plugin?view=compact#current" })).toBe("kind=git, url=https://example.test/releases/safe-plugin");
    for (const hostile of ["././nested", "plugins/./nested", "plugins/../private", "/rooted", "C:/rooted", "~/rooted", "plugins\\private", "token=secret", "plugins/\u0001private", "plugins/token", "plugins/%74oken/value", "plugins/%2574oken/value", "plugins/%252574oken/value", "plugins/%25252574oken/value", "plugins/%zz"]) {
      expect(formatPluginInventoryStructuredSource({ value: hostile }), hostile).toBe("value=<redacted>");
    }
    for (const key of ["repo", "ref", "package", "version", "sha", "hostPattern", "pathPattern"] as const) {
      expect(formatPluginInventoryStructuredSource({ [key]: "%EF%BD%81%EF%BD%90%EF%BD%89%EF%BC%8D%EF%BD%8B%EF%BD%85%EF%BD%99=value" }), key).toBe(`${key}=<redacted>`);
    }
    for (const url of ["https://example.test/password/value", "https://example.test/%70assword/value", "https://example.test/%2570assword/value", "https://example.test/%EF%BD%81%EF%BD%90%EF%BD%89/%EF%BD%8B%EF%BD%85%EF%BD%99", "https://example.test/%zz"]) {
      expect(formatPluginInventoryStructuredSource({ url }), url).toBe("url=<redacted>");
    }
    const controlSuffixes = [
      "\u001b[31m", "%1B%5B31m", "%251B%255B31m",
      "\u0001", "%01", "%2501",
      "\u200B", "%E2%80%8B", "%25E2%2580%258B",
      "\u2028", "%E2%80%A8", "%25E2%2580%25A8",
      "\u2029", "%E2%80%A9", "%25E2%2580%25A9",
    ];
    for (const suffix of controlSuffixes) {
      for (const key of ["ref", "hostPattern", "pathPattern"] as const) {
        expect(formatPluginInventoryStructuredSource({ [key]: `safe${suffix}tail` }), `${key} ${JSON.stringify(suffix)}`).toBe(`${key}=<redacted>`);
      }
      expect(formatPluginInventoryStructuredSource({ url: `https://example.test/safe${suffix}tail` }), `url ${JSON.stringify(suffix)}`).toBe("url=<redacted>");
    }
    for (const key of ["ref", "hostPattern", "pathPattern"] as const) {
      expect(formatPluginInventoryStructuredSource({ [key]: "release%2Dsafe" })).toBe(`${key}=release-safe`);
    }
    expect(formatPluginInventoryStructuredSource({ url: "https://example.test/caf%C3%A9" })).toBe("url=https://example.test/caf%C3%A9");
  });
});

describe("plugin inventory deterministic text", () => {
  it("lists qualified identities in snapshot order while keeping every state axis independent", () => {
    const state = snapshot([
      item("same@one", { installations: [{ scope: "user", version: "1", validity: "valid", selected: true, diagnostics: [], problems: [] }], enablement: { enabled: false, scope: "user", source: { kind: "claude-user", display: "<claude-user>/settings.json" } }, outcome: { status: "disabled", sharedStateCauses: [] } }),
      item("same@two", { catalogPresence: true, enablement: { enabled: true, scope: "project", source: { kind: "project", display: "<project>/.claude/settings.json" } }, outcome: { status: "enabled-but-uninstalled", sharedStateCauses: [] } }),
      item("loaded@market", { installations: [{ validity: "valid", selected: true, diagnostics: [], problems: [] }, { validity: "invalid", selected: false, diagnostics: [], problems: ["bad"] }], outcome: { status: "loaded", sharedStateCauses: [] } }),
    ]);
    const rendered = renderPluginInventoryList(state);
    expect(rendered).toContain("Plugin: same@one\n  installed: 1 valid\n  enabled: no\n  runtime: disabled\n  catalog: not known");
    expect(rendered).toContain("Plugin: same@two\n  installed: none\n  enabled: yes\n  runtime: enabled-but-uninstalled\n  catalog: known");
    expect(rendered).toContain("Plugin: loaded@market\n  installed: 1 valid, 1 invalid\n  enabled: not declared\n  runtime: loaded\n  catalog: not known");
    expect(rendered.indexOf("same@two")).toBeLessThan(rendered.indexOf("same@one"));
    expect(rendered.indexOf("loaded@market")).toBeLessThan(rendered.indexOf("same@one"));
    expect(rendered).toContain("captured for this session; run canonical /reload in the interactive TUI, or exit and relaunch PiCC to refresh");
    expect(renderPluginInventoryList(snapshot([], { lifetime: "command" }))).toContain("captured for this command; rerun this command to refresh");
  });

  it("renders every captured resolution state without deriving one axis from another", () => {
    const statuses = Object.keys(STATUS_EXPECTATIONS) as PluginResolutionStatus[];
    const rendered = renderPluginInventoryList(snapshot(statuses.map((status, index) => item(`state${index}@market`, { outcome: { status, sharedStateCauses: [] } }))));
    for (const status of statuses) expect(rendered).toContain(`runtime: ${status}`);
  });

  it("renders bounded details with independent declarations/runtime truth and explicit non-resolution posture", () => {
    const plugin = item("alpha@official", {
      manifestNamespace: "visible-alpha",
      catalogPresence: true,
      installations: [{ scope: "user", version: "1.2.3", validity: "valid", selected: true, location: { kind: "plugin-cache", display: "<plugin-cache>/official/alpha/1.2.3" }, diagnostics: [], problems: [] }],
      enablement: { enabled: true, scope: "managed", source: { kind: "claude-user", display: "<claude-user>/settings.json" } },
      selectedInstallation: { scope: "user", version: "1.2.3", root: { kind: "plugin-cache", display: "<plugin-cache>/official/alpha/1.2.3" }, project: { kind: "project", display: "<project>/packages/alpha" }, data: { kind: "plugin-data", display: "<plugin-data>/alpha" }, provenance: { state: { kind: "claude-user", display: "<claude-user>/plugins/installed_plugins.json" }, stateVersion: 2 } },
      outcome: { status: "loaded", sharedStateCauses: [] },
      metadata: { manifestName: "alpha", version: "1.2.3", description: "Useful plugin", author: "Team", homepage: "https://example.test/alpha", repository: "https://example.test/repo", license: "MIT", keywords: ["safe"], components: [] },
      catalogDeclarations: [{
        source: { kind: "git", url: "https://example.test/catalog" }, version: "2.0", revision: "abc", description: "catalog description",
        fieldProvenance: {},
        strict: { value: true, presence: "explicit", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/catalog.json" }, field: "strict" } },
        defaultEnabled: { value: false, presence: "default", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/catalog.json" }, field: "defaultEnabled" } },
        provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/catalog.json" }, scope: "user", origin: "catalog" }, runtimeEffect: "declared-not-effective",
      }],
      executionRisk: ["code"],
      components: [
        { origin: "selected-manifest", kind: "agents", count: 2, countSemantics: "selected-manifest-declarations", declaration: "paths", capabilityId: "feature.plugins-agents", supportTier: "partial", executionRisk: "code" },
        { origin: "selected-manifest", kind: "workflows", count: 1, countSemantics: "selected-manifest-declarations", declaration: "shape", capabilityId: "feature.plugins-other-components", supportTier: "not-supported", executionRisk: "unsupported-runtime", provenance: { source: { kind: "plugin-cache", display: "<plugin-cache>/official/alpha/1.2.3/.claude-plugin/plugin.json" }, field: "workflows" } },
        { origin: "final-runtime", kind: "agents", count: 1, countSemantics: "finalized-registrations", posture: "final-loaded", declaration: "default-layout", capabilityId: "feature.plugins-agents", supportTier: "partial", executionRisk: "code" },
      ],
      dependencies: [{ origin: "catalog", targetIdentity: "dep@official", version: "^1", posture: "declared-locally-observable-not-resolved", crossMarketplace: "same-marketplace", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/catalog.json" } } }],
      renames: [{ from: "old-alpha", target: "alpha", status: "current", posture: "declared-not-effective", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/catalog.json" } } }],
      diagnostics: [{ severity: "warning", message: "one component was unsupported" }],
    });
    const state = snapshot([plugin], { policyObservations: [{ kind: "strict", descriptor: { hostPattern: "safe.example" }, descriptorProvenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/policy.json" }, field: "hostPattern" }, match: true, validScope: true, emptyLockdown: false, posture: "claude-lifecycle-observation-not-enforced", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/policy.json" }, scope: "managed" } }] });
    const rendered = renderPluginInventoryOperation(state, { kind: "details", qualifiedIdentity: "alpha@official" });
    expect(rendered).toContain("Plugin: alpha@official");
    expect(rendered).toContain("selected-manifest/agents: count=2; semantics=selected-manifest-declarations");
    expect(rendered).toContain("final-runtime/agents: count=1; semantics=finalized-registrations");
    expect(rendered).toContain("selected-manifest/workflows: count=1; semantics=selected-manifest-declarations");
    expect(rendered).toContain("support=not-supported; capability=feature.plugins-other-components");
    expect(rendered).toContain("provenance=source=<plugin-cache>/official/alpha/1.2.3/.claude-plugin/plugin.json, field=workflows");
    expect(rendered).toContain("origin=catalog");
    expect(rendered).toContain("qualification=same-marketplace");
    expect(rendered).toContain("Dependencies (declared only; resolution is not performed)");
    expect(rendered).toContain("Renames (declared only; migration is not performed)");
    expect(rendered).toContain("<plugin-cache>/official/alpha/1.2.3");
    expect(rendered).toContain("Selected project location: <project>/packages/alpha");
    expect(rendered).toContain("source=kind=git, url=https://example.test/catalog");
    expect(rendered).toContain("version=2.0");
    expect(rendered).toContain("revision=abc");
    expect(rendered).toContain("description=catalog description");
    expect(rendered).toContain("strict=yes; presence=explicit");
    expect(rendered).toContain("default-enabled=no; presence=default");
    expect(rendered).toContain("declaration=paths; posture=observed declaration");
    expect(rendered).toContain("Execution risk: code");
    expect(rendered).toContain("GLOBAL policy observations (not owned by this plugin; not enforced by PiCC)");
    expect(rendered).toContain("descriptor=<redacted-field>");
    expect(renderPluginInventoryDetails(state, "alpha")).toBe(PLUGIN_INVENTORY_SLASH_USAGE);
    expect(renderPluginInventoryDetails(state, "missing@official")).toContain("copy an exact qualified identity");
  });

  it("sanitizes before Unicode-safe truncation and never emits ANSI, controls, bidi, credentials, or raw locations", () => {
    const hostile = `start\u001b[31mRED\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u202esecret=hunter2 token=abc123 C:\\Users\\private\\x /home/private/y https://user:pass@example.test/path?q=secret \ud800 ${"😀".repeat(400)}`;
    const plugin = item("safe@market", {
      metadata: { description: hostile, homepage: "https://user:pass@example.test/path?token=abc123", keywords: [hostile], components: [] },
      selectedInstallation: { scope: "user", version: "1", root: { kind: "external", display: hostile }, data: { kind: "plugin-data", display: "C:\\Users\\private" }, provenance: { state: { kind: "external", display: hostile }, stateVersion: 2 } },
      diagnostics: [{ severity: "error", message: hostile }],
    });
    const rendered = renderPluginInventoryDetails(snapshot([plugin]), "safe@market");
    expectSafeText(rendered);
    expect(rendered).toContain("<redacted-field>");
    expect(rendered).toContain("<redacted-url>");
    expect(rendered).toContain("<external>");
    expect(rendered.length).toBeLessThan(4_000);
  });

  it("redacts the exact adversarial location, URI, and credential matrix without retaining suffixes", () => {
    const fieldValues = [
      "root relative \\private folder\\quoted file.txt suffix",
      "drive \"C:\\private folder\\secret.txt\" suffix",
      "UNC '\\\\server\\private share\\secret.txt' suffix",
      "device \\\\?\\C:\\private folder\\secret.txt suffix",
      "device pipe \\\\.\\pipe\\secret name suffix",
      "POSIX '/srv/private folder/secret.txt' suffix",
      "punctuation [/home/private file] suffix",
      "angle </srv/private file> suffix",
      "Authorization: Bearer abc123 suffix",
      "Authorization=Basic abc123 suffix",
      "Authorization: \"Digest auth-value-773\" suffix",
      "'proxy-authorization' = 'Negotiate proxy-value-884' suffix",
      "password=\"hunter2 with spaces\" suffix",
      "{\"password\": \"quoted password spaces 995\"} suffix",
      "passwd='passwd-value-116' suffix",
      "token=token-value-227 suffix",
      "secret=secret-value-338 suffix",
      "client_secret=client-value-449 suffix",
      "client-secret=client-value-550 suffix",
      "client.secret=client-value-661 suffix",
      "credential=credential-value-772 suffix",
      "api-key=api-value-883 suffix",
      "api_key=api-value-994 suffix",
      "api key 'abc123 with spaces' suffix",
      "ｐａｓｓｗｏｒｄ＝ｆｕｌｌｗｉｄｔｈ－ｖａｌｕｅ－１０５ suffix",
      "fullwidth Ｃ：＼Users＼private＼secret.txt suffix",
      "fullwidth ／home／private／secret.txt suffix",
      "api.key=api-value-220 suffix",
      "api.key assignment-value-221 suffix",
      ".ssh/id_rsa suffix",
      "config/.env suffix",
      "relative/private/secret.txt suffix",
      "relative/public/readme.txt suffix",
      "input/output suffix",
      "equation x=y suffix",
      "assignment prose label: value suffix",
    ];
    for (const value of fieldValues) {
      const rendered = renderPluginInventoryDetails(snapshot([item("matrix@market", { metadata: { description: value, keywords: [], components: [] } })]), "matrix@market");
      expect(rendered).toContain("description: <redacted-field>");
      expect(rendered).not.toContain("suffix");
      expect(rendered).not.toContain(value);
      expectSafeText(rendered);
    }

    for (const value of ["ftp://user:pass@example.test/private", "ssh://user:pass@example.test/private", "mailto:user@example.test"]) {
      const rendered = renderPluginInventoryDetails(snapshot([item("uri@market", { metadata: { description: value, keywords: [], components: [] } })]), "uri@market");
      expect(rendered).toContain("description: <redacted-url>");
      expect(rendered).not.toContain("user:pass");
    }
  });

  it("redacts HTTP URLs whose userinfo, path, query, or fragment carries credential shapes", () => {
    const values = [
      "https://user:pass@example.test/safe",
      "https://example.test/password=hunter2-url",
      "https://example.test/%70assword%3Dhunter2-encoded",
      "https://example.test/safe;token=SECRET773",
      "https://example.test/foo-token=SECRET884",
      "https://example.test/foo-password=hunter2",
      "https://example.test/safe%3Btoken%3DSECRET773",
      "https://example.test/foo_token%3DSECRET-EXACT",
      "https://example.test/foo_token%253DSECRET-EXACT",
      "https://example.test/%EF%BD%86%EF%BD%8F%EF%BD%8F%EF%BC%8D%EF%BD%90%EF%BD%81%EF%BD%93%EF%BD%93%EF%BD%97%EF%BD%8F%EF%BD%92%EF%BD%84%EF%BC%9Dhunter2",
      "https://example.test/credential/credential-path-value",
      "https://example.test/api/key",
      "https://example.test/api.key",
      "https://example.test/client/secret",
      "https://example.test/password/value",
      "https://example.test/%EF%BD%81%EF%BD%90%EF%BD%89/%EF%BD%8B%EF%BD%85%EF%BD%99",
      "https://example.test/api%252Fkey",
      "https://example.test/safe?api_key=query-value-216",
      "https://example.test/safe#client_secret=fragment-value-327",
    ];
    for (const value of values) {
      const rendered = renderPluginInventoryDetails(snapshot([item("url@market", { metadata: { description: `${value} suffix`, keywords: [], components: [] } })]), "url@market");
      expect(rendered).toContain("description: <redacted-url>");
      expect(rendered).not.toContain(value);
      expect(rendered).not.toContain("suffix");
      expect(rendered).not.toMatch(/hunter2|credential-path-value|query-value-216|fragment-value-327/u);
    }

    const safe = renderPluginInventoryDetails(snapshot([item("url@market", { metadata: { description: "https://example.test/safe/mode-compact", keywords: [], components: [] } })]), "url@market");
    expect(safe).toContain("description: https://example.test/safe/mode-compact");
    expect(safe).not.toContain("<redacted-url>");
  });

  it("normalizes path-free Unicode and preserves safe HTTP URLs and structured pseudo-root locations", () => {
    const unicode = "Cafe\u0301 élan Ångström 한국어 Ελληνικά";
    const rendered = renderPluginInventoryDetails(snapshot([item("safe@market", {
      metadata: { description: unicode, homepage: "https://example.test/safe/path?q=ordinary#fragment", repository: "<project>/generic/location", keywords: [], components: [] },
      selectedInstallation: { scope: "user", version: "1", root: { kind: "plugin-cache", display: "<plugin-cache>/safe/root" }, data: { kind: "plugin-data", display: "<plugin-data>/safe" }, provenance: { state: { kind: "claude-user", display: "<claude-user>/state.json" }, stateVersion: 2 } },
    })]), "safe@market");
    expect(rendered).toContain("description: Café élan Ångström 한국어 Ελληνικά");
    expect(rendered).toContain("homepage: https://example.test/safe/path");
    expect(rendered).not.toContain("q=ordinary");
    expect(rendered).not.toContain("fragment");
    expect(rendered).toContain("repository: <redacted-field>");
    expect(rendered).toContain("<plugin-cache>/safe/root");
    expect(rendered).toContain("<plugin-data>/safe");
    expectSafeText(rendered);
  });

  it("bounds rows, fields, diagnostics, and explicit omission markers", () => {
    const manyItems = Array.from({ length: 105 }, (_, index) => item(`p${index}@market`));
    const list = renderPluginInventoryList(snapshot(manyItems, { omissions: { upstream: 7 } }));
    expect(list).toContain("Local rows not shown: 5");
    expect(list).toContain("Snapshot-capture evidence omissions: upstream=7");
    expect(list).not.toContain("p104@market");
    const many = Array.from({ length: 40 }, (_, index) => ({ severity: "warning" as const, message: `diagnostic-${index}` }));
    const details = renderPluginInventoryDetails(snapshot([item("p@market", { diagnostics: many })], { omissions: { fields: 3 } }), "p@market");
    expect(details).toContain("… 8 local values not shown");
    expect(details).toContain("Snapshot-capture evidence omissions (GLOBAL, not attributed to this plugin): fields=3");
    expect(details).not.toContain("diagnostic-39");
  });
});

describe("plugin inventory startup and doctor projections", () => {
  it.each(Object.entries(STATUS_EXPECTATIONS) as [PluginResolutionStatus, boolean][])("classifies %s consistently for startup and doctor", (status, needsAttention) => {
    const state = snapshot([item("status@market", { outcome: { status, sharedStateCauses: [] } })]);
    const startup = projectPluginInventoryStartup(state);
    const doctor = projectPluginInventoryDoctor(state);
    expect(startup.needsAttention).toBe(needsAttention);
    expect(startup.qualifiedIdentities).toEqual(needsAttention ? ["status@market"] : []);
    expect(doctor.counts.attention).toBe(needsAttention ? 1 : 0);
    if (needsAttention) {
      expect(doctor.diagnostics).toContainEqual(expect.objectContaining({ qualifiedIdentity: "status@market", status, nextCommand: "/plugin details status@market", repairBoundary: expect.stringContaining("read-only") }));
    } else {
      expect(doctor.diagnostics).toEqual([]);
    }
  });

  it("stays quiet for loaded/disabled plugins and emits bounded qualified attention with administrator policy evidence", () => {
    const quiet = projectPluginInventoryStartup(snapshot([item("same@one", { outcome: { status: "loaded", sharedStateCauses: [] } }), item("same@two", { outcome: { status: "disabled", sharedStateCauses: [] } })]));
    expect(quiet).toEqual({ needsAttention: false, qualifiedIdentities: [], managedPolicyEvidence: [], omissions: { identities: 0, managedPolicyEvidence: 0, captureEvidence: [] } });
    const failed = Array.from({ length: 12 }, (_, index) => item(`same@m${index}`, { outcome: { status: index === 0 ? "blocked" : "enabled-but-uninstalled", sharedStateCauses: [] } }));
    const state = snapshot(failed, { diagnostics: [
      { severity: "error", message: "raw administrator path", category: "managed-policy-malformed", sourceClass: "system-file", impact: "source-ignored" },
      { severity: "error", message: "raw administrator path", category: "managed-policy-unreadable", sourceClass: "registry-hklm", impact: "weaker-policy-suppressed" },
      { severity: "error", message: "not administrator", category: "managed-policy-malformed", sourceClass: "registry-hkcu", impact: "source-ignored" },
    ] });
    const projection = projectPluginInventoryStartup(state);
    expect(projection.needsAttention).toBe(true);
    expect(projection.qualifiedIdentities).toHaveLength(10);
    expect(projection.qualifiedIdentities).toContain("same@m0");
    expect(projection.qualifiedIdentities).toContain("same@m1");
    expect(projection.omissions).toEqual({ identities: 2, managedPolicyEvidence: 0, captureEvidence: [] });
    expect(projection.managedPolicyEvidence).toEqual([
      { category: "managed-policy-malformed", condition: "malformed", sourceClass: "system-file", sourceLabel: "system policy file", impact: "source-ignored", guidance: "Ask an administrator to correct the policy format", refreshGuidance: "run canonical /reload in the interactive TUI, or exit and relaunch PiCC" },
      { category: "managed-policy-unreadable", condition: "unreadable", sourceClass: "registry-hklm", sourceLabel: "machine registry policy", impact: "weaker-policy-suppressed", guidance: "Ask an administrator to correct access to the policy source", refreshGuidance: "run canonical /reload in the interactive TUI, or exit and relaunch PiCC" },
    ]);
    expect(projection.text).toContain("Run /doctor for details");
    expect(projection.text).toContain("system policy file was malformed; the administrator source was ignored and plugin enablement may differ. Ask an administrator to correct the policy format, then run canonical /reload in the interactive TUI, or exit and relaunch PiCC.");
    expect(projection.text).toContain("machine registry policy was unreadable; weaker policy was suppressed and plugin enablement may differ. Ask an administrator to correct access to the policy source, then run canonical /reload in the interactive TUI, or exit and relaunch PiCC.");
    expect(projection.text).not.toContain("captured for this session");
    expect(projection.text).not.toContain("raw administrator path");
  });

  it("caps startup managed policy per impact so both consequences survive and keeps capture omissions separate", () => {
    const diagnostics = (["source-ignored", "weaker-policy-suppressed"] as const).flatMap((impact) =>
      (["system-file", "system-drop-in", "registry-hklm"] as const).flatMap((sourceClass) =>
        (["managed-policy-malformed", "managed-policy-unreadable"] as const).map((category) => ({ severity: "error" as const, message: "hidden", category, sourceClass, impact }))));
    const projection = projectPluginInventoryStartup(snapshot([], { diagnostics, omissions: { "snapshot.items": 2, "snapshot.diagnostics": 4 } }));
    expect(projection.managedPolicyEvidence.filter((value) => value.impact === "source-ignored")).toHaveLength(3);
    expect(projection.managedPolicyEvidence.filter((value) => value.impact === "weaker-policy-suppressed")).toHaveLength(3);
    expect(projection.omissions).toEqual({ identities: 0, managedPolicyEvidence: 6, captureEvidence: [{ axis: "snapshot.diagnostics", count: 4 }, { axis: "snapshot.items", count: 2 }] });
    expect(projection.text).toContain("administrator source was ignored");
    expect(projection.text).toContain("weaker policy was suppressed");
    expect(projection.text).toContain("correct the policy format");
    expect(projection.text).toContain("correct access to the policy source");
  });

  it("provides structured counts, qualified diagnostics, managed evidence, and unchanged capability IDs", () => {
    const state = snapshot([
      item("same@one", { catalogPresence: true, installations: [{ validity: "valid", selected: true, diagnostics: [], problems: [] }], enablement: { enabled: true, scope: "user", source: { kind: "claude-user", display: "<claude-user>/settings.json" } }, outcome: { status: "loaded", sharedStateCauses: [] } }),
      item("same@two", { enablement: { enabled: true, scope: "user", source: { kind: "claude-user", display: "<claude-user>/settings.json" } }, outcome: { status: "blocked", sharedStateCauses: [] }, diagnostics: [{ severity: "error", message: "blocked safely" }] }),
    ], {
      capabilityEvidence: [{ capabilityId: "feature.plugins-agents", qualifiedIdentity: "same@one", component: "agents", observation: "Plugin agent field hooks was stripped before runtime construction" }],
      diagnostics: [{ severity: "error", message: "Managed plugin policy evidence affected startup", category: "managed-policy-unreadable", sourceClass: "system-drop-in", impact: "source-ignored" }],
    });
    const projection = projectPluginInventoryDoctor(state);
    expect(projection.counts).toEqual({ known: 2, installed: 1, enabled: 2, loaded: 1, cataloged: 1, attention: 1 });
    expect(projection.diagnostics).toContainEqual(expect.objectContaining({ qualifiedIdentity: "same@two", status: "blocked" }));
    expect(projection.capabilityEvidence).toEqual([{ capabilityId: "feature.plugins-agents", qualifiedIdentity: "same@one", component: "agents", observation: "Plugin agent field hooks was stripped before runtime construction" }]);
    expect(projection.managedPolicyEvidence).toEqual([{ category: "managed-policy-unreadable", condition: "unreadable", sourceClass: "system-drop-in", sourceLabel: "system policy drop-in", impact: "source-ignored", guidance: "Ask an administrator to correct access to the policy source", refreshGuidance: "run canonical /reload in the interactive TUI, or exit and relaunch PiCC" }]);
    expect(projection.snapshotBoundary).toContain("captured for this session");
  });

  it("projects every safe policy source and impact for doctor without raw paths while startup stays administrator-only", () => {
    const sources = [
      ["system-file", "system policy file", "Ask an administrator"],
      ["system-drop-in", "system policy drop-in", "Ask an administrator"],
      ["registry-hklm", "machine registry policy", "Ask an administrator"],
      ["registry-hkcu", "user registry policy", "Correct"],
      ["override", "managed-policy override", "Correct"],
    ] as const;
    const diagnostics = sources.flatMap(([sourceClass]) => ([
      { severity: "error" as const, message: `C:/RAW/${sourceClass}`, category: "managed-policy-malformed" as const, sourceClass, impact: "source-ignored" as const },
      { severity: "error" as const, message: `/RAW/${sourceClass}`, category: "managed-policy-unreadable" as const, sourceClass, impact: "weaker-policy-suppressed" as const },
    ]));

    const doctor = projectPluginInventoryDoctor(snapshot([], { diagnostics }));
    expect(doctor.managedPolicyEvidence).toHaveLength(10);
    for (const [sourceClass, sourceLabel, actor] of sources) {
      for (const impact of ["source-ignored", "weaker-policy-suppressed"] as const) {
        expect(doctor.managedPolicyEvidence).toContainEqual(expect.objectContaining({ sourceClass, sourceLabel, impact, guidance: expect.stringContaining(actor), refreshGuidance: expect.stringContaining("canonical /reload") }));
      }
    }
    expect(JSON.stringify(doctor)).not.toMatch(/C:\/RAW|\/RAW\//u);

    const startup = projectPluginInventoryStartup(snapshot([], { diagnostics }));
    expect(startup.managedPolicyEvidence.map((value) => value.sourceClass)).not.toContain("registry-hkcu");
    expect(startup.managedPolicyEvidence.map((value) => value.sourceClass)).not.toContain("override");
  });

  it("preserves exact long capability and qualified IDs and gives structured actionable failure guidance", () => {
    const capabilityId = `feature.${"x".repeat(190)}`;
    const identity = `${"p".repeat(120)}@market`;
    const session = projectPluginInventoryDoctor(snapshot([item(identity, { outcome: { status: "rejected", sharedStateCauses: [] } })], { capabilityEvidence: [{ capabilityId, qualifiedIdentity: identity, observation: "bounded" }] }));
    expect(session.capabilityEvidence[0]?.capabilityId).toBe(capabilityId);
    expect(session.capabilityEvidence[0]?.qualifiedIdentity).toBe(identity);
    expect(session.diagnostics[0]).toMatchObject({ qualifiedIdentity: identity, status: "rejected", nextCommand: `/plugin details ${identity}`, repairBoundary: expect.stringContaining("read-only"), refreshGuidance: expect.stringContaining("/reload") });
    const command = projectPluginInventoryDoctor(snapshot([item(identity, { outcome: { status: "blocked", sharedStateCauses: [] } })], { lifetime: "command" }));
    expect(command.diagnostics[0]).toMatchObject({ status: "blocked", nextCommand: `picc plugin details ${identity}` });
    expect(command.diagnostics[0]).toMatchObject({ refreshGuidance: "rerun this command to refresh" });
  });

  it("counts unique attention identities from outcomes, diagnostics, components, and limited capability evidence", () => {
    const projection = projectPluginInventoryDoctor(snapshot([
      item("failed@market", { outcome: { status: "blocked", sharedStateCauses: [] } }),
      item("warned@market", { diagnostics: [{ severity: "warning", message: "warning" }] }),
      item("limited@market", { components: [{ origin: "selected-manifest", kind: "channels", count: 1, countSemantics: "selected-manifest-declarations", capabilityId: "feature.plugins-other-components", supportTier: "not-supported", executionRisk: "unsupported-runtime" }] }),
      item("evidence@market"),
    ], { capabilityEvidence: [{ capabilityId: "feature.plugins-content", qualifiedIdentity: "evidence@market", supportTier: "partial", observation: "Final loaded component support is partial" }] }));
    expect(projection.counts.attention).toBe(4);
    expect(projection.counts.attention).not.toBe(0);
  });

  it("deduplicates actionable diagnostics while retaining the read-only repair and refresh contract", () => {
    const duplicate = { severity: "warning" as const, message: "repair this declaration" };
    const projection = projectPluginInventoryDoctor(snapshot([item("p@market", { diagnostics: [duplicate, duplicate] })]));
    expect(projection.diagnostics).toEqual([expect.objectContaining({
      qualifiedIdentity: "p@market",
      message: "repair this declaration",
      nextCommand: "/plugin details p@market",
      repairBoundary: expect.stringContaining("read-only"),
      refreshGuidance: expect.stringContaining("canonical /reload"),
    })]);
    expect(projection.omitted.diagnostics.projection).toBe(0);
  });

  it("does not count exact duplicate capability evidence as omission or loss", () => {
    const evidence = { capabilityId: "feature.plugins-content", qualifiedIdentity: "p@market", component: "commands", supportTier: "partial" as const, observation: "Final loaded component support is partial" };
    const projection = projectPluginInventoryDoctor(snapshot([item("p@market")], { capabilityEvidence: [evidence, evidence] }));
    expect(projection.capabilityEvidence).toEqual([evidence]);
    expect(projection.omitted.capabilityEvidence.projection).toBe(0);
    expect(projection.captureOmissions.some((value) => value.axis.includes("duplicate"))).toBe(false);
  });

  it("combines upstream capture and local projection omissions without conflating managed policy", () => {
    const diagnostics = Array.from({ length: 70 }, (_, index) => ({ severity: "warning" as const, message: `warning-${index}` }));
    const capabilityEvidence = Array.from({ length: 130 }, (_, index) => ({ capabilityId: `feature.test-${index}`, qualifiedIdentity: `p${index}@market`, observation: "bounded" }));
    const policyDiagnostics = (["source-ignored", "weaker-policy-suppressed"] as const).flatMap((impact) =>
      (["system-file", "system-drop-in", "registry-hklm"] as const).flatMap((sourceClass) =>
        (["managed-policy-malformed", "managed-policy-unreadable"] as const).map((category) => ({ severity: "error" as const, message: "managed", category, sourceClass, impact }))));
    const projection = projectPluginInventoryDoctor(snapshot([item("p@market", { diagnostics })], { diagnostics: policyDiagnostics, capabilityEvidence, omissions: { "snapshot.diagnostics": 4, "snapshot.capability-evidence": 5, "snapshot.policies": 6 } }));
    expect(projection.diagnostics).toHaveLength(64);
    expect(projection.capabilityEvidence).toHaveLength(128);
    expect(projection.captureOmissions).toEqual([{ axis: "snapshot.capability-evidence", count: 5 }, { axis: "snapshot.diagnostics", count: 4 }, { axis: "snapshot.policies", count: 6 }]);
    expect(projection.omitted).toEqual({ diagnostics: { capture: 4, projection: 6 }, capabilityEvidence: { capture: 5, projection: 2 }, managedPolicyEvidence: { projection: 0 } });
  });
});
