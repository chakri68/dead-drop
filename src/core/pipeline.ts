/**
 * The one pipeline every transport shares.
 *
 *   bytes -> compress? -> encrypt -> chunk -> LT encode -> frame -> symbols
 *   bytes <- decompress? <- decrypt <- reassemble <- LT decode <- deframe <- symbols
 *
 * A transport never sees any of this. It is handed opaque fixed-length frames
 * and asked to get them across; whatever fraction survives, the fountain sorts out.
 */
import { equal, utf8 } from "./bytes.ts";
import {
  decrypt,
  decompress,
  deriveKeys,
  encrypt,
  maybeCompress,
  randomSalt,
  sha256,
  type SessionKeys,
} from "./crypto.ts";
import { buildFrame, buildHeaderFrames, HEADER_SEQ, HeaderAssembler, MAX_SEQ, parseFrame } from "./frame.ts";
import { decodeHeader, digestBytesFor, encodeHeader, META_MIN_BLOCK, type Header } from "./header.ts";
import { LtDecoder, LtEncoder } from "./lt.ts";

export interface TransportProfile {
  /** Payload bytes per symbol. Set by the transport — 8 for MORSE, 1024 for LINK. */
  blockSize: number;
  /** Data symbols between header retransmissions. */
  headerEvery: number;
}

export interface Payload {
  bytes: Uint8Array;
  name: string;
  mime: string;
  isText: boolean;
}

// --- transmit ------------------------------------------------------------

export class TxSession {
  readonly profile: TransportProfile;
  readonly code: number;
  readonly payload: Payload;
  readonly K: number;
  readonly cipherLen: number;

  private readonly encoder: LtEncoder;
  private readonly headerFrames: Uint8Array[];
  private queue: Uint8Array[] = [];
  private sinceHeader = 0;
  private seq = 1;

  symbolsOut = 0;
  headersOut = 0;

  private constructor(
    profile: TransportProfile,
    code: number,
    payload: Payload,
    encoder: LtEncoder,
    headerFrames: Uint8Array[],
    cipherLen: number,
  ) {
    this.profile = profile;
    this.code = code;
    this.payload = payload;
    this.encoder = encoder;
    this.headerFrames = headerFrames;
    this.K = encoder.K;
    this.cipherLen = cipherLen;
    this.queue = [...headerFrames];
  }

  static async create(payload: Payload, code: number, profile: TransportProfile): Promise<TxSession> {
    const salt = randomSalt();
    const keys = await deriveKeys(code, salt);
    const digest = (await sha256(payload.bytes)).subarray(0, digestBytesFor(profile.blockSize));

    const packed = await maybeCompress(payload.bytes);
    const body = packed ?? payload.bytes;
    const cipher = await encrypt(keys, keys.ivPayload, body);

    // On MORSE and HAPTIC the filename would cost more airtime than the message.
    const meta =
      profile.blockSize >= META_MIN_BLOCK
        ? await encrypt(keys, keys.ivMeta, utf8.encode(JSON.stringify({ n: payload.name, m: payload.mime })))
        : null;

    const encoder = LtEncoder.fromPayload(cipher, profile.blockSize);
    const header: Header = {
      version: 1,
      compressed: !!packed,
      isText: payload.isText,
      K: encoder.K,
      cipherLen: cipher.length,
      plainLen: payload.bytes.length,
      blockSize: profile.blockSize,
      salt,
      digest,
      meta,
    };
    const headerFrames = buildHeaderFrames(encodeHeader(header), profile.blockSize);
    return new TxSession(profile, code, payload, encoder, headerFrames, cipher.length);
  }

  /**
   * Retune the header cadence. Used when a session ESCALATEs onto a faster
   * channel: the slow channel wanted the header every few symbols, the fast one
   * does not, and the session itself carries on unchanged.
   */
  setHeaderEvery(n: number): void {
    this.profile.headerEvery = Math.max(1, n);
  }

  /** Total frames per full cycle — the UI turns this into a pass count. */
  get cycleLength(): number {
    return this.headerFrames.length + this.profile.headerEvery;
  }

  get pass(): number {
    return Math.floor(this.symbolsOut / Math.max(1, this.K)) + 1;
  }

  /**
   * Next frame to put on the wire. Header fragments are interleaved forever,
   * so a receiver can join a transfer already in progress — which, on a
   * connectionless channel, is the normal case.
   */
  next(): Uint8Array {
    if (this.queue.length) {
      this.headersOut++;
      return this.queue.shift()!;
    }
    if (this.sinceHeader >= this.profile.headerEvery) {
      this.queue = [...this.headerFrames];
      this.sinceHeader = 0;
      this.headersOut++;
      return this.queue.shift()!;
    }
    const seq = this.seq;
    this.seq = seq >= MAX_SEQ ? 1 : seq + 1;
    this.sinceHeader++;
    this.symbolsOut++;
    return buildFrame(seq, this.encoder.symbol(seq), this.profile.blockSize);
  }

  /** Endless symbol stream. Transports pull at whatever rate their channel allows. */
  async *stream(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    while (!signal?.aborted) yield this.next();
  }
}

// --- receive -------------------------------------------------------------

export type RxState = "listening" | "header" | "decoding" | "verifying" | "complete" | "failed";

export interface RxSnapshot {
  state: RxState;
  framesSeen: number;
  framesBad: number;
  symbolsAccepted: number;
  blocks: number;
  K: number;
  headerParts: [number, number];
  name: string | null;
  mime: string | null;
  plainLen: number | null;
  isText: boolean;
  note: string | null;
}

