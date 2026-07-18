import type { ImageContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Shared image / binary / vision primitives. This module is PURE (no session,
// no Pi object, no I/O beyond the buffers a caller hands it) and is the single
// seam the notebook renderer, the Read routing, and the model-vision surface
// build on.
//
// Two Pi helpers this feature needs are NOT reachable through the package
// `exports` map (only `.` and `./rpc-entry` resolve), so they are REPRODUCED
// here — the same pattern `tool-shell.ts` uses for `getTextOutput`/`ansiRegex`:
//   - the magic-byte image sniff (`detectSupportedImageMimeType`, dist/utils/mime.js),
//     reproduced as `sniffImageMime`;
//   - the non-vision note wording (`getNonVisionImageNote`, dist/core/tools/read.js),
//     reproduced as `NON_VISION_IMAGE_NOTE`.
// Both are pinned to Pi's own via a `file://` smoke test (test/image-ingest-pi-contract
// .test.ts) so a Pi version bump that changes either fails loudly instead of
// silently diverging.
//
// `resizeImage` and `convertToPng` ARE reachable from the package root and are
// imported (never reproduced) — the normalization pipeline stays Pi's own.
// ---------------------------------------------------------------------------

/**
 * The full Pi raster set — exactly what Pi's stock `detectSupportedImageMimeType`
 * renders as an image, BMP included. This MUST equal Pi's set so the
 * image-vs-binary gate never sends a Pi-renderable image to the binary-error path
 * (a BMP that Pi renders must NOT become `BINARY_READ_ERROR`). `image/svg+xml` is
 * excluded on purpose — it is XML, not raster, and is never turned into an image
 * block. The notebook renderer emits image blocks for this same set: there is
 * one supported-raster set, not two.
 */
export const SUPPORTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
] as const;

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

/**
 * The stable, Claude-faithful prefix a caller returns for an unsupported binary
 * read. A caller MAY append a short type suffix (that suffix is PiCC's own
 * wording); tests assert this prefix, not a byte-exact whole string.
 */
export const BINARY_READ_ERROR = "This tool cannot read binary files." as const;

/**
 * The non-vision note wording, reproduced verbatim from Pi's
 * `getNonVisionImageNote` (dist/core/tools/read.js). Pinned by the `file://`
 * contract test so a Pi wording change fails loudly.
 */
export const NON_VISION_IMAGE_NOTE =
  "[Current model does not support images. The image will be omitted from this request.]" as const;

// --- guardrail limits (decompression-bomb + oversize input) ----------------
//
// The exact numbers are deliberately generous — a real screenshot/plot passes;
// only implausible declared geometry or an absurd payload is rejected BEFORE the
// resizer decodes.

/** Reject any single declared side beyond this many pixels (bomb guard). */
const MAX_IMAGE_DIMENSION = 20_000;
/** Reject any declared pixel area beyond this (a small file can declare huge dims). */
const MAX_IMAGE_PIXELS = 100_000_000; // 100 MP
/** Reject an encoded input larger than this before handing bytes to the resizer. */
const MAX_ENCODED_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB
/** Bounded window the dimension guard reads — the format HEADER only, never a decode. */
const HEADER_SCAN_WINDOW = 64 * 1024; // 64 KB (JPEG SOF can trail a large APP segment)

// ---------------------------------------------------------------------------
// Magic-byte sniff — reproduced from Pi's `detectSupportedImageMimeType`.
// Byte signatures (incl. BMP validity and the animated-PNG / JPEG-2000
// exclusions) mirror Pi exactly; the `file://` pin test guards the equivalence.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function byteAt(buffer: Buffer, offset: number): number {
  return buffer[offset] ?? 0;
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Buffer, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16LE(buffer: Buffer, offset: number): number {
  return byteAt(buffer, offset) + (byteAt(buffer, offset + 1) << 8);
}

function readUint32BE(buffer: Buffer, offset: number): number {
  return (
    byteAt(buffer, offset) * 0x1000000 +
    (byteAt(buffer, offset + 1) << 16) +
    (byteAt(buffer, offset + 2) << 8) +
    byteAt(buffer, offset + 3)
  );
}

function readUint32LE(buffer: Buffer, offset: number): number {
  return (
    byteAt(buffer, offset) +
    (byteAt(buffer, offset + 1) << 8) +
    (byteAt(buffer, offset + 2) << 16) +
    byteAt(buffer, offset + 3) * 0x1000000
  );
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 16 &&
    readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function isBmp(buffer: Buffer): boolean {
  if (buffer.length < 26) return false;
  const declaredFileSize = readUint32LE(buffer, 2);
  const pixelDataOffset = readUint32LE(buffer, 10);
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
  if (pixelDataOffset < 14 + dibHeaderSize) return false;
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;
  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) return false;
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

/**
 * Magic-byte image detection. Returns one of `SUPPORTED_IMAGE_MIMES` or `null`.
 * The extension is NEVER trusted — only bytes decide. Mirrors Pi's
 * `detectSupportedImageMimeType` exactly (the `file://` pin test asserts parity).
 */
export function sniffImageMime(buffer: Buffer): SupportedImageMime | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    // 0xFFD8FFF7 is JPEG-2000-ish / SOF7 — Pi excludes it.
    return byteAt(buffer, 3) === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
    return "image/bmp";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Binary detection — byte-based and locale-independent (never a charset guess).
// A NUL byte in a bounded header window, or a high ratio of non-text bytes, marks
// a buffer binary. Returns `false` for a supported-image buffer even though
// callers exclude images first (kept robust).
// ---------------------------------------------------------------------------

/** Header window scanned for the binary heuristic. */
const BINARY_SCAN_WINDOW = 8_000;
/** Fraction of non-text bytes in the window above which a buffer is binary. */
const BINARY_NONTEXT_RATIO = 0.3;

function isTextByte(byte: number): boolean {
  // Printable ASCII, common whitespace (tab/LF/CR/FF/VT), ESC, or any high byte
  // (UTF-8 multibyte lead/continuation). Everything else is a control byte.
  if (byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d) return true;
  if (byte === 0x1b) return true;
  if (byte >= 0x20 && byte <= 0x7e) return true;
  if (byte >= 0x80) return true;
  return false;
}

/**
 * True iff `buffer` looks like a non-text binary. Bounded, byte-based, and
 * locale-independent: a NUL in the header window is decisive, otherwise the
 * non-text-byte ratio over the window decides.
 */
export function isBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  // A supported image is not "binary" for routing purposes (callers exclude
  // images first, but keep this robust so a stray call is not misclassified).
  if (sniffImageMime(buffer) !== null) return false;
  const window = Math.min(buffer.length, BINARY_SCAN_WINDOW);
  let nonText = 0;
  for (let i = 0; i < window; i++) {
    const byte = byteAt(buffer, i);
    if (byte === 0x00) return true; // NUL — decisive
    if (!isTextByte(byte)) nonText++;
  }
  return nonText / window > BINARY_NONTEXT_RATIO;
}

// ---------------------------------------------------------------------------
// Model-vision predicate + non-vision note.
// ---------------------------------------------------------------------------

/**
 * True iff the model's input modalities include `"image"`. Tolerant of a
 * missing/opaque model (defaults to `false`) — mirrors the condition Pi's
 * `getNonVisionImageNote` keys on (`model.input.includes("image")`).
 */
export function modelSupportsImages(model: unknown): boolean {
  const input = (model as { input?: unknown } | null | undefined)?.input;
  return Array.isArray(input) && input.includes("image");
}

/**
 * The reproduced Pi non-vision note. Returns the wording so callers use it
 * instead of inventing a thinner placeholder. The `model` param is accepted for
 * call-site symmetry; the returned wording is constant.
 */
export function nonVisionImageNote(_model?: unknown): string {
  return NON_VISION_IMAGE_NOTE;
}

// ---------------------------------------------------------------------------
// Header-only dimension guard (decompression-bomb). Reads the FORMAT HEADER of
// each supported raster type over a bounded window — never a full decode, or the
// guard itself becomes the bomb. Encoded-size alone is insufficient: a tiny file
// can declare enormous dimensions, so this header check is load-bearing.
// ---------------------------------------------------------------------------

interface Dimensions {
  width: number;
  height: number;
}

function pngDimensions(buffer: Buffer): Dimensions | null {
  if (!isPng(buffer)) return null;
  return { width: readUint32BE(buffer, 16), height: readUint32BE(buffer, 20) };
}

function gifDimensions(buffer: Buffer): Dimensions | null {
  if (buffer.length < 10) return null;
  return { width: readUint16LE(buffer, 6), height: readUint16LE(buffer, 8) };
}

function bmpDimensions(buffer: Buffer): Dimensions | null {
  if (buffer.length < 26) return null;
  const dibHeaderSize = readUint32LE(buffer, 14);
  if (dibHeaderSize === 12) {
    return { width: readUint16LE(buffer, 18), height: readUint16LE(buffer, 20) };
  }
  if (dibHeaderSize >= 40) {
    // width/height are signed int32; height may be negative (top-down).
    const width = readUint32LE(buffer, 18) | 0;
    const height = readUint32LE(buffer, 22) | 0;
    return { width: Math.abs(width), height: Math.abs(height) };
  }
  return null;
}

function webpDimensions(buffer: Buffer): Dimensions | null {
  if (buffer.length < 30) return null;
  const fourCC =
    String.fromCharCode(byteAt(buffer, 12)) +
    String.fromCharCode(byteAt(buffer, 13)) +
    String.fromCharCode(byteAt(buffer, 14)) +
    String.fromCharCode(byteAt(buffer, 15));
  if (fourCC === "VP8X") {
    const width = 1 + (byteAt(buffer, 24) + (byteAt(buffer, 25) << 8) + (byteAt(buffer, 26) << 16));
    const height = 1 + (byteAt(buffer, 27) + (byteAt(buffer, 28) << 8) + (byteAt(buffer, 29) << 16));
    return { width, height };
  }
  if (fourCC === "VP8 ") {
    // Lossy: 3-byte frame tag, 3-byte start code (0x9d 0x01 0x2a), then 14-bit dims.
    const width = readUint16LE(buffer, 26) & 0x3fff;
    const height = readUint16LE(buffer, 28) & 0x3fff;
    return { width, height };
  }
  if (fourCC === "VP8L") {
    // Lossless: 0x2f signature at 20, then 14-bit width-1 / 14-bit height-1.
    if (byteAt(buffer, 20) !== 0x2f) return null;
    const bits =
      byteAt(buffer, 21) +
      (byteAt(buffer, 22) << 8) +
      (byteAt(buffer, 23) << 16) +
      byteAt(buffer, 24) * 0x1000000;
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return { width, height };
  }
  return null;
}

function jpegDimensions(buffer: Buffer): Dimensions | null {
  const end = Math.min(buffer.length, HEADER_SCAN_WINDOW);
  let offset = 2; // past FFD8
  while (offset + 9 < end) {
    if (byteAt(buffer, offset) !== 0xff) {
      offset++;
      continue;
    }
    const marker = byteAt(buffer, offset + 1);
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    // SOF0..SOF15 carry the frame geometry, EXCEPT DHT(C4)/JPG(C8)/DAC(CC).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: (byteAt(buffer, offset + 5) << 8) + byteAt(buffer, offset + 6),
        width: (byteAt(buffer, offset + 7) << 8) + byteAt(buffer, offset + 8),
      };
    }
    const segmentLength = (byteAt(buffer, offset + 2) << 8) + byteAt(buffer, offset + 3);
    if (segmentLength < 2) return null; // malformed — stop, don't loop forever
    offset += 2 + segmentLength;
  }
  return null;
}

