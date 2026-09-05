/**
 * 4-point homography. The receiver sees the glyph as an arbitrary quadrilateral
 * — handheld, off-axis, keystoned — and needs to know where cell (i, j) landed.
 * Four corner correspondences pin down the 8 free parameters of a projective
 * map exactly, so this is a plain 8x8 solve rather than a fit.
 */

export type Point = readonly [number, number];
export type Matrix3 = Float64Array;

/** Gaussian elimination with partial pivoting. Returns null for a degenerate system. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

/**
 * Homography mapping the four `src` points onto the four `dst` points.
 * Each correspondence contributes two rows of the standard DLT system.
 */
export function homography(src: Point[], dst: Point[]): Matrix3 | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solve(a, b);
  if (!h) return null;
  const m = new Float64Array(9);
  m.set(h);
  m[8] = 1;
  return m;
}

/** Map the unit square onto a quad — the common case, so it skips the solve setup. */
export function unitSquareTo(quad: Point[]): Matrix3 | null {
  return homography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    quad,
  );
}

export function project(m: Matrix3, u: number, v: number): [number, number] {
  const w = m[6] * u + m[7] * v + m[8];
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}
