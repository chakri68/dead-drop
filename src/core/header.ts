/**
 * The header symbol (seq 0). Everything the receiver needs before it can start
 * decoding, packed as tightly as possible — on MORSE this costs about twenty
 * seconds a copy, and it gets retransmitted for the whole session.
 *
 *   | ver:4 flags:4 | varint K | varint cipherLen | varint plainLen
 *   | varint blockSize | salt 4B | digest 16B | [varint metaLen | meta] |
 *
 * The filename and mime type live in `meta`, encrypted, so a recording of the
 * transmission doesn't announce what was moved. K and lengths stay in the clear
 * because the receiver needs them before it can know whether the code is right.
 */
import { concat } from "./bytes.ts";
import { getVarint, putVarint } from "./frame.ts";

export const HEADER_VERSION = 1;

/**
 * Truncated SHA-256 length. AES-GCM's tag is the real integrity guarantee — this
 * is the visible confirmation the UI reports — so on channels where the header
 * costs a minute per copy it shrinks. Both ends derive it from the block size,
 * which they already agree on, so nothing extra goes on the wire.
 */
export function digestBytesFor(blockSize: number): number {
  return blockSize <= 16 ? 4 : 16;
}

/** Below this, the filename is dropped rather than spend a minute transmitting it. */
export const META_MIN_BLOCK = 24;

export const FLAG_COMPRESSED = 1;
export const FLAG_TEXT = 2;
export const FLAG_META = 4;

export interface Header {
  version: number;
  compressed: boolean;
  isText: boolean;
  K: number;
  cipherLen: number;
  plainLen: number;
  blockSize: number;
  salt: Uint8Array;
  digest: Uint8Array;
  meta: Uint8Array | null;
}

export function encodeHeader(h: Header): Uint8Array {
  const digestBytes = digestBytesFor(h.blockSize);
  const flags =
    (h.compressed ? FLAG_COMPRESSED : 0) | (h.isText ? FLAG_TEXT : 0) | (h.meta ? FLAG_META : 0);
  const nums: number[] = [(HEADER_VERSION << 4) | flags];
  putVarint(nums, h.K);
  putVarint(nums, h.cipherLen);
  putVarint(nums, h.plainLen);
  putVarint(nums, h.blockSize);
  const parts = [new Uint8Array(nums), h.salt, h.digest.subarray(0, digestBytes)];
  if (h.meta) {
    const ml: number[] = [];
    putVarint(ml, h.meta.length);
    parts.push(new Uint8Array(ml), h.meta);
  }
  return concat(...parts);
}

export function decodeHeader(buf: Uint8Array): Header | null {
  try {
    const pos = { i: 0 };
    const b0 = buf[pos.i++];
    const version = b0 >> 4;
    if (version !== HEADER_VERSION) return null;
    const flags = b0 & 0x0f;
    const K = getVarint(buf, pos);
    const cipherLen = getVarint(buf, pos);
    const plainLen = getVarint(buf, pos);
    const blockSize = getVarint(buf, pos);
    if (K < 1 || blockSize < 1 || cipherLen < 1) return null;
    const salt = buf.slice(pos.i, (pos.i += 4));
    const digestBytes = digestBytesFor(blockSize);
    const digest = buf.slice(pos.i, (pos.i += digestBytes));
    if (digest.length !== digestBytes) return null;
    let meta: Uint8Array | null = null;
    if (flags & FLAG_META) {
      const len = getVarint(buf, pos);
      meta = buf.slice(pos.i, pos.i + len);
      if (meta.length !== len) return null;
    }
    return {
      version,
      compressed: !!(flags & FLAG_COMPRESSED),
      isText: !!(flags & FLAG_TEXT),
      K,
      cipherLen,
      plainLen,
      blockSize,
      salt,
      digest,
      meta,
    };
  } catch {
    return null;
  }
}
