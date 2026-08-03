import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../types.js";
import {
  MAX_PI_SESSION_HEADER_BYTES,
  MAX_SUBAGENT_OWNERSHIP_MARKER_BYTES,
  SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER,
  hashCanonicalPath,
  parsePiSessionFilename,
  parsePiSessionHeader,
  parseSubagentOwnershipMarker,
  serializeSubagentTranscriptOwnership,
  type PiSessionHeader,
} from "../util/subagent-transcripts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DIAGNOSTIC_LIMIT = 32;

interface BoundedFileHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface SubagentTranscriptFs {
  realpath(file: string): Promise<string>;
  lstat(file: string): Promise<fs.Stats>;
  readdir(directory: string): Promise<string[]>;
  open(file: string, flags: "r"): Promise<BoundedFileHandle>;
  unlink(file: string): Promise<void>;
  writeFile(
    file: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ): Promise<void>;
  rmdir(directory: string): Promise<void>;
}

export interface SubagentTranscriptReapOptions {
  sessionDirectory: string;
  activeMainSessionFile: string;
  activeMainCwd: string;
  maxAgeDays: number;
  cleanupAllowed: boolean;
  nowMs?: number;
  fs?: Partial<SubagentTranscriptFs>;
}

export type SubagentTranscriptFailureCategory =
  | "race"
  | "permission"
  | "busy"
  | "ownership-uncertain"
  | "other-io";

export interface SubagentTranscriptReapResult {
  removedTranscriptFiles: number;
  removedCollections: number;
  retainedEntries: number;
  failureCounts: Record<SubagentTranscriptFailureCategory, number>;
  diagnosticsTruncated: boolean;
  diagnostics: Diagnostic[];
}

const realFs: SubagentTranscriptFs = {
  realpath: (file) => fs.promises.realpath(file),
  lstat: (file) => fs.promises.lstat(file),
  readdir: (directory) => fs.promises.readdir(directory),
  open: (file, flags) => fs.promises.open(file, flags),
  unlink: (file) => fs.promises.unlink(file),
  writeFile: (file, data, options) => fs.promises.writeFile(file, data, options),
  rmdir: (directory) => fs.promises.rmdir(directory),
};

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "IO_ERROR";
}

function categoryFor(error: unknown): SubagentTranscriptFailureCategory {
  switch (errorCode(error)) {
    case "ENOENT":
    case "ENOTEMPTY": return "race";
    case "EACCES":
    case "EPERM": return "permission";
    case "EBUSY": return "busy";
    default: return "other-io";
  }
}

