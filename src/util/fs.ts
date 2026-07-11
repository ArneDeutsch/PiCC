import fs from "node:fs";
import path from "node:path";

/** Read a UTF-8 file, returning undefined on any error (completeness floor: never throw). */
export function readTextSafe(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** List directory entries safely; [] on error. */
export function listDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursively collect files matching a filename predicate. Symlink-loop safe (depth cap). */
export function walkFiles(
  dir: string,
  predicate: (name: string, fullPath: string) => boolean,
  maxDepth = 12,
): string[] {
  const out: string[] = [];
  const visit = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of listDirSafe(d)) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        visit(full, depth + 1);
      } else if (entry.isFile() && predicate(entry.name, full)) {
        out.push(full);
      }
    }
  };
  visit(dir, 0);
  return out;
}

/** Find the enclosing git repo root (directory containing .git), or undefined. */
export function findRepoRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** JSON parse that never throws. */
export function parseJsonSafe<T = unknown>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
