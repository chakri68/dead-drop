/**
 * Signal processing. Hand-rolled so the same code runs in the browser and in
 * the Node test harness — the modem is tested against synthesised noise, not
 * against a room.
 */

/** In-place iterative radix-2 FFT. `re`/`im` must be a power-of-two length. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + (len >> 1)] * cr - im[i + k + (len >> 1)] * ci;
        const vi = re[i + k + (len >> 1)] * ci + im[i + k + (len >> 1)] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + (len >> 1)] = ur - vr;
        im[i + k + (len >> 1)] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Magnitude spectrum of a real signal, for the waterfall display. */
export function magnitudes(samples: Float32Array, window: Float32Array, out: Float32Array): void {
  const n = window.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = (samples[i] ?? 0) * window[i];
  fft(re, im);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]);
}

/**
 * Generalised Goertzel: power at an arbitrary frequency over one window.
 * For MFSK we only care about 16 known tones, so this is far cheaper than an FFT
 * and doesn't force the tone spacing onto bin centres.
 */
export function goertzel(samples: Float32Array, offset: number, length: number, freq: number, sampleRate: number): number {
  const k = (freq * length) / sampleRate;
  const w = (2 * Math.PI * k) / length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    s0 = samples[offset + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}
