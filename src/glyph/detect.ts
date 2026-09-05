/**
 * Finding and reading a glyph in a camera frame.
 *
 *   adaptive threshold -> connected components -> keep the ring-shaped ones
 *   -> corners -> homography -> pick orientation -> calibrate -> sample cells
 *
 * Everything here is pure and works on a plain RGBA buffer, which is what makes
 * the optical loopback test possible: render a frame, warp/blur/tint it, and
 * check it still reads. Multiple quads per image are supported because a printed
 * PAPER sheet is a page full of them.
 */
import { cellUV, decodeGrid, PALETTE, PALETTE_LUMA, calibrationCell, ringCells, totalCells } from "./layout.ts";
import { project, unitSquareTo, type Matrix3, type Point } from "./homography.ts";
import type { ImageLike } from "./render.ts";

export interface GlyphDetection {
  /** Corners in source-image coordinates, ordered to match the decoded grid. */
  quad: Point[];
  bytes: Uint8Array;
  confidence: number;
}

export interface DetectOptions {
  /** Target width for the detection pass. Sampling still uses the full-res image. */
  workWidth?: number;
  maxQuads?: number;
}

function grayscale(img: ImageLike, step: number): { gray: Uint8Array; w: number; h: number } {
  const w = Math.max(1, Math.floor(img.width / step));
  const h = Math.max(1, Math.floor(img.height / step));
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy++) {
        const sy = y * step + dy;
        if (sy >= img.height) break;
        for (let dx = 0; dx < step; dx++) {
          const sx = x * step + dx;
          if (sx >= img.width) break;
          const o = (sy * img.width + sx) * 4;
          sum += 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
          n++;
        }
      }
      gray[y * w + x] = n ? sum / n : 0;
    }
  }
  return { gray, w, h };
}

/**
 * Adaptive threshold over a large window. Global Otsu fails on a printed sheet
 * lit from one side; a small window fails on the big flat regions inside a
 * glyph. A window around a sixth of the frame handles both.
 */
function binarize(gray: Uint8Array, w: number, h: number): Uint8Array {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const r = Math.max(8, Math.floor(Math.min(w, h) / 6));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * (w + 1) + x1 + 1] -
        integral[y0 * (w + 1) + x1 + 1] -
        integral[(y1 + 1) * (w + 1) + x0] +
        integral[y0 * (w + 1) + x0];
      out[y * w + x] = gray[y * w + x] * area > sum * 1.06 ? 1 : 0;
    }
  }
  return out;
}

interface Blob {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  candidates: Point[];
}

