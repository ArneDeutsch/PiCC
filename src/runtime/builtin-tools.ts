/**
 * Single source of truth for constructing PiCC's seven built-in tools
 * (bash, read, write, edit, grep, find, ls).
 *
 * This is the shared source of raw execution and renderer construction for the
 * main session and subagents. The main path adds routine rendering, collapse,
 * glyph framing, checkpoint handling, and registration. Subagent paths consume
 * the raw definitions selected by their grants.
 */
import { open as fsOpen, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { unicodeSafeSubprocessEnv } from "../util/env.js";
import type { CwdState } from "./cwd-state.js";
import { BINARY_READ_ERROR, isBinaryBuffer, sniffImageMime } from "./image-ingest.js";
// NOTE: `./notebook-render.js` is imported dynamically inside the notebook branch
// below, NOT at module load. It transitively imports the Pi package root (for
// `truncateHead`), which pulls in Pi's Photon/WASM image machinery; loading that on
// this hot-path module (the built-in `read` factory, imported by every session and
// subagent fork) deadlocks fork-heavy contexts. Deferring it to an actual `.ipynb`
// read keeps it off the eager graph. `image-ingest`'s detection helpers stay a
// static import because that module carries no Pi runtime import.

/**
 * A constructed Pi built-in tool instance. `execute` is the load-bearing member
 * (the factory rebinds it per call for live-cwd re-resolution); everything else
 * is spread through as the tool template.
 */
export type BuiltinToolInstance = {
  execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
  [key: string]: unknown;
};

/**
 * A Pi built-in tool *definition* — the renderer source. `create*Tool` strips
 * renderCall/renderResult via wrapToolDefinition, so diffs/truncation/highlighting
 * are re-sourced from `create*ToolDefinition`.
 */
export type BuiltinToolDefinition = {
  renderCall?: unknown;
  renderResult?: unknown;
  [key: string]: unknown;
};

/**
 * The narrow SDK handle {@link buildStockBuiltinTools} needs: the seven
 * `create<X>Tool` (EXECUTE source) and seven `create<X>ToolDefinition`
 * (RENDERER source) constructors, all REQUIRED.
 *
 * This is deliberately NOT `PiSdk` (whose mirror of these members is optional so
 * the un-wired fake still satisfies it). The main path passes the raw Pi import,
 * which has them; the subagent call site narrows/asserts its `PiSdk` handle to
 * this type before calling the factory.
 */
export interface BuiltinToolSdk {
  createBashTool(cwd: string, options: unknown): BuiltinToolInstance;
  createReadTool(cwd: string): BuiltinToolInstance;
  createWriteTool(cwd: string): BuiltinToolInstance;
  createEditTool(cwd: string): BuiltinToolInstance;
  createGrepTool(cwd: string): BuiltinToolInstance;
  createFindTool(cwd: string): BuiltinToolInstance;
  createLsTool(cwd: string): BuiltinToolInstance;
  createBashToolDefinition(cwd: string): BuiltinToolDefinition;
  createReadToolDefinition(cwd: string): BuiltinToolDefinition;
  createWriteToolDefinition(cwd: string): BuiltinToolDefinition;
  createEditToolDefinition(cwd: string): BuiltinToolDefinition;
  createGrepToolDefinition(cwd: string): BuiltinToolDefinition;
  createFindToolDefinition(cwd: string): BuiltinToolDefinition;
  createLsToolDefinition(cwd: string): BuiltinToolDefinition;
}

/** Deps every session supplies to shape the bash spawn environment + shell. */
export interface BuiltinToolDeps {
  /** The project's configured environment (`project.settings.env`). */
  settingsEnv: Record<string, string | undefined>;
  /** Absolute project root, injected as `CLAUDE_PROJECT_DIR`. */
  projectRoot: string;
  /** Pinned Git-Bash path on Windows (from resolveGitBashPath); absent elsewhere. */
  shellPath?: string;
}

/**
 * Pure transform for the built-in bash tool's subprocess environment: layer the
 * project's `settingsEnv` and `CLAUDE_PROJECT_DIR` over the inherited env, then
 * apply the Unicode-safe subprocess defaults. Settings win over inherited on a
 * key collision; `CLAUDE_PROJECT_DIR` wins over both.
 *
 * Extracted as a pure function so it can be asserted without constructing a tool
 * or spawning a process.
 */
export function buildBashSpawnEnv(
  inherited: Record<string, string | undefined>,
  settingsEnv: Record<string, string | undefined>,
  projectRoot: string,
): Record<string, string> {
  return unicodeSafeSubprocessEnv({
    ...inherited,
    ...settingsEnv,
    CLAUDE_PROJECT_DIR: projectRoot,
  });
}

/**
 * Build the `create*BashTool` options object: the Git-Bash `shellPath` pin (when
 * present) plus the spawnHook that rewrites the child's env via
 * {@link buildBashSpawnEnv}. Kept small so the subagent path reuses the identical
 * bash config.
 */
export function makeBuiltinBashOptions(deps: BuiltinToolDeps): {
  shellPath?: string;
  spawnHook(args: { command: unknown; cwd: unknown; env: Record<string, string | undefined> }): {
    command: unknown;
    cwd: unknown;
    env: Record<string, string>;
  };
} {
  return {
    ...(deps.shellPath ? { shellPath: deps.shellPath } : {}),
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: buildBashSpawnEnv(env, deps.settingsEnv, deps.projectRoot),
    }),
  };
}

