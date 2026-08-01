import fs from "node:fs";
import path from "node:path";

const METADATA_BYTE_LIMIT = 16 * 1024;

export type CanonicalDirectoryResult =
  | { kind: "canonical"; path: string }
  | { kind: "non-candidate"; reason: "missing" | "not-directory" }
  | { kind: "indeterminate" };

export interface ProjectIdentityFileSystem {
  realpath(value: string): string;
  stat(value: string): fs.Stats;
  open(value: string): number;
  fstat(fd: number): fs.Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

const nativeFileSystem: ProjectIdentityFileSystem = {
  realpath: (value) => fs.realpathSync.native(value),
  stat: (value) => fs.statSync(value),
  open: (value) => fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK),
  fstat: (fd) => fs.fstatSync(fd),
  read: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  close: (fd) => fs.closeSync(fd),
};

function filesystem(overrides?: Partial<ProjectIdentityFileSystem>): ProjectIdentityFileSystem {
  return { ...nativeFileSystem, ...overrides };
}

function nonCandidateReason(error: unknown): "missing" | "not-directory" | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "missing";
  if (code === "ENOTDIR") return "not-directory";
  return undefined;
}

export function canonicalDirectory(
  value: string,
  overrides?: Partial<ProjectIdentityFileSystem>,
): CanonicalDirectoryResult {
  const io = filesystem(overrides);
  try {
    const canonical = io.realpath(value);
    return io.stat(canonical).isDirectory()
      ? { kind: "canonical", path: canonical }
      : { kind: "non-candidate", reason: "not-directory" };
  } catch (error) {
    const reason = nonCandidateReason(error);
    return reason === undefined
      ? { kind: "indeterminate" }
      : { kind: "non-candidate", reason };
  }
}

function readBoundedMetadata(file: string, io: ProjectIdentityFileSystem): string | undefined {
  try {
    if (!io.stat(file).isFile()) return undefined;
  } catch {
    return undefined;
  }

  let fd: number | undefined;
  let candidate: string | undefined;
  try {
    fd = io.open(file);
    if (io.fstat(fd).isFile()) {
      const buffer = Buffer.allocUnsafe(METADATA_BYTE_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = io.read(fd, buffer, length, buffer.length - length, length);
        if (read === 0) break;
        length += read;
      }
      if (length <= METADATA_BYTE_LIMIT) candidate = buffer.toString("utf8", 0, length).trim();
    }
  } catch {
    candidate = undefined;
  } finally {
    if (fd !== undefined) {
      try {
        io.close(fd);
      } catch {
        candidate = undefined;
      }
    }
  }
  return candidate;
}

function canonicalPath(value: string, io: ProjectIdentityFileSystem): string | undefined {
  try {
    return io.realpath(value);
  } catch {
    return undefined;
  }
}

function linkedMainCheckout(projectRoot: string, io: ProjectIdentityFileSystem): string | undefined {
  const dotGit = path.join(projectRoot, ".git");
  try {
    if (!io.stat(dotGit).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const pointer = readBoundedMetadata(dotGit, io);
  const match = pointer === undefined ? undefined : /^gitdir:\s*(.+)$/i.exec(pointer);
  if (!match) return undefined;

  const adminResult = canonicalDirectory(path.resolve(projectRoot, match[1]!), io);
  if (adminResult.kind !== "canonical") return undefined;
  const admin = adminResult.path;
  if (path.basename(path.dirname(admin)) !== "worktrees") return undefined;

  const backlink = readBoundedMetadata(path.join(admin, "gitdir"), io);
  const commonPointer = readBoundedMetadata(path.join(admin, "commondir"), io);
  if (backlink === undefined || commonPointer === undefined || path.basename(backlink) !== ".git") return undefined;

  const backlinkRoot = canonicalPath(path.dirname(backlink), io);
  const canonicalProject = canonicalPath(projectRoot, io);
  if (backlinkRoot === undefined || canonicalProject === undefined || backlinkRoot !== canonicalProject) return undefined;

  const common = canonicalPath(path.resolve(admin, commonPointer), io);
  if (
    common === undefined || path.basename(common) !== ".git" ||
    canonicalPath(path.dirname(admin), io) !== canonicalPath(path.join(common, "worktrees"), io)
  ) return undefined;
  const main = canonicalPath(path.dirname(common), io);
  if (main === undefined || canonicalPath(path.join(main, ".git"), io) !== common) return undefined;
  try {
    return io.stat(main).isDirectory() ? main : undefined;
  } catch {
    return undefined;
  }
}

export function projectIdentities(
  projectRoot: string,
  overrides?: Partial<ProjectIdentityFileSystem>,
): readonly string[] {
  const io = filesystem(overrides);
  const active = canonicalDirectory(projectRoot, io);
  if (active.kind !== "canonical") return [];
  const main = linkedMainCheckout(active.path, io);
  return main === undefined || main === active.path ? [active.path] : [main, active.path];
}