async function readBoundedJson(
  io: SubagentTranscriptFs,
  file: string,
  limit: number,
  firstLine: boolean,
): Promise<{ ok: true; value: unknown } | { ok: false; error?: unknown }> {
  let handle: BoundedFileHandle | undefined;
  try {
    handle = await io.open(file, "r");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let end = bytesRead;
    if (firstLine) {
      end = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (end < 0 || end > limit) return { ok: false };
    } else if (bytesRead > limit) {
      return { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(buffer.subarray(0, end).toString("utf8")) };
    } catch {
      return { ok: false };
    }
  } catch (error) {
    return { ok: false, error };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readHeader(
  io: SubagentTranscriptFs,
  file: string,
): Promise<{ header?: PiSessionHeader; error?: unknown }> {
  const read = await readBoundedJson(io, file, MAX_PI_SESSION_HEADER_BYTES, true);
  return read.ok ? { header: parsePiSessionHeader(read.value) } : { error: read.error };
}

type MarkerState =
  | { kind: "absent" }
  | { kind: "valid" }
  | { kind: "invalid"; error?: unknown };

async function markerState(
  io: SubagentTranscriptFs,
  markerFile: string,
  parentBasename: string,
  cwdHash: string,
): Promise<MarkerState> {
  try {
    const stat = await io.lstat(markerFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "invalid" };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "absent" } : { kind: "invalid", error };
  }
  const read = await readBoundedJson(io, markerFile, MAX_SUBAGENT_OWNERSHIP_MARKER_BYTES, false);
  if (!read.ok) return { kind: "invalid", error: read.error };
  return parseSubagentOwnershipMarker(read.value, parentBasename, cwdHash)
    ? { kind: "valid" }
    : { kind: "invalid" };
}

function markerAuthorityContinues(initial: MarkerState, current: MarkerState): boolean {
  return initial.kind === "valid" ? current.kind === "valid" : current.kind !== "invalid";
}

type ParentState =
  | { kind: "valid"; mtimeMs: number }
  | { kind: "missing" }
  | { kind: "invalid"; error?: unknown };

async function parentAuthority(
  io: SubagentTranscriptFs,
  parentFile: string,
  parentBasename: string,
  cwdCanonical: string,
): Promise<ParentState> {
  const parsed = parsePiSessionFilename(parentBasename);
  if (!parsed) return { kind: "invalid" };
  let stat: fs.Stats;
  try {
    stat = await io.lstat(parentFile);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid", error };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "invalid" };
  const { header, error } = await readHeader(io, parentFile);
  if (!header || header.id !== parsed.id || header.timestamp !== parsed.timestamp) {
    return { kind: "invalid", error };
  }
  try {
    if (await io.realpath(header.cwd) !== cwdCanonical) return { kind: "invalid" };
  } catch (cwdError) {
    return { kind: "invalid", error: cwdError };
  }
  return { kind: "valid", mtimeMs: stat.mtimeMs };
}

/** Best-effort, no-follow cleanup of direct PiCC-owned child transcript collections. */
export async function reapSubagentTranscripts(
  options: SubagentTranscriptReapOptions,
): Promise<SubagentTranscriptReapResult> {
  const result: SubagentTranscriptReapResult = {
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
  };
  const io: SubagentTranscriptFs = { ...realFs, ...options.fs };
  const fail = (
    category: SubagentTranscriptFailureCategory,
    entry: string,
    action: string,
    code?: string,
  ): void => {
    result.failureCounts[category]++;
    if (result.diagnostics.length >= DIAGNOSTIC_LIMIT) {
      result.diagnosticsTruncated = true;
      return;
    }
    result.diagnostics.push({
      severity: "warning",
      message: `subagent transcript cleanup ${action}: ${path.basename(entry)}${code ? ` (${code})` : ""}`,
    });
  };
  const failError = (entry: string, action: string, error: unknown): void => {
    fail(categoryFor(error), entry, action, errorCode(error));
  };
  if (!options.cleanupAllowed || !Number.isInteger(options.maxAgeDays) || options.maxAgeDays < 1) {
    return result;
  }

  const cutoff = (options.nowMs ?? Date.now()) - options.maxAgeDays * DAY_MS;
  let root: string;
  let cwdCanonical: string;
  let activeCanonical: string;
  try {
    root = await io.realpath(options.sessionDirectory);
    cwdCanonical = await io.realpath(options.activeMainCwd);
    activeCanonical = await io.realpath(options.activeMainSessionFile);
    const [rootStat, activeParentCanonical] = await Promise.all([
      io.lstat(root),
      io.realpath(path.dirname(options.activeMainSessionFile)),
    ]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        activeParentCanonical !== root || path.dirname(activeCanonical) !== root) {
      fail("ownership-uncertain", "session-directory", "active identity is not a direct child");
      return result;
    }
  } catch (error) {
    fail(categoryFor(error), "session-directory", "active identity unavailable", errorCode(error));
    return result;
  }
  const activeName = path.basename(activeCanonical);
  const activeParsed = parsePiSessionFilename(activeName);
  try {
    const activeStat = await io.lstat(activeCanonical);
    const activeHeader = await readHeader(io, activeCanonical);
    if (!activeParsed || !activeStat.isFile() || activeStat.isSymbolicLink() ||
        !activeHeader.header || activeHeader.header.id !== activeParsed.id ||
        activeHeader.header.timestamp !== activeParsed.timestamp ||
        await io.realpath(activeHeader.header.cwd) !== cwdCanonical) {
      fail("ownership-uncertain", activeName, "active identity is invalid");
      return result;
    }
  } catch (error) {
    failError(activeName, "active identity unavailable", error);
    return result;
  }
  const activeStem = activeName.slice(0, -".jsonl".length);
  const cwdHash = hashCanonicalPath(cwdCanonical);

  let entries: string[];
  try {
    entries = await io.readdir(root);
  } catch (error) {
    failError("session-directory", "enumeration failed", error);
    return result;
  }

  for (const collectionName of entries) {
    const stem = collectionName.endsWith(".subagents") ? collectionName.slice(0, -10) : "";
    const parentBasename = `${stem}.jsonl`;
    if (!stem || !parsePiSessionFilename(parentBasename) || stem === activeStem) continue;
    const collection = path.join(root, collectionName);
    let collectionStat: fs.Stats;
    try {
      collectionStat = await io.lstat(collection);
      if (!collectionStat.isDirectory() || collectionStat.isSymbolicLink()) {
        fail("ownership-uncertain", collectionName, "preserved linked or non-directory collection");
        continue;
      }
      if (await io.realpath(collection) !== collection) {
        fail("ownership-uncertain", collectionName, "preserved non-direct collection");
        continue;
      }
    } catch (error) {
      failError(collectionName, "classification failed", error);
      continue;
    }

    const collectionIsDirect = async (): Promise<boolean> => {
      try {
        const current = await io.lstat(collection);
        return current.isDirectory() && !current.isSymbolicLink() &&
          current.dev === collectionStat.dev && current.ino === collectionStat.ino &&
          await io.realpath(collection) === collection;
      } catch {
        return false;
      }
    };
    const parentFile = path.join(root, parentBasename);
    const markerFile = path.join(collection, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    const restoreOwnershipEvidence = async (): Promise<void> => {
      if (!await collectionIsDirect()) {
        fail("ownership-uncertain", SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "restore refused for changed collection");
        return;
      }
      try {
        await io.writeFile(
          markerFile,
          serializeSubagentTranscriptOwnership(parentBasename, cwdHash),
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          failError(SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "restore failed", error);
          return;
        }
      }
      const [restored, collectionStillDirect] = await Promise.all([
        markerState(io, markerFile, parentBasename, cwdHash),
        collectionIsDirect(),
      ]);
      if (restored.kind !== "valid" || !collectionStillDirect) {
        fail(
          "ownership-uncertain",
          SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER,
          "restore did not produce matching evidence",
          restored.kind === "invalid" && restored.error ? errorCode(restored.error) : undefined,
        );
      }
    };
    const parent = await parentAuthority(io, parentFile, parentBasename, cwdCanonical);
    const marker = await markerState(io, markerFile, parentBasename, cwdHash);
    const mode = parent.kind === "valid" && marker.kind !== "invalid"
      ? "parent"
      : parent.kind === "missing" && marker.kind === "valid"
        ? "orphan"
        : undefined;
    if (!mode) {
      if (parent.kind === "invalid" && parent.error) failError(collectionName, "parent authority unavailable", parent.error);
      else if (marker.kind === "invalid" && marker.error) failError(collectionName, "marker unavailable", marker.error);
      else fail("ownership-uncertain", collectionName, "preserved uncertain ownership");
      continue;
    }
    if (mode === "parent" && parent.kind === "valid" && parent.mtimeMs >= cutoff) continue;

    let children: string[];
    try {
      children = await io.readdir(collection);
    } catch (error) {
      failError(collectionName, "enumeration failed", error);
      continue;
    }
    let markerNeeded = false;
    for (const childName of children) {
      if (childName === SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER) continue;
      const parsed = parsePiSessionFilename(childName, true);
      if (!parsed) continue;
      const child = path.join(collection, childName);
      let selectedStat: fs.Stats;
      try {
        selectedStat = await io.lstat(child);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          result.retainedEntries++;
          markerNeeded = true;
        }
        failError(childName, "classification failed", error);
        continue;
      }
      if (!selectedStat.isFile() || selectedStat.isSymbolicLink()) {
        result.retainedEntries++;
        markerNeeded = true;
        fail("ownership-uncertain", childName, "preserved linked or non-file entry");
        continue;
      }
      if (mode === "orphan" && selectedStat.mtimeMs >= cutoff) {
        markerNeeded = true;
        continue;
      }
      const selectedHeader = await readHeader(io, child);
      if (!selectedHeader.header || selectedHeader.header.id !== parsed.id ||
          selectedHeader.header.timestamp !== parsed.timestamp) {
        if (selectedHeader.error && errorCode(selectedHeader.error) === "ENOENT") {
          failError(childName, "header unavailable", selectedHeader.error);
        } else {
          result.retainedEntries++;
          markerNeeded = true;
          if (selectedHeader.error) failError(childName, "header unavailable", selectedHeader.error);
          else fail("ownership-uncertain", childName, "preserved header mismatch");
        }
        continue;
      }

      let authorityValid = false;
      if (mode === "parent") {
        const currentParent = await parentAuthority(io, parentFile, parentBasename, cwdCanonical);
        const currentMarker = await markerState(io, markerFile, parentBasename, cwdHash);
        authorityValid = currentParent.kind === "valid" && currentParent.mtimeMs < cutoff &&
          markerAuthorityContinues(marker, currentMarker);
      } else {
        const [currentParent, currentMarker] = await Promise.all([
          parentAuthority(io, parentFile, parentBasename, cwdCanonical),
          markerState(io, markerFile, parentBasename, cwdHash),
        ]);
        authorityValid = currentParent.kind === "missing" && currentMarker.kind === "valid";
      }
      if (!authorityValid || !await collectionIsDirect()) {
        result.retainedEntries++;
        markerNeeded = true;
        fail("ownership-uncertain", childName, "preserved after authority changed");
        continue;
      }

      try {
        const finalStat = await io.lstat(child);
        if (!finalStat.isFile() || finalStat.isSymbolicLink() ||
            finalStat.dev !== selectedStat.dev || finalStat.ino !== selectedStat.ino) {
          result.retainedEntries++;
          markerNeeded = true;
          fail("ownership-uncertain", childName, "preserved after entry identity changed");
          continue;
        }
        const finalHeader = await readHeader(io, child);
        if (!finalHeader.header || finalHeader.header.id !== selectedHeader.header.id ||
            finalHeader.header.timestamp !== selectedHeader.header.timestamp) {
          if (finalHeader.error && errorCode(finalHeader.error) === "ENOENT") {
            failError(childName, "replacement header unavailable", finalHeader.error);
          } else {
            result.retainedEntries++;
            markerNeeded = true;
            if (finalHeader.error) failError(childName, "replacement header unavailable", finalHeader.error);
            else fail("ownership-uncertain", childName, "preserved replaced entry");
          }
          continue;
        }
        await io.unlink(child);
        result.removedTranscriptFiles++;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          result.retainedEntries++;
          markerNeeded = true;
        }
        failError(childName, "unlink failed", error);
      }
    }

    let markerDetached = false;
    if (!markerNeeded && marker.kind === "valid") {
      try {
        const latestEntries = await io.readdir(collection);
        markerNeeded = latestEntries.some((entry) =>
          entry !== SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER && Boolean(parsePiSessionFilename(entry, true)),
        );
        if (markerNeeded) {
          fail("race", SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "preserved for a concurrent child");
        }
      } catch (error) {
        markerNeeded = true;
        failError(SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "final enumeration failed", error);
      }
    }
    if (!markerNeeded && marker.kind === "valid") {
      const currentParent = await parentAuthority(io, parentFile, parentBasename, cwdCanonical);
      const currentMarker = await markerState(io, markerFile, parentBasename, cwdHash);
      const mayRemoveMarker = await collectionIsDirect() &&
        markerAuthorityContinues(marker, currentMarker) && (
          mode === "parent"
            ? currentParent.kind === "valid" && currentParent.mtimeMs < cutoff
            : currentParent.kind === "missing"
        );
      if (mayRemoveMarker) {
        try {
          await io.unlink(markerFile);
          markerDetached = true;
        } catch (error) {
          if (errorCode(error) === "ENOENT") markerDetached = true;
          failError(SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "unlink failed", error);
        }
      } else {
        fail("ownership-uncertain", SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "preserved after authority changed");
      }
    }
    let remaining: string[];
    try {
      remaining = await io.readdir(collection);
    } catch (error) {
      failError(collectionName, "final enumeration failed", error);
      if (markerDetached) await restoreOwnershipEvidence();
      continue;
    }
    if (remaining.length > 0) {
      if (markerDetached) {
        fail("race", SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER, "restored for entries found after removal");
        await restoreOwnershipEvidence();
      }
      continue;
    }
    if (!await collectionIsDirect()) {
      fail("ownership-uncertain", collectionName, "preserved changed collection");
      if (markerDetached) await restoreOwnershipEvidence();
      continue;
    }
    try {
      await io.rmdir(collection);
      result.removedCollections++;
    } catch (error) {
      if (markerDetached) await restoreOwnershipEvidence();
      failError(collectionName, "directory removal failed", error);
    }
  }
  return result;
}