/** A raw (unwrapped) merged built-in def, keyed by its PiCC tool name. */
export interface StockBuiltinTool {
  name: string;
  def: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Read routing: notebook / image / binary awareness layered over Pi's `read`.
//
// The stock Pi `read` already handles image FILES (magic-byte detection →
// normalized image block + non-vision note) and plain text; PiCC delegates both
// of those straight back to it. This wrapper adds only what Pi's read lacks:
//   - `.ipynb` → cell-aware render (renderNotebook) with vision-gated image blocks;
//   - an unsupported binary (incl. PDF) → a Claude-style "cannot read binary
//     files" notice instead of mojibake.
// The routing lives here in the shared factory so it reaches BOTH the main session
// and dispatched subagents (both build their `read` from buildStockBuiltinTools).
// Every branch degrades rather than crashes: any failure falls back to Pi's read
// (or, for notebooks, to a read-shaped notice), so a session never dies here.
// ---------------------------------------------------------------------------

/**
 * Bounded window read for the image/binary routing decision — never slurps a
 * whole large file just to classify it. `sniffImageMime` needs only the format
 * header and `isBinaryBuffer` scans at most ~8 KB, so this window is ample.
 */
const READ_ROUTING_HEADER_BYTES = 64 * 1024;

/** The `read` tool result shape this wrapper both returns and delegates. */
interface ReadResult {
  content: unknown[];
  details?: Record<string, unknown>;
}

/** Pull the file path from `read` params (`path`, with `file_path` as Pi's alias). */
function readParamPath(params: unknown): string | undefined {
  if (params === null || typeof params !== "object") return undefined;
  const candidate = (params as Record<string, unknown>).path ?? (params as Record<string, unknown>).file_path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/** The active model from the tool ctx, threaded to the notebook renderer's vision gate. */
function ctxModel(ctx: unknown): unknown {
  return (ctx as { model?: unknown } | null | undefined)?.model;
}

/**
 * Resolve a read path against the effective cwd for PiCC's own pre-read (stat +
 * header window). Handles `~` expansion and absolute paths; a delegated read
 * still re-resolves through Pi (which also applies its macOS filename variants),
 * so any path this misses simply falls through to Pi unchanged.
 */
function resolveReadTarget(rawPath: string, cwd: string): string {
  let p = rawPath;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = resolvePath(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolvePath(cwd, p);
}

/** Read at most {@link READ_ROUTING_HEADER_BYTES} from the file head for the routing decision. */
async function readRoutingHeader(absPath: string): Promise<Buffer> {
  const handle = await fsOpen(absPath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, READ_ROUTING_HEADER_BYTES);
    if (length === 0) return Buffer.alloc(0);
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 0);
    return header;
  } finally {
    await handle.close();
  }
}

function startsWithBytes(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/**
 * A detected non-text file kind, from a FIXED magic-signature allowlist. `label`
 * is a friendly type name; `notYet` marks a format PiCC deliberately does not
 * read yet (PDF) rather than a universal binary limitation. Only these fixed
 * labels are ever surfaced — never the sniffed bytes.
 */
interface BinaryKind {
  label: string;
  notYet?: boolean;
}

/**
 * Classify a buffer by a fixed magic-signature allowlist. Returns a friendly
 * kind or `undefined`. PDF is called out with `notYet` so its notice can say
 * "not supported yet" — a plain "binary" message would mislead a Claude-tuned
 * user who knows Claude reads PDFs. The signatures are distinctive enough to not
 * fire on plain text.
 */
function detectBinaryKind(buf: Buffer): BinaryKind | undefined {
  if (startsWithBytes(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { label: "PDF", notYet: true }; // "%PDF-"
  if (startsWithBytes(buf, [0x50, 0x4b, 0x03, 0x04])) return { label: "ZIP archive" };
  if (startsWithBytes(buf, [0x1f, 0x8b])) return { label: "gzip archive" };
  if (startsWithBytes(buf, [0x7f, 0x45, 0x4c, 0x46])) return { label: "ELF executable" };
  return undefined;
}

/**
 * The Claude-style binary-read notice. The stable {@link BINARY_READ_ERROR}
 * prefix is always first (tests assert the prefix, never a byte-exact string);
 * the suffix (PiCC's own wording) names only the path and a fixed detected-type
 * label, never any sniffed byte content.
 */
function binaryNotice(kind: BinaryKind | undefined, rawPath: string): ReadResult {
  let text = BINARY_READ_ERROR;
  if (kind?.notYet) {
    text += ` The file "${rawPath}" looks like a ${kind.label}, which PiCC does not support reading yet.`;
  } else if (kind) {
    text += ` The file "${rawPath}" appears to be a ${kind.label}.`;
  } else {
    text += ` The file "${rawPath}" appears to contain binary (non-text) data.`;
  }
  return { content: [{ type: "text", text }], details: { binary: true } };
}

/** A read-shaped notice for a notebook that could not be rendered (degrade, never crash). */
function notebookNotice(message: string, rawPath: string): ReadResult {
  return {
    content: [{ type: "text", text: `Could not read notebook "${rawPath}": ${message}` }],
    details: { notebookError: true },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Route one `read` call. `makeRead` builds a live-cwd Pi read instance for the
 * delegated (image-file / plain-text) branches; `cwd` is the effective cwd used
 * for PiCC's own pre-read resolution.
 *
 * Routing order is load-bearing (see the module header): notebook → image →
 * binary → text.
 */
async function routeReadExecute(
  makeRead: () => BuiltinToolInstance,
  cwd: string,
  id: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
): Promise<unknown> {
  const delegate = () => makeRead().execute(id, params, signal, onUpdate, ctx);
  const rawPath = readParamPath(params);
  if (rawPath === undefined) return delegate();

  // (1) Notebook. Stat FIRST and reject an over-size file before reading it: this
  // pre-read stat is the real OOM guard — a huge/hostile .ipynb must be rejected
  // before it is slurped into memory (renderNotebook's own byte cap runs only
  // AFTER the read, so it cannot prevent the OOM the read itself would cause). A
  // structural throw (bad JSON, no `cells`, missing file) is caught and degraded
  // to a read-shaped notice — it must never escape and crash the session.
  if (rawPath.toLowerCase().endsWith(".ipynb")) {
    const abs = resolveReadTarget(rawPath, cwd);
    try {
      const { MAX_NOTEBOOK_BYTES, renderNotebook } = await import("./notebook-render.js");
      const { size } = await fsStat(abs);
      if (size > MAX_NOTEBOOK_BYTES) {
        return notebookNotice(
          `it is ${size} bytes, larger than the ${MAX_NOTEBOOK_BYTES}-byte notebook read limit`,
          rawPath,
        );
      }
      const text = await fsReadFile(abs, "utf8");
      const { content, truncated } = await renderNotebook(text, { model: ctxModel(ctx) });
      return { content, details: { truncated } } satisfies ReadResult;
    } catch (err) {
      return notebookNotice(errorText(err), rawPath);
    }
  }

  // (2) Image / (3) binary. Classify from a bounded header window; on ANY failure
  // (path this resolver misses, stat/read error) fall through to Pi's read, which
  // re-resolves the path itself and emits its own error. The binary check runs
  // only AFTER the supported-image exclusion (images carry NUL bytes, so a raw
  // isBinaryBuffer on a PNG would wrongly error).
  try {
    const abs = resolveReadTarget(rawPath, cwd);
    const header = await readRoutingHeader(abs);
    // (2) A supported image file → delegate to Pi's read (normalization + image
    // block + non-vision note). PiCC does not hand-roll the image-file path.
    if (sniffImageMime(header) !== null) return delegate();
    // (3) An unsupported binary → a Claude-style notice, not mojibake. A magic
    // match (e.g. PDF) is decisive on its own; otherwise the byte heuristic decides.
    const kind = detectBinaryKind(header);
    if (kind !== undefined || isBinaryBuffer(header)) return binaryNotice(kind, rawPath);
  } catch {
    // Fall through to Pi's read (its own resolution + error handling).
  }

  // (4) Plain text → Pi's read, unchanged.
  return delegate();
}

/**
 * Construct the seven PiCC-semantic built-in tools.
 *
 * Each built-in carries TWO sourcings that stay separate:
 * - `factory` (`create*Tool`) is the EXECUTE source — it drives the live-cwd
 *   re-resolution, the bash spawnHook/env, Git-Bash pinning, and `read`'s ctx
 *   handling. The execute closure rebinds per call: `factory(cwdRef.get())`.
 * - `defFactory` (`create*ToolDefinition`) is the RENDERER source — its
 *   renderCall/renderResult are cwd-light (the render ctx supplies cwd), so one
 *   instance is pulled at construction.
 *
 * Returns the merged defs raw. Main-session callers add their presentation and
 * checkpoint decorators before registration; subagent callers consume the raw
 * definitions allowed by their grants. `cwdRef.get()` is read live inside
 * `execute`.
 *
 * @see BuiltinToolSdk for why the SDK param is this narrow type, not `PiSdk`.
 */
export function buildStockBuiltinTools(
  sdk: BuiltinToolSdk,
  cwdRef: CwdState,
  deps: BuiltinToolDeps,
): StockBuiltinTool[] {
  const bashOptions = makeBuiltinBashOptions(deps);
  const factories: Array<
    [string, (cwd: string) => BuiltinToolInstance, (cwd: string) => BuiltinToolDefinition]
  > = [
    ["bash", (c) => sdk.createBashTool(c, bashOptions), (c) => sdk.createBashToolDefinition(c)],
    ["read", (c) => sdk.createReadTool(c), (c) => sdk.createReadToolDefinition(c)],
    ["write", (c) => sdk.createWriteTool(c), (c) => sdk.createWriteToolDefinition(c)],
    ["edit", (c) => sdk.createEditTool(c), (c) => sdk.createEditToolDefinition(c)],
    ["grep", (c) => sdk.createGrepTool(c), (c) => sdk.createGrepToolDefinition(c)],
    ["find", (c) => sdk.createFindTool(c), (c) => sdk.createFindToolDefinition(c)],
    ["ls", (c) => sdk.createLsTool(c), (c) => sdk.createLsToolDefinition(c)],
  ];
  const tools: StockBuiltinTool[] = [];
  for (const [name, factory, defFactory] of factories) {
    const template = factory(cwdRef.get());
    // Renderers only (execute stays sourced from `factory` below, byte-identical).
    const def = defFactory(cwdRef.get());
    // `read` gains the notebook/image/binary routing wrapper; every other tool
    // delegates straight to its live-cwd instance. Both re-source the execute
    // from `factory(cwdRef.get())` per call so the worktree cwd swap is honored.
    const execute =
      name === "read"
        ? async (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) =>
            routeReadExecute(() => factory(cwdRef.get()), cwdRef.get(), id, params, signal, onUpdate, ctx)
        : async (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => {
            const live = factory(cwdRef.get());
            return live.execute(id, params, signal, onUpdate, ctx);
          };
    tools.push({
      name,
      def: {
        ...template,
        name,
        renderCall: def.renderCall,
        renderResult: def.renderResult,
        execute,
      },
    });
  }
  return tools;
}
