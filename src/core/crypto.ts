/**
 * Session crypto.
 *
 * The threat model is narrow and worth stating: this stops a *recording* of the
 * transmission from being useful without the code. It does not hide that a
 * transmission happened, and it does nothing about someone standing next to you
 * reading the screen. A 20-bit code is trivially brute-forceable offline —
 * it buys you the length of the session, not secrecy forever.
 */
import { concat, utf8 } from "./bytes.ts";

export const PBKDF2_ITERATIONS = 150_000;
export const CODE_BITS = 20;
const CODE_SPACE = 1 << CODE_BITS;

export interface SessionKeys {
  key: CryptoKey;
  ivPayload: Uint8Array;
  ivMeta: Uint8Array;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

/** 20-bit code, rendered as 5 hex digits — `7F2A9`. */
export function randomCode(): number {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] % CODE_SPACE;
}

export function formatCode(code: number): string {
  return (code % CODE_SPACE).toString(16).toUpperCase().padStart(5, "0");
}

export function parseCode(text: string): number | null {
  const clean = text.trim().replace(/[^0-9a-fA-F]/g, "");
  if (clean.length !== 5) return null;
  const v = parseInt(clean, 16);
  return Number.isFinite(v) ? v % CODE_SPACE : null;
}

export function randomSalt(): Uint8Array {
  const s = new Uint8Array(4);
  globalThis.crypto.getRandomValues(s);
  return s;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", data as BufferSource));
}

/**
 * PBKDF2 -> AES-GCM-256, with both IVs derived from the same material rather
 * than transmitted. Saves 24 bytes on the wire, which matters when the wire
 * moves 8 bits a second.
 */
export async function deriveKeys(code: number, salt: Uint8Array): Promise<SessionKeys> {
  const material = await subtle().importKey("raw", utf8.encode(formatCode(code)) as BufferSource, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = new Uint8Array(
    await subtle().deriveBits(
      { name: "PBKDF2", salt: concat(utf8.encode("dead-drop/1"), salt) as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
      material,
      256,
    ),
  );
  const key = await subtle().importKey("raw", bits as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  const ivPayload = (await sha256(concat(bits, utf8.encode("iv/payload")))).subarray(0, 12);
  const ivMeta = (await sha256(concat(bits, utf8.encode("iv/meta")))).subarray(0, 12);
  return { key, ivPayload, ivMeta };
}

export async function encrypt(keys: SessionKeys, iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, keys.key, plain as BufferSource),
  );
}

export async function decrypt(keys: SessionKeys, iv: Uint8Array, cipher: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: iv as BufferSource }, keys.key, cipher as BufferSource),
    );
  } catch {
    return null; // wrong code, or the ciphertext didn't survive the trip
  }
}

// --- optional deflate ----------------------------------------------------

const hasCompression = typeof globalThis.CompressionStream === "function";

async function pipeThrough(data: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  // Blob.stream() rather than a manual ReadableStream: it is the shortest path
  // that works identically in the browser and in Node's test runner.
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, BufferSource>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Returns null when compression didn't actually help — we then send the original. */
export async function maybeCompress(data: Uint8Array): Promise<Uint8Array | null> {
  if (!hasCompression || data.length < 64) return null;
  try {
    const packed = await pipeThrough(data, new CompressionStream("deflate-raw"));
    return packed.length < data.length ? packed : null;
  } catch {
    return null;
  }
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream("deflate-raw"));
}
