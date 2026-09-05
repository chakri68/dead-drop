/**
 * On-off keying with Manchester encoding — the codec behind MORSE (a lamp) and
 * HAPTIC (a vibration motor).
 *
 * Manchester because these channels have no clock and no level reference. Every
 * bit carries its own transition, so the receiver recovers timing from the
 * signal itself, and the code is DC-balanced, so "how bright is bright" can be
 * a running average rather than a calibration step. A torch across a room and a
 * phone buzzing against another phone have the same problem, so they share this.
 *
 *   preamble  alternating half-bits — a square wave to lock the clock to
 *   marker    1,1,0,0 — illegal in Manchester, so it can only mean "data next"
 *   data      bit 0 -> low,high   bit 1 -> high,low
 */

export interface OokConfig {
  halfBitMs: number;
  preambleHalfBits: number;
}

export const MARKER: readonly number[] = [1, 1, 0, 0];

/** Below this many readings per half-bit the decoder stops working outright. */
export const MIN_SAMPLES_PER_HALF_BIT = 3;

export function encodeOok(frame: Uint8Array, cfg: OokConfig): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < cfg.preambleHalfBits; i++) out.push(i % 2);
  out.push(...MARKER);
  for (const byte of frame) {
    for (let b = 7; b >= 0; b--) {
      if ((byte >> b) & 1) out.push(1, 0);
      else out.push(0, 1);
    }
  }
  return new Uint8Array(out);
}