export interface RxResult {
  bytes: Uint8Array;
  name: string;
  mime: string;
  isText: boolean;
  verified: boolean;
}

export class RxSession {
  private readonly profile: TransportProfile;
  private assembler: HeaderAssembler;
  private header: Header | null = null;
  private decoder: LtDecoder | null = null;
  /** Symbols that arrived before the header did. Replayed once K is known. */
  private orphans: Array<[number, Uint8Array]> = [];
  private keys: SessionKeys | null = null;
  private code: number | null = null;
  private finishing = false;

  state: RxState = "listening";
  framesSeen = 0;
  framesBad = 0;
  name: string | null = null;
  mime: string | null = null;
  note: string | null = null;

  onUpdate: ((s: RxSnapshot) => void) | null = null;
  onComplete: ((r: RxResult) => void) | null = null;

  constructor(profile: TransportProfile) {
    this.profile = profile;
    this.assembler = new HeaderAssembler(profile.blockSize);
  }

  setCode(code: number | null): void {
    if (code === this.code) return;
    this.code = code;
    this.keys = null;
    void this.refreshKeys();
  }

  /** Raw bytes off a transport. Anything that isn't a clean frame is counted and dropped. */
  push(raw: Uint8Array): void {
    if (this.state === "complete") return;
    const frame = parseFrame(raw, this.profile.blockSize);
    this.framesSeen++;
    if (!frame) {
      this.framesBad++;
      this.emit();
      return;
    }
    if (frame.seq === HEADER_SEQ) this.acceptHeader(frame.payload);
    else this.acceptSymbol(frame.seq, frame.payload);
    this.emit();
  }

  private acceptHeader(payload: Uint8Array): void {
    if (this.header) return;
    if (this.state === "listening") this.state = "header";
    const blob = this.assembler.push(payload);
    if (!blob) return;
    const header = decodeHeader(blob);
    if (!header) return;
    if (header.blockSize !== this.profile.blockSize) {
      this.note = "TRANSPORT MISMATCH";
      return;
    }
    this.header = header;
    this.decoder = new LtDecoder(header.K, header.blockSize);
    this.state = "decoding";
    for (const [seq, data] of this.orphans) this.decoder.push(seq, data);
    this.orphans = [];
    void this.refreshKeys();
    this.checkDone();
  }

  private acceptSymbol(seq: number, payload: Uint8Array): void {
    if (!this.decoder) {
      // Header hasn't landed yet. Hold a bounded backlog so nothing arriving
      // early is wasted — on a slow channel that backlog is minutes of work.
      if (this.orphans.length < 8192) this.orphans.push([seq, payload.slice()]);
      return;
    }
    this.decoder.push(seq, payload);
    this.checkDone();
  }

  private async refreshKeys(): Promise<void> {
    if (this.keys || this.code === null || !this.header) return;
    const keys = await deriveKeys(this.code, this.header.salt);
    this.keys = keys;
    if (this.header.meta) {
      const metaPlain = await decrypt(keys, keys.ivMeta, this.header.meta);
      if (metaPlain) {
        try {
          const parsed = JSON.parse(utf8.decode(metaPlain)) as { n?: string; m?: string };
          this.name = parsed.n ?? null;
          this.mime = parsed.m ?? null;
          this.note = null;
        } catch {
          /* leave it sealed */
        }
      } else {
        this.note = "CODE REJECTED";
      }
    }
    this.emit();
    this.checkDone();
  }

  private checkDone(): void {
    if (this.finishing || !this.decoder?.done || !this.header) return;
    if (!this.keys) {
      this.state = "verifying";
      this.note = this.code === null ? "AWAITING SESSION KEY" : this.note;
      return;
    }
    this.finishing = true;
    void this.finish();
  }

  private async finish(): Promise<void> {
    const header = this.header!;
    const keys = this.keys!;
    this.state = "verifying";
    this.emit();

    const cipher = this.decoder!.assemble().subarray(0, header.cipherLen);
    const body = await decrypt(keys, keys.ivPayload, cipher);
    if (!body) {
      this.state = "failed";
      this.note = "DECRYPT FAILED — WRONG KEY?";
      this.finishing = false;
      this.keys = null;
      this.emit();
      return;
    }

    let bytes = body;
    if (header.compressed) {
      try {
        bytes = await decompress(body);
      } catch {
        this.state = "failed";
        this.note = "DECOMPRESS FAILED";
        this.emit();
        return;
      }
    }

    const digest = (await sha256(bytes)).subarray(0, digestBytesFor(header.blockSize));
    const verified = equal(digest, header.digest);
    this.state = verified ? "complete" : "failed";
    this.note = verified ? null : "DIGEST MISMATCH";
    this.emit();
    this.onComplete?.({
      bytes,
      name: this.name ?? (header.isText ? "message.txt" : "drop.bin"),
      mime: this.mime ?? (header.isText ? "text/plain" : "application/octet-stream"),
      isText: header.isText,
      verified,
    });
  }

  snapshot(): RxSnapshot {
    return {
      state: this.state,
      framesSeen: this.framesSeen,
      framesBad: this.framesBad,
      symbolsAccepted: this.decoder?.symbolsAccepted ?? this.orphans.length,
      blocks: this.decoder?.decodedCount ?? 0,
      K: this.header?.K ?? 0,
      headerParts: this.assembler.progress,
      name: this.name,
      mime: this.mime,
      plainLen: this.header?.plainLen ?? null,
      isText: this.header?.isText ?? false,
      note: this.note,
    };
  }

  private emit(): void {
    this.onUpdate?.(this.snapshot());
  }
}
