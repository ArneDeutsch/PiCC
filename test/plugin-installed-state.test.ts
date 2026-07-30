import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginInstalledState } from "../src/claude/plugin-installed-state.js";

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
    expect(empty).toEqual({ status: "valid", installations: [], diagnostics: [] });

    expect(loadPluginInstalledState(makeUserDir())).toEqual({
      status: "absent",
      installations: [],
      diagnostics: [],
    });
  });

  it("distinguishes unreadable, unsupported-version, and malformed state", () => {
    const unreadableUserDir = makeUserDir('{"version":2,"plugins":{}}');
    const unreadablePath = path.join(unreadableUserDir, "plugins", "installed_plugins.json");
    const originalReadFileSync = fs.readFileSync;
    const thrownErrorText = "private-read-error-text";
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: unknown, ...args: unknown[]) => {
      if (filePath === unreadablePath) {
        throw Object.assign(new Error(thrownErrorText), { code: "EACCES" });
      }
      return (originalReadFileSync as (...readArgs: unknown[]) => unknown)(filePath, ...args);
    }) as typeof fs.readFileSync);
    try {
      const unreadable = loadPluginInstalledState(unreadableUserDir);
      expect(unreadable.status).toBe("unreadable");
      expect(unreadable.installations).toEqual([]);
      expect(unreadable.diagnostics).toHaveLength(1);
      expect(unreadable.diagnostics[0]).toMatchObject({ severity: "warning" });
      expect(unreadable.diagnostics[0]!.message.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(unreadable.diagnostics)).not.toContain(thrownErrorText);
    } finally {
      readSpy.mockRestore();
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
    expect(result.diagnostics[0]!.message).toContain("demo@official");
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
    ["valid", '{"version":2,"plugins":{}}', undefined],
  ] as const)("observes only the installed-state file for %s state", (status, state, errorCode) => {
    const userDir = makeUserDir();
    const statePath = path.join(userDir, "plugins", "installed_plugins.json");
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((() => {
      if (errorCode !== undefined) {
        throw Object.assign(new Error("mocked installed-state read failure"), { code: errorCode });
      }
      return state!;
    }) as unknown as typeof fs.readFileSync);
    const existsSpy = vi.spyOn(fs, "existsSync");
    const statSpy = vi.spyOn(fs, "statSync");
    const lstatSpy = vi.spyOn(fs, "lstatSync");
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    const opendirSpy = vi.spyOn(fs, "opendirSync");

    const result = loadPluginInstalledState(userDir);

    expect(result.status).toBe(status);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(statePath, "utf8");
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
});
