import fs from "node:fs";
import path from "node:path";

/** Strip a leading UTF-8 BOM (U+FEFF) — Windows editors (Notepad, PowerShell 5.1) add it routinely. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read a UTF-8 file, returning undefined on any error (completeness floor: never throw). */
export function readTextSafe(filePath: string): string | undefined {
  try {
    return stripBom(fs.readFileSync(filePath, "utf8"));
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

/**
 * Recursively collect files matching a filename predicate. Follows symlinked
 * directories and Windows junctions (common for shared skills/rules dirs);
 * loop-safe via realpath tracking plus the depth cap.
 */
export function walkFiles(
  dir: string,
  predicate: (name: string, fullPath: string) => boolean,
  maxDepth = 12,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const realpathSafe = (p: string): string | undefined => {
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const visit = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of listDirSafe(d)) {
      const full = path.join(d, entry.name);
      let isDir = entry.isDirectory();
      let isFileEntry = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Dirents never report a link's target kind — stat through the link.
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFileEntry = st.isFile();
        } catch {
          continue; // broken link
        }
      }
      if (isDir) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const real = realpathSafe(full) ?? full;
        if (seen.has(real)) continue;
        seen.add(real);
        visit(full, depth + 1);
      } else if (isFileEntry && predicate(entry.name, full)) {
        out.push(full);
      }
    }
  };
  const rootReal = realpathSafe(dir);
  if (rootReal) seen.add(rootReal);
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

/** JSON parse that never throws. BOM-tolerant (Windows editors prepend U+FEFF). */
export function parseJsonSafe<T = unknown>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripBom(text)) as T;
  } catch {
    return undefined;
  }
}
