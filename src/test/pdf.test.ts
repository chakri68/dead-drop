import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPdf, layoutSheet, type Tile } from "../glyph/pdf.ts";
import { blockSizeFor, encodeGrid, totalCells } from "../glyph/layout.ts";
import { FRAME_OVERHEAD, buildFrame } from "../core/frame.ts";


const N = 32;
const B = blockSizeFor(N, FRAME_OVERHEAD);

function sheet(cols: number, rows: number): { tiles: Tile[]; cellMm: number } {
  const { positions, size, cellMm } = layoutSheet({ cols, rows, N, margin: 32 });
  const tiles = positions.map((p, i) => ({
    cells: encodeGrid(N, buildFrame(i + 1, new Uint8Array(B).map((_, k) => (k * 7 + i) & 255), B)),
    N,
    x: p[0],
    y: p[1],
    size,
  }));
  return { tiles, cellMm };
}

test("sheet capacity and cell size are printable", () => {
  for (const [cols, rows] of [[5, 7], [7, 10]] as const) {
    const { cellMm } = sheet(cols, rows);
    const bytes = cols * rows * B;
    console.log(`  ${cols}x${rows}: ${(bytes / 1024).toFixed(1)} KB/sheet, ${cellMm.toFixed(2)} mm cells (${totalCells(N)} across)`);
    assert.ok(cellMm > 0.5, `${cellMm}mm cells are below anything a home printer holds`);
  }
});

test("PDF is structurally valid and its xref points at real objects", async () => {
  const { tiles } = sheet(5, 7);
  const pdf = await buildPdf([
    { tiles, caption: "SHEET 1/2" },
    { tiles, caption: "SHEET 2/2" },
  ]);
  // latin1, not utf8: the file contains deflate output, and only a 1-byte-per-char
  // decoding keeps string indices equal to byte offsets.
  const text = new TextDecoder("latin1").decode(pdf);
  assert.ok(text.startsWith("%PDF-1.4"), "missing header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "missing trailer marker");
  assert.ok(text.includes("/Filter /FlateDecode"), "content streams should be compressed");

  const startxref = Number(text.slice(text.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
  assert.ok(startxref > 0 && startxref < pdf.length, "startxref out of range");
  assert.equal(text.slice(startxref, startxref + 4), "xref", "startxref does not point at the table");

  // Every xref entry must land exactly on its object header.
  const table = text.slice(startxref).split("\n");
  const count = Number(table[1].split(" ")[1]);
  for (let i = 1; i < count; i++) {
    const offset = Number(table[1 + i + 1].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${i} 0 obj`.length), `${i} 0 obj`, `object ${i} offset wrong`);
  }

  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Count 2/);
  console.log(`  2 sheets, 70 tiles, ${(pdf.length / 1024).toFixed(0)} KB PDF`);
});

test("compression actually shrinks the content", async () => {
  const { tiles } = sheet(5, 7);
  const pdf = await buildPdf([{ tiles, caption: "X" }]);
  // 35 tiles of 38x38 cells is a lot of rectangles; if this were uncompressed it
  // would be well over a megabyte.
  assert.ok(pdf.length < 400_000, `PDF was ${pdf.length} bytes`);
});
