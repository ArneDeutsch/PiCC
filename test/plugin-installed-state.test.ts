import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  loadPluginInstalledState,
  type InstalledPluginObservation,
} from "../src/claude/plugin-installed-state.js";
import type { NormalizedPluginInstallation } from "../src/types.js";
import { isQualifiedPluginId, parseQualifiedPluginId } from "../src/util/plugin-id.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/claude-plugins/installed-plugins-v2.json", import.meta.url),
);
const temporaryDirectories: string[] = [];

function makeUserDir(state?: string): string {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-installed-state-"));
  temporaryDirectories.push(userDir);
  if (state !== undefined) {
    const statePath = path.join(userDir, "plugins", "installed_plugins.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, state, "utf8");
  }
  return userDir;
}

function fromFixture(): string {
  return fs.readFileSync(fixturePath, "utf8");
}

function stateWith(records: unknown, pluginId = "demo@official"): string {
  return JSON.stringify({ version: 2, plugins: { [pluginId]: records } });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadPluginInstalledState", () => {
  it("normalizes the captured v2 envelope and preserves all scoped records", () => {
    const userDir = makeUserDir(fromFixture());
    const statePath = path.join(userDir, "plugins", "installed_plugins.json");

    const result = loadPluginInstalledState(userDir);

    expect(result.status).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.installations).toEqual([
      {
        pluginId: "formatter@community",
        scope: "project",
        projectPath: "<project>/alpha",
        installPath: "<plugins>/formatter/project",
        version: "2.4.0",
        provenance: {
          statePath,
          stateVersion: 2,
          installedAt: "2000-01-02T00:00:00.000Z",
          lastUpdated: "2000-01-03T00:00:00.000Z",
        },
      },
      {
        pluginId: "formatter@community",
        scope: "user",
        installPath: "<plugins>/formatter/user",
        version: "2.3.0",
        provenance: {
          statePath,
          stateVersion: 2,
          installedAt: "2000-01-01T00:00:00.000Z",
          lastUpdated: "2000-01-01T00:00:00.000Z",
        },
      },
      {
        pluginId: "lint@official",
        scope: "local",
        projectPath: "<project>/beta",
        installPath: "<plugins>/lint/local",
        version: "1.0.0",
        provenance: {
          statePath,
          stateVersion: 2,
          installedAt: "2000-02-01T00:00:00.000Z",
          lastUpdated: "2000-02-02T00:00:00.000Z",
        },
      },
    ]);
  });

  it("distinguishes valid empty and absent state", () => {
    const empty = loadPluginInstalledState(makeUserDir('{"version":2,"plugins":{}}'));
    expect(empty).toEqual({
      status: "valid",
      installations: [],
      observations: [],
      observationDiagnostics: [],
      observationOmissions: { records: 0, diagnostics: 0 },
      diagnostics: [],
    });

    expect(loadPluginInstalledState(makeUserDir())).toEqual({
      status: "absent",
      installations: [],
      observations: [],
      observationDiagnostics: [],
      observationOmissions: { records: 0, diagnostics: 0 },
      diagnostics: [],
    });
  });

  it("distinguishes unreadable, unsupported-version, and malformed state", () => {
    const unreadableUserDir = makeUserDir('{"version":2,"plugins":{}}');
    const unreadablePath = path.join(unreadableUserDir, "plugins", "installed_plugins.json");
    const originalOpenSync = fs.openSync;
    const thrownErrorText = "private-read-error-text";
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath: fs.PathLike, flags: fs.OpenMode) => {
      if (filePath === unreadablePath) {
        throw Object.assign(new Error(thrownErrorText), { code: "EACCES" });
      }
      return originalOpenSync(filePath, flags);
    }) as typeof fs.openSync);
    try {
      const unreadable = loadPluginInstalledState(unreadableUserDir);
      expect(unreadable.status).toBe("unreadable");
      expect(unreadable.installations).toEqual([]);
      expect(unreadable.diagnostics).toHaveLength(1);
      expect(unreadable.diagnostics[0]).toMatchObject({ severity: "warning" });
      expect(unreadable.diagnostics[0]!.message.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(unreadable.diagnostics)).not.toContain(thrownErrorText);
    } finally {
      openSpy.mockRestore();
    }

    expect(loadPluginInstalledState(makeUserDir('{"version":3,"plugins":{}}')).status).toBe(
      "unsupported",
    );
    expect(loadPluginInstalledState(makeUserDir('{"plugins":{}}')).status).toBe("malformed");
    expect(loadPluginInstalledState(makeUserDir("not json")).status).toBe("malformed");
  });

  it.each([
    ["malformed JSON", "{{ not json", "malformed"],
    ["array root", "[]", "malformed"],
    ["null root", "null", "malformed"],
    ["unsupported version", '{"version":3,"plugins":{}}', "unsupported"],
    ["non-numeric version", '{"version":"2","plugins":{}}', "malformed"],
    ["missing version", '{"plugins":{}}', "malformed"],
    ["array plugins", '{"version":2,"plugins":[]}', "malformed"],
    ["missing plugins", '{"version":2}', "malformed"],
  ] as const)("fails closed for a %s with bounded diagnostics", (_label, state, status) => {
    const result = loadPluginInstalledState(makeUserDir(state));
    expect(result.status).toBe(status);
    expect(result.installations).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).not.toContain(state);
  });

  it.each([
    ["non-array collection", { scope: "user" }],
    ["non-object record", ["record"]],
    ["missing scope", [{ installPath: "root", version: "1" }]],
    ["non-string scope", [{ scope: 4, installPath: "root", version: "1" }]],
    ["empty scope", [{ scope: "", installPath: "root", version: "1" }]],
    ["whitespace scope", [{ scope: " \t", installPath: "root", version: "1" }]],
    ["unsupported scope", [{ scope: "workspace", installPath: "root", version: "1" }]],
    ["missing install path", [{ scope: "user", version: "1" }]],
    ["non-string install path", [{ scope: "user", installPath: 4, version: "1" }]],
    ["empty install path", [{ scope: "user", installPath: "", version: "1" }]],
    ["whitespace install path", [{ scope: "user", installPath: " \t", version: "1" }]],
    ["missing version", [{ scope: "user", installPath: "root" }]],
    ["non-string version", [{ scope: "user", installPath: "root", version: 1 }]],
    ["empty version", [{ scope: "user", installPath: "root", version: "" }]],
    ["whitespace version", [{ scope: "user", installPath: "root", version: "  " }]],
    ["project scope missing project path", [{ scope: "project", installPath: "root", version: "1" }]],
    ["local scope missing project path", [{ scope: "local", installPath: "root", version: "1" }]],
    ["non-string project path", [{ scope: "user", projectPath: 4, installPath: "root", version: "1" }]],
    ["empty project path", [{ scope: "local", projectPath: "", installPath: "root", version: "1" }]],
    ["whitespace project path", [{ scope: "project", projectPath: "\n", installPath: "root", version: "1" }]],
    ["non-string installed timestamp", [{ scope: "user", installPath: "root", version: "1", installedAt: 4 }]],
    ["empty installed timestamp", [{ scope: "user", installPath: "root", version: "1", installedAt: "" }]],
    ["whitespace installed timestamp", [{ scope: "user", installPath: "root", version: "1", installedAt: " \t" }]],
    ["non-string update timestamp", [{ scope: "user", installPath: "root", version: "1", lastUpdated: false }]],
    ["empty update timestamp", [{ scope: "user", installPath: "root", version: "1", lastUpdated: "" }]],
    ["whitespace update timestamp", [{ scope: "user", installPath: "root", version: "1", lastUpdated: "\n" }]],
  ])("fails the whole state closed for a %s", (_label, records) => {
    const result = loadPluginInstalledState(makeUserDir(stateWith(records)));
    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.observationDiagnostics.some(({ message }) =>
      message.includes("demo@official"))).toBe(true);
  });

  it.each([
    ["non-object", "record", {}, ["record-not-object"]],
    ["unsupported scope", { scope: "workspace", installPath: "root", version: "1" },
      { scope: "workspace", installPath: "root", version: "1" }, ["scope-invalid"]],
    ["missing fields", { scope: "user" }, { scope: "user" },
      ["install-path-invalid", "version-invalid"]],
    ["invalid local path", { scope: "local", projectPath: "", installPath: "root", version: "1" },
      { scope: "local", installPath: "root", version: "1" },
      ["project-path-invalid", "project-path-required"]],
    ["invalid timestamps", { scope: "user", installPath: "root", version: "1", installedAt: 4, lastUpdated: false },
      { scope: "user", installPath: "root", version: "1" },
      ["installed-at-invalid", "last-updated-invalid"]],
  ] as const)("retains exact safe observation evidence for representative malformed %s records",
    (_label, record, declared, problems) => {
      const result = loadPluginInstalledState(makeUserDir(stateWith([record])));
      expect(result.observations).toEqual([{
        qualifiedIdentity: "demo@official",
        lifecycleName: "demo",
        marketplaceName: "official",
        validity: "invalid",
        loadEligibility: "observation-only",
        declared,
        problems,
      }]);
    });

  it.each([
    "demo@official",
    "demo.plugin-2@market_place.example-3",
    "a@b",
  ])("accepts qualified identity form %s", (pluginId) => {
    const result = loadPluginInstalledState(
      makeUserDir(stateWith([{ scope: "user", installPath: "root", version: "1" }], pluginId)),
    );
    expect(result.status).toBe("valid");
    expect(result.installations[0]!.pluginId).toBe(pluginId);
  });

  it.each([
    "",
    " ",
    "unqualified",
    "demo@@official",
    "demo@official@extra",
    " demo@official",
    "demo @official",
    "demo@ official",
    "demo@official ",
    "demo/@official",
    "demo@bad/market",
    "__proto__",
    "constructor",
  ])("rejects invalid or hostile identity form without disclosure: %s", (pluginId) => {
    const result = loadPluginInstalledState(
      makeUserDir(stateWith([{ scope: "user", installPath: "root", version: "1" }], pluginId)),
    );
    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    if (pluginId.trim().length > 0) expect(result.diagnostics[0]!.message).not.toContain(pluginId);
  });

  it("rolls back earlier valid records when a later record is malformed", () => {
    const result = loadPluginInstalledState(
      makeUserDir(JSON.stringify({
        version: 2,
        plugins: {
          "alpha@official": [
            { scope: "user", installPath: "alpha-user", version: "1" },
            { scope: "managed", installPath: "alpha-managed", version: "2" },
          ],
          "zeta@official": [
            { scope: "user", installPath: "zeta", version: "3" },
            { scope: "project", projectPath: " ", installPath: "broken", version: "4" },
          ],
        },
      })),
    );

    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("does not disclose malformed sensitive path or timestamp values", () => {
    const sensitivePath = "C:/Users/private/account/plugin";
    const sensitiveTimestamp = "private-activity-time";
    for (const record of [
      { scope: "user", installPath: { sensitivePath }, version: "1" },
      { scope: "project", projectPath: { sensitivePath }, installPath: "root", version: "1" },
      { scope: "user", installPath: "root", version: "1", installedAt: { sensitiveTimestamp } },
      { scope: "user", installPath: "root", version: "1", lastUpdated: { sensitiveTimestamp } },
    ]) {
      const result = loadPluginInstalledState(makeUserDir(stateWith([record])));
      const rendered = JSON.stringify(result.diagnostics);
      expect(rendered).not.toContain(sensitivePath);
      expect(rendered).not.toContain(sensitiveTimestamp);
    }
  });

  it("ignores unknown fields so the undocumented raw shape cannot escape", () => {
    const result = loadPluginInstalledState(
      makeUserDir(
        JSON.stringify({
          version: 2,
          envelopeSecret: "do-not-return",
          plugins: {
            "demo@official": [{
              scope: "user",
              installPath: "installed/demo",
              version: "1.2.3",
              rawSecret: "do-not-return",
            }],
          },
        }),
      ),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.installations).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(result.installations[0]).toMatchObject({
      pluginId: "demo@official",
      scope: "user",
      installPath: "installed/demo",
      version: "1.2.3",
    });
  });

  it("orders reversed identities and records deterministically", () => {
    const records = {
      alpha: [
        { scope: "user", installPath: "z", version: "1" },
        { scope: "managed", installPath: "a", version: "1" },
      ],
      zeta: [
        { scope: "user", installPath: "b", version: "2" },
        { scope: "user", installPath: "a", version: "2" },
      ],
    };
    const first = JSON.stringify({
      version: 2,
      plugins: { "zeta@official": records.zeta, "alpha@official": records.alpha },
    });
    const second = JSON.stringify({
      version: 2,
      plugins: {
        "alpha@official": [...records.alpha].reverse(),
        "zeta@official": [...records.zeta].reverse(),
      },
    });
    const normalize = (state: string) =>
      loadPluginInstalledState(makeUserDir(state)).installations.map(
        ({ provenance: _provenance, ...entry }) => entry,
      );

    expect(normalize(first)).toEqual(normalize(second));
    expect(normalize(first).map(({ pluginId, scope, installPath }) =>
      `${pluginId}:${scope}:${installPath}`)).toEqual([
      "alpha@official:managed:a",
      "alpha@official:user:z",
      "zeta@official:user:a",
      "zeta@official:user:b",
    ]);
  });

  it.each([
    ["absent", undefined, "ENOENT"],
    ["unreadable", undefined, "EACCES"],
    ["unsupported", '{"version":3,"plugins":{}}', undefined],
    ["malformed", "not json", undefined],
    ["malformed", `{"version":2,"plugins":{}}${" ".repeat(1024 * 1024)}`, undefined],
    ["valid", '{"version":2,"plugins":{}}', undefined],
  ] as const)("observes only the installed-state file for %s state", (status, state, errorCode) => {
    const userDir = makeUserDir(state);
    const statePath = path.join(userDir, "plugins", "installed_plugins.json");
    const originalOpenSync = fs.openSync;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath: fs.PathLike, flags: fs.OpenMode) => {
      if (errorCode !== undefined) {
        throw Object.assign(new Error("mocked installed-state read failure"), { code: errorCode });
      }
      return originalOpenSync(filePath, flags);
    }) as typeof fs.openSync);
    const existsSpy = vi.spyOn(fs, "existsSync");
    const statSpy = vi.spyOn(fs, "statSync");
    const lstatSpy = vi.spyOn(fs, "lstatSync");
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    const opendirSpy = vi.spyOn(fs, "opendirSync");

    const result = loadPluginInstalledState(userDir);

    expect(result.status).toBe(status);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(statePath, "r");
    expect(existsSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(opendirSpy).not.toHaveBeenCalled();
  });

  it("does not fall back to cache content when installed state is malformed", () => {
    const userDir = makeUserDir("not json");
    const cachedManifest = path.join(userDir, "plugins", "cache", "demo", ".claude-plugin", "plugin.json");
    fs.mkdirSync(path.dirname(cachedManifest), { recursive: true });
    fs.writeFileSync(cachedManifest, '{"name":"demo"}', "utf8");

    const result = loadPluginInstalledState(userDir);
    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("retains valid and invalid observational siblings while execution authority fails closed", () => {
    const result = loadPluginInstalledState(makeUserDir(JSON.stringify({
      version: 2,
      plugins: {
        "zeta@community": [
          { scope: "user", installPath: "zeta", version: "2" },
          { scope: "workspace", installPath: "blocked", version: "3" },
        ],
        "alpha@official": [
          { scope: "project", projectPath: "/project", installPath: "alpha", version: "1" },
        ],
      },
    })));

    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.observations).toHaveLength(3);
    expect(result.observations.map(({ qualifiedIdentity, validity }) =>
      `${qualifiedIdentity}:${validity}`)).toEqual([
      "alpha@official:valid",
      "zeta@community:valid",
      "zeta@community:invalid",
    ]);
    expect(result.observations[2]).toMatchObject({
      loadEligibility: "observation-only",
      declared: { scope: "workspace", installPath: "blocked", version: "3" },
      problems: ["scope-invalid"],
    });
    expect(result.observationDiagnostics).toEqual([{
      severity: "warning",
      message: 'Installed plugin record scope for "zeta@community" is unsupported',
    }]);
    expect(result.observations[0]).toMatchObject({
      lifecycleName: "alpha",
      marketplaceName: "official",
    });
    expectTypeOf<InstalledPluginObservation>().not.toMatchTypeOf<NormalizedPluginInstallation>();
  });

  it("retains valid siblings beside non-array collections and non-object records", () => {
    const result = loadPluginInstalledState(makeUserDir(JSON.stringify({
      version: 2,
      plugins: {
        "collection@official": { scope: "user" },
        "records@official": [null],
        "safe@community": [{ scope: "user", installPath: "safe", version: "1" }],
      },
    })));

    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.observations).toEqual([
      expect.objectContaining({
        qualifiedIdentity: "records@official",
        validity: "invalid",
        declared: {},
        problems: ["record-not-object"],
      }),
      expect.objectContaining({
        qualifiedIdentity: "safe@community",
        validity: "valid",
        declared: { scope: "user", installPath: "safe", version: "1" },
        problems: [],
      }),
    ]);
    expect(result.observationDiagnostics.map(({ message }) => message)).toEqual([
      'Installed plugin record for "records@official" is not an object',
      'Installed plugin records for "collection@official" are not an array',
    ]);
  });

  it("retains duplicate records, every scope, and BOM/CRLF input", () => {
    const records = [
      { scope: "managed", installPath: "managed", version: "1" },
      { scope: "user", installPath: "same", version: "1" },
      { scope: "user", installPath: "same", version: "1" },
      { scope: "project", projectPath: "/p", installPath: "project", version: "1" },
      { scope: "local", projectPath: "/p", installPath: "local", version: "1" },
    ];
    const state = `\uFEFF${JSON.stringify({ version: 2, plugins: { "demo@official": records } }, null, 2).replaceAll("\n", "\r\n")}`;
    const result = loadPluginInstalledState(makeUserDir(state));

    expect(result.status).toBe("valid");
    expect(result.observations).toHaveLength(5);
    expect(result.observations.map(({ declared }) => declared.scope).sort()).toEqual([
      "local", "managed", "project", "user", "user",
    ]);
    expect(result.observations.filter(({ declared }) => declared.installPath === "same")).toHaveLength(2);
    expect(result.installations).toHaveLength(5);
    expect(result.installations.map(({ scope }) => scope).sort()).toEqual([
      "local", "managed", "project", "user", "user",
    ]);
  });

  it("uses own keys and isolates hostile qualified identities", () => {
    const state = '{"version":2,"plugins":{"__proto__":[{"scope":"user","installPath":"bad","version":"1"}],"constructor":[{"scope":"user","installPath":"bad","version":"1"}],"safe@official":[{"scope":"user","installPath":"safe","version":"1"}]}}';
    const result = loadPluginInstalledState(makeUserDir(state));

    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.observations).toEqual([expect.objectContaining({
      qualifiedIdentity: "safe@official",
      validity: "valid",
    })]);
    expect(Object.prototype).not.toHaveProperty("scope");
  });

  it("bounds qualified identity parsing without changing the compatibility predicate", () => {
    expect(parseQualifiedPluginId("demo.plugin@market-place", 64)).toEqual({
      qualifiedIdentity: "demo.plugin@market-place",
      lifecycleName: "demo.plugin",
      marketplaceName: "market-place",
    });
    const longCompatibleIdentity = `${"a".repeat(300)}@official`;
    expect(isQualifiedPluginId(longCompatibleIdentity)).toBe(true);
    expect(parseQualifiedPluginId(longCompatibleIdentity, 256)).toBeUndefined();
    expect(parseQualifiedPluginId("demo@@official", 256)).toBeUndefined();
  });

  it("omits overlong observational identity evidence without revoking compatible authority", () => {
    const longCompatibleIdentity = `${"a".repeat(300)}@official`;
    const result = loadPluginInstalledState(makeUserDir(JSON.stringify({
      version: 2,
      plugins: {
        [longCompatibleIdentity]: [{ scope: "user", installPath: "long", version: "1" }],
        "safe@community": [{ scope: "managed", installPath: "safe", version: "2" }],
      },
    })));

    expect(result.status).toBe("valid");
    expect(result.installations.map(({ pluginId }) => pluginId)).toEqual([
      longCompatibleIdentity,
      "safe@community",
    ]);
    expect(result.observations).toEqual([expect.objectContaining({
      qualifiedIdentity: "safe@community",
      lifecycleName: "safe",
      marketplaceName: "community",
    })]);
    expect(result.observationOmissions).toEqual({ records: 1, diagnostics: 0 });
    expect(result.observationDiagnostics).toEqual([{
      severity: "warning",
      message: "Installed plugin observations omitted records with an overlong qualified identity",
    }]);
    expect(JSON.stringify(result.observationDiagnostics)).not.toContain(longCompatibleIdentity);
  });

  it("bounds scalar evidence and redacts malformed credentials and unknown values", () => {
    const credential = "user:password-canary@example.test";
    const result = loadPluginInstalledState(makeUserDir(stateWith([{
      scope: "user",
      installPath: "x".repeat(4097),
      version: "v".repeat(257),
      installedAt: { credential },
      command: `curl https://${credential}`,
      configuration: { token: credential },
    }])));

    expect(result.status).toBe("malformed");
    expect(result.installations).toEqual([]);
    expect(result.observations).toEqual([expect.objectContaining({
      validity: "invalid",
      declared: { scope: "user" },
      problems: ["install-path-invalid", "version-invalid", "installed-at-invalid"],
    })]);
    expect(JSON.stringify([...result.diagnostics, ...result.observationDiagnostics])).not.toContain(credential);
  });

  it("bounds record and diagnostic counts with deterministic omission evidence", () => {
    const validRecords = Array.from({ length: 1025 }, (_, index) => ({
      scope: "user", installPath: `root-${String(index).padStart(4, "0")}`, version: "1",
    }));
    const forward = loadPluginInstalledState(makeUserDir(stateWith(validRecords)));
    const reverse = loadPluginInstalledState(makeUserDir(stateWith([...validRecords].reverse())));
    expect(forward.status).toBe("malformed");
    expect(forward.installations).toEqual([]);
    expect(forward.observations).toHaveLength(1024);
    expect(forward.observations).toEqual(reverse.observations);
    expect(forward.observationDiagnostics).toEqual(reverse.observationDiagnostics);
    expect(forward.observationOmissions).toEqual({ records: 1, diagnostics: 0 });
    expect(reverse.observationOmissions).toEqual(forward.observationOmissions);
    expect(forward.observations.at(-1)?.declared.installPath).toBe("root-1023");
    expect(forward.observationDiagnostics.at(-1)?.message).toContain("safe record limit");

    const invalidRecords = Array.from({ length: 80 }, () => ({}));
    const diagnosticBound = loadPluginInstalledState(makeUserDir(stateWith(invalidRecords)));
    expect(diagnosticBound.observations).toHaveLength(80);
    expect(diagnosticBound.observationDiagnostics).toHaveLength(64);
    expect(diagnosticBound.observationOmissions).toEqual({ records: 0, diagnostics: 176 });
  });

  it("reads exact-limit and limit-plus-one files through bounded descriptors", () => {
    const maximumBytes = 1024 * 1024;
    const validPrefix = '{"version":2,"plugins":{}}';
    const loadTracked = (byteLength: number) => {
      const state = validPrefix + " ".repeat(byteLength - Buffer.byteLength(validPrefix));
      const userDir = makeUserDir(state);
      const requested: number[] = [];
      const consumed: number[] = [];
      const originalReadSync = fs.readSync;
      const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
        requested.push(args[3] as number);
        const result = (originalReadSync as (...readArgs: unknown[]) => number)(...args);
        consumed.push(result);
        return result;
      }) as typeof fs.readSync);
      const closeSpy = vi.spyOn(fs, "closeSync");
      try {
        const result = loadPluginInstalledState(userDir);
        return { result, requested, consumed, closeCalls: closeSpy.mock.calls.length };
      } finally {
        readSpy.mockRestore();
        closeSpy.mockRestore();
      }
    };

    const exact = loadTracked(maximumBytes);
    expect(exact.result.status).toBe("valid");
    expect(Math.max(...exact.requested)).toBe(maximumBytes + 1);
    expect(exact.consumed.reduce((sum, value) => sum + value, 0)).toBe(maximumBytes);
    expect(exact.closeCalls).toBe(1);

    const oversized = loadTracked(maximumBytes + 1);
    expect(oversized.result.status).toBe("malformed");
    expect(oversized.result.diagnostics[0]!.message).toContain("size");
    expect(Math.max(...oversized.requested)).toBe(maximumBytes + 1);
    expect(oversized.consumed.reduce((sum, value) => sum + value, 0)).toBe(maximumBytes + 1);
    expect(oversized.closeCalls).toBe(1);
  });

  it("rejects excessive nesting and file bytes before observational traversal", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 33; index++) nested = { nested };
    const excessiveNesting = loadPluginInstalledState(makeUserDir(JSON.stringify({
      version: 2, plugins: {}, unknown: nested,
    })));
    expect(excessiveNesting.status).toBe("malformed");
    expect(excessiveNesting.observations).toEqual([]);
    expect(excessiveNesting.diagnostics[0]!.message).toContain("nesting");

    const oversized = loadPluginInstalledState(makeUserDir(
      `{"version":2,"plugins":{}}${" ".repeat(1024 * 1024)}`,
    ));
    expect(oversized.status).toBe("malformed");
    expect(oversized.observations).toEqual([]);
    expect(oversized.diagnostics[0]!.message).toContain("size");
  });

  it("orders observational evidence independently of object and record order", () => {
    const alpha = [
      { scope: "user", installPath: "z", version: "2" },
      { scope: "managed", installPath: "a", version: "1" },
    ];
    const zeta = [
      { scope: "workspace", installPath: "bad", version: "3" },
      { scope: "user", installPath: "good", version: "2" },
    ];
    const first = loadPluginInstalledState(makeUserDir(JSON.stringify({
      version: 2, plugins: { "zeta@official": zeta, "alpha@official": alpha },
    })));
    const second = loadPluginInstalledState(makeUserDir(JSON.stringify({
      version: 2,
      plugins: {
        "alpha@official": [...alpha].reverse(),
        "zeta@official": [...zeta].reverse(),
      },
    })));
    expect(first.observations).toEqual(second.observations);
    expect(first.observationDiagnostics).toEqual(second.observationDiagnostics);
  });

  it("performs no writes, network access, or process startup on representative paths", () => {
    const validDir = makeUserDir(stateWith([
      { scope: "user", installPath: "root", version: "1" },
    ]));
    const malformedDir = makeUserDir(stateWith(["bad-record"]));
    const unreadableDir = makeUserDir('{"version":2,"plugins":{}}');
    const unreadablePath = path.join(unreadableDir, "plugins", "installed_plugins.json");
    const oversizedDir = makeUserDir(
      `{"version":2,"plugins":{}}${" ".repeat(1024 * 1024)}`,
    );
    const originalOpenSync = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((filePath: fs.PathLike, flags: fs.OpenMode) => {
      if (filePath === unreadablePath) throw Object.assign(new Error("private"), { code: "EACCES" });
      return originalOpenSync(filePath, flags);
    }) as typeof fs.openSync);
    const writeTraps = [
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("write attempted"); }),
      vi.spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("append attempted"); }),
      vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename attempted"); }),
      vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("unlink attempted"); }),
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("mkdir attempted"); }),
    ];
    const processTraps = [
      vi.spyOn(childProcess, "spawn").mockImplementation((() => { throw new Error("spawn attempted"); }) as typeof childProcess.spawn),
      vi.spyOn(childProcess, "spawnSync").mockImplementation((() => { throw new Error("spawnSync attempted"); }) as typeof childProcess.spawnSync),
      vi.spyOn(childProcess, "execFile").mockImplementation((() => { throw new Error("exec attempted"); }) as unknown as typeof childProcess.execFile),
      vi.spyOn(childProcess, "execFileSync").mockImplementation((() => { throw new Error("execSync attempted"); }) as typeof childProcess.execFileSync),
    ];
    const networkTraps = [
      vi.spyOn(http, "request").mockImplementation((() => { throw new Error("http attempted"); }) as typeof http.request),
      vi.spyOn(https, "request").mockImplementation((() => { throw new Error("https attempted"); }) as typeof https.request),
      vi.spyOn(net, "connect").mockImplementation((() => { throw new Error("network attempted"); }) as typeof net.connect),
    ];
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => Promise.reject(new Error("fetch attempted")));
    globalThis.fetch = fetchSpy;
    try {
      expect(loadPluginInstalledState(validDir).status).toBe("valid");
      expect(loadPluginInstalledState(malformedDir).status).toBe("malformed");
      expect(loadPluginInstalledState(unreadableDir).status).toBe("unreadable");
      expect(loadPluginInstalledState(oversizedDir).status).toBe("malformed");
      for (const trap of [...writeTraps, ...processTraps, ...networkTraps]) {
        expect(trap).not.toHaveBeenCalled();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
