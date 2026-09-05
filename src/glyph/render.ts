/** Rendering a glyph frame. The RGBA path exists so tests can warp and blur it without a canvas. */
import { BORDER_CELLS, PALETTE, totalCells } from "./layout.ts";

export interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function renderRGBA(N: number, cells: Uint8Array, cellPx: number): ImageLike {
  const T = totalCells(N);
  const size = T * cellPx;
  const data = new Uint8ClampedArray(size * size * 4);
  const put = (cx: number, cy: number, rgb: readonly [number, number, number]) => {
    for (let y = cy * cellPx; y < (cy + 1) * cellPx; y++) {
      for (let x = cx * cellPx; x < (cx + 1) * cellPx; x++) {
        const o = (y * size + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
  };
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const edge = Math.min(x, y, T - 1 - x, T - 1 - y);
      // 0 = outer black margin, 1 = white ring, 2 = black gap, 3+ = data
      if (edge === 1) put(x, y, PALETTE[7]);
      else if (edge < BORDER_CELLS) put(x, y, PALETTE[0]);
      else put(x, y, PALETTE[cells[(y - BORDER_CELLS) * N + (x - BORDER_CELLS)]]);
    }
  }
  return { data, width: size, height: size };
}

/** Canvas path — crisper than scaling an RGBA buffer, and it is what the screen shows. */
export function drawGlyph(ctx: CanvasRenderingContext2D, N: number, cells: Uint8Array, size: number): void {
  const T = totalCells(N);
  const cell = size / T;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const edge = Math.min(x, y, T - 1 - x, T - 1 - y);
      let idx: number;
      if (edge === 1) idx = 7;
      else if (edge < BORDER_CELLS) continue;
      else idx = cells[(y - BORDER_CELLS) * N + (x - BORDER_CELLS)];
      if (idx === 0) continue;
      const c = PALETTE[idx];
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      // Ceil the extent so neighbouring cells never leave a seam at fractional sizes.
      ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }
}
