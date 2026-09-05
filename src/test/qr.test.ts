import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QR_CONFIGS,
  blankMatrix,
  dataCodewords,
  drawQr,
  encodeQr,
  formatBits,
  maskFn,
  qrCapacity,
  qrSize,
  rsEncode,
  totalCodewords,
  versionBits,
  type QrConfig,
} from "../glyph/qr.ts";

/**
 * Published alignment-pattern centres. Used only to check that the geometry in
 * blankMatrix reproduces the standard's codeword capacities — if a version's
 * function-pattern layout were wrong, its capacity would come out wrong too.
 */
const ALIGNMENT: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
};

/** Total codewords per version, from the standard. */
const TOTAL = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655];

test("matrix geometry reproduces the standard codeword capacities", () => {
  for (let v = 1; v <= 15; v++) {
    const cfg: QrConfig = { version: v, ec: "L", ecPerBlock: 1, blocks: 1, alignment: ALIGNMENT[v] };
    assert.equal(totalCodewords(cfg), TOTAL[v - 1], `version ${v} capacity`);
  }
});

test("shipped configurations match published byte-mode capacities", () => {
  // These are the numbers a QR reference table gives; a wrong block count or EC
  // size would land somewhere else.
  const expected: Record<string, number> = { "1L": 17, "10L": 271, "15L": 520 };
  for (const [id, want] of Object.entries(expected)) {
    const cfg = QR_CONFIGS[id];
    assert.equal(qrCapacity(cfg), want, `${id} byte capacity`);
    assert.ok(dataCodewords(cfg) > 0);
  }
});

test("Reed-Solomon codewords divide cleanly by the generator", () => {
  // A correct RS codeword has remainder zero when divided by the generator, so
  // re-encoding data||ec must produce all zeros.
  for (const n of [7, 18, 22]) {
    const data = new Uint8Array(40).map((_, i) => (i * 37 + 11) & 255);
    const ec = rsEncode(data, n);
    const combined = new Uint8Array(data.length + ec.length);
    combined.set(data);
    combined.set(ec, data.length);
    const remainder = rsEncode(combined, n);
    assert.ok(remainder.every((b) => b === 0), `remainder not zero for n=${n}`);
  }
});

test("format information is a distance-7 BCH code", () => {
  // The BCH(15,5) format code has minimum distance 7. If the generator or the
  // mask were wrong, that property would collapse.
  const values: number[] = [];
  for (const ec of ["L", "M", "Q", "H"] as const) {
    for (let mask = 0; mask < 8; mask++) values.push(formatBits(ec, mask));
  }
  assert.equal(values.length, 32);
  let min = 15;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      let d = 0;
      let x = values[i] ^ values[j];
      while (x) {
        d += x & 1;
        x >>= 1;
      }
      min = Math.min(min, d);
    }
  }
  assert.equal(min, 7, `minimum distance was ${min}`);
});

test("version information is a distance-8 BCH code", () => {
  const values: number[] = [];
  for (let v = 7; v <= 40; v++) values.push(versionBits(v));
  let min = 18;
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      let d = 0;
      let x = values[i] ^ values[j];
      while (x) {
        d += x & 1;
        x >>= 1;
      }
      min = Math.min(min, d);
    }
  }
  assert.ok(min >= 8, `version BCH minimum distance was ${min}`);
});

/**
 * A structural reader: assumes a perfect, upright matrix and no errors, so it
 * skips image processing and error correction entirely. It checks placement,
 * masking and format encoding round-trip — the parts a capacity table can't.
 */
function readQr(symbol: { modules: Uint8Array; size: number }, cfg: QrConfig): Uint8Array {
  const { size } = symbol;
  const { reserved } = blankMatrix(cfg);
  const at = (x: number, y: number) => y * size + x;

  // Recover the mask from the format strip down the left of the top-left finder.
  let mask = -1;
  for (let m = 0; m < 8; m++) {
    const bits = formatBits(cfg.ec, m);
    let ok = true;
    for (let i = 0; i < 15; i++) {
      const v = (bits >> i) & 1;
      let px: number;
      if (i < 6) px = at(8, i);
      else if (i < 8) px = at(8, i + 1);
      else if (i === 8) px = at(7, 8);
      else px = at(14 - i, 8);
      if (symbol.modules[px] !== v) ok = false;
    }
    if (ok) {
      mask = m;
      break;
    }
  }
  assert.ok(mask >= 0, "no format information found");

  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[at(x, y)]) continue;
        const raw = symbol.modules[at(x, y)];
        bits.push(maskFn(mask, x, y) ? raw ^ 1 : raw);
      }
    }
    upward = !upward;
  }

  const codewords = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < codewords.length; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k];
    codewords[i] = v;
  }

  // Undo the interleave.
  const total = dataCodewords(cfg);
  const shortLen = Math.floor(total / cfg.blocks);
  const longBlocks = total % cfg.blocks;
  const blocks: number[][] = Array.from({ length: cfg.blocks }, () => []);
  let idx = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let b = 0; b < cfg.blocks; b++) {
      const len = shortLen + (b >= cfg.blocks - longBlocks ? 1 : 0);
      if (i < len) blocks[b].push(codewords[idx++]);
    }
  }
  const data = new Uint8Array(blocks.flat());

  // Parse byte mode.
  let bit = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  assert.equal(take(4), 0b0100, "mode indicator");
  const length = take(cfg.version < 10 ? 8 : 16);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = take(8);
  return out;
}

for (const id of ["1L", "10L", "15L"]) {
  test(`round-trip through ${id}`, () => {
    const cfg = QR_CONFIGS[id];
    const payload = new Uint8Array(qrCapacity(cfg)).map((_, i) => (i * 91 + 7) & 255);
    const symbol = encodeQr(payload, cfg);
    assert.equal(symbol.size, qrSize(cfg.version));
    const back = readQr(symbol, cfg);
    assert.deepEqual([...back], [...payload], `${id} payload did not survive`);
  });
}

test("finder patterns land where scanners look for them", () => {
  const cfg = QR_CONFIGS["10L"];
  const { modules, size } = encodeQr(new Uint8Array(10), cfg);
  const at = (x: number, y: number) => modules[y * size + x];
  const FINDER = [
    "1111111",
    "1000001",
    "1011101",
    "1011101",
    "1011101",
    "1000001",
    "1111111",
  ];
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        assert.equal(at(ox + x, oy + y), FINDER[y][x] === "1" ? 1 : 0, `finder at ${ox},${oy} cell ${x},${y}`);
      }
    }
  }
  assert.equal(at(8, size - 8), 1, "dark module");
  for (let i = 8; i < size - 8; i++) assert.equal(at(i, 6), i % 2 === 0 ? 1 : 0, "timing pattern");
});

test("oversized payload is refused rather than silently truncated", () => {
  const cfg = QR_CONFIGS["1L"];
  assert.throws(() => encodeQr(new Uint8Array(qrCapacity(cfg) + 1), cfg), /exceeds/);
});

test("drawQr is callable with a canvas-shaped context", () => {
  const calls: string[] = [];
  const fake = {
    set fillStyle(v: string) {
      calls.push(v);
    },
    fillRect: () => {},
  } as unknown as CanvasRenderingContext2D;
  drawQr(fake, encodeQr(new Uint8Array([1, 2, 3]), QR_CONFIGS["1L"]), 200);
  assert.ok(calls.includes("#fff") && calls.includes("#000"));
});
