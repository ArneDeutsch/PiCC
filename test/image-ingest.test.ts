import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  BINARY_READ_ERROR,
  SUPPORTED_IMAGE_MIMES,
  isBinaryBuffer,
  modelSupportsImages,
  sniffImageMime,
  toImageContent,
} from "../src/runtime/image-ingest.js";

// --- deterministic in-test fixture builders (no committed binaries) ---------

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
  ihdr[9] = 0; // color type: grayscale
  const raw = Buffer.alloc(height * (1 + width)); // filter byte + row, all zero
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A real grayscale PNG whose pixels are pseudo-random, so it does not compress to near-nothing. */
function makeNoisyPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc(height * (1 + width));
  let seed = 0x1234_5678;
  for (let row = 0; row < height; row++) {
    const base = row * (1 + width);
    raw[base] = 0; // filter byte
    for (let col = 0; col < width; col++) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff; // LCG → high-entropy pixels
      raw[base + 1 + col] = (seed >>> 16) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A PNG whose IHDR DECLARES huge dimensions but carries no real pixels — a bomb header. */
function makeBombPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IEND", Buffer.alloc(0))]);
}

/** An animated PNG: a valid PNG whose `acTL` chunk precedes IDAT. Must sniff to null. */
function makeApng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const actl = Buffer.alloc(8); // num_frames, num_plays
  actl.writeUInt32BE(2, 0);
  actl.writeUInt32BE(0, 4);
  const raw = Buffer.alloc(height * (1 + width));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    pngChunk("acTL", actl),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A NUL-free buffer with the given fraction of non-text control bytes (0x01) padded with 'a'. */
function makeControlHeavy(total: number, nonTextCount: number): Buffer {
  const bytes = Buffer.alloc(total, 0x61); // 'a' (text)
  for (let i = 0; i < nonTextCount; i++) bytes[i] = 0x01; // control byte, non-NUL
  return bytes;
}

function makeGif(): Buffer {
  // "GIF89a" + logical screen descriptor (10×20) + minimal terminator.
  const head = Buffer.from("GIF89a", "ascii");
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(10, 0);
  lsd.writeUInt16LE(20, 2);
  return Buffer.concat([head, lsd, Buffer.from([0x3b])]);
}

function makeWebp(): Buffer {
  // RIFF container, VP8L lossless, canvas 4×4.
  const vp8l = Buffer.alloc(9);
  vp8l[0] = 0x2f; // VP8L signature
  const w = 4 - 1;
  const h = 4 - 1;
  const bits = (w & 0x3fff) | ((h & 0x3fff) << 14);
  vp8l.writeUInt32LE(bits >>> 0, 1);
  const body = Buffer.concat([Buffer.from("VP8L", "ascii"), (() => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(vp8l.length, 0);
    return b;
  })(), vp8l]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), riffSize, Buffer.from("WEBP", "ascii"), body]);
}

/** A valid uncompressed 24bpp BMP of w×h (BITMAPINFOHEADER). */
function makeBmp(width: number, height: number): Buffer {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // DIB header size (BITMAPINFOHEADER)
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // color planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  return buf;
}

const SVG = Buffer.from(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>',
  "utf-8",
);

// --- read IHDR width from an output PNG (proves the resizer actually shrank) --
function pngWidth(base64: string): number {
  const buf = Buffer.from(base64, "base64");
  return buf.readUInt32BE(16);
}

describe("sniffImageMime — magic bytes, never the extension", () => {
  it("detects each supported raster type incl. image/bmp", () => {
    expect(sniffImageMime(makePng(4, 4))).toBe("image/png");
    // Minimal JPEG SOI+APP0 marker.
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe("image/jpeg");
    expect(sniffImageMime(makeGif())).toBe("image/gif");
    expect(sniffImageMime(makeWebp())).toBe("image/webp");
    // BMP-parity fix is pinned here: a valid BMP must sniff to image/bmp, not null.
    expect(sniffImageMime(makeBmp(2, 2))).toBe("image/bmp");
  });

  it("returns null for text and for svg (svg is XML, not raster)", () => {
    expect(sniffImageMime(Buffer.from("just some plain text\n", "utf-8"))).toBeNull();
    expect(sniffImageMime(SVG)).toBeNull();
  });

  it("rejects the JPEG-2000-ish 0xFFD8FFF7 exclusion", () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xf7]))).toBeNull();
  });

  it("excludes an animated PNG (acTL chunk before IDAT) → null, not image/png", () => {
    // A still PNG of the same geometry must still be accepted, so the acTL walk
    // (not the signature) is what rejects the APNG.
    expect(sniffImageMime(makePng(4, 4))).toBe("image/png");
    expect(sniffImageMime(makeApng(4, 4))).toBeNull();
  });

  it("SUPPORTED_IMAGE_MIMES is Pi's full five-type raster set including bmp", () => {
    expect([...SUPPORTED_IMAGE_MIMES]).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
    ]);
  });
});

