import fs from "node:fs";
import { normalizeMcpServerBlock, type RawMcpEntry } from "./mcp-config.js";

export const MANAGED_MCP_MAX_BYTES = 1024 * 1024;

export type ManagedMcpUnusableReason =
  | "non-regular"
  | "unreadable"
  | "oversized"
  | "invalid-encoding"
  | "malformed"
  | "wrong-root"
  | "unstable";

export interface ManagedMcpEntry extends RawMcpEntry {
  readonly source: "managed-mcp";
}

export type ManagedMcpResult =
  | { readonly status: "absent" }
  | { readonly status: "loaded"; readonly servers: readonly ManagedMcpEntry[] }
  | { readonly status: "unusable"; readonly reason: ManagedMcpUnusableReason };

export interface ManagedMcpFileMetadata {
  readonly regular: boolean;
  readonly size: number;
  readonly identity: string;
  readonly modified: string;
}

export interface ManagedMcpFileHandle {
  metadata(): ManagedMcpFileMetadata | undefined;
  read(maxBytes: number): Uint8Array | undefined;
  currentPathMetadata(): ManagedMcpFileMetadata | undefined;
  close(): boolean;
}

export interface ManagedMcpIo {
  open(filePath: string):
    | { readonly status: "absent" }
    | { readonly status: "unreadable" }
    | { readonly status: "opened"; readonly handle: ManagedMcpFileHandle };
}

function metadataOf(stat: fs.Stats): ManagedMcpFileMetadata {
  return {
    regular: stat.isFile(),
    size: stat.size,
    identity: `${stat.dev}:${stat.ino}`,
    modified: `${stat.mtimeMs}:${stat.ctimeMs}`,
  };
}

export interface ManagedMcpNodeFs {
  readonly constants: { readonly O_RDONLY: number };
  openSync(filePath: string, flags: number): number;
  lstatSync(filePath: string): fs.Stats;
  fstatSync(descriptor: number): fs.Stats;
  readSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  closeSync(descriptor: number): void;
}

/** Construct the fixed-path adapter; injection exists only for deterministic filesystem boundary tests. */
export function createNodeManagedMcpIo(nodeFs: ManagedMcpNodeFs = fs): ManagedMcpIo {
  return {
    open(filePath) {
      let descriptor: number;
      try {
        descriptor = nodeFs.openSync(filePath, nodeFs.constants.O_RDONLY);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return { status: "unreadable" };
        try {
          nodeFs.lstatSync(filePath);
          return { status: "unreadable" };
        } catch (lstatError) {
          return (lstatError as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
            ? { status: "absent" }
            : { status: "unreadable" };
        }
      }
      let closed = false;
      return {
        status: "opened",
        handle: {
          metadata() {
            try {
              return metadataOf(nodeFs.fstatSync(descriptor));
            } catch {
              return undefined;
            }
          },
          read(maxBytes) {
            try {
              const buffer = Buffer.allocUnsafe(maxBytes);
              let offset = 0;
              while (offset < buffer.length) {
                const count = nodeFs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
                if (count === 0) break;
                offset += count;
              }
              return buffer.subarray(0, offset);
            } catch {
              return undefined;
            }
          },
          currentPathMetadata() {
            try {
              return metadataOf(nodeFs.lstatSync(filePath));
            } catch {
              return undefined;
            }
          },
          close() {
            if (closed) return false;
            closed = true;
            try {
              nodeFs.closeSync(descriptor);
              return true;
            } catch {
              return false;
            }
          },
        },
      };
    },
  };
}

const nodeManagedMcpIo = createNodeManagedMcpIo();

function sameSnapshot(left: ManagedMcpFileMetadata, right: ManagedMcpFileMetadata): boolean {
  return left.regular === right.regular && left.size === right.size &&
    left.identity === right.identity && left.modified === right.modified;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Snapshot one already-authorized standalone managed MCP artifact without throwing. */
export function loadManagedMcpSnapshot(
  filePath: string,
  io: ManagedMcpIo = nodeManagedMcpIo,
): ManagedMcpResult {
  let opened: ReturnType<ManagedMcpIo["open"]>;
  try {
    opened = io.open(filePath);
  } catch {
    return { status: "unusable", reason: "unreadable" };
  }
  if (opened.status !== "opened") {
    return opened.status === "absent"
      ? { status: "absent" }
      : { status: "unusable", reason: "unreadable" };
  }

  const handle = opened.handle;
  let result: ManagedMcpResult;
  try {
    const before = handle.metadata();
    if (before === undefined) result = { status: "unusable", reason: "unreadable" };
    else if (!before.regular || !Number.isSafeInteger(before.size) || before.size < 0) {
      result = { status: "unusable", reason: "non-regular" };
    } else if (before.size > MANAGED_MCP_MAX_BYTES) {
      result = { status: "unusable", reason: "oversized" };
    } else {
      const bytes = handle.read(MANAGED_MCP_MAX_BYTES + 1);
      const after = handle.metadata();
      const pathMetadata = handle.currentPathMetadata();
      if (bytes === undefined) result = { status: "unusable", reason: "unreadable" };
      else if (bytes.byteLength > MANAGED_MCP_MAX_BYTES) result = { status: "unusable", reason: "oversized" };
      else if (after === undefined || pathMetadata === undefined || !sameSnapshot(before, after) ||
        !sameSnapshot(after, pathMetadata) || bytes.byteLength !== after.size) {
        result = { status: "unusable", reason: "unstable" };
      } else {
        let text: string | undefined;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          text = undefined;
        }
        if (text === undefined) {
          result = { status: "unusable", reason: "invalid-encoding" };
        } else {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          if (parsed === undefined) result = { status: "unusable", reason: "malformed" };
          else if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
            result = { status: "unusable", reason: "wrong-root" };
          } else {
            result = {
              status: "loaded",
              servers: Object.freeze(normalizeMcpServerBlock(parsed.mcpServers, "managed MCP configuration")
                .map((entry) => Object.freeze({ ...entry, source: "managed-mcp" as const }))),
            };
          }
        }
      }
    }
  } catch {
    result = { status: "unusable", reason: "unreadable" };
  }
  try {
    if (!handle.close()) return { status: "unusable", reason: "unstable" };
  } catch {
    return { status: "unusable", reason: "unstable" };
  }
  return result!;
}
