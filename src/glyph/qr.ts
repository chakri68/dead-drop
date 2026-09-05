/**
 * A QR encoder, for the QR-classic fallback mode.
 *
 * We don't ship a decoder — that side is the platform's `BarcodeDetector`, which
 * is why the mode hides itself when the API is missing. But nothing in the
 * browser will *generate* a QR, so this exists.
 *
 * Only a couple of (version, EC level) configurations are supported, because the
 * transport needs a fixed symbol size anyway and each configuration is a table
 * entry that has to be right. Every entry is cross-checked in the tests against
 * the published byte-mode capacity for that configuration, so a wrong number
 * fails the build rather than quietly producing codes nothing can read.
 */

// --- GF(256) -------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `n` error-correction codewords. */
function rsGenerator(n: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data * x^n` divided by the generator — the EC codewords. */
export function rsEncode(data: Uint8Array, n: number): Uint8Array {
  const gen = rsGenerator(n);
  const out = new Uint8Array(data.length + n);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = out[i];
    if (factor === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= gmul(gen[j], factor);
  }
  return out.subarray(data.length);
}

// --- configuration -------------------------------------------------------

export type EcLevel = "L" | "M" | "Q" | "H";
const EC_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

export interface QrConfig {
  version: number;
  ec: EcLevel;
  /** Error-correction codewords per block. */
  ecPerBlock: number;
  blocks: number;
  /** Alignment pattern centre coordinates. Hardcoded per version — the usual
   *  derivation formula disagrees with the standard at several versions. */
  alignment: number[];
}

export const QR_CONFIGS: Record<string, QrConfig> = {
  "1L": { version: 1, ec: "L", ecPerBlock: 7, blocks: 1, alignment: [] },
  "10L": { version: 10, ec: "L", ecPerBlock: 18, blocks: 4, alignment: [6, 28, 50] },
  "15L": { version: 15, ec: "L", ecPerBlock: 22, blocks: 6, alignment: [6, 26, 48, 70] },
};

export function qrSize(version: number): number {
  return 17 + version * 4;
}

/** Character-count field width for byte mode. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

// --- matrix scaffolding --------------------------------------------------

const FREE = -1;

export function blankMatrix(cfg: QrConfig): { modules: Int8Array; reserved: Uint8Array; size: number } {
  const size = qrSize(cfg.version);
  const modules = new Int8Array(size * size).fill(FREE);
  const reserved = new Uint8Array(size * size);
  const at = (x: number, y: number) => y * size + x;

  const setFn = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[at(x, y)] = v;
    reserved[at(x, y)] = 1;
  };

  const finder = (cx: number, cy: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const inner = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        const on = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && inner !== 2;
        setFn(cx + dx, cy + dy, on ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  // Timing patterns run between the finders on row and column 6.
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0 ? 1 : 0);
    setFn(6, i, i % 2 === 0 ? 1 : 0);
  }

  for (const cy of cfg.alignment) {
    for (const cx of cfg.alignment) {
      // Alignment patterns don't overlap the finders.
      const nearFinder =
        (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  setFn(8, size - 8, 1); // the always-dark module

  // Reserve the format-info strips; contents are written after masking.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[at(i, 8)] = 1;
      reserved[at(8, i)] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[at(size - 1 - i, 8)] = 1;
    reserved[at(8, size - 1 - i)] = 1;
  }
  if (cfg.version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      reserved[at(a, b)] = 1;
      reserved[at(b, a)] = 1;
    }
  }
  return { modules, reserved, size };
}

/** Free module count / 8 — the codeword capacity, straight off the geometry. */
export function totalCodewords(cfg: QrConfig): number {
  const { reserved } = blankMatrix(cfg);
  let free = 0;
  for (const r of reserved) if (!r) free++;
  return Math.floor(free / 8);
}

export function dataCodewords(cfg: QrConfig): number {
  return totalCodewords(cfg) - cfg.blocks * cfg.ecPerBlock;
}

/** Payload bytes this configuration carries in byte mode. */
export function qrCapacity(cfg: QrConfig): number {
  return dataCodewords(cfg) - Math.ceil((4 + countBits(cfg.version)) / 8);
}

// --- encoding ------------------------------------------------------------

function encodeData(cfg: QrConfig, payload: Uint8Array): Uint8Array {
  const total = dataCodewords(cfg);
  const bits: number[] = [];
  const put = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(payload.length, countBits(cfg.version));
  for (const b of payload) put(b, 8);
  // Terminator, then pad to a codeword boundary, then the standard pad bytes.
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    out[i / 8] = v;
  }
  for (let i = Math.ceil(bits.length / 8); i < total; i++) out[i] = i % 2 === 0 ? 0xec : 0x11;
  return out;
}

/**
 * Split into blocks, error-correct each, then interleave. The interleave is why
 * a scratch across a printed code doesn't kill it: damage lands one codeword
 * deep in many blocks rather than wiping a single block out.
 */
function interleave(cfg: QrConfig, data: Uint8Array): Uint8Array {
  const total = data.length;
  const shortLen = Math.floor(total / cfg.blocks);
  const longBlocks = total % cfg.blocks;
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let o = 0;
  for (let i = 0; i < cfg.blocks; i++) {
    const len = shortLen + (i >= cfg.blocks - longBlocks ? 1 : 0);
    const block = data.subarray(o, o + len);
    o += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, cfg.ecPerBlock));
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < cfg.ecPerBlock; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return new Uint8Array(out);
}

export function maskFn(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** BCH(15,5) format information, XORed with the standard mask. */
export function formatBits(ec: EcLevel, mask: number): number {
  let v = (EC_BITS[ec] << 3) | mask;
  let rem = v << 10;
  for (let i = 4; i >= 0; i--) {
    if ((rem >> (10 + i)) & 1) rem ^= 0x537 << i;
  }
  v = ((v << 10) | rem) ^ 0x5412;
  return v;
}

/** BCH(18,6) version information, present from version 7 up. */
export function versionBits(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((rem >> (12 + i)) & 1) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

function penalty(modules: Int8Array, size: number): number {
  const at = (x: number, y: number) => modules[y * size + x];
  let score = 0;

  // Rule 1: runs of five or more.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      let prev = -1;
      for (let j = 0; j < size; j++) {
        const v = horizontal ? at(j, i) : at(i, j);
        if (v === prev) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = v;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }

  // Rule 3: the finder-lookalike sequence, which confuses scanners.
  const a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      for (const pattern of [a, b]) {
        let rowMatch = true;
        let colMatch = true;
        for (let k = 0; k < 11; k++) {
          if (at(j + k, i) !== pattern[k]) rowMatch = false;
          if (at(i, j + k) !== pattern[k]) colMatch = false;
        }
        if (rowMatch) score += 40;
        if (colMatch) score += 40;
      }
    }
  }

  // Rule 4: overall darkness away from 50%.
  let dark = 0;
  for (const v of modules) if (v === 1) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Renders a QR symbol. Returns `size x size` modules, 1 = dark. */
export function encodeQr(payload: Uint8Array, cfg: QrConfig): { modules: Uint8Array; size: number } {
  if (payload.length > qrCapacity(cfg)) {
    throw new Error(`payload ${payload.length} B exceeds ${qrCapacity(cfg)} B for version ${cfg.version}${cfg.ec}`);
  }
  const codewords = interleave(cfg, encodeData(cfg, payload));
  const { modules, reserved, size } = blankMatrix(cfg);
  const at = (x: number, y: number) => y * size + x;

  // Zigzag up-and-down through two-module columns, right to left, skipping the
  // vertical timing column.
  let bit = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[at(x, y)]) continue;
        const byte = codewords[bit >> 3] ?? 0;
        modules[at(x, y)] = (byte >> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
    upward = !upward;
  }

  // Try all eight masks and keep the least offensive.
  let best: { mask: number; modules: Int8Array; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!reserved[at(x, y)] && maskFn(mask, x, y)) candidate[at(x, y)] ^= 1;
      }
    }
    writeFormat(candidate, size, cfg, mask);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { mask, modules: candidate, score };
  }

  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = best!.modules[i] === 1 ? 1 : 0;
  return { modules: out, size };
}

function writeFormat(modules: Int8Array, size: number, cfg: QrConfig, mask: number): void {
  const at = (x: number, y: number) => y * size + x;
  const bits = formatBits(cfg.ec, mask);
  for (let i = 0; i < 15; i++) {
    const v = (bits >> i) & 1;
    // Copy one: down the left column and across the top row, skipping timing.
    if (i < 6) modules[at(8, i)] = v;
    else if (i < 8) modules[at(8, i + 1)] = v;
    else if (i === 8) modules[at(7, 8)] = v;
    else modules[at(14 - i, 8)] = v;
    // Copy two: the mirrored strips beside the other two finders.
    if (i < 8) modules[at(size - 1 - i, 8)] = v;
    else modules[at(8, size - 15 + i)] = v;
  }
  if (cfg.version >= 7) {
    const vb = versionBits(cfg.version);
    for (let i = 0; i < 18; i++) {
      const v = (vb >> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      modules[at(a, b)] = v;
      modules[at(b, a)] = v;
    }
  }
}

/** Draw a symbol with the quiet zone the standard requires. */
export function drawQr(
  ctx: CanvasRenderingContext2D,
  symbol: { modules: Uint8Array; size: number },
  pixels: number,
): void {
  const quiet = 4;
  const total = symbol.size + quiet * 2;
  const scale = pixels / total;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, pixels, pixels);
  ctx.fillStyle = "#000";
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      if (!symbol.modules[y * symbol.size + x]) continue;
      ctx.fillRect(
        Math.floor((x + quiet) * scale),
        Math.floor((y + quiet) * scale),
        Math.ceil(scale),
        Math.ceil(scale),
      );
    }
  }
}
