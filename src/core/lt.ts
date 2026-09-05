/**
 * LT (Luby transform) fountain codes.
 *
 * The transmitter emits an endless stream of XOR combinations of the source
 * blocks; the receiver collects any ~1.05-1.15K of them, in any order, and peels
 * them apart. Nothing is ever retransmitted because nothing is ever requested —
 * which is the only reason a one-way channel that drops a third of its frames
 * can still move a file.
 */
import { xorInto } from "./bytes.ts";
import { mixSeed, mulberry32, sampleDistinct } from "./prng.ts";

/** Robust-soliton tuning. Fixed constants: both ends must agree without negotiating. */
export const LT_C = 0.03;
export const LT_DELTA = 0.05;

const cdfCache = new Map<number, Float64Array>();

/**
 * Robust soliton distribution as a cumulative table indexed by degree-1.
 * rho is the ideal soliton (degree d with probability 1/d(d-1)); tau adds the
 * spike near K/S that stops the ripple from dying out early.
 */
export function solitonCdf(K: number): Float64Array {
  const cached = cdfCache.get(K);
  if (cached) return cached;

  const p = new Float64Array(K);
  p[0] = 1 / K;
  for (let d = 2; d <= K; d++) p[d - 1] = 1 / (d * (d - 1));

  const S = LT_C * Math.log(K / LT_DELTA) * Math.sqrt(K);
  const pivot = Math.max(1, Math.min(K, Math.round(K / S)));
  for (let d = 1; d < pivot; d++) p[d - 1] += S / (K * d);
  p[pivot - 1] += (S * Math.log(S / LT_DELTA)) / K;

  let total = 0;
  for (let i = 0; i < K; i++) total += p[i];

  const cdf = new Float64Array(K);
  let acc = 0;
  for (let i = 0; i < K; i++) {
    acc += p[i] / total;
    cdf[i] = acc;
  }
  cdf[K - 1] = 1;
  cdfCache.set(K, cdf);
  return cdf;
}

