import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createRetainedInputReport } from "../src/runtime/retained-input-report.js";
import {
  RetainedInputPersistenceError,
  persistRetainedInputReport,
  type RetainedInputPersistenceSession,
} from "../src/runtime/retained-input-persistence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-retained-persist-"));
  roots.push(root);
  const manager = SessionManager.create(root, root, { id: "main-owner" });
  manager.appendMessage({ role: "user", content: "seed" } as never);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }], stopReason: "stop" } as never);
  if (process.platform !== "win32") fs.chmodSync(manager.getSessionFile()!, 0o600);
  const report = createRetainedInputReport({
    agentId: "agent-123456789abc",
    sessionId: "parent-session:agent-123456789abc",
    generation: 7,
    stage: "resumed-cancellation",
    occurrences: [
      { id: 1, sessionId: "parent-session:agent-123456789abc", generation: 7, delivery: "steer", content: "duplicate" },
      { id: 2, sessionId: "parent-session:agent-123456789abc", generation: 7, delivery: "followUp", content: "duplicate" },
    ],
    guidance: "inspect effects",
  });
  return { root, manager, report };
}

describe("retained input persistence", () => {
  it("reopens and strictly verifies the bounded primary session record", () => {
    const { manager, report } = fixture();
    const locator = persistRetainedInputReport(report, { session: manager });
    expect(locator).toMatchObject({ kind: "session-entry", sessionFile: manager.getSessionFile() });
    const reopened = SessionManager.open(manager.getSessionFile()!, manager.getSessionDir(), manager.getCwd());
    const entry = reopened.getBranch().find((candidate: any) => candidate.id === (locator as any).entryId) as any;
    expect(entry.data.report.occurrences).toEqual([
      { id: 1, mode: "steer", content: "duplicate" },
      { id: 2, mode: "followUp", content: "duplicate" },
    ]);
  });

  it("accepts the production child session id shape and returns a verified primary locator", () => {
    const { manager, report } = fixture();
    expect(report.sessionId).toBe("parent-session:agent-123456789abc");
    expect(persistRetainedInputReport(report, { session: manager })).toMatchObject({
      kind: "session-entry", sessionFile: manager.getSessionFile(),
    });
  });

  it.each([
    "parent-session", "parent-session:", ":agent-session-schema", "parent:other-agent",
    `parent-${"x".repeat(300)}:agent-session-schema`, "parent\u0000session:agent-session-schema",
  ])("rejects malformed, control-bearing, or overlong child session ids: %j", (sessionId) => {
    const { manager } = fixture();
    const report = createRetainedInputReport({
      agentId: "agent-session-schema", sessionId, generation: 1, stage: "resumed-cancellation",
      occurrences: [{ id: 1, sessionId, generation: 1, delivery: "steer", content: "retained" }],
      guidance: "safe",
    });
    expect(() => persistRetainedInputReport(report, { session: manager })).toThrow(RetainedInputPersistenceError);
  });

  it("uses one restrictive exclusive atomic file after primary verification fails", () => {
    const { manager, report } = fixture();
    const session: RetainedInputPersistenceSession = {
      getSessionFile: () => manager.getSessionFile(),
      getSessionDir: () => manager.getSessionDir(),
      getCwd: () => manager.getCwd(),
      getBranch: () => manager.getBranch(),
      appendCustomEntry: () => "prospective-only",
    };
    const locator = persistRetainedInputReport(report, {
      session,
      reopenSession: () => ({ getBranch: () => [] } as RetainedInputPersistenceSession),
    });
    expect(locator.kind).toBe("recovery-file");
    const file = (locator as { kind: "recovery-file"; path: string }).path;
    expect(path.dirname(file)).toBe(fs.realpathSync.native(manager.getSessionDir()));
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(persisted.report.occurrences.map((entry: any) => [entry.id, entry.mode, entry.content])).toEqual([
      [1, "steer", "duplicate"], [2, "followUp", "duplicate"],
    ]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.readdirSync(manager.getSessionDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    "../escape", "/absolute", "C:\\drive", "\\\\server\\share", "has/slash", "has\\separator",
  ])("rejects an unsafe generated identifier without leaking retained payload: %s", (agentId) => {
    const { manager } = fixture();
    const secret = "payload-must-not-leak";
    const report = createRetainedInputReport({
      agentId, sessionId: `parent-session:${agentId}`, generation: 1, stage: "resumed-cancellation",
      occurrences: [{ id: 1, sessionId: `parent-session:${agentId}`, generation: 1, delivery: "steer", content: secret }],
      guidance: "safe",
    });
    let error: unknown;
    try { persistRetainedInputReport(report, { session: manager }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(RetainedInputPersistenceError);
    expect(String(error)).not.toContain(secret);
  });

  it("rejects incomplete, non-serializable, ephemeral, and changed-owner custody", () => {
    const { root, manager, report } = fixture();
    const incomplete = createRetainedInputReport({
      agentId: "agent-incomplete", sessionId: "parent-session:agent-incomplete", generation: 1,
      stage: "resumed-cancellation", occurrences: [], unrepresentableCount: 1, guidance: "safe",
    });
    expect(() => persistRetainedInputReport(incomplete, { session: manager })).toThrow(
      /incomplete or cannot be represented.*no durable locator/iu,
    );
    expect(() => persistRetainedInputReport(report, {
      session: { getSessionFile: () => undefined },
    })).toThrow(RetainedInputPersistenceError);

    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.jsonl`);
    fs.writeFileSync(outside, "{}\n", { mode: 0o600 });
    try {
      expect(() => persistRetainedInputReport(report, {
        session: {
          getSessionFile: () => outside,
          getSessionDir: () => root,
          getCwd: () => root,
          getBranch: () => [],
          appendCustomEntry: () => "x",
        },
      })).toThrow(RetainedInputPersistenceError);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects cyclic and over-budget payloads without exposing their content", () => {
    const { manager } = fixture();
    const cyclic: any[] = [];
    cyclic.push({ type: "text", text: "cyclic-secret", self: cyclic });
    const cyclicReport = createRetainedInputReport({
      agentId: "agent-cyclic", sessionId: "parent-session:agent-cyclic", generation: 1, stage: "resumed-cancellation",
      occurrences: [{ id: 1, sessionId: "parent-session:agent-cyclic", generation: 1, delivery: "steer", content: cyclic }],
      guidance: "safe",
    });
    const largeSecret = `large-secret-${"x".repeat(600 * 1024)}`;
    const largeReport = createRetainedInputReport({
      agentId: "agent-large", sessionId: "parent-session:agent-large", generation: 1, stage: "resumed-cancellation",
      occurrences: [{ id: 1, sessionId: "parent-session:agent-large", generation: 1, delivery: "followUp", content: largeSecret }],
      guidance: "safe",
    });
    for (const [report, secret] of [[cyclicReport, "cyclic-secret"], [largeReport, "large-secret"]] as const) {
      let error: unknown;
      try { persistRetainedInputReport(report, { session: manager }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RetainedInputPersistenceError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each(["link", "flush"] as const)("fails closed when fallback atomic %s publication fails", (failure) => {
    const { manager, report } = fixture();
    const session: RetainedInputPersistenceSession = {
      getSessionFile: () => manager.getSessionFile(), getSessionDir: () => manager.getSessionDir(),
      getCwd: () => manager.getCwd(), getBranch: () => [], appendCustomEntry: () => "unverified",
    };
    const spy = vi.spyOn(fs, failure === "link" ? "linkSync" : "fsyncSync") as any;
    spy.mockImplementation(() => { throw new Error("payload-must-not-leak"); });
    try {
      let error: unknown;
      try {
        persistRetainedInputReport(report, {
          session, reopenSession: () => ({ getBranch: () => [] } as RetainedInputPersistenceSession),
        });
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RetainedInputPersistenceError);
      expect(String(error)).not.toContain("payload-must-not-leak");
      expect(fs.readdirSync(manager.getSessionDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("rejects an original symlink but uses a restrictive fallback for a Pi-native 0644 session", () => {
    const { root, manager, report } = fixture();
    const original = manager.getSessionFile()!;
    const linked = path.join(root, "linked-session.jsonl");
    fs.symlinkSync(original, linked);
    expect(() => persistRetainedInputReport(report, {
      session: { ...manager, getSessionFile: () => linked } as never,
    })).toThrow(RetainedInputPersistenceError);

    fs.chmodSync(original, 0o644);
    let appends = 0;
    const session: RetainedInputPersistenceSession = {
      getSessionFile: () => original,
      getSessionDir: () => manager.getSessionDir(),
      getCwd: () => manager.getCwd(),
      getBranch: () => manager.getBranch(),
      appendCustomEntry: (...args) => { appends += 1; return manager.appendCustomEntry(...args); },
    };
    const locator = persistRetainedInputReport(report, { session });
    expect(appends).toBe(0);
    expect(locator).toMatchObject({ kind: "recovery-file", sessionFile: original });
    const recoveryFile = (locator as { kind: "recovery-file"; path: string }).path;
    expect(fs.statSync(original).mode & 0o777).toBe(0o644);
    expect(fs.statSync(recoveryFile).mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(recoveryFile, "utf8"))).toMatchObject({ report: {
      sessionId: report.sessionId,
      agentId: report.agentId,
    } });
  });

  it("rejects session and owner replacement at the append boundary", () => {
    for (const replace of ["session", "owner"] as const) {
      const { root, manager, report } = fixture();
      const sessionFile = manager.getSessionFile()!;
      const blocker = path.join(root, `.picc-retained-${report.agentId}-${report.generation}.json`);
      let callbackReached = false;
      let replacementCompleted = false;
      let replacementRefused = false;
      const session: RetainedInputPersistenceSession = {
        getSessionFile: () => sessionFile,
        getSessionDir: () => root,
        getCwd: () => root,
        getBranch: () => [],
        appendCustomEntry: () => {
          callbackReached = true;
          const destructiveReplacement = (operation: () => void): void => {
            try { operation(); } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "EACCES" && code !== "EBUSY" && code !== "EPERM") throw error;
              replacementRefused = true;
              fs.writeFileSync(blocker, "replacement-test-blocker", { mode: 0o600 });
              throw error;
            }
          };
          if (replace === "session") {
            const bytes = fs.readFileSync(sessionFile);
            destructiveReplacement(() => fs.unlinkSync(sessionFile));
            fs.writeFileSync(sessionFile, bytes, { mode: 0o600 });
          } else {
            const moved = `${root}-moved`;
            destructiveReplacement(() => fs.renameSync(root, moved));
            roots.push(moved);
            fs.mkdirSync(root);
            fs.copyFileSync(path.join(moved, path.basename(sessionFile)), sessionFile);
            fs.chmodSync(sessionFile, 0o600);
          }
          replacementCompleted = true;
          return "unverified";
        },
      };
      expect(() => persistRetainedInputReport(report, { session, reopenSession: (file) => ({ getSessionFile: () => file, getBranch: () => [] }) }))
        .toThrow(RetainedInputPersistenceError);
      expect(callbackReached).toBe(true);
      expect(replacementCompleted || replacementRefused).toBe(true);
      expect(replacementCompleted && replacementRefused).toBe(false);
      expect(fs.existsSync(blocker)).toBe(replacementRefused);
      if (replacementRefused) expect(fs.readFileSync(blocker, "utf8")).toBe("replacement-test-blocker");
    }
  });

  it("authenticates an exact published file on a later bounded retry", () => {
    const { manager, report } = fixture();
    const session: RetainedInputPersistenceSession = {
      getSessionFile: () => manager.getSessionFile(), getSessionDir: () => manager.getSessionDir(),
      getCwd: () => manager.getCwd(), getBranch: () => [], appendCustomEntry: () => "unverified",
    };
    const destination = path.join(manager.getSessionDir(), `.picc-retained-${report.agentId}-${report.generation}.json`);
    const canonicalDestination = path.join(
      fs.realpathSync.native(manager.getSessionDir()), path.basename(destination),
    );
    let verificationReads = 0;
    expect(() => persistRetainedInputReport(report, {
      session,
      reopenSession: (file) => ({ getSessionFile: () => file, getBranch: () => [] }),
      readRecoveryFileForVerification: () => {
        verificationReads += 1;
        return Buffer.from("mismatch");
      },
    })).toThrow(RetainedInputPersistenceError);
    expect(verificationReads).toBe(1);
    const published = fs.readFileSync(destination);
    expect(JSON.parse(published.toString("utf8"))).toMatchObject({
      version: 1,
      report: { agentId: report.agentId, sessionId: report.sessionId, generation: report.generation },
    });
    expect(persistRetainedInputReport(report, { session, reopenSession: (file) => ({ getSessionFile: () => file, getBranch: () => [] }) }))
      .toEqual({ kind: "recovery-file", sessionFile: manager.getSessionFile(), path: canonicalDestination });
    expect(fs.readFileSync(destination)).toEqual(published);
  });

  it("bounds each invocation to one primary append and one exclusive fallback attempt", () => {
    const { manager, report } = fixture();
    let appends = 0;
    const session: RetainedInputPersistenceSession = {
      getSessionFile: () => manager.getSessionFile(), getSessionDir: () => manager.getSessionDir(),
      getCwd: () => manager.getCwd(), getBranch: () => [], appendCustomEntry: () => { appends += 1; return "unverified"; },
    };
    const open = vi.spyOn(fs, "openSync");
    try {
      persistRetainedInputReport(report, { session, reopenSession: (file) => ({ getSessionFile: () => file, getBranch: () => [] }) });
      expect(appends).toBe(1);
      expect(open.mock.calls.filter(([, flags]) => typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0)).toHaveLength(1);
    } finally { open.mockRestore(); }
  });

  it("fails closed when primary and fallback both fail and leaves no success locator", () => {
    const { manager, report } = fixture();
    const blocker = path.join(manager.getSessionDir(), `.picc-retained-${report.agentId}-${report.generation}.json`);
    fs.writeFileSync(blocker, "occupied", { mode: 0o600 });
    const session: RetainedInputPersistenceSession = {
      getSessionFile: () => manager.getSessionFile(),
      getSessionDir: () => manager.getSessionDir(),
      getCwd: () => manager.getCwd(),
      getBranch: () => [],
      appendCustomEntry: () => "unverified",
    };
    expect(() => persistRetainedInputReport(report, {
      session,
      reopenSession: () => ({ getBranch: () => [] } as RetainedInputPersistenceSession),
    })).toThrow(RetainedInputPersistenceError);
    expect(fs.readFileSync(blocker, "utf8")).toBe("occupied");
  });
});
