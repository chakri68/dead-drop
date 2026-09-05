import { test } from "node:test";
import assert from "node:assert/strict";
import { RxSession, TxSession, type RxResult } from "../core/pipeline.ts";
import { equal, utf8 } from "../core/bytes.ts";

const profile = (blockSize: number) => ({ blockSize, headerEvery: 24 });

/** A box, because TS can't narrow a variable that's only written from a callback. */
function collect(rx: RxSession): () => RxResult | null {
  const box: { value: RxResult | null } = { value: null };
  rx.onComplete = (r) => {
    box.value = r;
  };
  return () => box.value;
}

async function settle(done: () => RxResult | null): Promise<void> {
  for (let i = 0; i < 60 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

interface TransferOpts {
  blockSize: number;
  loss: number;
  code?: number;
  rxCode?: number;
  corrupt?: number;
  lateCode?: boolean;
}

async function transfer(payload: Uint8Array, opts: TransferOpts): Promise<RxResult | null> {
  const code = opts.code ?? 0x7f2a9;
  const tx = await TxSession.create(
    { bytes: payload, name: "note.txt", mime: "text/plain", isText: true },
    code,
    profile(opts.blockSize),
  );
  const rx = new RxSession(profile(opts.blockSize));
  if (!opts.lateCode) rx.setCode(opts.rxCode ?? code);
  const done = collect(rx);

  let frames = 0;
  for (let i = 0; i < tx.K * 40 + 400 && !done(); i++) {
    const f = tx.next();
    frames++;
    // Entering the code must not depend on whether this frame survived.
    if (opts.lateCode && frames === 60) rx.setCode(opts.rxCode ?? code);
    if (Math.random() < opts.loss) continue;
    const wire = f.slice();
    if (opts.corrupt && Math.random() < opts.corrupt) wire[(Math.random() * wire.length) | 0] ^= 0xff;
    rx.push(wire);
    await Promise.resolve();
  }
  await settle(done);
  return done();
}

test("loopback transfer, clean channel", async () => {
  const payload = utf8.encode("MEET AT THE USUAL PLACE. BRING THE FILE.".repeat(20));
  const result = await transfer(payload, { blockSize: 192, loss: 0 });
  assert.ok(result, "no completion");
  assert.ok(result.verified, "integrity not confirmed");
  assert.ok(equal(result.bytes, payload));
  assert.equal(result.name, "note.txt");
});

for (const loss of [0.1, 0.3, 0.5]) {
  test(`transfer survives ${loss * 100}% frame loss`, async () => {
    const payload = new Uint8Array(8000).map((_, i) => (i * 7) & 255);
    const result = await transfer(payload, { blockSize: 192, loss });
    assert.ok(result?.verified);
    assert.ok(equal(result.bytes, payload));
  });
}

test("corrupted frames are rejected, not decoded", async () => {
  const payload = new Uint8Array(4000).map((_, i) => (i * 13) & 255);
  const result = await transfer(payload, { blockSize: 192, loss: 0.05, corrupt: 0.2 });
  assert.ok(result?.verified, "should still converge through a 20% corruption rate");
  assert.ok(equal(result.bytes, payload));
});

test("code entered mid-transfer still completes", async () => {
  const payload = utf8.encode("typed the key halfway through".repeat(40));
  const result = await transfer(payload, { blockSize: 128, loss: 0.1, lateCode: true });
  assert.ok(result?.verified);
  assert.ok(equal(result.bytes, payload));
});

test("wrong code fails cleanly and never yields plaintext", async () => {
  const payload = utf8.encode("classified".repeat(50));
  const result = await transfer(payload, { blockSize: 128, loss: 0, code: 0x11111, rxCode: 0x22222 });
  assert.equal(result, null, "must not complete with the wrong key");
});

test("tiny payload over a MORSE-sized block", async () => {
  const payload = utf8.encode("DROP AT 0300");
  const result = await transfer(payload, { blockSize: 8, loss: 0.15 });
  assert.ok(result?.verified);
  assert.ok(equal(result.bytes, payload));
});

test("receiver can join a transfer already in progress", async () => {
  const payload = utf8.encode("late joiner".repeat(200));
  const tx = await TxSession.create(
    { bytes: payload, name: "x.txt", mime: "text/plain", isText: true },
    0x12345,
    profile(96),
  );
  const rx = new RxSession(profile(96));
  rx.setCode(0x12345);
  const done = collect(rx);
  for (let i = 0; i < 200; i++) tx.next(); // receiver wasn't there yet
  for (let i = 0; i < 4000 && !done(); i++) {
    rx.push(tx.next());
    await Promise.resolve();
  }
  await settle(done);
  const result = done();
  assert.ok(result?.verified);
  assert.ok(equal(result.bytes, payload));
});

test("binary payload keeps its name and mime type", async () => {
  const payload = new Uint8Array(20000);
  globalThis.crypto.getRandomValues(payload);
  const tx = await TxSession.create(
    { bytes: payload, name: "photo.jpg", mime: "image/jpeg", isText: false },
    0xabcde,
    profile(192),
  );
  const rx = new RxSession(profile(192));
  rx.setCode(0xabcde);
  const done = collect(rx);
  for (let i = 0; i < 20000 && !done(); i++) {
    rx.push(tx.next());
    await Promise.resolve();
  }
  await settle(done);
  const result = done();
  assert.ok(result?.verified);
  assert.equal(result.name, "photo.jpg");
  assert.equal(result.mime, "image/jpeg");
  assert.ok(equal(result.bytes, payload));
});
