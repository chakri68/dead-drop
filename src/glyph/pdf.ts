/**
 * A PDF writer, because a PDF is mostly just text and the alternative was a
 * dependency. Enough of the format to place coloured rectangles on A4 pages and
 * nothing else.
 *
 * Content streams go out FlateDecode-compressed, which is exactly what
 * `CompressionStream('deflate')` produces — zlib-wrapped deflate. A page of
 * glyph cells compresses about twenty to one, so this matters.
 */
import { concat, utf8 } from "../core/bytes.ts";
import { PALETTE, totalCells } from "./layout.ts";

export const A4 = { width: 595.28, height: 841.89 };

export interface Tile {
  /** N*N colour indices, as produced by encodeGrid. */
  cells: Uint8Array;
  N: number;
  x: number;
  y: number;
  size: number;
}

/**
 * One page of content. Cells are merged into horizontal runs of a colour before
 * being emitted — a glyph is mostly black margin, and a run-length pass cuts the
 * operator count by roughly half before compression even starts.
 */
function pageContent(tiles: Tile[]): string {
  const ops: string[] = [];
  let currentColour = -1;
  for (const tile of tiles) {
    const T = totalCells(tile.N);
    const cell = tile.size / T;
    for (let row = 0; row < T; row++) {
      let runStart = 0;
      let runColour = -2;
      const flush = (end: number) => {
        if (runColour < 0 || end <= runStart) return;
        if (runColour !== currentColour) {
          const [r, g, b] = PALETTE[runColour];
          ops.push(`${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)} rg`);
          currentColour = runColour;
        }
        const px = tile.x + runStart * cell;
        // PDF's origin is bottom-left; glyph rows count from the top.
        const py = tile.y + tile.size - (row + 1) * cell;
        ops.push(`${px.toFixed(2)} ${py.toFixed(2)} ${((end - runStart) * cell).toFixed(2)} ${cell.toFixed(2)} re f`);
      };
      for (let col = 0; col < T; col++) {
        const edge = Math.min(col, row, T - 1 - col, T - 1 - row);
        let idx: number;
        if (edge === 1) idx = 7;
        else if (edge < 3) idx = 0;
        else idx = tile.cells[(row - 3) * tile.N + (col - 3)];
        if (idx !== runColour) {
          flush(col);
          runStart = col;
          runColour = idx;
        }
      }
      flush(T);
    }
  }
  return ops.join("\n");
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("deflate") as unknown as ReadableWritablePair<Uint8Array, BufferSource>);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

export interface PdfPage {
  tiles: Tile[];
  /** Caption printed under the grid. */
  caption: string;
}

/** Assemble the pages into a complete PDF file. */
export async function buildPdf(pages: PdfPage[]): Promise<Uint8Array> {
  const objects: Uint8Array[] = [];
  const add = (body: string | Uint8Array): number => {
    objects.push(typeof body === "string" ? utf8.encode(body) : body);
    return objects.length; // 1-based object number
  };

  // Object 1 is the catalog, 2 the page tree; both are patched once we know the
  // page object numbers.
  add("");
  add("");
  const fontObj = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");

  const pageObjs: number[] = [];
  for (const page of pages) {
    const text = `BT /F1 8 Tf 36 24 Td (${page.caption.replace(/[()\\]/g, "")}) Tj ET`;
    const raw = utf8.encode(`${pageContent(page.tiles)}\n0 0 0 rg\n${text}`);
    const packed = await deflate(raw);
    const body = packed ?? raw;
    const header = utf8.encode(
      `<< /Length ${body.length}${packed ? " /Filter /FlateDecode" : ""} >>\nstream\n`,
    );
    const contentObj = add(concat(header, body, utf8.encode("\nendstream")));
    pageObjs.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width.toFixed(2)} ${A4.height.toFixed(2)}] ` +
          `/Contents ${contentObj} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
      ),
    );
  }

  objects[0] = utf8.encode("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = utf8.encode(
    `<< /Type /Pages /Kids [${pageObjs.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjs.length} >>`,
  );

  const parts: Uint8Array[] = [utf8.encode("%PDF-1.4\n")];
  const offsets: number[] = [];
  let offset = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    const chunk = concat(utf8.encode(`${i + 1} 0 obj\n`), objects[i], utf8.encode("\nendobj\n"));
    parts.push(chunk);
    offset += chunk.length;
  }

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(utf8.encode(xref));
  return concat(...parts);
}

export interface SheetLayout {
  cols: number;
  rows: number;
  N: number;
  margin: number;
}

/** Tile positions for one sheet, and the cell size that results. */
export function layoutSheet(layout: SheetLayout): { positions: Array<[number, number]>; size: number; cellMm: number } {
  const usableW = A4.width - layout.margin * 2;
  const usableH = A4.height - layout.margin * 2 - 24; // leave room for the caption
  const gap = 6;
  const size = Math.min(
    (usableW - gap * (layout.cols - 1)) / layout.cols,
    (usableH - gap * (layout.rows - 1)) / layout.rows,
  );
  const positions: Array<[number, number]> = [];
  for (let r = 0; r < layout.rows; r++) {
    for (let c = 0; c < layout.cols; c++) {
      positions.push([
        layout.margin + c * (size + gap),
        A4.height - layout.margin - (r + 1) * size - r * gap,
      ]);
    }
  }
  // 1 pt = 1/72 inch = 0.3528 mm
  const cellMm = (size / totalCells(layout.N)) * 0.3528;
  return { positions, size, cellMm };
}
