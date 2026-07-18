import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NON_VISION_IMAGE_NOTE, sniffImageMime } from "../src/runtime/image-ingest.js";

/**
 * Pi-contract pins for the helpers image-ingest.ts REPRODUCES (the package
 * `exports` map blocks the deep paths, so — like tool-shell.ts's getTextOutput
 * pin — the concrete files are imported via an absolute file:// URL). A Pi
 * version bump that changes the magic-byte sniff or the non-vision wording fails
 * loudly here instead of diverging silently.
 */
function piDistFileUrl(relFromDist: string): string {
  const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const distIdx = mainUrl.indexOf("/dist/");
  expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
  return `${mainUrl.slice(0, distIdx)}/dist/${relFromDist}`;
}

describe("image-ingest Pi contract", () => {
  it("sniffImageMime matches Pi's own detectSupportedImageMimeType across a byte battery", async () => {
    const real: {
      detectSupportedImageMimeType: (buf: Buffer) => string | null;
    } = await import(piDistFileUrl("utils/mime.js"));
    expect(typeof real.detectSupportedImageMimeType, "Pi moved utils/mime.js").toBe("function");

    // A NUL byte to prove BM prefix + junk stays null; a real BMP; PNG; JPEG;
    // JPEG-2000 exclusion; GIF; WEBP; text; svg. Built inline so the pin is
    // self-contained.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02, 0x08, 0x00,
    ]);
    const bmp = Buffer.alloc(54);
    bmp.write("BM", 0, "ascii");
    bmp.writeUInt32LE(54, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(2, 18);
    bmp.writeInt32LE(2, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    // Animated PNG: valid signature + IHDR, then an acTL chunk before IDAT. The
    // chunk-walk must reject it (→ null); pinned against Pi's own detector.
    const apng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]), // IHDR length 13
      Buffer.from("IHDR"),
      Buffer.alloc(13),
      Buffer.alloc(4), // IHDR crc (unchecked)
      Buffer.from([0x00, 0x00, 0x00, 0x08]), // acTL length 8
      Buffer.from("acTL"),
      Buffer.alloc(8),
      Buffer.alloc(4), // acTL crc (unchecked)
    ]);
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(7), Buffer.from([0x3b])]);
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0x10, 0, 0, 0]),
      Buffer.from("WEBP"),
      Buffer.from("VP8L"),
      Buffer.from([0x04, 0, 0, 0]),
      Buffer.from([0x2f, 0, 0, 0]),
    ]);

    const battery: Buffer[] = [
      png,
      apng, // animated PNG → null
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), // JPEG
      Buffer.from([0xff, 0xd8, 0xff, 0xf7]), // JPEG-2000 exclusion → null
      gif,
      webp,
      bmp,
      Buffer.from("BM not-a-bmp-just-text-after-magic", "utf-8"), // BM prefix, invalid → null
      Buffer.from("plain text\n", "utf-8"),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf-8"),
      Buffer.from([]),
    ];

    for (const buf of battery) {
      expect(sniffImageMime(buf), `mismatch on ${buf.subarray(0, 8).toString("hex")}`).toBe(
        real.detectSupportedImageMimeType(buf),
      );
    }
  });

  it("NON_VISION_IMAGE_NOTE is the exact literal Pi's read.js emits", async () => {
    // getNonVisionImageNote is NOT exported, so pin the wording against the
    // source text of Pi's own read.js — a Pi wording change fails here.
    const source = await readFile(fileURLToPath(piDistFileUrl("core/tools/read.js")), "utf-8");
    expect(source, "Pi moved core/tools/read.js or changed the non-vision wording").toContain(
      NON_VISION_IMAGE_NOTE,
    );
  });
});
