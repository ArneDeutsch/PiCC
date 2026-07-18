import { afterAll, beforeAll, describe, expect, it } from "vitest";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as piSdk from "@earendil-works/pi-coding-agent";
import picc from "../src/index.js";
import { buildStockBuiltinTools, type BuiltinToolSdk } from "../src/runtime/builtin-tools.js";
import { CwdState } from "../src/runtime/cwd-state.js";
import { BINARY_READ_ERROR } from "../src/runtime/image-ingest.js";
import { MAX_NOTEBOOK_BYTES } from "../src/runtime/notebook-render.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSdkHandle } from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

// ---------------------------------------------------------------------------
// Routing is added in the SHARED built-in factory (buildStockBuiltinTools), the
// exact call both the main session and dispatched subagents make to build their
// `read`. Layer-1 exercises the real Pi read through that factory; Layer-2 proves
// the same routing reaches a dispatched subagent.
// ---------------------------------------------------------------------------

interface Block {
  type: string;
  text?: string;
}
interface ReadRes {
  content: Block[];
  details?: Record<string, unknown>;
}

const VISION_CTX = { model: { input: ["text", "image"] } } as never;
const NONVISION_CTX = { model: { input: ["text"] } } as never;

/** Join the text of every text block, for content assertions. */
function joinText(res: ReadRes): string {
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.text ?? "").replace(/\r\n/g, "\n"))
    .join("\n");
}

function hasImageBlock(res: ReadRes): boolean {
  return res.content.some((b) => b.type === "image");
}

// --- deterministic in-test image fixtures (no committed binaries) -----------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A real 8-bit grayscale PNG of w×h whose IDAT actually decodes (Photon-decodable). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc(height * (1 + width));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** A valid uncompressed 24bpp BMP of w×h — pins the BMP-in-the-raster-set regression fix. */
function makeBmp(width: number, height: number): Buffer {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  return buf;
}

function notebookWithImage(): unknown {
  const pngB64 = makePng(6, 6).toString("base64");
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: "markdown", id: "md", source: "# Title\nProse here." },
      {
        cell_type: "code",
        id: "code-1",
        source: "print('hi')",
        outputs: [{ output_type: "stream", name: "stdout", text: "STREAM_MARKER\n" }],
      },
      {
        cell_type: "code",
        id: "code-img",
        source: "fig",
        outputs: [
          {
            output_type: "display_data",
            data: { "image/png": pngB64, "text/plain": "<Figure size 640x480>" },
          },
        ],
      },
    ],
  };
}

// ===========================================================================
// Layer 1 — real Pi read through the shared factory
// ===========================================================================

