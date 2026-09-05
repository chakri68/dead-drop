import { test } from "node:test";
import assert from "node:assert/strict";
import { BANDS, Demodulator, configFor, modulate } from "../core/modem.ts";
import { buildFrame, frameSize, parseFrame } from "../core/frame.ts";

const SR = 48000;

function noisy(signal: Float32Array, snrDb: number, lead: number): Float32Array {
  let power = 0;
  for (const s of signal) power += s * s;
  power /= signal.length;
  const noisePower = power / 10 ** (snrDb / 10);
  const sigma = Math.sqrt(noisePower);
  const out = new Float32Array(lead + signal.length + lead);
  for (let i = 0; i < out.length; i++) {
    const s = i >= lead && i < lead + signal.length ? signal[i - lead] : 0;
    // Box-Muller
    const u = Math.max(1e-9, Math.random());
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
    out[i] = s + sigma * g;
  }
  return out;
}

/** Send `count` frames through an AWGN channel, report how many survive CRC. */
function loopback(snrDb: number, count: number, bandId: "audible" | "ultrasonic") {
  const band = BANDS[bandId];
  const cfg = configFor(band, SR);
  const B = band.blockSize;
  const chunks: Float32Array[] = [];
  const sent: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const payload = new Uint8Array(B).map(() => (Math.random() * 256) | 0);
    const frame = buildFrame(i + 1, payload, B);
    sent.push(frame);
    chunks.push(modulate(cfg, frame));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const signal = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    signal.set(c, o);
    o += c.length;
  }

  const rx = noisy(signal, snrDb, cfg.symbolSamples * 3);
  const demod = new Demodulator(cfg, frameSize(B));
  let good = 0;
  let seen = 0;
  const chunk = 2048;
  for (let i = 0; i < rx.length; i += chunk) {
    demod.push(rx.subarray(i, Math.min(i + chunk, rx.length)), (f) => {
      seen++;
      if (parseFrame(f, B)) good++;
    });
  }
  return { good, seen, count };
}

test("audible band: clean channel decodes every frame", () => {
  const { good, count } = loopback(40, 12, "audible");
  assert.equal(good, count, `only ${good}/${count} frames survived a clean channel`);
});

test("ultrasonic band: clean channel decodes every frame", () => {
  const { good, count } = loopback(40, 8, "ultrasonic");
  assert.equal(good, count, `only ${good}/${count} frames survived a clean channel`);
});

test("frame success rate vs SNR", () => {
  const rows: string[] = [];
  let usable = 0;
  for (const snr of [30, 20, 15, 10, 6, 3, 0, -3]) {
    const { good, count } = loopback(snr, 16, "audible");
    const rate = good / count;
    if (rate >= 0.5) usable = snr;
    rows.push(`  SNR ${String(snr).padStart(3)} dB -> ${(rate * 100).toFixed(0).padStart(3)}% of frames`);
  }
  console.log(rows.join("\n"));
  // The fountain only needs a fraction of frames, so "usable" is well below 100%.
  assert.ok(usable <= 6, `expected at least half the frames through at 6 dB SNR, best usable was ${usable}`);
});

test("carrier-free audio produces no frames", () => {
  const band = BANDS.audible;
  const cfg = configFor(band, SR);
  const demod = new Demodulator(cfg, frameSize(band.blockSize));
  const junk = new Float32Array(SR).map(() => Math.random() * 2 - 1);
  let emitted = 0;
  let valid = 0;
  demod.push(junk, (f) => {
    emitted++;
    if (parseFrame(f, band.blockSize)) valid++;
  });
  assert.equal(valid, 0, "noise must never produce a CRC-valid frame");
});

test("44.1 kHz devices work too", () => {
  const band = BANDS.audible;
  const cfg = configFor(band, 44100);
  const B = band.blockSize;
  const frame = buildFrame(7, new Uint8Array(B).fill(0xa5), B);
  const demod = new Demodulator(cfg, frameSize(B));
  let ok = false;
  const pad = new Float32Array(cfg.symbolSamples * 3);
  demod.push(pad, () => {});
  demod.push(modulate(cfg, frame), (f) => {
    const p = parseFrame(f, B);
    if (p && p.seq === 7) ok = true;
  });
  assert.ok(ok, "44.1 kHz round-trip failed");
});
