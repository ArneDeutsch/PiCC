import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentTrailerLine,
  isAgentId,
  mintAgentId,
  prepareSubagentTranscriptCollection,
  resolveSubagentTranscript,
  SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER,
  subagentSessionDir,
} from "../src/util/subagent-transcripts.js";
import {
  TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE,
  createAgentToolDefinition,
  createSendMessageToolDefinition,
  type PiSdk,
} from "../src/runtime/subagents.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
} from "../src/runtime/background-tasks.js";
import {
  fakeSdk,
  makeAgent,
  makeSubagentRuntime,
  useRealSessionManager,
  type FakeSessionState,
} from "./helpers/fake-sdk.js";

// These tests exercise the REAL Pi SessionManager (create/flush/open) — inject it
// so fakeSdk's default persistedSessionManager persists to disk. Kept out of a
// static fake-sdk import so builtin-agents' vi.mock factory can't deadlock.
useRealSessionManager(SessionManager);

/**
 * Persisted subagent transcripts + agent IDs: every successfully persisted dispatch leaves a
 * JSONL transcript discoverable from the main session via the hardened
 * resolver; the coordinator receives the agent ID in model-readable text; the
 * dispose→reopen round-trip is proven on the REAL Pi SessionManager.
 */

const AGENT_ID = /^agent-[0-9a-f]{12}$/;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* OS reaps temp dirs eventually */
    }
  }
});

function tempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-t02-"));
  tempDirs.push(dir);
  return dir;
}

/** A main-session transcript path shaped exactly like Pi's (need not exist). */
function fakeMainSessionFile(dir: string = tempSessionsDir()): string {
  return path.join(dir, "2026-01-01T00-00-00-000Z_0197-main-session.jsonl");
}

