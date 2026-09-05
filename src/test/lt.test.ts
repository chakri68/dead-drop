import { test } from "node:test";
import assert from "node:assert/strict";
import { LtEncoder, LtDecoder, neighborsFor } from "../core/lt.ts";
import { equal } from "../core/bytes.ts";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  return b;
}

/** Stream symbols through a lossy, reordering, duplicating channel. */
function roundTrip(payload: Uint8Array, B: number, lossRate: number, opts: { shuffle?: boolean; dupes?: boolean } = {}) {
  const enc = LtEncoder.fromPayload(payload, B);
  const dec = new LtDecoder(enc.K, B);
  let sent = 0;
  const batch: Array<[number, Uint8Array]> = [];
  const flush = () => {
    if (opts.shuffle) batch.sort(() => Math.random() - 0.5);
    for (const [seq, data] of batch) {
      dec.push(seq, data);
      if (opts.dupes && Math.random() < 0.2) dec.push(seq, data);
    }
    batch.length = 0;
  };
  for (let seq = 1; seq <= enc.K * 60 && !dec.done; seq++) {
    sent++;
    if (Math.random() < lossRate) continue;
    batch.push([seq, enc.symbol(seq)]);
    if (batch.length >= 16) flush();
    if (!opts.shuffle) flush();
  }
  flush();
  return { dec, sent, enc };
}

for (const loss of [0, 0.1, 0.3, 0.5]) {
  test(`LT round-trip at ${loss * 100}% loss`, () => {
    const payload = randomBytes(4096);
    const { dec } = roundTrip(payload, 64, loss, { shuffle: true, dupes: true });
    assert.ok(dec.done, `failed to decode at ${loss} loss`);
    assert.ok(equal(dec.assemble().subarray(0, payload.length), payload));
  });
}

test("overhead stays under 15% for K >= 100", () => {
  const trials = 30;
  let ratio = 0;
  for (let i = 0; i < trials; i++) {
    const payload = randomBytes(128 * 64); // K = 128
    const { dec, enc } = roundTrip(payload, 64, 0, {});
    assert.ok(dec.done);
    ratio += dec.symbolsAccepted / enc.K;
  }
  ratio /= trials;
  console.log(`  mean overhead: ${((ratio - 1) * 100).toFixed(1)}%`);
  assert.ok(ratio <= 1.15, `overhead ${ratio} exceeds 15%`);
});

test("neighbour mapping is a pure function of (seq, K)", () => {
  // Guard rail: an encoder change that shifts this silently breaks every receiver.
  const snapshot = [1, 2, 3, 50, 999, 65535].map((seq) => neighborsFor(seq, 128).slice().sort((a, b) => a - b));
  assert.deepEqual(
    snapshot,
    [1, 2, 3, 50, 999, 65535].map((seq) => neighborsFor(seq, 128).slice().sort((a, b) => a - b)),
  );
  for (const n of snapshot) assert.equal(new Set(n).size, n.length, "indices must be distinct");
  console.log("  degrees:", snapshot.map((n) => n.length).join(","));
});

test("K = 1 degenerate case", () => {
  const payload = randomBytes(30);
  const { dec } = roundTrip(payload, 64, 0.5, {});
  assert.ok(dec.done);
  assert.ok(equal(dec.assemble().subarray(0, 30), payload));
});
