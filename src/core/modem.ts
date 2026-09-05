/**
 * CHIRP — the acoustic modem.
 *
 * 16-tone MFSK, 4 bits per symbol, continuous phase. Each frame goes out as:
 *
 *   [preamble: tone0/tone15 alternating]  [start marker]  [2 tones per byte]
 *
 * The preamble does two jobs: it announces that something is coming, and its
 * alternation gives the receiver a symbol clock without either side agreeing on
 * a start time. The marker then pins down where data actually begins, because
 * "the preamble stopped" is a fuzzy edge and an off-by-one symbol ruins a frame.
 *
 * No error correction here on purpose. A frame either passes CRC or it doesn't,
 * and the fountain upstairs decides what that cost.
 */
import { goertzel } from "./dsp.ts";

export interface ModemConfig {
  sampleRate: number;
  baseFreq: number;
  spacing: number;
  symbolSamples: number;
  preambleSymbols: number;
  gapSamples: number;
}

export const TONES = 16;
const MARKER: [number, number] = [5, 10]; // impossible during the 0/15 preamble

export interface BandPreset {
  id: "audible" | "ultrasonic";
  label: string;
  baseFreq: number;
  spacing: number;
  symbolSeconds: number;
  blockSize: number;
}

export const BANDS: Record<BandPreset["id"], BandPreset> = {
  audible: {
    id: "audible",
    label: "AUDIBLE 1.2-4.8 kHz",
    baseFreq: 1200,
    spacing: 240,
    symbolSeconds: 0.01,
    blockSize: 48,
  },
  ultrasonic: {
    // Most phone speakers roll off hard above ~19 kHz, so this band stays low
    // and slow. It is near-silent, not inaudible, and range is a metre or two.
    id: "ultrasonic",
    label: "ULTRASONIC 17.5-19.4 kHz",
    baseFreq: 17500,
    spacing: 125,
    symbolSeconds: 0.02,
    blockSize: 32,
  },
};

export function configFor(band: BandPreset, sampleRate: number): ModemConfig {
  return {
    sampleRate,
    baseFreq: band.baseFreq,
    spacing: band.spacing,
    symbolSamples: Math.round(band.symbolSeconds * sampleRate),
    preambleSymbols: 12,
    gapSamples: Math.round(0.03 * sampleRate),
  };
}

export function toneFreq(cfg: ModemConfig, tone: number): number {
  return cfg.baseFreq + tone * cfg.spacing;
}

/** Bytes -> tone indices, high nibble first. */
export function bytesToTones(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of bytes) {
    out.push(b >> 4, b & 0x0f);
    }
  return out;
}

