/**
 * WIRE — Web Serial.
 *
 * The one channel that ignores every environmental condition. Frames are
 * SLIP-delimited (RFC 1055) because a serial port is a byte stream with no
 * message boundaries and a dropped byte would otherwise desynchronise it forever.
 */
import { frameSize, parseFrame } from "../core/frame.ts";
import { SymbolQueue, type Transport, type TransportContext, type TxContext } from "./types.ts";
import { hexPreview, SymbolLog } from "../ui/visuals.ts";

const END = 0xc0;
const ESC = 0xdb;
const ESC_END = 0xdc;
const ESC_ESC = 0xdd;

export function slipEncode(frame: Uint8Array): Uint8Array {
  const out: number[] = [END];
  for (const b of frame) {
    if (b === END) out.push(ESC, ESC_END);
    else if (b === ESC) out.push(ESC, ESC_ESC);
    else out.push(b);
  }
  out.push(END);
  return new Uint8Array(out);
}

/** Streaming SLIP decoder: feed bytes, get whole frames. */
export class SlipDecoder {
  private buf: number[] = [];
  private escaped = false;

  push(chunk: Uint8Array, sink: (frame: Uint8Array) => void): void {
    for (const b of chunk) {
      if (b === END) {
        if (this.buf.length) sink(new Uint8Array(this.buf));
        this.buf = [];
        this.escaped = false;
        continue;
      }
      if (this.escaped) {
        this.buf.push(b === ESC_END ? END : b === ESC_ESC ? ESC : b);
        this.escaped = false;
      } else if (b === ESC) {
        this.escaped = true;
      } else {
        this.buf.push(b);
      }
      if (this.buf.length > 8192) this.buf = []; // lost sync; wait for the next END
    }
  }
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}
interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

const serial = (): SerialLike | undefined => (navigator as unknown as { serial?: SerialLike }).serial;

export const wire: Transport = {
  id: "wire",
  name: "Web Serial",
  codename: "WIRE",
  tier: "Tier 3 — radio & cable",
  caps: { bidirectional: true, estBps: 100_000, range: "cable length" },
  note: "Needs a USB-serial bridge on both ends. Immune to light, sound and everything else in the room.",
  modes: [
    { id: "115200", label: "115200 BAUD", blockSize: 512, headerEvery: 64 },
    { id: "921600", label: "921600 BAUD", blockSize: 1024, headerEvery: 64 },
  ],

  async probe() {
    return serial() ? "ok" : "unsupported";
  },

  async tx(symbols, ctx: TxContext) {
    const port = await serial()!.requestPort();
    await port.open({ baudRate: Number(ctx.mode.id) });
    const writer = port.writable!.getWriter();
    const log = new SymbolLog(ctx.mount);
    ctx.meter.set(1);
    ctx.log(`PORT OPEN @ ${ctx.mode.id} BAUD`);
    let n = 0;
    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted) break;
        await writer.write(slipEncode(frame));
        if (++n % 8 === 0) log.push(`TX ${String(n).padStart(6)}  ${hexPreview(frame, 10)}`);
      }
    } finally {
      writer.releaseLock();
      await port.close().catch(() => {});
    }
  },

  async *rx(ctx: TransportContext) {
    const port = await serial()!.requestPort();
    await port.open({ baudRate: Number(ctx.mode.id) });
    const queue = new SymbolQueue();
    const log = new SymbolLog(ctx.mount);
    const slip = new SlipDecoder();
    const size = frameSize(ctx.mode.blockSize);
    ctx.meter.set(1);
    ctx.log(`PORT OPEN @ ${ctx.mode.id} BAUD`);

    const reader = port.readable!.getReader();
    let n = 0;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || ctx.signal.aborted) break;
          slip.push(value!, (frame) => {
            if (frame.length !== size || !parseFrame(frame, ctx.mode.blockSize)) return;
            if (++n % 8 === 0) log.push(`RX ${String(n).padStart(6)}  ${hexPreview(frame, 10)}`);
            queue.push(frame);
          });
        }
      } catch {
        /* port closed */
      } finally {
        queue.close();
      }
    })();

    ctx.signal.addEventListener("abort", () => {
      void reader.cancel().catch(() => {});
      queue.close();
    }, { once: true });

    try {
      yield* queue;
    } finally {
      reader.releaseLock();
      await port.close().catch(() => {});
    }
  },
};