/** Parse a JSONL transcript into its entries. */
function readEntries(file: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

type ToolLike = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

describe("agent IDs and the hardened transcript resolver", () => {
  it("mints unique, well-formed agent IDs", () => {
    const minted = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = mintAgentId();
      expect(id).toMatch(AGENT_ID);
      expect(isAgentId(id)).toBe(true);
      minted.add(id);
    }
    expect(minted.size).toBe(200);
  });

  it("rejects everything that is not a minted ID: separators, dot-dot, absolute/drive/UNC paths, reserved names", () => {
    const main = fakeMainSessionFile();
    const hostile = [
      "",
      "..",
      "agent-..",
      "a/b",
      "agent-abcdef123456/..",
      "../agent-abcdef123456",
      "..\\agent-abcdef123456",
      "agent-abc\\def123456",
      "/etc/passwd",
      "C:\\evil",
      "C:evil",
      "\\\\srv\\share\\x",
      "CON",
      "NUL",
      "PRN.jsonl",
      "agent-CON",
      "agent-ABCDEF123456", // uppercase — not the minted form
      "agent-abcdef12345", // 11 hex
      "agent-abcdef1234567", // 13 hex
      "agent-abcdef12345g", // non-hex
      "agent-abcdef123456 ", // trailing space
    ];
    for (const id of hostile) {
      expect(() => resolveSubagentTranscript(main, id), `must reject ${JSON.stringify(id)}`).toThrow(
        /Invalid agent id/,
      );
    }
  });

  it("maps a minted ID to its transcript file (undefined before it exists, newest match after)", () => {
    const main = fakeMainSessionFile();
    const id = mintAgentId();
    expect(resolveSubagentTranscript(main, id)).toBeUndefined(); // no dir yet

    const dir = subagentSessionDir(main);
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveSubagentTranscript(main, id)).toBeUndefined(); // empty dir

    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-01-000Z_${id}.jsonl`), "{}\n");
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-02-000Z_${mintAgentId()}.jsonl`), "{}\n");
    const resolved = resolveSubagentTranscript(main, id);
    expect(resolved).toBe(path.join(dir, `2026-01-01T00-00-01-000Z_${id}.jsonl`));

    // Two transcripts for one ID (create-again edge): the newest wins.
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-03-000Z_${id}.jsonl`), "{}\n");
    expect(resolveSubagentTranscript(main, id)).toBe(
      path.join(dir, `2026-01-01T00-00-03-000Z_${id}.jsonl`),
    );
  });

  it("derives the subagents directory for Windows-shaped AND posix-shaped main-session paths", () => {
    // Windows drive-letter path — must derive correctly even on a posix host.
    expect(
      subagentSessionDir(
        "C:\\Users\\arne\\.pi\\agent\\sessions\\F--proj\\2026-01-01T00-00-00-000Z_abc.jsonl",
      ),
    ).toBe("C:\\Users\\arne\\.pi\\agent\\sessions\\F--proj\\2026-01-01T00-00-00-000Z_abc.subagents");
    // Posix path — must not be mangled by win32 semantics.
    expect(
      subagentSessionDir("/home/arne/.pi/agent/sessions/proj/2026-01-01T00-00-00-000Z_abc.jsonl"),
    ).toBe("/home/arne/.pi/agent/sessions/proj/2026-01-01T00-00-00-000Z_abc.subagents");
  });

  it("a well-formed ID against a foreign-flavor main-session path returns undefined (no throw)", () => {
    // A Windows-shaped main path on a posix host (or vice versa): the derived
    // subagents dir does not exist, so the resolver returns undefined cleanly —
    // the throw is reserved for a MALFORMED agent id, not a missing directory.
    const id = mintAgentId();
    const winPath =
      "C:\\Users\\arne\\.pi\\agent\\sessions\\F--proj\\2026-01-01T00-00-00-000Z_main.jsonl";
    const posixPath = "/home/arne/.pi/agent/sessions/proj/2026-01-01T00-00-00-000Z_main.jsonl";
    expect(() => resolveSubagentTranscript(winPath, id)).not.toThrow();
    expect(resolveSubagentTranscript(winPath, id)).toBeUndefined();
    expect(() => resolveSubagentTranscript(posixPath, id)).not.toThrow();
    expect(resolveSubagentTranscript(posixPath, id)).toBeUndefined();
  });
});

describe("collection ownership admission", () => {
  it("gates ordinary persistence before its factory and degrades with recovery guidance", async () => {
    const sessions = tempSessionsDir();
    const parent = SessionManager.create(sessions, sessions, { id: "main-order" });
    parent.appendMessage({ role: "user", content: "parent" } as never);
    parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const parentFile = parent.getSessionFile()!;
    const h = fakeSdk({ replies: ["done"] });
    let calls = 0;
    const sdk: PiSdk = {
      ...h.sdk,
      persistedSessionManager: (cwd, directory, id) => {
        calls++;
        expect(fs.existsSync(path.join(directory, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER))).toBe(true);
        return h.sdk.persistedSessionManager!(cwd, directory, id);
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], sdk, {
      getMainSessionFile: () => parentFile,
      prepareTranscriptCollection: undefined,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("refuses every unsafe marker state before the ordinary persistence factory", async () => {
    const assertSafeOwnershipRecovery = (message: string | undefined) => {
      expect(message).toContain(TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE);
      expect(message).not.toMatch(
        /repair|readable (?:ownership )?marker|ownership marker.{0,20}readable|reconcile (?:transcript )?ownership|restart PiCC/i,
      );
      const messageWithoutSafeGuidance = message?.replace(TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE, "");
      expect(messageWithoutSafeGuidance).not.toMatch(
        /(?:edit|delete|remove).{0,60}ownership marker|ownership marker.{0,60}(?:edit|delete|remove)|(?:delete|remove|clean|discard).{0,60}(?:transcript|collection|data)|(?:transcript|collection|data).{0,60}(?:delete|remove|clean|discard)/i,
      );
      expect(message).not.toMatch(
        /new (?:main )?session.{0,80}(?:cleans?|deletes?|removes?|discards?)/i,
      );
    };
    const cases = ["malformed", "oversized", "unreadable", "mismatch", "linked", "EEXIST"] as const;
    for (const kind of cases) {
      const sessions = tempSessionsDir();
      const parent = SessionManager.create(sessions, sessions, { id: `main-${kind}` });
      parent.appendMessage({ role: "user", content: "parent" } as never);
      parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
      const parentFile = parent.getSessionFile()!;
      const directory = subagentSessionDir(parentFile);
      const marker = path.join(directory, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
      fs.mkdirSync(directory);
      if (kind !== "EEXIST") {
        fs.writeFileSync(marker, kind === "malformed" ? "not-json\n"
          : kind === "oversized" ? "x".repeat(4097)
            : "{}\n");
      }
      const prepare = () => prepareSubagentTranscriptCollection(parentFile, kind === "unreadable" ? {
        open: (file, flags) => {
          if (file === marker) throw Object.assign(new Error("denied"), { code: "EACCES" });
          return fs.openSync(file, flags);
        },
      } : kind === "linked" ? {
        lstat: (file) => {
          const stat = fs.lstatSync(file);
          return file === marker
            ? { ...stat, isFile: () => true, isSymbolicLink: () => true } as fs.Stats
            : stat;
        },
      } : kind === "EEXIST" ? {
        writeFile: (file, data, options) => {
          fs.writeFileSync(file, "{}\n", { encoding: "utf8", flag: "wx", mode: options.mode });
          throw Object.assign(new Error("raced"), { code: "EEXIST" });
        },
      } : {});
      const admission = prepare();
      expect(admission.ok, kind).toBe(false);
      const markerAfterAdmission = fs.readFileSync(marker, "utf8");
      const h = fakeSdk({ replies: ["in memory"] });
      let factoryCalls = 0;
      const sdk: PiSdk = {
        ...h.sdk,
        persistedSessionManager: (...args) => {
          factoryCalls++;
          return h.sdk.persistedSessionManager!(...args);
        },
      };
      const runtime = makeSubagentRuntime([makeAgent()], sdk, {
        getMainSessionFile: () => parentFile,
        prepareTranscriptCollection: () => admission,
      });
      const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
      expect(result.ok).toBe(true);
      expect(result.resumable).toBe(false);
      expect(factoryCalls).toBe(0);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
      expect(fs.readFileSync(marker, "utf8")).toBe(markerAfterAdmission);
      const ordinaryDiagnostic = result.diagnostics.find((diagnostic) =>
        diagnostic.message.includes("persistence was skipped") &&
        diagnostic.message.includes("in-memory and non-resumable"));
      expect(ordinaryDiagnostic, kind).toBeDefined();
      assertSafeOwnershipRecovery(ordinaryDiagnostic?.message);

      const forkHandle = fakeSdk({ replies: ["fresh"] });
      let forkFactoryCalls = 0;
      const forkSdk: PiSdk = {
        ...forkHandle.sdk,
        forkSessionManager: (...args) => {
          forkFactoryCalls++;
          return forkHandle.sdk.forkSessionManager!(...args);
        },
      };
      const forkRuntime = makeSubagentRuntime([], forkSdk, {
        getMainSessionFile: () => parentFile,
        prepareTranscriptCollection: () => admission,
      });
      const forkResult = await forkRuntime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
      expect(forkResult.ok).toBe(true);
      expect(forkResult.isFork).toBe(false);
      expect(forkFactoryCalls).toBe(0);
      const forkDiagnostic = forkResult.diagnostics.find((diagnostic) =>
        diagnostic.message.startsWith("fork ran with fresh context:"));
      expect(forkDiagnostic, kind).toBeDefined();
      assertSafeOwnershipRecovery(forkDiagnostic?.message);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    }
  });
  it("bounds parent-header and marker reads at the descriptor operation", () => {
    const sessions = tempSessionsDir();
    const parent = SessionManager.create(sessions, sessions, { id: "main-bounded" });
    parent.appendMessage({ role: "user", content: "parent" } as never);
    parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const parentFile = parent.getSessionFile()!;
    expect(prepareSubagentTranscriptCollection(parentFile).ok).toBe(true);
    const requested: number[] = [];
    const second = prepareSubagentTranscriptCollection(parentFile, {
      read: (fd, buffer, offset, length, position) => {
        requested.push(length);
        return fs.readSync(fd, buffer, offset, length, position);
      },
    });
    expect(second.ok).toBe(true);
    expect(requested).toEqual([16 * 1024 + 1, 4096 + 1]);
  });

  it("creates stable non-plaintext ownership evidence and leaves a matching marker unchanged", () => {
    const sessions = tempSessionsDir();
    const cwd = fs.mkdtempSync(path.join(sessions, "cwd-"));
    const parent = SessionManager.create(cwd, sessions, { id: "main-owned" });
    parent.appendMessage({ role: "user", content: "parent" } as never);
    parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const parentFile = parent.getSessionFile()!;
    const first = prepareSubagentTranscriptCollection(parentFile);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const marker = path.join(first.directory, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    const before = fs.readFileSync(marker, "utf8");
    expect(before).toContain('"version":1');
    expect(before).toContain(path.basename(parentFile));
    expect(before).not.toContain(cwd);
    expect(prepareSubagentTranscriptCollection(parentFile)).toEqual(first);
    expect(fs.readFileSync(marker, "utf8")).toBe(before);
  });

  it("refuses malformed, mismatched, and linked markers without overwriting them", () => {
    const kinds: Array<"malformed" | "mismatch" | "linked"> = ["malformed", "mismatch"];
    if (process.platform !== "win32") kinds.push("linked");
    for (const kind of kinds) {
      const sessions = tempSessionsDir();
      const parent = SessionManager.create(sessions, sessions, { id: `main-${kind}` });
      parent.appendMessage({ role: "user", content: "parent" } as never);
      parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
      const parentFile = parent.getSessionFile()!;
      const directory = subagentSessionDir(parentFile);
      fs.mkdirSync(directory);
      const marker = path.join(directory, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
      const target = path.join(sessions, `target-${kind}`);
      if (kind === "linked") {
        fs.writeFileSync(target, "foreign\n");
        fs.symlinkSync(target, marker, "file");
      } else {
        fs.writeFileSync(marker, kind === "malformed" ? "not-json\n" : '{"version":1}\n');
      }
      const before = kind === "linked" ? fs.readFileSync(target, "utf8") : fs.readFileSync(marker, "utf8");
      expect(prepareSubagentTranscriptCollection(parentFile).ok).toBe(false);
      expect(kind === "linked" ? fs.readFileSync(target, "utf8") : fs.readFileSync(marker, "utf8")).toBe(before);
    }
  });
});

describe("dispatch persists a transcript (real Pi SessionManager)", () => {
  it("a completed dispatch leaves a marked JSONL transcript named by the agent ID", async () => {
    const sessions = tempSessionsDir();
    const parent = SessionManager.create(sessions, sessions, { id: "main-dispatch" });
    parent.appendMessage({ role: "user", content: "parent" } as never);
    parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const main = parent.getSessionFile()!;
    const h = fakeSdk({ replies: ["the review verdict"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
      prepareTranscriptCollection: prepareSubagentTranscriptCollection,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "review it", depth: 1 });

    expect(result.ok).toBe(true);
    expect(result.agentId).toMatch(AGENT_ID);
    expect(result.resumable).toBe(true);
    expect(result.transcriptPath).toBeDefined();
    expect(path.dirname(path.resolve(result.transcriptPath!))).toBe(
      path.resolve(subagentSessionDir(main)),
    );
    expect(path.basename(result.transcriptPath!)).toContain(`_${result.agentId}.jsonl`);
    expect(fs.existsSync(result.transcriptPath!)).toBe(true);
    expect(fs.existsSync(path.join(subagentSessionDir(main), SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER))).toBe(true);

    // The transcript carries the run: Pi session header (id = agent ID) + turns.
    const entries = readEntries(result.transcriptPath!);
    const header = entries.find((e) => e.type === "session");
    expect(header?.id).toBe(result.agentId);
    const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
    expect(messages.some((m) => m.role === "user" && String(m.content).includes("review it"))).toBe(
      true,
    );
    expect(JSON.stringify(messages)).toContain("the review verdict");

    // The exported resolver maps the ID back to exactly this file.
    const resolved = resolveSubagentTranscript(main, result.agentId);
    expect(path.resolve(resolved!)).toBe(path.resolve(result.transcriptPath!));
  });

  it("parallel dispatches get distinct IDs and distinct transcripts under one main session", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["one", "two"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const [r1, r2] = await Promise.all([
      runtime.dispatch({ subagentType: "reviewer", prompt: "a", depth: 1 }),
      runtime.dispatch({ subagentType: "reviewer", prompt: "b", depth: 1 }),
    ]);
    expect(r1.agentId).not.toBe(r2.agentId);
    expect(r1.transcriptPath).not.toBe(r2.transcriptPath);
    expect(path.resolve(resolveSubagentTranscript(main, r1.agentId)!)).toBe(
      path.resolve(r1.transcriptPath!),
    );
    expect(path.resolve(resolveSubagentTranscript(main, r2.agentId)!)).toBe(
      path.resolve(r2.transcriptPath!),
    );
  });

  it("dispose→reopen round-trip: the transcript reopens with the prior messages intact and accepts appends", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["first answer"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "the task", depth: 1 });
    expect(result.resumable).toBe(true);
    // dispatch() disposed the session in its finally — reopen from disk alone.
    const reopened = SessionManager.open(result.transcriptPath!);
    expect(reopened.getSessionId()).toBe(result.agentId);
    const ctx = reopened.buildSessionContext();
    const texts = JSON.stringify(ctx.messages);
    expect(ctx.messages.length).toBeGreaterThanOrEqual(2);
    expect(texts).toContain("the task");
    expect(texts).toContain("first answer");

    // Resume-append (the resume write path): append through the reopened manager,
    // reopen AGAIN, and see all four messages — proving the file stays a valid,
    // appendable Pi session across close/reopen cycles.
    reopened.appendMessage({ role: "user", content: "follow-up question" } as never);
    reopened.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "follow-up answer" }],
      stopReason: "stop",
    } as never);
    const third = SessionManager.open(result.transcriptPath!);
    const resumed = third.buildSessionContext();
    expect(resumed.messages.length).toBe(ctx.messages.length + 2);
    expect(JSON.stringify(resumed.messages)).toContain("follow-up answer");
  });

  it("a failed run's transcript persists too (partial work is inspectable) and stays resumable", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half the work" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 quota exceeded",
        });
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.outcome).toBe("failed");
    expect(result.resumable).toBe(true);
    expect(fs.existsSync(result.transcriptPath!)).toBe(true);
    expect(fs.readFileSync(result.transcriptPath!, "utf8")).toContain("half the work");
  });

  it("built-in Explore/Plan persist a transcript but are flagged non-resumable; a project agent named Explore is resumable", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["explored", "planned", "project-explored"] });
    const runtime = makeSubagentRuntime([], h.sdk, { getMainSessionFile: () => main });
    const explore = await runtime.dispatch({ subagentType: "Explore", prompt: "look", depth: 1 });
    expect(explore.ok).toBe(true);
    expect(explore.resumable).toBe(false); // one-shot builtin
    expect(explore.agentId).toMatch(AGENT_ID); // still identified…
    expect(fs.existsSync(explore.transcriptPath!)).toBe(true); // …and observable

    const plan = await runtime.dispatch({ subagentType: "Plan", prompt: "plan", depth: 1 });
    expect(plan.resumable).toBe(false);

    // A same-named PROJECT agent overrides the builtin and is a normal agent.
    const projectRuntime = makeSubagentRuntime([makeAgent({ name: "Explore" })], h.sdk, {
      getMainSessionFile: () => main,
    });
    const overridden = await projectRuntime.dispatch({
      subagentType: "Explore",
      prompt: "look",
      depth: 1,
    });
    expect(overridden.resumable).toBe(true);
  });

  it("a caller-provided agent ID is reused verbatim (stability across resumes)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["ok"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      agentId: "agent-aabbccddeeff",
    });
    expect(result.agentId).toBe("agent-aabbccddeeff");
    expect(path.basename(result.transcriptPath!)).toContain("_agent-aabbccddeeff.jsonl");
  });

  it("a hostile/malformed caller-provided agent ID fails the dispatch loudly (hardening)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["should never run"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    for (const hostile of ["../evil", "agent-../x", "agent-ABCDEF123456", "agent-xyz"]) {
      const result = await runtime.dispatch({
        subagentType: "reviewer",
        prompt: "p",
        depth: 1,
        agentId: hostile,
      });
      expect(result.ok, `must reject ${hostile}`).toBe(false);
      expect(result.outcome).toBe("failed");
      expect(result.resumable).toBe(false);
      expect(result.error).toContain(JSON.stringify(hostile));
      // Never minted-over-and-run, never passed through to disk.
      expect(result.transcriptPath).toBeUndefined();
    }
    // The session is never even created for a rejected id.
    expect(h.sessions).toHaveLength(0);
  });

  it("degrades to in-memory with a diagnostic when the main session file is unknown (print/no-session edge)", async () => {
    const h = fakeSdk({ replies: ["still works"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // no getMainSessionFile
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true); // dispatch MUST succeed
    expect(result.finalMessage).toBe("still works");
    expect(result.resumable).toBe(false);
    expect(result.transcriptPath).toBeUndefined();
    expect(
      result.diagnostics.some(
        (d) => d.severity === "info" && d.message.includes("not persisted"),
      ),
    ).toBe(true);
  });

  it("degrades to in-memory with a WARNING when transcript creation itself fails", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["survived"] });
    const sdk: PiSdk = {
      ...h.sdk,
      persistedSessionManager: () => {
        throw new Error("disk full (simulated)");
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { getMainSessionFile: () => main });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("survived");
    expect(result.resumable).toBe(false);
    expect(result.transcriptPath).toBeUndefined();
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("disk full (simulated)"),
      ),
    ).toBe(true);
  });

  it("degrades with a diagnostic when the SDK lacks persistedSessionManager entirely", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["legacy sdk ok"] });
    const sdk: PiSdk = { ...h.sdk, persistedSessionManager: undefined };
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { getMainSessionFile: () => main });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.resumable).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("unavailable in this SDK"))).toBe(true);
  });
});

describe("fork inheritance on the REAL Pi SessionManager", () => {
  // Fork inheritance defaults to ENABLED; ensure the gate is unset for these
  // tests (process.env is global within a file — a sibling test could set it).
  afterEach(() => {
    delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
  });

  /** Seed a REAL parent transcript with a unique token; return {file, token}. */
  function seedParentTranscript(): { file: string; token: string; sessionsDir: string } {
    const sessionsDir = tempSessionsDir();
    const token = `PARENT-TOKEN-${mintAgentId()}`;
    const parent = SessionManager.create(sessionsDir, sessionsDir, { id: "0197-main-session" });
    parent.appendMessage({ role: "user", content: `the parent said: ${token}` } as never);
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "understood" }],
      stopReason: "stop",
    } as never);
    const file = parent.getSessionFile()!;
    expect(fs.existsSync(file)).toBe(true);
    return { file, token, sessionsDir };
  }

  it("a depth-1 fork seeds the child with the parent's full history (genuine inheritance)", async () => {
    const { file: parentFile, token } = seedParentTranscript();
    const h = fakeSdk({ replies: ["the fork's own verbatim answer"] });
    const sdk: PiSdk = {
      ...h.sdk,
      forkSessionManager: (source, cwd, directory, id) => {
        expect(fs.existsSync(path.join(directory, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER))).toBe(true);
        return h.sdk.forkSessionManager!(source, cwd, directory, id);
      },
    };
    const runtime = makeSubagentRuntime([], sdk, {
      getMainSessionFile: () => parentFile,
      prepareTranscriptCollection: undefined,
    });
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "continue", depth: 1 });

    expect(result.ok).toBe(true);
    expect(result.isFork).toBe(true);
    expect(result.resumable).toBe(false);
    expect(result.transcriptPath).toBeDefined();
    // The fork's OWN transcript is a NEW file in the subagents sibling dir.
    expect(path.resolve(result.transcriptPath!)).not.toBe(path.resolve(parentFile));
    expect(path.dirname(path.resolve(result.transcriptPath!))).toBe(
      path.resolve(subagentSessionDir(parentFile)),
    );
    expect(fs.existsSync(path.join(subagentSessionDir(parentFile), SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER))).toBe(true);
    // Reopen the fork's own file from disk: it carries the inherited parent token.
    const reopened = SessionManager.open(result.transcriptPath!);
    const texts = JSON.stringify(reopened.buildSessionContext().messages);
    expect(texts).toContain(token);
    // …and the fork's own reply (output isolation keeps intermediate turns local,
    // but the child transcript itself records the whole run).
    expect(texts).toContain("the fork's own verbatim answer");
    // Only the fork's final assistant message returns to the parent.
    expect(result.finalMessage).toBe("the fork's own verbatim answer");
  });

  it("forking NEVER modifies the parent transcript (no reopen-in-place)", async () => {
    const { file: parentFile } = seedParentTranscript();
    const before = readEntries(parentFile);
    const h = fakeSdk({ replies: ["done"] });
    const runtime = makeSubagentRuntime([], h.sdk, { getMainSessionFile: () => parentFile });
    await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    const after = readEntries(parentFile);
    // Byte-for-byte identical: the fork wrote a brand-new file, not the parent's.
    expect(after).toEqual(before);
  });

  it("a fork is non-resumable and SendMessage refuses it cleanly (persisted transcript notwithstanding)", async () => {
    const { file: parentFile } = seedParentTranscript();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const h = fakeSdk({ replies: ["ok"] });
    const runtime = makeSubagentRuntime([], h.sdk, {
      getMainSessionFile: () => parentFile,
      subagentRegistry: registry,
    });
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    // Persisted-transcript posture (a real child file exists) yet non-resumable.
    expect(result.transcriptPath).toBeDefined();
    expect(fs.existsSync(result.transcriptPath!)).toBe(true);
    expect(result.resumable).toBe(false);

    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as {
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(sm.execute("s", { to: result.agentId, message: "follow up" })).rejects.toThrow(
      /not resumable/i,
    );
  });
});

describe("model-visible agent-ID delivery", () => {
  it("foreground content of a RESUMABLE agent = verbatim message + delimited ID trailer", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["```yaml\nverdict: approve\n```"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    const agentId = String(res.details.agentId);
    expect(agentId).toMatch(AGENT_ID);
    // Verbatim message first, then the clearly delimited harness trailer.
    expect(text.startsWith("```yaml\nverdict: approve\n```")).toBe(true);
    expect(text.endsWith(`\n\n---\n[agent ${agentId} completed — resumable via SendMessage]`)).toBe(
      true,
    );
    expect(text).toBe(
      "```yaml\nverdict: approve\n```" +
        `\n\n---\n${agentTrailerLine(agentId, { completed: true })}`,
    );
    // details carries the structured copy for logs/UI.
    expect(res.details.resumable).toBe(true);
    expect(String(res.details.transcriptPath)).toContain(agentId);
  });

  it("no trailer for one-shot builtins (Explore) — the content stays fully verbatim", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["EXPLORE-FINDINGS"] });
    const runtime = makeSubagentRuntime([], h.sdk, { getMainSessionFile: () => main });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "Explore", prompt: "p" });
    expect(res.content[0]!.text).toBe("EXPLORE-FINDINGS");
    expect(res.details.resumable).toBe(false);
  });

  it("no trailer for the in-memory fallback — non-resumable IDs are never advertised", async () => {
    const h = fakeSdk({ replies: ["plain answer"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // in-memory fallback
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    expect(res.content[0]!.text).toBe("plain answer");
    expect(res.details.resumable).toBe(false);
  });

  it("the cut-off path preserves partial output and carries state-aware resume guidance", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half a review" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "503 died",
        });
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    const agentId = String(res.details.agentId);
    expect(text.startsWith("half a review")).toBe(true);
    expect(text).toContain("[subagent cut off]");
    expect(text).toContain("Resume this same agent with SendMessage");
    expect(text).toContain(`Failed agent ID: ${agentId}.`);
    expect(res.details.cutOff).toBe(true);
  });

  it("background start message and TaskOutput both carry the agent ID", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["BG-VERBATIM-RESULT"] });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    expect(agentId).toMatch(AGENT_ID);
    // The start message is the model-visible channel for background dispatches.
    expect(started.content[0]!.text).toContain(`agent id: ${agentId}`);

    const taskId = String(started.details.taskId);
    const record = await registry.wait(taskId);
    expect(record?.agentId).toBe(agentId); // pre-minted ID matches the settled result
    expect(record?.resumable).toBe(true);
    expect(String(record?.transcriptPath)).toContain(agentId);

    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    const text = out.content[0]!.text;
    expect(text.startsWith("BG-VERBATIM-RESULT")).toBe(true);
    expect(text.endsWith(`\n\n---\n[agent ${agentId} completed — resumable via SendMessage]`)).toBe(
      true,
    );
    expect(out.details.agentId).toBe(agentId);
  });

  it("TaskOutput of a failed-but-resumable background task gives same-agent recovery guidance", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "progress so far" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "500 exploded",
        });
      },
    });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    const text = out.content[0]!.text;
    expect(out.details.status).toBe("failed");
    expect(text).toContain("500 exploded");
    expect(text).toContain("Resume this same agent with SendMessage");
    expect(text).toContain(`Failed agent ID: ${agentId}.`);
    expect(text).toContain("This agent is technically resumable via SendMessage.");
  });

  it("a NON-resumable failed-with-partial (cut-off) foreground run shows the cut-off but no resume channel", async () => {
    // In-memory fallback (no getMainSessionFile) → non-resumable, WITH partial
    // output: the tool takes the cut-off-with-partial path but must NOT advertise
    // a resume channel (guards the `resumable ? … : …` gate against a flip).
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half a review" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "503 died",
        });
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // in-memory fallback
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    expect(res.details.outcome).toBe("failed");
    expect(res.details.resumable).toBe(false);
    expect(text).toContain("half a review");
    expect(text).toContain("[subagent cut off]");
    expect(text).toContain("same-agent continuation is unavailable");
    expect(text).toContain("not resumable via SendMessage");
  });

  it("a NON-resumable failed-with-partial background task explains unavailable continuation", async () => {
    // Same as above via TaskOutput: guidance must report actual capability
    // without presenting same-agent continuation as available.
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "progress so far" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "500 exploded",
        });
      },
    });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // in-memory fallback
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    const text = out.content[0]!.text;
    expect(out.details.status).toBe("failed");
    expect(out.details.resumable).toBe(false);
    expect(text).toContain("failed");
    expect(text).toContain("500 exploded");
    expect(text).toContain("same-agent continuation is unavailable");
    expect(text).toContain("This agent is not resumable via SendMessage.");
    expect(text).not.toContain("This agent is technically resumable via SendMessage.");
  });

  it("a zero-progress transient failure prefers replacement and reports actual resumability", async () => {
    const failNoPartial = () =>
      fakeSdk({
        onPrompt: (_t: string, s: FakeSessionState) => {
          // Terminal error with NO assistant text produced → empty finalMessage,
          // so the tool takes the throw path (not the cut-off-with-partial path).
          s.messages.push({
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 dead",
          });
        },
      });

    // Resumable (persisted): replacement preference stays separate from capability.
    const main = fakeMainSessionFile();
    const runtimeR = makeSubagentRuntime([makeAgent()], failNoPartial().sdk, {
      getMainSessionFile: () => main,
    });
    const toolR = createAgentToolDefinition(runtimeR, { depth: 0 }) as unknown as ToolLike;
    let resumableMsg = "";
    try {
      await toolR.execute("t", { subagent_type: "reviewer", prompt: "p" });
    } catch (e) {
      resumableMsg = (e as Error).message;
    }
    expect(resumableMsg).toContain("API error");
    expect(resumableMsg).toContain("Prefer explicitly dispatching a fresh replacement agent");
    expect(resumableMsg).toMatch(/Failed agent ID: agent-[0-9a-f]{12}\./);
    expect(resumableMsg).toContain("technically resumable via SendMessage");

    // Non-resumable (in-memory fallback): replacement guidance still reports
    // that the failed identity cannot be resumed.
    const runtimeN = makeSubagentRuntime([makeAgent()], failNoPartial().sdk); // no getMainSessionFile
    const toolN = createAgentToolDefinition(runtimeN, { depth: 0 }) as unknown as ToolLike;
    let nonResumableMsg = "";
    try {
      await toolN.execute("t", { subagent_type: "reviewer", prompt: "p" });
    } catch (e) {
      nonResumableMsg = (e as Error).message;
    }
    expect(nonResumableMsg).toContain("API error");
    expect(nonResumableMsg).toContain("Prefer explicitly dispatching a fresh replacement agent");
    expect(nonResumableMsg).toContain("not resumable via SendMessage");
  });

  it("a truncated COMPLETED run rides the ID trailer INSIDE the single cut-off frame (no double ---)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: [{ text: "partial answer", stopReason: "length" }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    const agentId = String(res.details.agentId);
    expect(res.details.outcome).toBe("completed");
    expect(text).toContain("[subagent cut off]");
    // Exactly ONE `---` frame; the trailer is an extra line inside it.
    expect(text.split("\n\n---\n")).toHaveLength(2);
    expect(text.endsWith(`\n[agent ${agentId} — resumable via SendMessage]`)).toBe(true);
    expect(text).not.toContain(`\n\n---\n[agent ${agentId}`);
  });

  it("a truncated COMPLETED background task rides the trailer inside the single frame too", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: [{ text: "bg partial", stopReason: "length" }] });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    const text = out.content[0]!.text;
    expect(out.details.status).toBe("completed");
    expect(text).toContain("[subagent cut off]");
    expect(text.split("\n\n---\n")).toHaveLength(2);
    expect(text.endsWith(`\n[agent ${agentId} — resumable via SendMessage]`)).toBe(true);
  });

  it("a one-shot builtin (Explore) background start message includes the agent id; a resumable one keeps it", async () => {
    const main = fakeMainSessionFile();
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([], fakeSdk({ replies: ["explored"] }).sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "Explore",
      prompt: "look",
      run_in_background: true,
    });
    // The id is model-visible at the start-message surface for EVERY
    // background task, one-shot builtins included (the old suppression is gone).
    const agentId = String(started.details.agentId);
    expect(started.content[0]!.text).toContain(`agent id: ${agentId}`);
    expect(started.content[0]!.text).toContain("agent: Explore");
    expect(agentId).toMatch(AGENT_ID);

    // A resumable (non-builtin) background dispatch DOES advertise its id.
    const runtime2 = makeSubagentRuntime([makeAgent()], fakeSdk({ replies: ["r"] }).sdk, {
      getMainSessionFile: () => main,
    });
    const tool2 = createAgentToolDefinition(runtime2, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started2 = await tool2.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    expect(started2.content[0]!.text).toContain("agent id:");
  });
});

describe("subagent hooks carry agent_id/agent_type; transcript_path stays = main (parity)", () => {
  it("agent-scoped hook runners are NOT re-pointed to the subagent transcript (Claude Code parity)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["done"] });
    // The runtime must construct the scoped runner WITHOUT a subagent-transcript
    // getter (no second argument) — the runner then keeps the MAIN session
    // transcript_path (index.ts fallback). Re-pointing it at the subagent's own
    // file would violate Claude Code parity (review round 2).
    const optsSeen: Array<unknown> = [];
    const makeScopedHookRunner = (_config: Record<string, unknown>, ...rest: unknown[]) => {
      optsSeen.push(rest[0]);
      return {
        fire: async () => ({ block: false, askDowngraded: false, diagnostics: [] }),
      };
    };
    const agent = makeAgent({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check", raw: {} }] }] },
    });
    const runtime = makeSubagentRuntime([agent], h.sdk, {
      getMainSessionFile: () => main,
      makeScopedHookRunner: makeScopedHookRunner as never,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(optsSeen).toHaveLength(1);
    // No opts argument was passed → the scoped runner falls back to the main
    // transcript, never the subagent's own.
    expect(optsSeen[0]).toBeUndefined();
    expect(result.transcriptPath).toBeDefined();
  });

  it("SubagentStart and SubagentStop payloads carry agent_id + agent_type and NEVER the subagent transcript_path (parity)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["done"] });
    const fired: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const hookRunner = {
      fire: async (event: string, payload: Record<string, unknown>) => {
        fired.push({ event, payload });
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
      hookRunner,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const start = fired.find((f) => f.event === "SubagentStart");
    const stop = fired.find((f) => f.event === "SubagentStop");
    // Both the type and the id ride on both events (Claude Code hook input parity).
    expect(start?.payload.subagent_type).toBe("reviewer");
    expect(start?.payload.agent_id).toBe(result.agentId);
    expect(start?.payload.agent_type).toBe("reviewer");
    expect(stop?.payload.subagent_type).toBe("reviewer");
    expect(stop?.payload.agent_id).toBe(result.agentId);
    expect(stop?.payload.agent_type).toBe("reviewer");
    // Parity (Claude Code, review round 2): PiCC does NOT clobber transcript_path
    // on subagent hook payloads — neither Start nor Stop carries the subagent's
    // own transcript. The MAIN transcript_path is supplied by the HookRunner's
    // own constructed default (exercised directly in hooks.test.ts), not injected
    // into the payload here.
    expect(start?.payload.transcript_path).toBeUndefined();
    expect(stop?.payload.transcript_path).toBeUndefined();
  });

  it("Pre- and PostToolUse hooks fired from INSIDE the dispatch carry agent_id + agent_type (central injection)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["done"] });
    const fired: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const hookRunner = {
      fire: async (event: string, payload: Record<string, unknown>) => {
        fired.push({ event, payload });
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
      hookRunner,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    // The guard extension the dispatch installed fires PreToolUse through the
    // SAME (identity-injected) runner as Subagent{Start,Stop}. Retrieve it from
    // the created session's resource loader and drive one tool_call.
    const loaderOptions = (h.created[0]!.resourceLoader as { options: Record<string, unknown> })
      .options;
    const factories = loaderOptions.extensionFactories as Array<{
      name: string;
      factory: (pi: unknown) => unknown;
    }>;
    const guardFactory = factories.find((f) => f.name.startsWith("picc-guard-"))!.factory;
    let toolCallHandler: ((event: unknown) => unknown) | undefined;
    let toolResultHandler: ((event: unknown) => unknown) | undefined;
    guardFactory({
      on: (event: string, handler: (event: unknown) => unknown) => {
        if (event === "tool_call") toolCallHandler = handler;
        if (event === "tool_result") toolResultHandler = handler;
      },
      sendMessage: () => {},
    });
    await toolCallHandler!({ toolName: "Read", input: { file_path: "x" }, toolCallId: "tc1" });
    const pre = fired.find((f) => f.event === "PreToolUse");
    expect(pre).toBeDefined();
    expect(pre?.payload.agent_id).toBe(result.agentId);
    expect(pre?.payload.agent_type).toBe("reviewer");
    // The SAME injectIdentity choke point covers PostToolUse (tool_result):
    // a non-error result fires PostToolUse through the identity-injected runner.
    await toolResultHandler!({
      toolName: "Read",
      input: { file_path: "x" },
      toolCallId: "tc1",
      content: [{ type: "text", text: "file body" }],
      isError: false,
    });
    const post = fired.find((f) => f.event === "PostToolUse");
    expect(post).toBeDefined();
    expect(post?.payload.agent_id).toBe(result.agentId);
    expect(post?.payload.agent_type).toBe("reviewer");
  });
});
