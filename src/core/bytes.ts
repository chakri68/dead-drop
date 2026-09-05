/** Byte plumbing. No dependencies, works in Node and the browser. */

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) dst[i] ^= src[i];
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** URL-safe base64, no padding. Hand-rolled so it works identically in Node and browsers. */
export function toBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = b[i] << 16;
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63];
  }
  return out;
}

const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  // tolerate standard base64 alphabet on input
  t["+".charCodeAt(0)] = 62;
  t["/".charCodeAt(0)] = 63;
  return t;
})();

export function fromBase64(s: string): Uint8Array {
  const chars: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v >= 0) chars.push(v);
  }
  const outLen = Math.floor((chars.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const v of chars) {
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/** CRC-16/CCITT-FALSE. Table built once. */
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

export function crc16(b: Uint8Array, from = 0, to = b.length): number {
  let crc = 0xffff;
  for (let i = from; i < to; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 8) ^ b[i]) & 0xff]) & 0xffff;
  return crc;
}

export function writeU24(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 16) & 0xff;
  b[off + 1] = (v >>> 8) & 0xff;
  b[off + 2] = v & 0xff;
}

export function readU24(b: Uint8Array, off: number): number {
  return (b[off] << 16) | (b[off + 1] << 8) | b[off + 2];
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder().decode(b),
};

/** Pack a bit stream MSB-first. Used by the optical codec. */
export class BitWriter {
  private buf: Uint8Array;
  private bitPos = 0;
  constructor(capacityBytes: number) {
    this.buf = new Uint8Array(capacityBytes);
  }
  write(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      if (bit) this.buf[this.bitPos >>> 3] |= 0x80 >>> (this.bitPos & 7);
      this.bitPos++;
    }
  }
  get bits(): number {
    return this.bitPos;
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, Math.ceil(this.bitPos / 8));
  }
}

export class BitReader {
  private bitPos = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  read(width: number): number {
    let v = 0;
    for (let i = 0; i < width; i++) {
      const byte = this.buf[this.bitPos >>> 3] ?? 0;
      v = (v << 1) | ((byte >>> (7 - (this.bitPos & 7))) & 1);
      this.bitPos++;
    }
    return v;
  }
  get remaining(): number {
    return this.buf.length * 8 - this.bitPos;
  }
}
