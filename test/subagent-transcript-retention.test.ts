import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { reapSubagentTranscripts } from "../src/runtime/subagent-transcript-retention.js";
import {
  SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER,
  hashCanonicalPath,
  prepareSubagentTranscriptCollection,
  subagentSessionDir,
} from "../src/util/subagent-transcripts.js";

const roots: string[] = [];
const NOW = Date.UTC(2026, 0, 31);
const OLD = new Date(NOW - 31 * 86_400_000);
const FRESH = new Date(NOW - 30 * 86_400_000);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-reaper-"));
  roots.push(root);
  const cwd = fs.mkdtempSync(path.join(root, "cwd-"));
  const active = SessionManager.create(cwd, root, { id: `active-${roots.length}` });
  active.appendMessage({ role: "user", content: "active" } as never);
  active.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
  const activeFile = active.getSessionFile()!;
  const main = SessionManager.create(cwd, root, { id: `main-${roots.length}` });
  main.appendMessage({ role: "user", content: "x" } as never);
  main.appendMessage({ role: "assistant", content: [{ type: "text", text: "y" }], stopReason: "stop" } as never);
  const mainFile = main.getSessionFile()!;
  const prepared = prepareSubagentTranscriptCollection(mainFile);
  if (!prepared.ok) throw new Error(prepared.diagnostic.message);
  const child = SessionManager.create(cwd, prepared.directory, { id: "agent-abcdef123456" });
  child.appendMessage({ role: "user", content: "task" } as never);
  child.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } as never);
  return { root, cwd, activeFile, mainFile, collection: prepared.directory, childFile: child.getSessionFile()! };
}

function touch(file: string, date: Date): void {
  fs.utimesSync(file, date, date);
}

function createChild(
  f: ReturnType<typeof fixture>,
  id: string,
  content: string,
): string {
  const child = SessionManager.create(f.cwd, f.collection, { id });
  child.appendMessage({ role: "user", content } as never);
  child.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
  return child.getSessionFile()!;
}

async function reap(f: ReturnType<typeof fixture>, active = f.activeFile) {
  return reapSubagentTranscripts({
    sessionDirectory: f.root,
    activeMainSessionFile: active,
    activeMainCwd: f.cwd,
    maxAgeDays: 30,
    cleanupAllowed: true,
    nowMs: NOW,
  });
}

