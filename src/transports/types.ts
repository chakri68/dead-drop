/**
 * A transport answers two questions: how do I emit a symbol, and how do I detect
 * one. Everything above it — chunking, loss recovery, integrity, progress — is
 * shared, which is why adding an absurd new channel is a couple hundred lines
 * rather than a rewrite.
 */
import type { Signal } from "../core/signal.ts";
import type { TxSession } from "../core/pipeline.ts";

export type ProbeResult = "ok" | "unsupported" | "denied";

export interface TransportCaps {
  bidirectional: boolean;
  estBps: number;
  range: string;
}

export interface TransportMode {
  id: string;
  label: string;
  /** Payload bytes per symbol on this channel. */
  blockSize: number;
  /** Data symbols between header retransmissions. Slow channels repeat sooner. */
  headerEvery: number;
}

export interface TransportContext {
  mode: TransportMode;
  signal: AbortSignal;
  /** The transport's own live visual — spectrogram, camera feed, trace. */
  mount: HTMLElement;
  log: (line: string) => void;
  /** 0..1 lock quality for the RX LOCK bar. */
  meter: Signal<number>;
  /** Set by bidirectional transports when the far end says it is done. */
  done?: () => void;
}

export interface TxContext extends TransportContext {
  session: TxSession;
}

export interface Transport {
  id: string;
  name: string;
  codename: string;
  tier: string;
  caps: TransportCaps;
  modes: TransportMode[];
  /** Shown in the UI verbatim. Where a channel is compromised, say so here. */
  note?: string;
  probe(): Promise<ProbeResult>;
  tx(symbols: AsyncIterable<Uint8Array>, ctx: TxContext): Promise<void>;
  rx(ctx: TransportContext): AsyncIterable<Uint8Array>;
}

/** Bridges callback-driven sources (camera frames, GATT notifications) into an async iterable. */
export class SymbolQueue implements AsyncIterable<Uint8Array> {
  private items: Uint8Array[] = [];
  private waiting: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  private closed = false;

  push(item: Uint8Array): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
      return;
    }
    // Bound the backlog: if the consumer stalls, newer symbols are worth more
    // than stale ones on a fountain channel.
    if (this.items.length > 512) this.items.shift();
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => (this.waiting = resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
