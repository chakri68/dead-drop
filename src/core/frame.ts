/**
 * Wire framing.
 *
 * Every symbol on every transport looks the same:
 *
 *   | magic 1B | seq 3B | payload B | crc16 2B |
 *
 * seq 0 is reserved for header fragments; seq >= 1 carries LT symbol (seq - 1).
 * A transport's only job is to move one of these across the gap intact; the CRC
 * decides whether it arrived, and the fountain absorbs the ones that didn't.
 */
import { concat, crc16, readU24, writeU24 } from "./bytes.ts";

export const MAGIC = 0x7e;
export const FRAME_OVERHEAD = 6;
export const HEADER_SEQ = 0;
/** seq is 3 bytes; wrap before it overflows rather than aliasing another symbol. */
export const MAX_SEQ = 0xffffff;

export function frameSize(blockSize: number): number {
  return blockSize + FRAME_OVERHEAD;
}

export function buildFrame(seq: number, payload: Uint8Array, blockSize: number): Uint8Array {
  const out = new Uint8Array(frameSize(blockSize));
  out[0] = MAGIC;
  writeU24(out, 1, seq);
  out.set(payload.subarray(0, blockSize), 4);
  const c = crc16(out, 0, 4 + blockSize);
  out[4 + blockSize] = (c >>> 8) & 0xff;
  out[5 + blockSize] = c & 0xff;
  return out;
}

export interface ParsedFrame {
  seq: number;
  payload: Uint8Array;
}

/** Returns null for anything that isn't a structurally valid, CRC-clean frame. */
export function parseFrame(buf: Uint8Array, blockSize: number): ParsedFrame | null {
  if (buf.length !== frameSize(blockSize) || buf[0] !== MAGIC) return null;
  const want = (buf[4 + blockSize] << 8) | buf[5 + blockSize];
  if (crc16(buf, 0, 4 + blockSize) !== want) return null;
  return { seq: readU24(buf, 1), payload: buf.subarray(4, 4 + blockSize) };
}

/** Scan a byte stream for the first valid frame. Used by transports without message boundaries. */
export function findFrame(buf: Uint8Array, blockSize: number): { frame: ParsedFrame; end: number } | null {
  const size = frameSize(blockSize);
  for (let i = 0; i + size <= buf.length; i++) {
    if (buf[i] !== MAGIC) continue;
    const f = parseFrame(buf.subarray(i, i + size), blockSize);
    if (f) return { frame: f, end: i + size };
  }
  return null;
}

// --- varints -------------------------------------------------------------

export function putVarint(out: number[], v: number): void {
  let n = v;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

export function getVarint(buf: Uint8Array, pos: { i: number }): number {
  let v = 0;
  let shift = 1;
  for (let k = 0; k < 5; k++) {
    const b = buf[pos.i++];
    if (b === undefined) throw new Error("varint truncated");
    v += (b & 0x7f) * shift;
    if (!(b & 0x80)) return v;
    shift *= 128;
  }
  throw new Error("varint too long");
}

// --- header fragmentation ------------------------------------------------

/**
 * The header is bigger than one symbol on the slow transports (MORSE moves 8
 * bytes at a time), so it rides across several seq-0 frames:
 *
 *   | hidx 1B | hcount 1B | slice of (varint len | header | crc16) |
 */
export function buildHeaderFrames(header: Uint8Array, blockSize: number): Uint8Array[] {
  const lenPrefix: number[] = [];
  putVarint(lenPrefix, header.length);
  const c = crc16(header);
  const blob = concat(
    new Uint8Array(lenPrefix),
    header,
    new Uint8Array([(c >>> 8) & 0xff, c & 0xff]),
  );

  const per = blockSize - 2;
  if (per < 1) throw new Error("block size too small for a header");
  const count = Math.ceil(blob.length / per);
  if (count > 255) throw new Error("header too large to fragment");

  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const payload = new Uint8Array(blockSize);
    payload[0] = i;
    payload[1] = count;
    payload.set(blob.subarray(i * per, Math.min((i + 1) * per, blob.length)), 2);
    frames.push(buildFrame(HEADER_SEQ, payload, blockSize));
  }
  return frames;
}

/** Collects header fragments until the blob is complete and its CRC checks out. */
export class HeaderAssembler {
  private parts = new Map<number, Uint8Array>();
  private count = 0;
  private readonly blockSize: number;

  constructor(blockSize: number) {
    this.blockSize = blockSize;
  }

  get progress(): [number, number] {
    return [this.parts.size, this.count];
  }

  push(payload: Uint8Array): Uint8Array | null {
    const idx = payload[0];
    const count = payload[1];
    if (count === 0 || idx >= count) return null;
    // A changed fragment count means we drifted onto a different session.
    if (this.count && count !== this.count) this.parts.clear();
    this.count = count;
    this.parts.set(idx, payload.slice(2));
    if (this.parts.size < count) return null;

    const per = this.blockSize - 2;
    const blob = new Uint8Array(count * per);
    for (const [i, part] of this.parts) blob.set(part, i * per);

    try {
      const pos = { i: 0 };
      const len = getVarint(blob, pos);
      if (len <= 0 || pos.i + len + 2 > blob.length) return null;
      const header = blob.subarray(pos.i, pos.i + len);
      const want = (blob[pos.i + len] << 8) | blob[pos.i + len + 1];
      if (crc16(header) !== want) {
        this.parts.clear();
        this.count = 0;
        return null;
      }
      return header.slice();
    } catch {
      return null;
    }
  }
}
