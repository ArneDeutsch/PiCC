import { createHash } from "node:crypto";
import type { Sha256 } from "./types.js";

export interface ArtifactDigestEntry {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly executable?: boolean;
  readonly data?: Uint8Array;
}

function field(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length).update(bytes);
}

function relativeToRoot(entryPath: string, rootPath: string): string | undefined {
  if (rootPath.length === 0) return entryPath;
  if (entryPath === rootPath) return "";
  const prefix = `${rootPath}/`;
  return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : undefined;
}

export function digestArtifactEntries(
  entries: readonly ArtifactDigestEntry[],
  rootPath = "",
): Sha256 {
  const hash = createHash("sha256");
  hash.update("picc-plugin-tree-v1\0", "utf8");
  const selected = entries
    .map((entry) => ({ entry, relative: relativeToRoot(entry.path, rootPath) }))
    .filter((item): item is { entry: ArtifactDigestEntry; relative: string } => item.relative !== undefined && item.relative !== "")
    .sort((left, right) => Buffer.compare(Buffer.from(left.relative, "utf8"), Buffer.from(right.relative, "utf8")));
  for (const { entry, relative } of selected) {
    hash.update(entry.kind === "directory" ? "d" : entry.executable === true ? "x" : "f", "utf8");
    field(hash, relative);
    if (entry.kind === "file") field(hash, entry.data ?? new Uint8Array());
  }
  return `sha256:${hash.digest("hex")}`;
}
