import { test } from "node:test";
import assert from "node:assert/strict";
import { OokDecoder, encodeOok, type OokConfig } from "../core/ook.ts";
import { mulberry32 } from "../core/prng.ts";
import { buildFrame, frameSize, parseFrame } from "../core/frame.ts";

const B = 8;
// MORSE's default mode: sized so a 24 fps camera still clears the ~3
// readings-per-half-bit the decoder needs.
const cfg: OokConfig = { halfBitMs: 130, preambleHalfBits: 28 };

/**
 * Simulate what a camera actually delivers: level readings at an uneven frame
 * rate, with the on/off contrast degraded and Gaussian noise on top.
 *
 * Seeded, so a run either passes or reveals a regression — an unseeded version
 * of this drops a frame roughly one run in twelve and teaches you nothing.
 */
function simulate(
  frames: Uint8Array[],
  opts: { fps: number; contrast: number; noise: number; jitterMs: number; clockErr?: number; seed?: number },
) {
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const decoder = new OokDecoder(cfg, frameSize(B));
  const out: Uint8Array[] = [];
  let t = 0;
  const period = cfg.halfBitMs * (opts.clockErr ?? 1);

  const levels: Array<{ start: number; end: number; v: number }> = [];
  let cursor = 500; // lead-in of darkness
  for (const f of frames) {
    for (const hb of encodeOok(f, cfg)) {
      levels.push({ start: cursor, end: cursor + period, v: hb });
      cursor += period;
    }
    cursor += period * 6; // inter-frame gap
  }
  const total = cursor + 500;

  const levelAt = (time: number): number => {
    for (const l of levels) if (time >= l.start && time < l.end) return l.v;
    return 0;
  };

  while (t < total) {
    const base = 0.18 + levelAt(t) * opts.contrast;
    const u = Math.max(1e-9, rand());
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    const frame = decoder.push(t, base + g * opts.noise);
    if (frame) out.push(frame);
    t += 1000 / opts.fps + (rand() * 2 - 1) * opts.jitterMs;
  }
  return out;
}

function makeFrames(n: number): Uint8Array[] {
  return Array.from({ length: n }, (_, i) => buildFrame(i + 1, new Uint8Array(B).fill((i * 37) & 255), B));
}

/** Mean frames recovered across seeds — one seed proves nothing about a noisy channel. */
function recoveryRate(opts: Parameters<typeof simulate>[1], frames = 3, seeds = 8): number {
  let total = 0;
  for (let seed = 0; seed < seeds; seed++) {
    total += simulate(makeFrames(frames), { ...opts, seed: seed * 1013 + 7 }).filter((f) => parseFrame(f, B)).length;
  }
  return total / (seeds * frames);
}

test("clean OOK round-trip at 30 fps", () => {
  const rate = recoveryRate({ fps: 30, contrast: 0.6, noise: 0.005, jitterMs: 2 });
  console.log(`  recovered ${(rate * 100).toFixed(0)}% of frames on a clean 30 fps channel`);
  assert.ok(rate >= 0.95, `only ${(rate * 100).toFixed(0)}% recovered`);
});

test("survives low contrast and camera noise", () => {
  const rate = recoveryRate({ fps: 30, contrast: 0.14, noise: 0.012, jitterMs: 6 }, 4);
  console.log(`  recovered ${(rate * 100).toFixed(0)}% of frames through 14% contrast`);
  // The fountain only needs a workable fraction, not all of them.
  assert.ok(rate >= 0.6, `only ${(rate * 100).toFixed(0)}% recovered`);
});

test("tolerates a 3% transmitter clock error", () => {
  const rate = recoveryRate({ fps: 30, contrast: 0.5, noise: 0.006, jitterMs: 3, clockErr: 1.03 });
  console.log(`  recovered ${(rate * 100).toFixed(0)}% of frames from a fast transmitter`);
  assert.ok(rate >= 0.8, `only ${(rate * 100).toFixed(0)}% recovered`);
});

test("a 24 fps camera still decodes — cameras slow down in the dark", () => {
  const rate = recoveryRate({ fps: 24, contrast: 0.5, noise: 0.008, jitterMs: 4 });
  console.log(`  recovered ${(rate * 100).toFixed(0)}% of frames at 24 fps`);
  assert.ok(rate >= 0.9, `only ${(rate * 100).toFixed(0)}% recovered at 24 fps`);
});

test("below three samples per half-bit the decoder gives up rather than guessing", () => {
  // Documenting the cliff: this is why the modes are named after frame rates.
  const fastCfg: OokConfig = { halfBitMs: 55, preambleHalfBits: 32 };
  const decoder = new OokDecoder(fastCfg, frameSize(B));
  const frames = makeFrames(3);
  let t = 0;
  let valid = 0;
  const levels: Array<[number, number, number]> = [];
  let cursor = 300;
  for (const f of frames) {
    for (const hb of encodeOok(f, fastCfg)) {
      levels.push([cursor, cursor + fastCfg.halfBitMs, hb]);
      cursor += fastCfg.halfBitMs;
    }
    cursor += fastCfg.halfBitMs * 6;
  }
  while (t < cursor + 300) {
    let v = 0;
    for (const [s0, e0, val] of levels) if (t >= s0 && t < e0) v = val;
    const f = decoder.push(t, 0.18 + v * 0.5);
    if (f && parseFrame(f, B)) valid++;
    t += 1000 / 24; // 55ms half-bits at 24 fps: 1.3 samples each
  }
  assert.equal(valid, 0, "should decode nothing rather than emit garbage frames");
});

test("a dark room produces no frames", () => {
  const decoder = new OokDecoder(cfg, frameSize(B));
  const rand = mulberry32(99);
  let emitted = 0;
  for (let t = 0; t < 30000; t += 33) {
    if (decoder.push(t, 0.2 + (rand() - 0.5) * 0.01)) emitted++;
  }
  assert.equal(emitted, 0);
});

test("random flicker never forges a valid frame", () => {
  // Swept across seeds: a CRC-valid frame must never fall out of noise.
  for (let seed = 0; seed < 12; seed++) {
    const decoder = new OokDecoder(cfg, frameSize(B));
    const rand = mulberry32(seed * 7919 + 1);
    let valid = 0;
    for (let t = 0; t < 120000; t += 33) {
      const f = decoder.push(t, rand());
      if (f && parseFrame(f, B)) valid++;
    }
    assert.equal(valid, 0, `CRC accepted a noise-built frame at seed ${seed}`);
  }
});
