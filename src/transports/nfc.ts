/**
 * NFC — the literal dead drop.
 *
 * Another place the spec's shape doesn't survive contact with the platform:
 * Web NFC has no peer-to-peer mode. Android Beam is gone and `NDEFReader` only
 * reads and writes *tags*. So tap-to-transfer between two phones isn't
 * available to a web page.
 *
 * Tag-mediated transfer is, and it is arguably more on-theme: write symbols to
 * a cheap NTAG sticker, leave the sticker taped under a bench, walk away. The
 * other party taps it and collects. Each tap moves one symbol, so a short
 * message is a handful of taps — and because the symbols are fountain-coded it
 * does not matter which ones, or in what order.
 */
import { frameSize, parseFrame } from "../core/frame.ts";
import { SymbolQueue, type Transport, type TransportContext, type TxContext } from "./types.ts";
import { hexPreview, SymbolLog } from "../ui/visuals.ts";

const MEDIA_TYPE = "application/x-dead-drop";

interface NdefRecordLike {
  recordType: string;
  mediaType?: string;
  data?: DataView;
}
interface NdefMessageLike {
  records: NdefRecordLike[];
}
interface NdefReaderLike {
  scan(opts?: { signal?: AbortSignal }): Promise<void>;
  write(message: unknown, opts?: { signal?: AbortSignal }): Promise<void>;
  onreading: ((e: { message: NdefMessageLike; serialNumber: string }) => void) | null;
  onreadingerror: (() => void) | null;
}

const NdefReader = (): (new () => NdefReaderLike) | undefined =>
  (globalThis as unknown as { NDEFReader?: new () => NdefReaderLike }).NDEFReader;

export const nfc: Transport = {
  id: "nfc",
  name: "NFC tag drop",
  codename: "NFC",
  tier: "Tier 3 — radio & cable",
  caps: { bidirectional: false, estBps: 2_000, range: "touching a tag" },
  note: "Android Chrome only, and it writes to tags rather than to another phone — Web NFC has no peer-to-peer mode. One symbol per tap; an NTAG215 holds a whole short message.",
  modes: [{ id: "ndef", label: "NDEF TAG", blockSize: 240, headerEvery: 4 }],

  async probe() {
    if (!NdefReader()) return "unsupported";
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    const Reader = NdefReader()!;
    const writer = new Reader();
    const log = new SymbolLog(ctx.mount);
    ctx.log("PRESENT A TAG TO WRITE THE NEXT SYMBOL");
    ctx.meter.set(1);
    let n = 0;
    for await (const frame of symbols) {
      if (ctx.signal.aborted) break;
      try {
        await writer.write(
          { records: [{ recordType: "mime", mediaType: MEDIA_TYPE, data: frame }] },
          { signal: ctx.signal },
        );
        n++;
        log.push(`WROTE ${String(n).padStart(4)}  ${hexPreview(frame, 10)}`);
        ctx.log(`SYMBOLS WRITTEN  ${n}  — PRESENT ANOTHER TAG`);
      } catch (err) {
        if (ctx.signal.aborted) break;
        ctx.log(`WRITE FAILED — ${(err as Error).message}`);
      }
    }
  },

  async *rx(ctx: TransportContext) {
    const Reader = NdefReader()!;
    const reader = new Reader();
    const queue = new SymbolQueue();
    const log = new SymbolLog(ctx.mount);
    const size = frameSize(ctx.mode.blockSize);
    ctx.meter.set(1);

    reader.onreading = ({ message }) => {
      for (const record of message.records) {
        if (record.recordType !== "mime" || record.mediaType !== MEDIA_TYPE || !record.data) continue;
        const frame = new Uint8Array(record.data.buffer, record.data.byteOffset, record.data.byteLength);
        if (frame.length !== size || !parseFrame(frame, ctx.mode.blockSize)) continue;
        log.push(`READ  ${hexPreview(frame, 10)}`);
        queue.push(frame.slice());
      }
    };
    reader.onreadingerror = () => ctx.log("TAG UNREADABLE — TRY AGAIN");
    await reader.scan({ signal: ctx.signal });
    ctx.log("TAP A TAG TO COLLECT A SYMBOL");
    ctx.signal.addEventListener("abort", () => queue.close(), { once: true });

    yield* queue;
  },
};
