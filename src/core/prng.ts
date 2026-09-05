/**
 * Deterministic PRNG. The transmitter and receiver never talk, so the mapping
 * `seq -> source block indices` has to be reproducible from the sequence number
 * alone. That makes this file load-bearing: change it and every existing
 * receiver stops decoding. See src/test/lt.test.ts for the snapshot that guards it.
 */

/** 32-bit avalanche mixer (splitmix-flavoured) so adjacent seqs give unrelated streams. */
export function mixSeed(seq: number): number {
  let h = (seq >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/** mulberry32 — small, fast, good enough for symbol construction. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `d` distinct values from [0, n) in O(d) time and memory.
 * Partial Fisher-Yates over a virtual array, with only the swapped
 * positions materialised in a Map — `n` can be huge without allocating it.
 */
export function sampleDistinct(rng: () => number, n: number, d: number): number[] {
  const k = Math.min(d, n);
  const swaps = new Map<number, number>();
  const out = new Array<number>(k);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const vi = swaps.get(i) ?? i;
    const vj = swaps.get(j) ?? j;
    out[i] = vj;
    swaps.set(j, vi);
  }
  return out;
}
