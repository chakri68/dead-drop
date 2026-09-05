import { test } from "node:test";
import assert from "node:assert/strict";
import { detectGlyphs } from "../glyph/detect.ts";
import { renderRGBA, type ImageLike } from "../glyph/render.ts";
import { blockSizeFor, capacityBytes, encodeGrid, totalCells } from "../glyph/layout.ts";
import { homography, project } from "../glyph/homography.ts";
import { buildFrame, FRAME_OVERHEAD, parseFrame } from "../core/frame.ts";
import { equal } from "../core/bytes.ts";

const N = 24;
const B = blockSizeFor(N, FRAME_OVERHEAD);

function blankCanvas(w: number, h: number, shade = 24): ImageLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = shade;
    data[i * 4 + 1] = shade;
    data[i * 4 + 2] = shade;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

/**
 * Paste `src` into `dst` under a projective warp, then optionally blur, tint and
 * add noise — a crude stand-in for a handheld phone camera looking at a screen.
 */
function warpInto(
  dst: ImageLike,
  src: ImageLike,
  quad: Array<[number, number]>,
  opts: { blur?: number; gain?: [number, number, number]; noise?: number } = {},
): void {
  // Inverse map: destination pixel -> source pixel.
  const inv = homography(quad, [
    [0, 0],
    [src.width - 1, 0],
    [src.width - 1, src.height - 1],
    [0, src.height - 1],
  ]);
  assert.ok(inv);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of quad) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const gain = opts.gain ?? [1, 1, 1];
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(dst.height - 1, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(dst.width - 1, Math.ceil(maxX)); x++) {
      const [sx, sy] = project(inv!, x, y);
      if (sx < 0 || sy < 0 || sx > src.width - 1 || sy > src.height - 1) continue;
      // bilinear sample
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
      const o = (y * dst.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v =
          src.data[(y0 * src.width + x0) * 4 + c] * (1 - fx) * (1 - fy) +
          src.data[(y0 * src.width + x1) * 4 + c] * fx * (1 - fy) +
          src.data[(y1 * src.width + x0) * 4 + c] * (1 - fx) * fy +
          src.data[(y1 * src.width + x1) * 4 + c] * fx * fy;
        dst.data[o + c] = v * gain[c];
      }
      dst.data[o + 3] = 255;
    }
  }
  if (opts.blur) boxBlur(dst, opts.blur);
  if (opts.noise) {
    for (let i = 0; i < dst.data.length; i += 4) {
      for (let c = 0; c < 3; c++) dst.data[i + c] += (Math.random() * 2 - 1) * opts.noise;
    }
  }
}

function boxBlur(img: ImageLike, radius: number): void {
  const r = Math.max(1, Math.round(radius));
  const copy = new Uint8ClampedArray(img.data);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= img.height) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= img.width) continue;
            s += copy[(yy * img.width + xx) * 4 + c];
            n++;
          }
        }
        img.data[(y * img.width + x) * 4 + c] = s / n;
      }
    }
  }
}

function makeFrame(seq: number): Uint8Array {
  const payload = new Uint8Array(B).map((_, i) => (i * 31 + seq * 7) & 255);
  return buildFrame(seq, payload, B);
}

function renderFrame(seq: number, cellPx = 8): ImageLike {
  const frame = makeFrame(seq);
  assert.ok(frame.length <= capacityBytes(N));
  return renderRGBA(N, encodeGrid(N, frame), cellPx);
}

test("glyph capacity and framing line up", () => {
  console.log(`  N=${N} -> ${capacityBytes(N)} B/frame, block size ${B}, ${totalCells(N)} cells across`);
  assert.ok(B + FRAME_OVERHEAD <= capacityBytes(N));
});

test("flat-on round trip", () => {
  const src = renderFrame(11);
  const dst = blankCanvas(700, 700);
  warpInto(dst, src, [
    [90, 90],
    [610, 90],
    [610, 610],
    [90, 610],
  ]);
  const found = detectGlyphs(dst, N);
  assert.equal(found.length, 1, "expected exactly one glyph");
  const parsed = parseFrame(found[0].bytes.subarray(0, B + 6), B);
  assert.ok(parsed, "CRC failed on a flat-on capture");
  assert.equal(parsed!.seq, 11);
  assert.ok(equal(parsed!.payload, makeFrame(11).subarray(4, 4 + B)));
});

test("survives perspective, blur, colour cast and noise", () => {
  const cases: Array<{ name: string; quad: Array<[number, number]>; blur?: number; gain?: [number, number, number]; noise?: number }> = [
    { name: "keystone 20deg", quad: [[120, 100], [600, 150], [580, 620], [100, 580]] },
    { name: "keystone 35deg", quad: [[160, 90], [610, 190], [560, 640], [90, 540]] },
    { name: "rotated 25deg", quad: [[240, 80], [640, 250], [470, 640], [70, 470]] },
    { name: "blur r=2", quad: [[100, 100], [600, 100], [600, 600], [100, 600]], blur: 2 },
    { name: "blur r=3", quad: [[100, 100], [620, 110], [610, 610], [95, 600]], blur: 3 },
    { name: "warm cast", quad: [[110, 100], [600, 120], [590, 610], [100, 590]], gain: [1.0, 0.82, 0.6] },
    { name: "cool cast + blur", quad: [[110, 100], [600, 120], [590, 610], [100, 590]], gain: [0.7, 0.85, 1.0], blur: 2 },
    { name: "noise 18", quad: [[110, 100], [600, 120], [590, 610], [100, 590]], noise: 18 },
    { name: "dim + noise", quad: [[110, 100], [600, 120], [590, 610], [100, 590]], gain: [0.45, 0.45, 0.45], noise: 10 },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const dst = blankCanvas(700, 700);
    warpInto(dst, renderFrame(42), c.quad, { blur: c.blur, gain: c.gain, noise: c.noise });
    const found = detectGlyphs(dst, N);
    const ok = found.some((f) => {
      const p = parseFrame(f.bytes.subarray(0, B + 6), B);
      return p?.seq === 42;
    });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${c.name}`);
    if (!ok) failures.push(c.name);
  }
  assert.deepEqual(failures, [], `failed: ${failures.join(", ")}`);
});

test("reads several tiles from one image, as a printed sheet would", () => {
  const dst = blankCanvas(900, 640);
  const seqs = [1, 2, 3, 4, 5, 6];
  let i = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const x = 20 + col * 295;
      const y = 20 + row * 305;
      warpInto(dst, renderFrame(seqs[i++], 6), [
        [x, y],
        [x + 275, y + 4],
        [x + 272, y + 282],
        [x - 2, y + 278],
      ]);
    }
  }
  const found = detectGlyphs(dst, N);
  const decoded = new Set<number>();
  for (const f of found) {
    const p = parseFrame(f.bytes.subarray(0, B + 6), B);
    if (p) decoded.add(p.seq);
  }
  console.log(`  decoded ${decoded.size}/6 tiles in one shot`);
  assert.ok(decoded.size >= 5, `only ${decoded.size} of 6 tiles read`);
});

test("empty scene yields nothing", () => {
  assert.equal(detectGlyphs(blankCanvas(640, 480), N).length, 0);
});