/** Flood fill bright regions, keeping only the extreme points each blob needs for corners. */
function blobs(bin: Uint8Array, w: number, h: number, minArea: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const found: Blob[] = [];
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let area = 0;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    // Extremes along four axes; a square's corners are always among these eight.
    const ext = new Array(8).fill(-Infinity);
    const pts: Point[] = new Array(8).fill([0, 0]);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const axes = [x, -x, y, -y, x + y, -(x + y), x - y, -(x - y)];
      for (let a = 0; a < 8; a++) {
        if (axes[a] > ext[a]) {
          ext[a] = axes[a];
          pts[a] = [x, y];
        }
      }
      if (x > 0 && bin[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
      if (x < w - 1 && bin[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
      if (y > 0 && bin[p - w] && !seen[p - w]) (seen[p - w] = 1), stack.push(p - w);
      if (y < h - 1 && bin[p + w] && !seen[p + w]) (seen[p + w] = 1), stack.push(p + w);
    }
    if (area >= minArea) found.push({ area, minX, maxX, minY, maxY, candidates: pts });
  }
  return found;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points: Point[]): Point[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) =>
    a[0] === b[0] ? a[1] - b[1] : a[0] - b[0],
  );
  if (pts.length < 3) return pts;
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polyArea(q: Point[]): number {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Largest-area quadrilateral among the blob's extreme points, kept in hull order. */
function bestQuad(candidates: Point[]): Point[] | null {
  const hull = convexHull(candidates);
  if (hull.length < 4) return null;
  if (hull.length === 4) return hull;
  let best: Point[] | null = null;
  let bestArea = 0;
  const n = hull.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = [hull[a], hull[b], hull[c], hull[d]];
          const area = polyArea(q);
          if (area > bestArea) {
            bestArea = area;
            best = q;
          }
        }
  return best;
}

/** Average an RGB patch, so a single hot pixel or a bit of blur doesn't decide a cell. */
function samplePatch(img: ImageLike, x: number, y: number, r: number): [number, number, number] {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  const x0 = Math.max(0, Math.round(x - r));
  const x1 = Math.min(img.width - 1, Math.round(x + r));
  const y0 = Math.max(0, Math.round(y - r));
  const y1 = Math.min(img.height - 1, Math.round(y + r));
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const o = (yy * img.width + xx) * 4;
      sr += img.data[o];
      sg += img.data[o + 1];
      sb += img.data[o + 2];
      n++;
    }
  }
  return n ? [sr / n, sg / n, sb / n] : [0, 0, 0];
}

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function readQuad(img: ImageLike, N: number, quad: Point[]): GlyphDetection | null {
  const span = Math.sqrt(polyArea(quad));
  const patch = Math.max(0, span / ringCells(N) / 3.2);

  // The ring is 4-fold symmetric, so try all four corner orderings and let the
  // calibration row — whose luminance pattern is known — say which is upright.
  let best: { rot: number; m: Matrix3; score: number } | null = null;
  for (let rot = 0; rot < 4; rot++) {
    const ordered = [quad[rot % 4], quad[(rot + 1) % 4], quad[(rot + 2) % 4], quad[(rot + 3) % 4]];
    const m = unitSquareTo(ordered);
    if (!m) continue;
    const luma: number[] = [];
    const expect: number[] = [];
    for (let c = 0; c < N; c++) {
      const [u, v] = cellUV(N, 0, c);
      const [x, y] = project(m, u, v);
      const [r, g, b] = samplePatch(img, x, y, patch);
      luma.push(0.299 * r + 0.587 * g + 0.114 * b);
      expect.push(PALETTE_LUMA[calibrationCell(c)]);
    }
    const score = correlation(luma, expect);
    if (!best || score > best.score) best = { rot, m, score };
  }
  if (!best || best.score < 0.55) return null;

  const m = best.m;
  // Per-channel thresholds straight off this frame's calibration row.
  const hi = [0, 0, 0];
  const lo = [0, 0, 0];
  const hiN = [0, 0, 0];
  const loN = [0, 0, 0];
  for (let c = 0; c < N; c++) {
    const [u, v] = cellUV(N, 0, c);
    const [x, y] = project(m, u, v);
    const rgb = samplePatch(img, x, y, patch);
    const idx = calibrationCell(c);
    for (let ch = 0; ch < 3; ch++) {
      if (PALETTE[idx][ch] > 127) {
        hi[ch] += rgb[ch];
        hiN[ch]++;
      } else {
        lo[ch] += rgb[ch];
        loN[ch]++;
      }
    }
  }
  const mid = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    if (!hiN[ch] || !loN[ch]) return null;
    const h = hi[ch] / hiN[ch];
    const l = lo[ch] / loN[ch];
    if (h - l < 18) return null; // channel collapsed — blown out, or not a glyph
    mid[ch] = (h + l) / 2;
  }

  const cells = new Uint8Array(N * N);
  let margin = 0;
  let counted = 0;
  for (let row = 1; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const [u, v] = cellUV(N, row, col);
      const [x, y] = project(m, u, v);
      const rgb = samplePatch(img, x, y, patch);
      let idx = 0;
      for (let ch = 0; ch < 3; ch++) {
        const d = rgb[ch] - mid[ch];
        if (d > 0) idx |= 1 << ch;
        margin += Math.min(Math.abs(d) / 60, 1);
        counted++;
      }
      cells[row * N + col] = idx;
    }
  }

  return {
    quad: [quad[best.rot % 4], quad[(best.rot + 1) % 4], quad[(best.rot + 2) % 4], quad[(best.rot + 3) % 4]],
    bytes: decodeGrid(N, cells),
    confidence: Math.min(1, (best.score * 0.5 + (counted ? margin / counted : 0) * 0.5)),
  };
}

export function detectGlyphs(img: ImageLike, N: number, opts: DetectOptions = {}): GlyphDetection[] {
  const workWidth = opts.workWidth ?? 480;
  const step = Math.max(1, Math.round(img.width / workWidth));
  const { gray, w, h } = grayscale(img, step);
  const bin = binarize(gray, w, h);

  // The ring must be at least a few cells thick to survive; that sets a floor
  // on how small a glyph can be in frame before we stop trying.
  const minSide = Math.max(16, totalCells(N) * 1.2);
  const found = blobs(bin, w, h, minSide * 2);

  const out: GlyphDetection[] = [];
  const limit = opts.maxQuads ?? 32;
  found.sort((a, b) => b.area - a.area);
  for (const blob of found) {
    if (out.length >= limit) break;
    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    if (bw < minSide || bh < minSide) continue;
    const aspect = bw / bh;
    if (aspect < 0.35 || aspect > 2.9) continue;
    const fill = blob.area / (bw * bh);
    if (fill < 0.02 || fill > 0.6) continue; // a ring is mostly hole

    const quad = bestQuad(blob.candidates);
    if (!quad) continue;
    if (polyArea(quad) < bw * bh * 0.35) continue;

    const scaled: Point[] = quad.map((p) => [(p[0] + 0.5) * step, (p[1] + 0.5) * step] as Point);
    const det = readQuad(img, N, scaled);
    if (det) out.push(det);
  }
  return out;
}