/** Declared pixel dimensions from the format header, or `null` if unreadable. */
function declaredDimensions(buffer: Buffer, mimeType: SupportedImageMime): Dimensions | null {
  switch (mimeType) {
    case "image/png":
      return pngDimensions(buffer);
    case "image/jpeg":
      return jpegDimensions(buffer);
    case "image/gif":
      return gifDimensions(buffer);
    case "image/webp":
      return webpDimensions(buffer);
    case "image/bmp":
      return bmpDimensions(buffer);
  }
}

// ---------------------------------------------------------------------------
// Normalize raw bytes → a normalized ImageContent, through Pi's own pipeline.
//
// FAILURE SHAPE: the stated signature is `Promise<ImageContent>`, so on any
// invalid/oversize/bomb input this THROWS an `Error` rather than returning a
// discriminated union — the caller wraps the call and degrades to a text
// placeholder on throw. This helper is consumed only by the notebook path; the
// image-file Read path delegates to Pi's own read and never calls this.
// ---------------------------------------------------------------------------

/** The formats `resizeImage` can encode directly; anything else is PNG-converted first (as Pi does). */
const RESIZE_NATIVE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Normalize decoded image `buffer` (claimed to be `mimeType`) into a normalized
 * `ImageContent` via Pi's `resizeImage` (Pi defaults: ~2000px longest side, JPEG
 * re-encode under the byte cap). The output byte cap is sourced from
 * `opts.maxBytes` when given, else Pi's own default (never hard-coded here).
 *
 * The caller passes DECODED bytes: a notebook image output is a base64 string, so
 * the caller must `Buffer.from(value, "base64")` before calling this.
 *
 * Guardrails run BEFORE any decode: the encoded input must be under the size cap,
 * the magic bytes must match `mimeType`, and the header-declared dimensions must
 * be readable and plausible (decompression-bomb guard). An unreadable header
 * fails closed. Any violation throws.
 */