export function halfBitsToBytes(halfBits: number[]): Uint8Array {
  const bits = halfBits.length >> 1;
  const out = new Uint8Array(bits >> 3);
  for (let i = 0; i < bits; i++) {
    // A pair that didn't transition is a bit error; take the first half and let
    // the CRC upstairs deal with it.
    const bit = halfBits[i * 2] === 1 ? 1 : 0;
    if (bit) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

type State = "hunt" | "preamble" | "data";

/**
 * Streaming decoder over irregularly sampled level readings — camera frames
 * arrive at whatever rate the camera feels like, and DeviceMotion is worse.
 */
export class OokDecoder {
  private cfg: OokConfig;
  private frameBytes: number;

  private hi = 0;
  private lo = 1;
  private level = 0;
  private lastBit = 0;
  private edges: number[] = [];
  private state: State = "hunt";

  private period = 0;
  /** Time of the current half-bit's leading boundary. Advances with the clock. */
  private boundary = 0;
  private sampleGap = 33;
  private lastPush = -1;
  private nextSample = 0;
  private window: Array<[number, number]> = [];
  private halfBits: number[] = [];
  private preambleSeen = 0;

  /** 0..1, for the UI meter. */
  lock = 0;
  threshold: number | null = null;

  /**
   * How often readings are arriving. The decoder needs about three per half-bit
   * to resolve one reliably — below that it fails completely rather than
   * degrading — so the receiver surfaces this instead of leaving you to guess
   * why a perfectly visible blinking light decodes nothing.
   */
  get sampleRateHz(): number {
    return this.sampleGap > 0 ? 1000 / this.sampleGap : 0;
  }

  get samplesPerHalfBit(): number {
    return this.cfg.halfBitMs / Math.max(1, this.sampleGap);
  }

  constructor(cfg: OokConfig, frameBytes: number) {
    this.cfg = cfg;
    this.frameBytes = frameBytes;
    this.period = cfg.halfBitMs;
  }

  /** Feed one reading. Returns a frame's bytes when one completes. */
  push(t: number, value: number): Uint8Array | null {
    // Track how often readings arrive: a camera quantises every edge it reports
    // to its own frame period, and the clock recovery has to allow for that.
    if (this.lastPush >= 0) {
      const gap = t - this.lastPush;
      if (gap > 0 && gap < 500) this.sampleGap = this.sampleGap * 0.9 + gap * 0.1;
    }
    this.lastPush = t;

    // Peak tracker: fast to widen, slow to close, so a long run of one level
    // doesn't drag the threshold onto itself.
    if (value > this.hi) this.hi = value;
    else this.hi += (value - this.hi) * 0.004;
    if (value < this.lo) this.lo = value;
    else this.lo += (value - this.lo) * 0.004;

    const span = this.hi - this.lo;
    if (span < 0.02) {
      this.threshold = null;
      return null;
    }
    const mid = (this.hi + this.lo) / 2;
    this.threshold = mid;

    const hys = span * 0.12;
    if (value > mid + hys) this.level = 1;
    else if (value < mid - hys) this.level = 0;

    if (this.level !== this.lastBit) {
      this.lastBit = this.level;
      this.onEdge(t);
    }

    if (this.state === "hunt") return null;

    this.window.push([t, this.level]);
    if (t >= this.nextSample) {
      const halfBit = this.vote();
      this.window.length = 0;
      this.boundary = this.nextSample;
      this.nextSample += this.period;
      return this.onHalfBit(halfBit);
    }
    return null;
  }

  /**
   * Weight each reading by how close it sits to the middle of the half-bit.
   * With only ~3 camera frames per half-bit, a plain majority is decided by
   * whichever sample happened to straddle the transition, and ties break the
   * same way every time — which shows up as one-bit slips in long runs.
   */
  private vote(): number {
    if (!this.window.length) return this.level;
    const centre = this.nextSample - this.period / 2;
    let num = 0;
    let den = 0;
    for (const [ts, v] of this.window) {
      const w = Math.max(0.05, 1 - Math.abs(ts - centre) / (this.period / 2));
      num += w * v;
      den += w;
    }
    return num / den >= 0.5 ? 1 : 0;
  }

  private onEdge(t: number): void {
    this.edges.push(t);
    if (this.edges.length > 24) this.edges.shift();

    if (this.state === "hunt") {
      this.tryLock(t);
      return;
    }
    // Phase-locked loop over the observed edges. Edges land on half-bit
    // boundaries, so the error is the distance to whichever boundary is nearer.
    // Measuring it against a boundary that advances with the clock (rather than
    // a modulo of a fixed origin) keeps this well-conditioned: the origin form
    // makes a tiny change in period look like an enormous phase jump.
    const err = Math.abs(t - this.boundary) < Math.abs(t - this.nextSample)
      ? t - this.boundary
      : t - this.nextSample;
    if (Math.abs(err) > this.period * 0.5) return;

    // Proportional term keeps sampling centred; the integral term corrects the
    // period, without which a 1% error in the initial estimate walks a full
    // half-bit out of alignment across a couple of hundred of them.
    this.boundary += err * 0.15;
    this.nextSample += err * 0.15;
    this.period += err * 0.005;
    const lo = this.cfg.halfBitMs * 0.6;
    const hi = this.cfg.halfBitMs * 1.6;
    this.period = Math.min(hi, Math.max(lo, this.period));
  }

  /**
   * The preamble is a square wave, so its edges land one half-bit apart and are
   * numbered 0, 1, 2... A least-squares fit of edge time against edge index
   * recovers both period and phase, and averaging over eleven edges cancels most
   * of the frame-rate quantisation that makes any single interval unreliable.
   */
  private tryLock(t: number): void {
    const n = 11;
    if (this.edges.length < n) return;
    const recent = this.edges.slice(-n);

    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += recent[i];
      sxx += i * i;
      sxy += i * recent[i];
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return;
    const period = (n * sxy - sx * sy) / denom;
    const intercept = (sy - period * sx) / n;
    if (period < this.cfg.halfBitMs * 0.5 || period > this.cfg.halfBitMs * 2.0) return;

    // Every edge must sit on its predicted boundary, allowing for the reporting
    // quantisation. Anything sloppier is flicker, not a preamble.
    const tolerance = Math.max(period * 0.3, this.sampleGap * 1.15);
    for (let i = 0; i < n; i++) {
      if (Math.abs(recent[i] - (intercept + period * i)) > tolerance) return;
    }

    this.period = period;
    // Edges are half-bit *boundaries*, so sampling runs boundary-to-boundary and
    // decides at the end of each window. Centring on an edge would average the
    // transition itself into every decision.
    this.boundary = intercept + period * (n - 1);
    this.nextSample = this.boundary + period;
    this.state = "preamble";
    this.preambleSeen = 0;
    this.halfBits = [];
    this.window.length = 0;
    this.lock = Math.max(this.lock, 0.55);
    void t;
  }

  private onHalfBit(v: number): Uint8Array | null {
    if (this.state === "preamble") {
      this.halfBits.push(v);
      if (this.halfBits.length > 4) this.halfBits.shift();
      this.preambleSeen++;
      if (this.halfBits.length === 4 && MARKER.every((m, i) => m === this.halfBits[i])) {
        this.state = "data";
        this.halfBits = [];
        this.lock = Math.min(1, this.lock + 0.25);
        return null;
      }
      if (this.preambleSeen > this.cfg.preambleHalfBits + 12) {
        this.state = "hunt";
        this.edges.length = 0;
        this.lock *= 0.6;
      }
      return null;
    }

    this.halfBits.push(v);
    if (this.halfBits.length >= this.frameBytes * 16) {
      const bytes = halfBitsToBytes(this.halfBits);
      this.state = "hunt";
      this.edges.length = 0;
      this.halfBits = [];
      return bytes;
    }
    return null;
  }
}