describe("isBinaryBuffer — byte-based, locale-independent", () => {
  it("returns true for a buffer with a NUL byte", () => {
    expect(isBinaryBuffer(Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]))).toBe(true);
  });

  it("returns false for UTF-8 text (incl. multibyte)", () => {
    expect(isBinaryBuffer(Buffer.from("hello — grüße 日本語\n", "utf-8"))).toBe(false);
  });

  it("returns false for a supported-image buffer (a PNG is not 'binary')", () => {
    expect(isBinaryBuffer(makePng(4, 4))).toBe(false);
  });

  it("returns true for a NUL-free, control-byte-heavy buffer (non-text-ratio branch)", () => {
    // No NUL byte, so the ratio branch (not the decisive-NUL branch) decides:
    // 40% of 100 bytes are control bytes (0x01) → above the 30% threshold.
    expect(isBinaryBuffer(makeControlHeavy(100, 40))).toBe(true);
  });

  it("returns false just under the non-text-ratio threshold (pins the boundary)", () => {
    // 29% non-text, NUL-free — just below the 30% threshold → still text.
    expect(isBinaryBuffer(makeControlHeavy(100, 29))).toBe(false);
  });
});

describe("modelSupportsImages", () => {
  it("true for a vision model double, false for a non-vision one", () => {
    expect(modelSupportsImages({ input: ["text", "image"] })).toBe(true);
    expect(modelSupportsImages({ input: ["text"] })).toBe(false);
  });

  it("defaults to false for a missing/opaque model", () => {
    expect(modelSupportsImages(undefined)).toBe(false);
    expect(modelSupportsImages(null)).toBe(false);
    expect(modelSupportsImages({})).toBe(false);
    expect(modelSupportsImages("not-a-model")).toBe(false);
  });

  it("BINARY_READ_ERROR is the stable Claude-faithful prefix", () => {
    expect(BINARY_READ_ERROR).toBe("This tool cannot read binary files.");
  });
});

describe("toImageContent — normalization + guardrails", () => {
  it("shrinks an oversized (>2000px) image (proves the resizer is wired, not a passthrough)", async () => {
    const input = makePng(2500, 10); // longest side 2500 > Pi's ~2000 default
    expect(pngWidth(input.toString("base64"))).toBe(2500); // input really declares 2500
    const content = await toImageContent(input, "image/png");
    expect(content.type).toBe("image");
    expect((SUPPORTED_IMAGE_MIMES as readonly string[]).includes(content.mimeType)).toBe(true);
    // The output PNG's declared width must have actually shrunk below the input.
    expect(content.mimeType).toBe("image/png");
    const outWidth = pngWidth(content.data);
    expect(outWidth).toBeLessThan(2500);
    expect(outWidth).toBeLessThanOrEqual(2000);
  });

  it("normalizes a BMP (converts to PNG as Pi does)", async () => {
    const content = await toImageContent(makeBmp(3, 3), "image/bmp");
    expect(content.type).toBe("image");
    expect(content.mimeType).toBe("image/png"); // BMP is PNG-converted before resize
    expect(content.data.length).toBeGreaterThan(0);
  });

  it("rejects a decompression-bomb header (huge declared dims, tiny file)", async () => {
    const bomb = makeBombPng(100_000, 100_000); // ~40 bytes, declares 10^10 pixels
    expect(bomb.length).toBeLessThan(100);
    await expect(toImageContent(bomb, "image/png")).rejects.toThrow(/decompression-bomb/);
  });

  it("rejects bytes that do not match the claimed mime", async () => {
    await expect(toImageContent(Buffer.from("not an image", "utf-8"), "image/png")).rejects.toThrow(
      /do not match/,
    );
  });

  it("rejects an unsupported mime (e.g. svg)", async () => {
    await expect(toImageContent(SVG, "image/svg+xml")).rejects.toThrow(/unsupported image mime/);
  });

  it("honors an explicit opts.maxBytes (output within the cap, differs from the default path)", async () => {
    const input = makeNoisyPng(300, 300); // noisy → default output is well above the small cap
    const dflt = await toImageContent(input, "image/png");
    const maxBytes = 20_000;
    // The default (uncapped) output must actually exceed the cap, or the test is vacuous.
    expect(Buffer.byteLength(dflt.data, "utf-8")).toBeGreaterThan(maxBytes);

    const capped = await toImageContent(input, "image/png", { maxBytes });
    expect(capped.type).toBe("image");
    // The cap is honored: the encoded (base64) output stays under it.
    expect(Buffer.byteLength(capped.data, "utf-8")).toBeLessThan(maxBytes);
    // And it genuinely differs from the default-path output.
    expect(capped.data).not.toBe(dflt.data);
  });

  it("fails closed when the header is unreadable (dimensions cannot be verified)", async () => {
    // A JPEG whose SOI+APP0 sniff as image/jpeg but which carries no SOF frame
    // marker (the SOF sits beyond the scan window in the real attack) → the bomb
    // guard cannot read dimensions, so it must reject rather than hand bytes to
    // Photon's full decode.
    const app0 = Buffer.alloc(14); // JFIF payload bytes (contents irrelevant)
    const noSofJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), // SOI + APP0, length 16 (2 + 14)
      app0,
    ]);
    expect(sniffImageMime(noSofJpeg)).toBe("image/jpeg");
    await expect(toImageContent(noSofJpeg, "image/jpeg")).rejects.toThrow(
      /cannot verify image dimensions/,
    );
  });
});
