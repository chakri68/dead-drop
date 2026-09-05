import { test } from "node:test";
import assert from "node:assert/strict";
import { TxSession, RxSession, type RxResult } from "../core/pipeline.ts";
import { BANDS, configFor, TONES } from "../core/modem.ts";
import { frameSize } from "../core/frame.ts";
import { blockSizeFor } from "../glyph/layout.ts";
import { FRAME_OVERHEAD } from "../core/frame.ts";
import { utf8, equal } from "../core/bytes.ts";
import { mulberry32 } from "../core/prng.ts";

/** getRandomValues caps at 64 KB per call; the acceptance payloads are bigger. */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) {
    globalThis.crypto.getRandomValues(out.subarray(o, Math.min(o + 65536, n)));
  }
  return out;
}

/** Prose that deflates like prose does — roughly 2:1 — not a repeated string. */
function englishText(bytes: number): Uint8Array {
  const words = ("the drop is under the third bench from the fountain bring what you owe and come alone " +
    "wednesday at dawn if the light is on walk past and try again on friday the key is spoken never written " +
    "count the paces from the gate and look for the mark left in chalk below the rail " +
    "we do not use the same place twice so burn this once you have read it and say nothing to anyone ").split(" ");
  let s = "";
  let i = 0;
  while (utf8.encode(s).length < bytes) {
    s += words[(i * 7919 + (i >> 3)) % words.length] + " ";
    i++;
  }
  return utf8.encode(s).subarray(0, bytes);
}

/**
 * The spec's acceptance criteria, checked against real sessions rather than
 * arithmetic on a napkin. These count the frames the transmitter actually
 * produces — header retransmissions included, which are easy to forget and are
 * 14% of CHIRP's airtime — and multiply by the channel's real symbol duration.
 */

/** Run a transfer to completion over a lossy channel; return frames sent. */
async function framesToComplete(
  payload: Uint8Array,
  blockSize: number,
  headerEvery: number,
  loss: number,
  seed = 0x5eed,
): Promise<number> {
  // Seeded: these numbers go in the README, so they have to be reproducible.
  const rand = mulberry32(seed);
  const code = 0x7f2a9;
  const profile = { blockSize, headerEvery };
  const tx = await TxSession.create(
    { bytes: payload, name: "note.txt", mime: "text/plain", isText: true },
    code,
    profile,
  );
  const rx = new RxSession(profile);
  rx.setCode(code);
  const box: { value: RxResult | null } = { value: null };
  rx.onComplete = (r) => {
    box.value = r;
  };
  // Count frames until the last block is decoded, not until the result is
  // verified: key derivation is deliberately slow and happens locally, in
  // parallel with the transfer, so it isn't airtime.
  let frames = 0;
  for (let i = 0; i < 200_000; i++) {
    const snap = rx.snapshot();
    if (snap.K > 0 && snap.blocks >= snap.K) break;
    const f = tx.next();
    frames++;
    if (rand() < loss) continue;
    rx.push(f);
    if (i % 64 === 0) await Promise.resolve();
  }
  for (let i = 0; i < 200 && !box.value; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(box.value?.verified, "transfer did not complete");
  assert.ok(equal(box.value!.bytes, payload), "payload did not survive");
  return frames;
}

test("1 KB of text crosses by sound in under 40 seconds", async () => {
  const band = BANDS.audible;
  const cfg = configFor(band, 48000);
  // Airtime per frame: preamble + marker + two tones per byte, plus the gap.
  const symbolsPerFrame = cfg.preambleSymbols + 2 + frameSize(band.blockSize) * 2;
  const secondsPerFrame = (symbolsPerFrame * cfg.symbolSamples + cfg.gapSamples) / cfg.sampleRate;

  const headerEvery = 16; // matches the CHIRP transport's audible mode
  const proseSeconds = (await framesToComplete(englishText(1024), band.blockSize, headerEvery, 0)) * secondsPerFrame;
  const randomSeconds = (await framesToComplete(randomBytes(1024), band.blockSize, headerEvery, 0)) * secondsPerFrame;
  console.log(`  1 KB English text:   ${proseSeconds.toFixed(1)}s`);
  console.log(`  1 KB incompressible: ${randomSeconds.toFixed(1)}s (worst case the channel can be asked for)`);

  assert.ok(proseSeconds < 40, `text took ${proseSeconds.toFixed(1)}s`);
  assert.ok(randomSeconds < 45, `even incompressible should stay close: ${randomSeconds.toFixed(1)}s`);
  assert.ok(TONES === 16);
});

test("500 KB crosses by LANTERN in under 5 minutes, with a 10 s look-away", async () => {
  const N = 24;
  const blockSize = blockSizeFor(N, FRAME_OVERHEAD);
  const fps = 12;
  const payload = randomBytes(500 * 1024); // incompressible, like a photo

  // 10 seconds of a 12 fps channel is 120 frames missed; model it as loss.
  const frames = await framesToComplete(payload, blockSize, 40, 0);
  const lookAwaySeconds = 10;
  const seconds = frames / fps + lookAwaySeconds;
  console.log(
    `  ${frames} frames at ${fps} fps = ${(frames / fps).toFixed(0)}s, +${lookAwaySeconds}s looking away = ${(seconds / 60).toFixed(1)} min`,
  );
  assert.ok(seconds < 300, `took ${seconds.toFixed(0)}s`);
});

test("MORSE moves a short message, and we write down how long it really takes", async () => {
  // The spec guessed "a couple of minutes" for 200 bytes. It is not a couple of
  // minutes. Recorded here so the README can quote a measurement rather than a hope.
  const halfBitMs = 130; // steady mode: what a 24 fps camera can follow
  const blockSize = 16;
  const halfBitsPerFrame = 28 + 4 + frameSize(blockSize) * 16;
  const secondsPerFrame = (halfBitsPerFrame * halfBitMs) / 1000 + (halfBitMs * 6) / 1000;

  const short = utf8.encode("DROP AT 0300. THIRD BENCH.");
  // Averaged over seeds: a single lossy run swings by minutes on a channel this slow.
  let shortTotal = 0;
  for (let seed = 0; seed < 6; seed++) {
    shortTotal += (await framesToComplete(short, blockSize, 6, 0.1, seed * 7919 + 3)) * secondsPerFrame;
  }
  const shortMin = shortTotal / 6 / 60;
  const longMin = ((await framesToComplete(randomBytes(200), blockSize, 6, 0)) * secondsPerFrame) / 60;
  console.log(`  ${short.length} B message: ${shortMin.toFixed(1)} min at 3.8 bit/s (10% frame loss)`);
  console.log(`  200 B incompressible: ${longMin.toFixed(1)} min`);

  // Bounds are regression guards, not tight fits: 5.9 min clean, 8.4 at 10% loss.
  assert.ok(shortMin < 12, `short message took ${shortMin.toFixed(1)} min`);
  assert.ok(longMin < 20, `200 B took ${longMin.toFixed(1)} min`);
});
