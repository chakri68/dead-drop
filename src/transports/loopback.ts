/**
 * LOOPBACK — no gap at all.
 *
 * Exists so the whole pipeline and UI can be exercised without hardware, and so
 * you can watch a fountain converge under a loss rate you dial yourself. The
 * cross-tab mode goes through a BroadcastChannel, which makes two browser tabs
 * a real two-device test.
 */
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";
import { hexPreview, SymbolLog } from "../ui/visuals.ts";

const CHANNEL = "dead-drop/loopback";
const bus = new EventTarget();

/** Loss injected on the transmit side so the receiver's counters stay honest. */
export const loopbackLoss = { rate: 0.15 };

function emit(frame: Uint8Array, crossTab: boolean, channel: BroadcastChannel | null): void {
  if (crossTab) channel?.postMessage(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
  else bus.dispatchEvent(new CustomEvent("symbol", { detail: frame }));
}

export const loopback: Transport = {
  id: "loopback",
  name: "Loopback",
  codename: "MIRROR",
  tier: "Tier 0 — bench",
  caps: { bidirectional: true, estBps: 100_000, range: "same machine" },
  note: "No physical channel. Cross-tab mode moves symbols between two browser tabs, which is the closest thing to a second device without one.",
  modes: [
    { id: "page", label: "SAME PAGE", blockSize: 192, headerEvery: 32 },
    { id: "tab", label: "CROSS-TAB", blockSize: 192, headerEvery: 32 },
  ],

  async probe() {
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    const crossTab = ctx.mode.id === "tab";
    const channel = crossTab ? new BroadcastChannel(CHANNEL) : null;
    const log = new SymbolLog(ctx.mount);
    ctx.meter.set(1);
    let sent = 0;
    let dropped = 0;
    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted) break;
        if (Math.random() < loopbackLoss.rate) {
          dropped++;
        } else {
          emit(frame, crossTab, channel);
          sent++;
        }
        if (sent % 4 === 0) log.push(`TX ${String(sent).padStart(5)}  DROP ${String(dropped).padStart(4)}  ${hexPreview(frame, 10)}`);
        await sleep(12, ctx.signal);
      }
    } finally {
      channel?.close();
    }
  },

  async *rx(ctx: TransportContext) {
    const queue = new SymbolQueue();
    const crossTab = ctx.mode.id === "tab";
    const log = new SymbolLog(ctx.mount);
    ctx.meter.set(1);
    let seen = 0;

    const onPage = (e: Event) => queue.push((e as CustomEvent<Uint8Array>).detail);
    const channel = crossTab ? new BroadcastChannel(CHANNEL) : null;
    if (channel) channel.onmessage = (e) => queue.push(new Uint8Array(e.data as ArrayBuffer));
    else bus.addEventListener("symbol", onPage);
    ctx.signal.addEventListener("abort", () => queue.close(), { once: true });

    try {
      for await (const frame of queue) {
        seen++;
        if (seen % 4 === 0) log.push(`RX ${String(seen).padStart(5)}  ${hexPreview(frame, 10)}`);
        yield frame;
      }
    } finally {
      bus.removeEventListener("symbol", onPage);
      channel?.close();
    }
  },
};