describe("Read routing (shared factory + real Pi read)", () => {
  let dir: string;
  let read: { execute(id: string, p: unknown, s: unknown, u: unknown, c: unknown): Promise<ReadRes> };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-readroute-"));
    fs.writeFileSync(path.join(dir, "rich.ipynb"), JSON.stringify(notebookWithImage()));
    fs.writeFileSync(path.join(dir, "empty-cells.ipynb"), JSON.stringify({ nbformat: 4, cells: [] }));
    fs.writeFileSync(path.join(dir, "bad.ipynb"), "this is not { valid json");
    fs.writeFileSync(path.join(dir, "v3.ipynb"), JSON.stringify({ nbformat: 3, worksheets: [] }));
    // Over-limit .ipynb — a sparse file whose stat size exceeds the cap without
    // writing megabytes; the pre-read stat must reject it before any read.
    const huge = path.join(dir, "huge.ipynb");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, MAX_NOTEBOOK_BYTES + 1);
    // Binaries, built in-test as Buffers.
    fs.writeFileSync(
      path.join(dir, "nul.bin"),
      Buffer.concat([Buffer.from("head"), Buffer.from([0x00, 0x01, 0x02]), Buffer.from("tail")]),
    );
    fs.writeFileSync(
      path.join(dir, "doc.pdf"),
      Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n", "latin1"),
    );
    fs.writeFileSync(path.join(dir, "pic.png"), makePng(8, 8));
    fs.writeFileSync(path.join(dir, "pic.bmp"), makeBmp(8, 8));
    fs.writeFileSync(path.join(dir, "plain.txt"), "hello world\nsecond line\n");
    // SVG is XML, not raster: sniffImageMime → null AND isBinaryBuffer → false,
    // so it must fall through to Pi's text read, never the binary error.
    fs.writeFileSync(
      path.join(dir, "vector.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n',
    );

    const tools = buildStockBuiltinTools(piSdk as unknown as BuiltinToolSdk, new CwdState(dir), {
      settingsEnv: {},
      projectRoot: dir,
    });
    read = tools.find((t) => t.name === "read")!.def as never;
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (params: unknown, ctx: unknown): Promise<ReadRes> =>
    read.execute("call", params, undefined, undefined, ctx);

  it("renders an .ipynb cell-aware (not raw notebook JSON)", async () => {
    const res = await run({ path: "rich.ipynb" }, NONVISION_CTX);
    const text = joinText(res);
    expect(text).toContain("=== Cell 0 (markdown");
    expect(text).toContain("=== Cell 1 (code");
    expect(text).toContain("STREAM_MARKER");
    // Not the raw JSON.
    expect(text).not.toContain('"nbformat"');
    expect(text).not.toContain('"cell_type"');
  });

  it("emits a real image block for a notebook image output on a vision model", async () => {
    const res = await run({ path: "rich.ipynb" }, VISION_CTX);
    expect(hasImageBlock(res)).toBe(true);
    // The sibling text/plain is still rendered.
    expect(joinText(res)).toContain("<Figure size 640x480>");
  });

  it("degrades a notebook image output to a placeholder on a non-vision model", async () => {
    const res = await run({ path: "rich.ipynb" }, NONVISION_CTX);
    expect(hasImageBlock(res)).toBe(false);
    const text = joinText(res);
    expect(text).toContain("image/png");
    expect(text).toContain("does not support images");
  });

  it("returns a notice (not a throw) for a valid 0-cell notebook", async () => {
    const res = await run({ path: "empty-cells.ipynb" }, NONVISION_CTX);
    expect(joinText(res)).toContain("0 cells");
  });

  it("degrades bad-JSON / missing-cells / missing-file .ipynb to a read-shaped notice, no throw", async () => {
    for (const p of ["bad.ipynb", "v3.ipynb", "does-not-exist.ipynb"]) {
      const res = await run({ path: p }, NONVISION_CTX);
      const text = joinText(res);
      expect(text).toContain("Could not read notebook");
      expect(text).toContain(p);
    }
  });

  it("rejects an over-limit .ipynb via the pre-read stat", async () => {
    const res = await run({ path: "huge.ipynb" }, NONVISION_CTX);
    const text = joinText(res);
    expect(text).toContain("Could not read notebook");
    expect(text).toContain("larger than");
  });

  it("returns the Claude-style binary error for a null-byte binary (no mojibake/raw bytes)", async () => {
    const res = await run({ path: "nul.bin" }, NONVISION_CTX);
    const text = joinText(res);
    expect(text.startsWith(BINARY_READ_ERROR)).toBe(true);
    expect(hasImageBlock(res)).toBe(false);
    expect(text).not.toContain(String.fromCharCode(0)); // no raw NUL
    expect(text).not.toContain(String.fromCharCode(0xfffd)); // no mojibake replacement char
    expect(text).not.toContain("head"); // no sniffed byte content leaked
    expect(text).not.toContain("tail");
  });

  it("names PDF as not-yet-supported (prefix + PDF suffix), not a generic binary", async () => {
    const res = await run({ path: "doc.pdf" }, NONVISION_CTX);
    const text = joinText(res);
    expect(text.startsWith(BINARY_READ_ERROR)).toBe(true);
    expect(text).toContain("PDF");
    expect(text).toMatch(/not support|yet/);
  });

  it("delegates a real PNG file to Pi's read → image block, not the binary error", async () => {
    const res = await run({ path: "pic.png" }, VISION_CTX);
    expect(hasImageBlock(res)).toBe(true);
    expect(joinText(res).startsWith(BINARY_READ_ERROR)).toBe(false);
  });

  it("delegates a real BMP file to Pi's read → image block, not the binary error", async () => {
    const res = await run({ path: "pic.bmp" }, VISION_CTX);
    expect(hasImageBlock(res)).toBe(true);
    expect(joinText(res).startsWith(BINARY_READ_ERROR)).toBe(false);
  });

  it("delegates an .svg file to Pi's text read, NOT the binary error", async () => {
    const res = await run({ path: "vector.svg" }, NONVISION_CTX);
    const text = joinText(res);
    // SVG sniffs to null (excluded from the raster set) and is not binary (XML
    // text), so it falls through to Pi's read as text — never the binary error,
    // never an image block.
    expect(text.startsWith(BINARY_READ_ERROR)).toBe(false);
    expect(hasImageBlock(res)).toBe(false);
    expect(text).toContain("<svg");
    expect(text).toContain("<rect");
  });

  it("delegates a plain-text file to Pi's read unchanged", async () => {
    const res = await run({ path: "plain.txt" }, NONVISION_CTX);
    const text = joinText(res);
    expect(text).toContain("hello world");
    expect(text).toContain("second line");
    expect(text.startsWith(BINARY_READ_ERROR)).toBe(false);
  });
});

