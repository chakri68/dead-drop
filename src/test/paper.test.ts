import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPdf, layoutSheet } from "../glyph/pdf.ts";
import { blockSizeFor, encodeGrid } from "../glyph/layout.ts";
import { detectGlyphs } from "../glyph/detect.ts";
import { FRAME_OVERHEAD, buildFrame, parseFrame } from "../core/frame.ts";
import type { ImageLike } from "../glyph/render.ts";

const N = 32;
const B = blockSizeFor(N, FRAME_OVERHEAD);

function have(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Minimal P6 reader — pdftoppm's default output is raw RGB behind a text header. */
function readPpm(path: string): ImageLike {
  const raw = readFileSync(path);
  let pos = 0;
  const token = (): string => {
    while (raw[pos] === 32 || raw[pos] === 10 || raw[pos] === 13 || raw[pos] === 9) pos++;
    if (raw[pos] === 35) {
      while (raw[pos] !== 10) pos++;
      return token();
    }
    let s = "";
    while (pos < raw.length && raw[pos] > 32) s += String.fromCharCode(raw[pos++]);
    return s;
  };
  assert.equal(token(), "P6");
  const width = Number(token());
  const height = Number(token());
  token();
  pos++;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = raw[pos + i * 3];
    data[i * 4 + 1] = raw[pos + i * 3 + 1];
    data[i * 4 + 2] = raw[pos + i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

/**
 * The closest thing to a print-and-scan test that doesn't involve a printer:
 * generate the real PDF, have poppler rasterise it as a printer's RIP would,
 * and read the tiles back out of the resulting page.
 */
test("a generated sheet survives being rendered and read back", { skip: !have("pdftoppm") && "pdftoppm not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-paper-"));
  const { positions, size, cellMm } = layoutSheet({ cols: 5, rows: 7, N, margin: 32 });
  const expected = positions.map((_, i) => i + 1);
  const tiles = positions.map((p, i) => ({
    cells: encodeGrid(N, buildFrame(i + 1, new Uint8Array(B).map((_, k) => (k * 13 + i * 7) & 255), B)),
    N,
    x: p[0],
    y: p[1],
    size,
  }));
  const pdf = await buildPdf([{ tiles, caption: "TEST SHEET" }]);
  writeFileSync(join(dir, "sheet.pdf"), pdf);

  for (const dpi of [150, 200]) {
    execFileSync("pdftoppm", ["-r", String(dpi), join(dir, "sheet.pdf"), join(dir, `p${dpi}`)]);
    const file = readdirSync(dir).find((f) => f.startsWith(`p${dpi}`) && f.endsWith(".ppm"))!;
    const page = readPpm(join(dir, file));
    const found = detectGlyphs(page, N, { workWidth: 1400, maxQuads: 80 });
    const seqs = new Set<number>();
    for (const f of found) {
      const parsed = parseFrame(f.bytes.subarray(0, B + FRAME_OVERHEAD), B);
      if (parsed) seqs.add(parsed.seq);
    }
    console.log(`  ${dpi} dpi (${cellMm.toFixed(2)} mm cells): ${found.length} tiles found, ${seqs.size}/${expected.length} decoded`);
    assert.equal(found.length, expected.length, `${dpi} dpi: not every tile was located`);
    // The fountain tolerates gaps, but a clean render should be near perfect.
    assert.ok(seqs.size >= expected.length - 1, `${dpi} dpi: only ${seqs.size} tiles decoded`);
  }
});
