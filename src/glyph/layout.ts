/**
 * LANTERN glyph layout.
 *
 * Not QR. QR spends most of its area on being findable from any angle in a
 * single shot; we control both ends and get thousands of shots, so we spend the
 * area on payload instead and let the fountain cover the frames we misread.
 *
 * A frame is a square of cells:
 *
 *   +--------------------------------+  1 cell black margin
 *   | +----------------------------+ |  1 cell white ring   <- the only thing
 *   | | +------------------------+ | |  1 cell black gap       detection looks for
 *   | | | calibration row        | | |
 *   | | | data ...               | | |  N x N inner grid
 *   | | +------------------------+ | |
 *   | +----------------------------+ |
 *   +--------------------------------+
 *
 * Each cell is one of 8 colours — the corners of the RGB cube — so a cell is
 * exactly 3 bits and each bit is one channel above or below its own threshold.
 * The calibration row carries all 8 colours in a known order, which is where
 * those thresholds come from: it re-derives white balance every single frame,
 * so a warm room light or a phone's auto-WB drifting mid-transfer costs nothing.
 */

/** Bit 0 = red, bit 1 = green, bit 2 = blue. Index and colour are the same thing. */
export const PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

export const PALETTE_LUMA = PALETTE.map(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b);

/** Cells of frame around the data grid: margin + ring + gap, per side. */
export const BORDER_CELLS = 3;
export const RING_INSET = 1; // margin cells outside the white ring

export function totalCells(N: number): number {
  return N + BORDER_CELLS * 2;
}

/** Width of the white ring's outer square, in cells. The homography's unit square. */
export function ringCells(N: number): number {
  return totalCells(N) - RING_INSET * 2;
}

/** Where cell (row, col) of the data grid sits inside the ring's unit square. */
export function cellUV(N: number, row: number, col: number): [number, number] {
  const span = ringCells(N);
  const off = BORDER_CELLS - RING_INSET; // ring + gap
  return [(off + col + 0.5) / span, (off + row + 0.5) / span];
}

export function capacityBytes(N: number): number {
  return Math.floor((N * (N - 1) * 3) / 8);
}

/** Payload bytes per symbol for a given grid, rounded down to a tidy multiple. */
export function blockSizeFor(N: number, frameOverhead: number): number {
  return Math.max(8, Math.floor((capacityBytes(N) - frameOverhead) / 16) * 16);
}

/** Row 0 cycles the whole palette so every channel gets equal high and low samples. */
export function calibrationCell(col: number): number {
  return col % 8;
}

/** Frame bytes -> N*N colour indices. Row 0 is calibration, the rest is payload. */
export function encodeGrid(N: number, data: Uint8Array): Uint8Array {
  const cells = new Uint8Array(N * N);
  for (let c = 0; c < N; c++) cells[c] = calibrationCell(c);
  let bit = 0;
  const total = (N - 1) * N;
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (let k = 0; k < 3; k++) {
      const idx = bit >> 3;
      const b = idx < data.length ? (data[idx] >> (7 - (bit & 7))) & 1 : 0;
      v |= b << k;
      bit++;
    }
    cells[N + i] = v;
  }
  return cells;
}

/** N*N colour indices -> frame bytes. Inverse of encodeGrid, calibration row dropped. */
export function decodeGrid(N: number, cells: Uint8Array): Uint8Array {
  const out = new Uint8Array(capacityBytes(N));
  let bit = 0;
  const total = (N - 1) * N;
  for (let i = 0; i < total; i++) {
    const v = cells[N + i];
    for (let k = 0; k < 3; k++) {
      if ((v >> k) & 1) {
        const idx = bit >> 3;
        if (idx < out.length) out[idx] |= 1 << (7 - (bit & 7));
      }
      bit++;
    }
  }
  return out;
}