function sampleDegree(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u <= cdf[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

/**
 * Below this many blocks the soliton distribution is too sparse to reach full
 * rank quickly, and its overhead balloons (25% at K=22). Mixing in uniformly
 * random degrees fills rank far faster; at these sizes the denser XORs cost
 * nothing. Above it, soliton alone is both cheaper and better.
 */
export const LT_DENSE_BELOW = 64;
const LT_DENSE_SHARE = 0.5;

/**
 * The pure function at the centre of the protocol: which source blocks are
 * XORed into the symbol with this sequence number. Deterministic given (seq, K)
 * and nothing else, because the receiver has no back-channel to ask.
 */
export function neighborsFor(seq: number, K: number, cdf = solitonCdf(K)): number[] {
  const rng = mulberry32(mixSeed(seq));
  const pick = rng();
  if (K <= LT_DENSE_BELOW && pick < LT_DENSE_SHARE) {
    return sampleDistinct(rng, K, 1 + Math.floor(rng() * K));
  }
  return sampleDistinct(rng, K, sampleDegree(cdf, rng()));
}

export class LtEncoder {
  readonly K: number;
  private readonly cdf: Float64Array;

  readonly blockSize: number;
  private readonly blocks: Uint8Array[];

  constructor(blocks: Uint8Array[], blockSize: number) {
    this.blocks = blocks;
    this.blockSize = blockSize;
    this.K = blocks.length;
    this.cdf = solitonCdf(this.K);
  }

  /** Split a payload into K blocks of `blockSize`, zero-padding the tail. */
  static fromPayload(payload: Uint8Array, blockSize: number): LtEncoder {
    const K = Math.max(1, Math.ceil(payload.length / blockSize));
    const blocks: Uint8Array[] = [];
    for (let i = 0; i < K; i++) {
      const b = new Uint8Array(blockSize);
      b.set(payload.subarray(i * blockSize, Math.min((i + 1) * blockSize, payload.length)));
      blocks.push(b);
    }
    return new LtEncoder(blocks, blockSize);
  }

  /** Symbol for a given sequence number. Deterministic and stateless. */
  symbol(seq: number): Uint8Array {
    const out = new Uint8Array(this.blockSize);
    for (const idx of neighborsFor(seq, this.K, this.cdf)) xorInto(out, this.blocks[idx]);
    return out;
  }
}

const DEAD = new Uint8Array(0);

export class LtDecoder {
  readonly blocks: (Uint8Array | null)[];
  private readonly cdf: Float64Array;
  private readonly seen = new Set<number>();
  private readonly symData: Uint8Array[] = [];
  private readonly symNeighbors: Set<number>[] = [];
  private readonly symAlive: boolean[] = [];
  /** block index -> indices of live symbols that still reference it */
  private readonly refs = new Map<number, Set<number>>();

  decodedCount = 0;
  symbolsAccepted = 0;

  readonly K: number;
  readonly blockSize: number;

  constructor(K: number, blockSize: number) {
    this.K = K;
    this.blockSize = blockSize;
    this.blocks = new Array(K).fill(null);
    this.cdf = solitonCdf(K);
  }

  get done(): boolean {
    return this.decodedCount >= this.K;
  }

  /** Feed one symbol. Returns how many source blocks it unlocked (often 0, sometimes many). */
  push(seq: number, payload: Uint8Array): number {
    if (this.done || this.seen.has(seq)) return 0;
    this.seen.add(seq);
    this.symbolsAccepted++;

    const data = payload.slice(0, this.blockSize);
    const pending = new Set<number>();
    for (const idx of neighborsFor(seq, this.K, this.cdf)) {
      const known = this.blocks[idx];
      if (known) xorInto(data, known);
      else pending.add(idx);
    }
    if (pending.size === 0) return 0; // fully redundant

    const si = this.symData.length;
    this.symData.push(data);
    this.symNeighbors.push(pending);
    this.symAlive.push(true);
    for (const b of pending) {
      let set = this.refs.get(b);
      if (!set) this.refs.set(b, (set = new Set()));
      set.add(si);
    }

    let newly = pending.size === 1 ? this.peel(si) : 0;
    if (!this.done) newly += this.maybeSolve();
    return newly;
  }

  private lastAttempt = -1e9;

  /**
   * Elimination is O(m^3/32); peeling is nearly free. So peel first and only
   * fall back once there are plausibly enough independent equations, with a
   * stride so we don't re-run the whole solve on every arriving symbol.
   */
  private maybeSolve(): number {
    const unknowns = this.K - this.decodedCount;
    if (unknowns === 0) return 0;
    let live = 0;
    for (let i = 0; i < this.symAlive.length; i++) if (this.symAlive[i]) live++;
    if (live < unknowns) return 0;
    const stride = unknowns <= 256 ? 1 : Math.ceil(unknowns / 128);
    if (this.symbolsAccepted - this.lastAttempt < stride) return 0;
    this.lastAttempt = this.symbolsAccepted;
    return this.solveResidual();
  }

  /** Belief propagation: resolve degree-1 symbols, then cascade. */
  private peel(start: number): number {
    let newly = 0;
    const queue = [start];
    while (queue.length) {
      const si = queue.pop()!;
      if (!this.symAlive[si]) continue;
      const nb = this.symNeighbors[si];
      if (nb.size !== 1) continue;

      const b = nb.values().next().value as number;
      this.symAlive[si] = false;
      nb.clear();

      if (this.blocks[b]) {
        this.refs.get(b)?.delete(si);
        this.symData[si] = DEAD;
        continue;
      }

      this.blocks[b] = this.symData[si];
      this.decodedCount++;
      newly++;

      const dependents = this.refs.get(b);
      this.refs.delete(b);
      if (!dependents) continue;
      for (const oi of dependents) {
        if (oi === si || !this.symAlive[oi]) continue;
        xorInto(this.symData[oi], this.blocks[b]!);
        const set = this.symNeighbors[oi];
        set.delete(b);
        if (set.size === 1) queue.push(oi);
        else if (set.size === 0) {
          this.symAlive[oi] = false;
          this.symData[oi] = DEAD;
        }
      }
    }
    return newly;
  }

  /**
   * Fallback when peeling stalls. Peeling only makes progress while some symbol
   * has exactly one unknown neighbour; near the end of a transfer the graph
   * routinely runs out of those with a handful of blocks still missing, and
   * waiting for a lucky symbol costs 30-60% extra traffic. Solving the residual
   * system directly instead means decoding completes as soon as the received
   * symbols actually span the space, which is the information-theoretic floor.
   *
   * Standard fountain-code practice (RaptorQ calls it inactivation decoding).
   * Runs over GF(2) with bitset rows, so it is XOR and word scans all the way down.
   */
  private solveResidual(): number {
    const unknowns: number[] = [];
    const col = new Int32Array(this.K).fill(-1);
    for (let i = 0; i < this.K; i++) {
      if (!this.blocks[i]) {
        col[i] = unknowns.length;
        unknowns.push(i);
      }
    }
    const m = unknowns.length;
    if (m === 0) return 0;

    const live: number[] = [];
    for (let i = 0; i < this.symAlive.length; i++) if (this.symAlive[i]) live.push(i);
    if (live.length < m) return 0;

    const words = (m + 31) >>> 5;
    const n = live.length;
    const rows = new Uint32Array(n * words);
    const data = new Uint8Array(n * this.blockSize);
    for (let r = 0; r < n; r++) {
      const si = live[r];
      for (const b of this.symNeighbors[si]) {
        const c = col[b];
        rows[r * words + (c >>> 5)] |= 1 << (c & 31);
      }
      data.set(this.symData[si], r * this.blockSize);
    }

    const pivotCol = new Int32Array(m).fill(-1);
    let rank = 0;
    for (let c = 0; c < m && rank < m; c++) {
      const w = c >>> 5;
      const bit = 1 << (c & 31);
      let pivot = -1;
      for (let r = rank; r < n; r++) {
        if (rows[r * words + w] & bit) {
          pivot = r;
          break;
        }
      }
      if (pivot < 0) continue;
      if (pivot !== rank) {
        for (let k = 0; k < words; k++) {
          const t = rows[pivot * words + k];
          rows[pivot * words + k] = rows[rank * words + k];
          rows[rank * words + k] = t;
        }
        for (let k = 0; k < this.blockSize; k++) {
          const t = data[pivot * this.blockSize + k];
          data[pivot * this.blockSize + k] = data[rank * this.blockSize + k];
          data[rank * this.blockSize + k] = t;
        }
      }
      for (let r = rank + 1; r < n; r++) {
        if (!(rows[r * words + w] & bit)) continue;
        for (let k = w; k < words; k++) rows[r * words + k] ^= rows[rank * words + k];
        const dr = r * this.blockSize;
        const dp = rank * this.blockSize;
        for (let k = 0; k < this.blockSize; k++) data[dr + k] ^= data[dp + k];
      }
      pivotCol[rank] = c;
      rank++;
    }
    if (rank < m) return 0; // not enough independent equations yet

    // Back-substitute: every column above the pivot is itself a solved pivot column.
    const solution: Uint8Array[] = new Array(m);
    for (let r = m - 1; r >= 0; r--) {
      const c = pivotCol[r];
      const acc = data.slice(r * this.blockSize, (r + 1) * this.blockSize);
      for (let k = c >>> 5; k < words; k++) {
        let word = rows[r * words + k];
        // Clear columns at or below the pivot. Written as a doubled shift because
        // `1 << 32` wraps to 1 in JS and would mask nothing when the pivot is bit 31.
        if (k === c >>> 5) word &= ~(((1 << (c & 31)) << 1) - 1);
        while (word) {
          const b = 31 - Math.clz32(word & -word);
          const cc = (k << 5) + b;
          word &= word - 1;
          if (cc > c && solution[cc]) xorInto(acc, solution[cc]);
        }
      }
      solution[c] = acc;
    }

    let newly = 0;
    for (let i = 0; i < m; i++) {
      this.blocks[unknowns[i]] = solution[i];
      newly++;
    }
    this.decodedCount = this.K;
    for (let i = 0; i < this.symAlive.length; i++) {
      this.symAlive[i] = false;
      this.symData[i] = DEAD;
      this.symNeighbors[i].clear();
    }
    this.refs.clear();
    return newly;
  }

  /** Concatenated source blocks. Caller trims to the true payload length. */
  assemble(): Uint8Array {
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) {
      const b = this.blocks[i];
      if (b) out.set(b, i * this.blockSize);
    }
    return out;
  }
}