describe("owned subagent transcript retention", () => {
  it("retains every child of a fresh parent and uses strict cutoff equality", async () => {
    const f = fixture();
    touch(f.mainFile, FRESH);
    touch(f.childFile, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 0, removedCollections: 0 });
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("a stale parent deletes all valid children regardless of child age without deleting the parent", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    touch(f.childFile, new Date(NOW));
    const result = await reap(f);
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1, retainedEntries: 0 });
    expect(fs.existsSync(f.mainFile)).toBe(true);
    expect(fs.existsSync(f.collection)).toBe(false);
  });

  it("the exact active stale parent collection is excluded", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    expect(await reap(f, f.mainFile)).toMatchObject({ removedTranscriptFiles: 0 });
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("owned orphans remove only stale children and keep the marker for fresh children", async () => {
    const f = fixture();
    const second = SessionManager.create(f.cwd, f.collection, { id: "agent-123456abcdef" });
    second.appendMessage({ role: "user", content: "new" } as never);
    second.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const freshChild = second.getSessionFile()!;
    touch(f.childFile, OLD);
    touch(freshChild, FRESH);
    fs.unlinkSync(f.mainFile);
    const result = await reap(f);
    expect(result.removedTranscriptFiles).toBe(1);
    expect(fs.existsSync(freshChild)).toBe(true);
    expect(fs.existsSync(path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER))).toBe(true);
  });

  it("preserves markerless legacy orphans and mismatched ownership", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => fs.unlinkSync(path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER)),
      (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER), "{}\n"),
    ]) {
      const f = fixture();
      touch(f.childFile, OLD);
      fs.unlinkSync(f.mainFile);
      mutate(f);
      expect((await reap(f)).removedTranscriptFiles).toBe(0);
      expect(fs.existsSync(f.childFile)).toBe(true);
    }
  });

  it("preserves unknown, malformed, nested, and linked content while continuing siblings", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    touch(f.childFile, OLD);
    fs.writeFileSync(path.join(f.collection, "notes.txt"), "keep");
    fs.writeFileSync(path.join(f.collection, "2026-01-01T00-00-00-000Z_agent-111111111111.jsonl"), "bad\n");
    fs.mkdirSync(path.join(f.collection, "nested"));
    const result = await reap(f);
    expect(result.removedTranscriptFiles).toBe(1);
    expect(result.retainedEntries).toBe(1);
    expect(fs.existsSync(path.join(f.collection, "notes.txt"))).toBe(true);
    expect(fs.existsSync(f.collection)).toBe(true);
    expect(result.diagnostics.every((d) => !d.message.includes(f.root))).toBe(true);
  });

  it("local unlink failures retain data, sanitize diagnostics, and do not stop siblings", async () => {
    const f = fixture();
    const second = SessionManager.create(f.cwd, f.collection, { id: "agent-123456abcdef" });
    second.appendMessage({ role: "user", content: "second" } as never);
    second.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const secondFile = second.getSessionFile()!;
    touch(f.mainFile, OLD);
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: {
        unlink: async (file) => {
          if (file === f.childFile) throw Object.assign(new Error(`secret ${f.root}`), { code: "EACCES" });
          await fs.promises.unlink(file);
        },
      },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, retainedEntries: 1 });
    expect(fs.existsSync(f.childFile)).toBe(true);
    expect(fs.existsSync(secondFile)).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("EACCES"))).toBe(true);
    expect(result.diagnostics.every((d) => !d.message.includes(f.root))).toBe(true);
    expect(result.diagnostics.length).toBeLessThanOrEqual(32);
  });

  it("revalidates a stale parent immediately before unlink", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    touch(f.childFile, OLD);
    let childClassified = false;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: {
        lstat: async (file) => {
          if (file === f.childFile) childClassified = true;
          if (file === f.mainFile && childClassified) touch(f.mainFile, new Date(NOW));
          return fs.promises.lstat(file);
        },
      },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 0, retainedEntries: 1 });
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("preserves an orphan when its marker differs only by Windows-shaped canonical cwd case", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    const ownership = JSON.parse(fs.readFileSync(marker, "utf8")) as { cwdHash: string };
    const preservedCase = "C:\\Projects\\CaseSensitive";
    ownership.cwdHash = hashCanonicalPath("C:\\projects\\casesensitive");
    fs.writeFileSync(marker, `${JSON.stringify(ownership)}\n`, "utf8");

    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: {
        realpath: async (file) => file === f.cwd ? preservedCase : fs.promises.realpath(file),
      },
    });

    expect(result.failureCounts["ownership-uncertain"]).toBe(1);
    expect(result).toMatchObject({ removedTranscriptFiles: 0, removedCollections: 0 });
    expect(fs.existsSync(f.childFile)).toBe(true);
    expect(fs.existsSync(f.collection)).toBe(true);
  });

  it("canonicalizes a non-vacuous active root alias through the root authority", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const alias = `${f.root}-alias`;
    roots.push(alias);
    fs.symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
    const result = await reapSubagentTranscripts({
      sessionDirectory: alias,
      activeMainSessionFile: path.join(alias, path.basename(f.mainFile)),
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      removedTranscriptFiles: 0,
      removedCollections: 0,
      retainedEntries: 0,
      failureCounts: {
        race: 0,
        permission: 0,
        busy: 0,
        "ownership-uncertain": 0,
        "other-io": 0,
      },
      diagnosticsTruncated: false,
      diagnostics: [],
    });
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("fails closed when the exact direct active identity cannot be established", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const result = await reap(f, path.join(f.root, "missing-active.jsonl"));
    expect(result.removedTranscriptFiles).toBe(0);
    expect(result.failureCounts.race).toBe(1);
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it.each(["parent-id", "parent-timestamp", "parent-cwd", "marker"] as const)(
    "preserves the collection on %s authority mismatch",
    async (kind) => {
      const f = fixture();
      touch(f.mainFile, OLD);
      if (kind === "marker") {
        fs.writeFileSync(path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER), "{}\n");
      } else {
        const lines = fs.readFileSync(f.mainFile, "utf8").split("\n");
        const header = JSON.parse(lines[0]!) as Record<string, unknown>;
        if (kind === "parent-id") header.id = "different-main";
        else if (kind === "parent-timestamp") header.timestamp = "2000-01-01T00:00:00.000Z";
        else {
          const foreign = fs.mkdtempSync(path.join(f.root, "foreign-cwd-"));
          header.cwd = foreign;
        }
        lines[0] = JSON.stringify(header);
        fs.writeFileSync(f.mainFile, lines.join("\n"));
      }
      const result = await reap(f);
      expect(result.removedTranscriptFiles).toBe(0);
      expect(result.failureCounts["ownership-uncertain"]).toBeGreaterThan(0);
      expect(fs.existsSync(f.childFile)).toBe(true);
    },
  );

  it("preserves a child timestamp mismatch as ownership-uncertain", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const lines = fs.readFileSync(f.childFile, "utf8").split("\n");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    header.timestamp = "2000-01-01T00:00:00.000Z";
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(f.childFile, lines.join("\n"));

    const result = await reap(f);
    expect(result).toMatchObject({ removedTranscriptFiles: 0, retainedEntries: 1 });
    expect(result.failureCounts["ownership-uncertain"]).toBe(1);
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("cleans a stale parent-backed markerless legacy collection", async () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER));
    touch(f.mainFile, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
    expect(fs.existsSync(f.mainFile)).toBe(true);
  });

  it("removes an owned orphan collection when its final stale child is removed", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
    expect(fs.existsSync(f.collection)).toBe(false);
  });

  it("isolates multiple collections and ignores directory mtime", async () => {
    const first = fixture();
    const second = SessionManager.create(first.cwd, first.root, { id: "second-parent" });
    second.appendMessage({ role: "user", content: "second" } as never);
    second.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    const secondFile = second.getSessionFile()!;
    const prepared = prepareSubagentTranscriptCollection(secondFile);
    if (!prepared.ok) throw new Error(prepared.diagnostic.message);
    const secondChild = SessionManager.create(first.cwd, prepared.directory, { id: "agent-111111111111" });
    secondChild.appendMessage({ role: "user", content: "child" } as never);
    secondChild.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    touch(first.mainFile, OLD);
    touch(secondFile, new Date(NOW));
    touch(first.collection, new Date(NOW));
    const result = await reap(first);
    expect(result.removedTranscriptFiles).toBe(1);
    expect(fs.existsSync(first.mainFile)).toBe(true);
    expect(fs.existsSync(secondFile)).toBe(true);
    expect(fs.existsSync(secondChild.getSessionFile()!)).toBe(true);
  });

  it.each([
    ["ENOENT", "race", 0],
    ["EPERM", "permission", 1],
    ["EBUSY", "busy", 1],
    ["EIO", "other-io", 1],
  ] as const)("classifies %s unlink failures and continues", async (code, category, retained) => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { unlink: async (file) => {
        if (file === f.childFile) throw Object.assign(new Error("hidden"), { code });
        await fs.promises.unlink(file);
      } },
    });
    expect(result.failureCounts[category]).toBeGreaterThan(0);
    expect(result.retainedEntries).toBe(retained);
  });

  it("blocks deletion when an absent parent-backed marker appears mismatched", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    fs.unlinkSync(marker);
    let markerStats = 0;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { lstat: async (file) => {
        if (file === marker && ++markerStats === 2) fs.writeFileSync(marker, "{}\n");
        return fs.promises.lstat(file);
      } },
    });
    expect(result.removedTranscriptFiles).toBe(0);
    expect(result.failureCounts["ownership-uncertain"]).toBe(1);
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it.each(["absent", "invalid"] as const)(
    "preserves initial valid-marker authority when the marker becomes %s",
    async (change) => {
      const f = fixture();
      touch(f.mainFile, OLD);
      const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
      let markerStats = 0;
      const result = await reapSubagentTranscripts({
        sessionDirectory: f.root,
        activeMainSessionFile: f.activeFile,
        activeMainCwd: f.cwd,
        maxAgeDays: 30,
        cleanupAllowed: true,
        nowMs: NOW,
        fs: { lstat: async (file) => {
          if (file === marker && ++markerStats === 2) {
            if (change === "absent") fs.unlinkSync(marker);
            else fs.writeFileSync(marker, "{}\n");
          }
          return fs.promises.lstat(file);
        } },
      });
      expect(result).toMatchObject({ removedTranscriptFiles: 0, retainedEntries: 1 });
      expect(result.failureCounts["ownership-uncertain"]).toBe(1);
      expect(fs.existsSync(f.childFile)).toBe(true);
    },
  );

  it("preserves an orphan when its marker is replaced", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let markerStats = 0;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { lstat: async (file) => {
        if (file === marker && ++markerStats === 2) fs.writeFileSync(marker, "{}\n");
        return fs.promises.lstat(file);
      } },
    });
    expect(result.removedTranscriptFiles).toBe(0);
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("preserves a child when its parent is replaced", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    let parentStats = 0;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { lstat: async (file) => {
        if (file === f.mainFile && ++parentStats === 2) {
          fs.unlinkSync(f.mainFile);
          fs.writeFileSync(f.mainFile, "replacement\n");
        }
        return fs.promises.lstat(file);
      } },
    });
    expect(result.removedTranscriptFiles).toBe(0);
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("revalidates orphan authority when a parent appears", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    const parentBody = fs.readFileSync(f.mainFile);
    fs.unlinkSync(f.mainFile);
    let parentStats = 0;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { lstat: async (file) => {
        if (file === f.mainFile && ++parentStats === 2) fs.writeFileSync(f.mainFile, parentBody);
        return fs.promises.lstat(file);
      } },
    });
    expect(result.removedTranscriptFiles).toBe(0);
    expect(fs.existsSync(f.childFile)).toBe(true);
  });

  it("preserves a child replaced after selection", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    let childStats = 0;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { lstat: async (file) => {
        if (file === f.childFile && ++childStats === 2) {
          fs.unlinkSync(f.childFile);
          fs.writeFileSync(f.childFile, "replacement\n");
        }
        return fs.promises.lstat(file);
      } },
    });
    expect(result.removedTranscriptFiles).toBe(0);
    expect(result.retainedEntries).toBe(1);
    expect(fs.readFileSync(f.childFile, "utf8")).toBe("replacement\n");
  });

  it.each(["initial", "final"] as const)(
    "counts ENOENT during the %s child header read only as a race",
    async (phase) => {
      const f = fixture();
      touch(f.mainFile, OLD);
      let childOpens = 0;
      const result = await reapSubagentTranscripts({
        sessionDirectory: f.root,
        activeMainSessionFile: f.activeFile,
        activeMainCwd: f.cwd,
        maxAgeDays: 30,
        cleanupAllowed: true,
        nowMs: NOW,
        fs: { open: async (file, flags) => {
          if (file === f.childFile && ++childOpens === (phase === "initial" ? 1 : 2)) {
            fs.unlinkSync(file);
          }
          return fs.promises.open(file, flags);
        } },
      });
      expect(result).toMatchObject({
        removedTranscriptFiles: 0,
        removedCollections: 1,
        retainedEntries: 0,
      });
      expect(result.failureCounts.race).toBe(1);
      expect(fs.existsSync(f.collection)).toBe(false);
    },
  );

  it("keeps ownership when a recognized child appears before marker removal", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let collectionReads = 0;
    let freshChild = "";
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { readdir: async (directory) => {
        if (directory === f.collection && ++collectionReads === 2) {
          const child = SessionManager.create(f.cwd, directory, { id: "agent-eeeeeeeeeeee" });
          child.appendMessage({ role: "user", content: "arrived before marker removal" } as never);
          child.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
          freshChild = child.getSessionFile()!;
        }
        return fs.promises.readdir(directory);
      } },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts.race).toBe(1);
    expect(fs.existsSync(freshChild)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("restores orphan ownership when a child arrives after marker removal", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let freshChild = "";
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { unlink: async (file) => {
        await fs.promises.unlink(file);
        if (file === marker) {
          freshChild = createChild(f, "agent-a1a1a1a1a1a1", "arrived after marker removal");
          touch(freshChild, FRESH);
        }
      } },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts.race).toBe(1);
    expect(fs.existsSync(freshChild)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);

    touch(freshChild, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
  });

  it("restores orphan ownership when final enumeration fails after marker removal", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let collectionReads = 0;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { readdir: async (directory) => {
        if (directory === f.collection && ++collectionReads === 3) {
          throw Object.assign(new Error("hidden"), { code: "EIO" });
        }
        return fs.promises.readdir(directory);
      } },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts["other-io"]).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);

    const laterChild = createChild(f, "agent-e5e5e5e5e5e5", "eligible after restored ownership");
    touch(laterChild, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
    expect(fs.existsSync(f.collection)).toBe(false);
  });

  it.each([
    ["EBUSY", "busy"],
    ["EACCES", "permission"],
  ] as const)("restores ownership after %s rmdir failure before a delayed child arrives", async (code, category) => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let rmdirFailed = false;
    let postRmdirCollectionStats = 0;
    let freshChild = "";
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: {
        rmdir: async () => {
          rmdirFailed = true;
          throw Object.assign(new Error("hidden"), { code });
        },
        lstat: async (file) => {
          if (file === f.collection && rmdirFailed) {
            postRmdirCollectionStats++;
            if (!freshChild) {
              const id = code === "EBUSY" ? "agent-b2bbbbbbbbbb" : "agent-c3cccccccccc";
              freshChild = createChild(f, id, "arrived after rmdir failure");
              touch(freshChild, FRESH);
            } else if (postRmdirCollectionStats === 2) {
              throw Object.assign(new Error("hidden"), { code: "EIO" });
            }
          }
          return fs.promises.lstat(file);
        },
      },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts[category]).toBe(1);
    expect(postRmdirCollectionStats).toBe(2);
    expect(fs.existsSync(freshChild)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);

    touch(freshChild, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
  });

  it("restores the same orphan collection after an ENOENT rmdir rename-away race", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    const original = fs.statSync(f.collection);
    const away = `${f.collection}.away`;
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { rmdir: async (directory) => {
        await fs.promises.rename(directory, away);
        await fs.promises.rename(away, directory);
        throw Object.assign(new Error("hidden"), { code: "ENOENT" });
      } },
    });
    const returned = fs.statSync(f.collection);
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts.race).toBe(1);
    expect({ dev: returned.dev, ino: returned.ino }).toEqual({ dev: original.dev, ino: original.ino });
    expect(fs.existsSync(marker)).toBe(true);

    const laterChild = createChild(f, "agent-a4a4a4a4a4a4", "eligible after ENOENT restoration");
    touch(laterChild, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
    expect(fs.existsSync(f.collection)).toBe(false);
  });

  it("does not recreate an orphan collection that disappeared before ENOENT rmdir", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { rmdir: async (directory) => {
        await fs.promises.rmdir(directory);
        throw Object.assign(new Error("hidden"), { code: "ENOENT" });
      } },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts).toMatchObject({ race: 1, "ownership-uncertain": 1 });
    expect(fs.existsSync(f.collection)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("restores ownership when marker unlink reports ENOENT and the collection survives", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let freshChild = "";
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { unlink: async (file) => {
        if (file !== marker) return fs.promises.unlink(file);
        await fs.promises.unlink(file);
        freshChild = createChild(f, "agent-d4d4d4d4d4d4", "survived missing marker unlink");
        touch(freshChild, FRESH);
        throw Object.assign(new Error("hidden"), { code: "ENOENT" });
      } },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts.race).toBe(2);
    expect(fs.existsSync(freshChild)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);

    touch(freshChild, OLD);
    expect(await reap(f)).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
  });

  it("restores orphan ownership when a fresh Pi child races final rmdir", async () => {
    const f = fixture();
    touch(f.childFile, OLD);
    fs.unlinkSync(f.mainFile);
    const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    let freshChild = "";
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { rmdir: async (directory) => {
        const child = SessionManager.create(f.cwd, directory, { id: "agent-fedcba654321" });
        child.appendMessage({ role: "user", content: "arrived during cleanup" } as never);
        child.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
        freshChild = child.getSessionFile()!;
        await fs.promises.rmdir(directory);
      } },
    });
    expect(result).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 0 });
    expect(result.failureCounts.race).toBe(1);
    expect(fs.existsSync(freshChild)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);

    touch(freshChild, OLD);
    const later = await reap(f);
    expect(later).toMatchObject({ removedTranscriptFiles: 1, removedCollections: 1 });
    expect(fs.existsSync(f.collection)).toBe(false);
  });

  it("does not remove a collection when a new entry appears", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const newcomer = path.join(f.collection, "new-entry.txt");
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: { unlink: async (file) => {
        await fs.promises.unlink(file);
        if (file === f.childFile) fs.writeFileSync(newcomer, "new");
      } },
    });
    expect(result.removedTranscriptFiles).toBe(1);
    expect(result.removedCollections).toBe(0);
    expect(fs.existsSync(newcomer)).toBe(true);
  });

  it.each(["collection", "marker", "child"] as const)(
    "preserves portable injected linked %s classification",
    async (target) => {
      const f = fixture();
      touch(f.mainFile, OLD);
      const marker = path.join(f.collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
      const targetPath = target === "collection" ? f.collection : target === "marker" ? marker : f.childFile;
      const result = await reapSubagentTranscripts({
        sessionDirectory: f.root,
        activeMainSessionFile: f.activeFile,
        activeMainCwd: f.cwd,
        maxAgeDays: 30,
        cleanupAllowed: true,
        nowMs: NOW,
        fs: { lstat: async (file) => {
          const stat = await fs.promises.lstat(file);
          if (file !== targetPath) return stat;
          return { ...stat, isFile: () => target !== "collection", isDirectory: () => target === "collection", isSymbolicLink: () => true } as fs.Stats;
        } },
      });
      expect(result.removedTranscriptFiles).toBe(0);
      expect(fs.existsSync(f.childFile)).toBe(true);
    },
  );

  it.each(["enumeration", "stat", "rmdir"] as const)("classifies ENOENT at %s as a race", async (boundary) => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: {
        readdir: async (directory) => {
          if (boundary === "enumeration" && directory === f.root) throw Object.assign(new Error(), { code: "ENOENT" });
          return fs.promises.readdir(directory);
        },
        lstat: async (file) => {
          if (boundary === "stat" && file === f.collection) throw Object.assign(new Error(), { code: "ENOENT" });
          return fs.promises.lstat(file);
        },
        rmdir: async (directory) => {
          if (boundary === "rmdir") throw Object.assign(new Error(), { code: "ENOENT" });
          return fs.promises.rmdir(directory);
        },
      },
    });
    if (boundary === "rmdir") {
      expect(result).toMatchObject({
        removedTranscriptFiles: 1,
        removedCollections: 0,
        retainedEntries: 0,
        failureCounts: {
          race: 1,
          permission: 0,
          busy: 0,
          "ownership-uncertain": 0,
          "other-io": 0,
        },
        diagnosticsTruncated: false,
      });
      expect(result.diagnostics).toHaveLength(1);
    } else {
      expect(result.failureCounts.race).toBeGreaterThan(0);
    }
  });

  it("keeps aggregate categories complete after diagnostic truncation", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    fs.unlinkSync(f.childFile);
    for (let i = 0; i < 35; i++) {
      const id = i.toString(16).padStart(12, "0");
      fs.writeFileSync(path.join(f.collection, `2026-01-01T00-00-00-000Z_agent-${id}.jsonl`), "bad\n");
    }
    const failures = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
    for (const id of failures) {
      const child = SessionManager.create(f.cwd, f.collection, { id: `agent-${id}` });
      child.appendMessage({ role: "user", content: id } as never);
      child.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
    }
    const result = await reapSubagentTranscripts({
      sessionDirectory: f.root,
      activeMainSessionFile: f.activeFile,
      activeMainCwd: f.cwd,
      maxAgeDays: 30,
      cleanupAllowed: true,
      nowMs: NOW,
      fs: {
        readdir: async (directory) => (await fs.promises.readdir(directory)).sort(),
        unlink: async (file) => {
          const name = path.basename(file);
          const code = name.includes("aaaaaaaaaaaa") ? "EPERM"
            : name.includes("bbbbbbbbbbbb") ? "EBUSY"
              : name.includes("cccccccccccc") ? "EIO"
                : name.includes("dddddddddddd") ? "ENOENT" : undefined;
          if (code === "ENOENT") await fs.promises.unlink(file);
          if (code) throw Object.assign(new Error("hidden"), { code });
          await fs.promises.unlink(file);
        },
      },
    });
    expect(result).toMatchObject({
      removedTranscriptFiles: 0,
      removedCollections: 0,
      retainedEntries: 38,
      failureCounts: {
        race: 1,
        permission: 1,
        busy: 1,
        "ownership-uncertain": 35,
        "other-io": 1,
      },
      diagnosticsTruncated: true,
    });
    expect(result.diagnostics).toHaveLength(32);
  });

  it.skipIf(process.platform === "win32")("does not follow an authorized POSIX collection symlink", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "picc-reaper-outside-"));
    roots.push(outside);
    const canary = path.join(outside, path.basename(f.childFile));
    fs.writeFileSync(canary, "outside-canary\n");
    fs.rmSync(f.collection, { recursive: true });
    fs.symlinkSync(outside, f.collection, "dir");
    await reap(f);
    expect(fs.readFileSync(canary, "utf8")).toBe("outside-canary\n");
  });

  it.skipIf(process.platform !== "win32")("does not follow an authorized Windows junction collection", async () => {
    const f = fixture();
    touch(f.mainFile, OLD);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "picc-reaper-outside-"));
    roots.push(outside);
    const canary = path.join(outside, path.basename(f.childFile));
    fs.writeFileSync(canary, "outside-canary\n");
    fs.rmSync(f.collection, { recursive: true });
    fs.symlinkSync(outside, f.collection, "junction");
    await reap(f);
    expect(fs.readFileSync(canary, "utf8")).toBe("outside-canary\n");
  });
});