// ===========================================================================
// Layer 2 — a dispatched subagent's Read inherits the routing
// ===========================================================================

describe("Read routing reaches a dispatched subagent", () => {
  let dir: string;
  let pi: FakePi;
  let h: FakeSdkHandle;
  const originalCwd = process.cwd();
  const originalUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(async () => {
    dir = materializeFixture("full-surface");
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    fs.writeFileSync(path.join(dir, "sub.ipynb"), JSON.stringify(notebookWithImage()));
    fs.writeFileSync(
      path.join(dir, "sub.bin"),
      Buffer.concat([Buffer.from("x"), Buffer.from([0x00, 0x00]), Buffer.from("y")]),
    );

    h = fakeSdk({ onPrompt: async () => "OK" });
    pi = fakePi();
    picc(pi.api as never, { sdk: h.sdk, onInitializationSettled: pi.captureInitialization });
    await pi.waitForInitialization();
    await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (originalUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = originalUserDir;
    cleanupFixture(dir);
  });

  async function subagentRead(): Promise<FakeCustomTool> {
    const agentTool = pi.tools.get("Agent");
    const res = await agentTool.execute("a1", {
      subagent_type: "future-agent",
      prompt: "go",
      run_in_background: false,
    });
    expect(res.details.outcome).toBe("completed");
    const owner = h.created.find((opts) =>
      ((opts.customTools as FakeCustomTool[]) ?? []).some((t) => t.name === "read"),
    );
    const readTool = ((owner?.customTools as FakeCustomTool[]) ?? []).find((t) => t.name === "read");
    expect(readTool, "a dispatched subagent got a read customTool").toBeDefined();
    return readTool!;
  }

  it("renders an .ipynb cell-aware in a dispatched subagent", async () => {
    const readTool = await subagentRead();
    const res = (await readTool.execute("r1", { path: "sub.ipynb" })) as unknown as ReadRes;
    expect(joinText(res)).toContain("=== Cell 0 (markdown");
  });

  it("returns the binary error for a binary file in a dispatched subagent", async () => {
    const readTool = await subagentRead();
    const res = (await readTool.execute("r2", { path: "sub.bin" })) as unknown as ReadRes;
    expect(joinText(res).startsWith(BINARY_READ_ERROR)).toBe(true);
  });
});