export function tonesToBytes(tones: number[]): Uint8Array {
  const out = new Uint8Array(tones.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (tones[i * 2] << 4) | tones[i * 2 + 1];
  return out;
}

/** Full on-air symbol sequence for one frame. */
export function frameTones(cfg: ModemConfig, frame: Uint8Array): number[] {
  const tones: number[] = [];
  for (let i = 0; i < cfg.preambleSymbols; i++) tones.push(i % 2 === 0 ? 0 : TONES - 1);
  tones.push(MARKER[0], MARKER[1]);
  tones.push(...bytesToTones(frame));
  return tones;
}

/**
 * Render tones to PCM with continuous phase. Discontinuities at symbol edges
 * splatter energy across the band and cheap speakers turn them into clicks,
 * which the receiver then reads as tone changes.
 */
export function modulate(cfg: ModemConfig, frame: Uint8Array): Float32Array {
  const tones = frameTones(cfg, frame);
  const out = new Float32Array(tones.length * cfg.symbolSamples + cfg.gapSamples);
  let phase = 0;
  let o = 0;
  const ramp = Math.min(64, cfg.symbolSamples >> 3);
  for (const tone of tones) {
    const step = (2 * Math.PI * toneFreq(cfg, tone)) / cfg.sampleRate;
    for (let i = 0; i < cfg.symbolSamples; i++) {
      let a = 0.6;
      if (i < ramp) a *= i / ramp;
      else if (i >= cfg.symbolSamples - ramp) a *= (cfg.symbolSamples - i) / ramp;
      out[o++] = a * Math.sin(phase);
      phase += step;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

interface ToneRead {
  tone: number;
  purity: number;
}

/**
 * Streaming demodulator. Push samples, get frames.
 *
 * Runs as a three-state machine: HUNT slides a quarter-symbol at a time looking
 * for the preamble's alternation; MARKER walks symbol-aligned until it sees the
 * start pair; DATA reads a fixed number of symbols, because the frame length is
 * a property of the transport and never goes on the wire.
 */
export class Demodulator {
  private readonly cfg: ModemConfig;
  private readonly frameBytes: number;
  private buf = new Float32Array(0);
  private pos = 0;
  private state: "hunt" | "marker" | "data" = "hunt";
  private history: ToneRead[] = [];
  private markerWait = 0;
  private tones: number[] = [];

  /** 0..1 lock quality, for the UI meter. */
  lock = 0;
  lastTone = -1;

  constructor(cfg: ModemConfig, frameBytes: number) {
    this.cfg = cfg;
    this.frameBytes = frameBytes;
  }

  private get hop(): number {
    return Math.max(1, this.cfg.symbolSamples >> 2);
  }

  private read(offset: number): ToneRead {
    const { symbolSamples, sampleRate } = this.cfg;
    let best = -1;
    let bestPower = 0;
    let total = 0;
    for (let t = 0; t < TONES; t++) {
      const p = goertzel(this.buf, offset, symbolSamples, toneFreq(this.cfg, t), sampleRate);
      total += p;
      if (p > bestPower) {
        bestPower = p;
        best = t;
      }
    }
    return { tone: best, purity: total > 0 ? bestPower / total : 0 };
  }

  /**
   * Nudge the sampling instant to whichever of three nearby offsets looks
   * cleanest. Two phones' sample clocks differ by ~100ppm, which is only a few
   * samples per frame, but it accumulates over a long transfer.
   */
  private readAligned(offset: number): { read: ToneRead; offset: number } {
    const nudge = Math.max(1, this.cfg.symbolSamples >> 5);
    let best = { read: this.read(offset), offset };
    for (const d of [-nudge, nudge]) {
      const o = offset + d;
      if (o < 0 || o + this.cfg.symbolSamples > this.buf.length) continue;
      const r = this.read(o);
      if (r.purity > best.read.purity) best = { read: r, offset: o };
    }
    return best;
  }

  push(samples: Float32Array, sink: (frame: Uint8Array) => void): void {
    const merged = new Float32Array(this.buf.length - this.pos + samples.length);
    merged.set(this.buf.subarray(this.pos));
    merged.set(samples, this.buf.length - this.pos);
    this.buf = merged;
    this.pos = 0;
    this.drain(sink);

    // Keep a symbol of context; drop the rest so the buffer doesn't grow forever.
    const keep = this.cfg.symbolSamples * 2;
    if (this.pos > keep) {
      this.buf = this.buf.slice(this.pos - keep);
      this.pos = keep;
    }
  }

  private drain(sink: (frame: Uint8Array) => void): void {
    const { symbolSamples } = this.cfg;
    for (;;) {
      if (this.state === "hunt") {
        if (this.pos + symbolSamples > this.buf.length) return;
        const r = this.read(this.pos);
        this.history.push(r);
        if (this.history.length > 40) this.history.shift();
        this.pos += this.hop;
        this.lastTone = r.purity > 0.35 ? r.tone : -1;
        const edge = this.findPreamble();
        if (edge !== null) {
          this.pos = edge;
          this.state = "marker";
          this.markerWait = 0;
          this.history.length = 0;
        }
        continue;
      }

      if (this.pos + symbolSamples > this.buf.length) return;

      if (this.state === "marker") {
        const { read, offset } = this.readAligned(this.pos);
        this.pos = offset + symbolSamples;
        this.lastTone = read.tone;
        if (read.tone === MARKER[0]) {
          if (this.pos + symbolSamples > this.buf.length) {
            this.pos = offset; // wait for more audio rather than guessing
            return;
          }
          const second = this.readAligned(this.pos);
          this.pos = second.offset + symbolSamples;
          if (second.read.tone === MARKER[1]) {
            this.state = "data";
            this.tones = [];
            this.lock = Math.min(1, (read.purity + second.read.purity) / 2 + 0.15);
            continue;
          }
        }
        // Preamble tones are fine, anything else means we lost it.
        if (++this.markerWait > this.cfg.preambleSymbols + 6) {
          this.state = "hunt";
          this.lock *= 0.5;
        }
        continue;
      }

      // data
      const { read, offset } = this.readAligned(this.pos);
      this.pos = offset + symbolSamples;
      this.tones.push(read.tone);
      this.lock = this.lock * 0.9 + read.purity * 0.1;
      if (this.tones.length >= this.frameBytes * 2) {
        sink(tonesToBytes(this.tones));
        this.state = "hunt";
        this.history.length = 0;
      }
    }
  }

  /**
   * Look back for the preamble's 0/15 alternation and return the sample offset
   * of the next symbol boundary. Quarter-symbol hops mean each symbol shows up
   * roughly four times, so a run-length view of the tone history finds the edge.
   */
  private findPreamble(): number | null {
    const h = this.history;
    const need = 6;
    if (h.length < need * 3) return null;

    let runs = 0;
    let i = h.length - 1;
    let lastTone = -1;
    let boundaryIdx = -1;
    while (i >= 0 && runs < need) {
      const r = h[i];
      if (r.purity < 0.30 || (r.tone !== 0 && r.tone !== TONES - 1)) break;
      if (lastTone === -1) lastTone = r.tone;
      else if (r.tone !== lastTone) {
        if (boundaryIdx < 0) boundaryIdx = i + 1;
        lastTone = r.tone;
        runs++;
      }
      i--;
    }
    if (runs < need || boundaryIdx < 0) return null;

    // history[k] was read at (pos - (len - k) * hop) before pos advanced.
    const stepsBack = h.length - boundaryIdx;
    const boundary = this.pos - stepsBack * this.hop;
    // Skip whatever preamble remains, landing on the marker.
    let edge = boundary;
    while (edge + this.cfg.symbolSamples * 2 < this.buf.length) {
      const r = this.read(edge);
      if (r.tone !== 0 && r.tone !== TONES - 1) break;
      edge += this.cfg.symbolSamples;
    }
    this.lock = Math.max(this.lock, 0.5);
    return edge;
  }
}