export async function toImageContent(
  buffer: Buffer,
  mimeType: string,
  opts?: { maxBytes?: number },
): Promise<ImageContent> {
  if (!(SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mimeType)) {
    throw new Error(`toImageContent: unsupported image mime "${mimeType}"`);
  }
  // Reject oversized input before any parsing so a huge payload never reaches the
  // sniff/header walk.
  if (buffer.length > MAX_ENCODED_INPUT_BYTES) {
    throw new Error(
      `toImageContent: encoded input ${buffer.length} bytes exceeds cap ${MAX_ENCODED_INPUT_BYTES}`,
    );
  }
  // Never trust the claimed mime — the bytes must be that raster type. This also
  // excludes svg+xml and any non-raster payload (sniff returns null → mismatch).
  const sniffed = sniffImageMime(buffer);
  if (sniffed === null || sniffed !== mimeType) {
    throw new Error(
      `toImageContent: bytes do not match claimed mime "${mimeType}" (sniffed ${sniffed ?? "null"})`,
    );
  }
  // Fail CLOSED: for a buffer that sniffed as a supported raster, an unreadable
  // header means the bomb guard cannot run. Pi's Photon resizer does a full decode
  // with no pre-decode pixel guard, so this header check is the only bomb guard —
  // proceeding on unverifiable dimensions (e.g. a crafted JPEG whose SOF sits
  // beyond the scan window) would defeat it. Reject without decoding any bytes.
  const dims = declaredDimensions(buffer, sniffed);
  if (dims === null) {
    throw new Error(
      `toImageContent: cannot verify image dimensions for "${mimeType}" (unreadable header)`,
    );
  }
  if (
    dims.width > MAX_IMAGE_DIMENSION ||
    dims.height > MAX_IMAGE_DIMENSION ||
    dims.width * dims.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error(
      `toImageContent: declared dimensions ${dims.width}x${dims.height} exceed the decompression-bomb guard`,
    );
  }

  const resizeOptions = opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : undefined;

  // Pi's image codecs are loaded lazily, only when an image is actually
  // normalized. Importing them at module load pulls Pi's Photon/WASM worker
  // machinery into every module that imports this file — including the built-in
  // `read` factory on the session hot path — which deadlocks in fork-heavy
  // contexts. Deferring the import here keeps the detection helpers (sniff/binary)
  // free of that side effect, so only a real image render pays the cost.
  const { convertToPng, resizeImage } = await import("@earendil-works/pi-coding-agent");

  // Pi resizes png/jpeg/gif/webp directly; anything else (BMP) is converted to
  // PNG first, exactly as Pi's `processImage`/`normalizeImage` does.
  let bytes: Uint8Array = new Uint8Array(buffer);
  let resizeMime: string = mimeType;
  if (!RESIZE_NATIVE_MIMES.includes(mimeType)) {
    const png = await convertToPng(buffer.toString("base64"), mimeType);
    if (!png) {
      throw new Error(`toImageContent: could not convert ${mimeType} to a supported inline format`);
    }
    bytes = new Uint8Array(Buffer.from(png.data, "base64"));
    resizeMime = png.mimeType;
  }

  const resized = await resizeImage(bytes, resizeMime, resizeOptions);
  if (!resized) {
    throw new Error("toImageContent: could not normalize image below the inline size limit");
  }
  return { type: "image", data: resized.data, mimeType: resized.mimeType };
}
