/**
 * Per-transport live visuals. The spec calls these mandatory and it's right:
 * a progress bar tells you a transfer is working, a waterfall tells you *why*
 * it isn't.
 */

const AMBER = [255, 176, 0] as const;

function fitCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas.getContext("2d")!;
}

export function makeCanvas(mount: HTMLElement, className = "viz"): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = className;
  mount.appendChild(c);
  return c;
}

/** Scrolling spectrogram. One column per push, oldest falling off the left. */
export class Waterfall {
  private canvas: HTMLCanvasElement;
  private minBin: number;
  private maxBin: number;

  constructor(canvas: HTMLCanvasElement, opts: { sampleRate: number; fftSize: number; minFreq: number; maxFreq: number }) {
    this.canvas = canvas;
    const perBin = opts.sampleRate / opts.fftSize;
    this.minBin = Math.max(0, Math.floor(opts.minFreq / perBin) - 2);
    this.maxBin = Math.min(opts.fftSize / 2, Math.ceil(opts.maxFreq / perBin) + 2);
  }

  push(mags: Float32Array): void {
    const ctx = fitCanvas(this.canvas);
    const { width: w, height: h } = this.canvas;
    ctx.drawImage(this.canvas, -2, 0);
    let peak = 1e-6;
    for (let i = this.minBin; i < this.maxBin; i++) peak = Math.max(peak, mags[i]);
    const span = this.maxBin - this.minBin;
    const colH = h / span;
    for (let i = 0; i < span; i++) {
      const v = Math.min(1, mags[this.minBin + i] / peak) ** 0.55;
      const y = h - (i + 1) * colH;
      ctx.fillStyle = `rgb(${AMBER[0] * v},${AMBER[1] * v * 0.95},${AMBER[2] * v + 20 * v})`;
      ctx.fillRect(w - 2, y, 2, colH + 1);
    }
  }

  clear(): void {
    const ctx = fitCanvas(this.canvas);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

/** Rolling line trace with an optional threshold rule — luminance, acceleration. */
export class Trace {
  private canvas: HTMLCanvasElement;
  private values: number[] = [];
  private marks: number[] = [];
  private cap: number;

  constructor(canvas: HTMLCanvasElement, cap = 480) {
    this.canvas = canvas;
    this.cap = cap;
  }

  push(v: number, mark = 0): void {
    this.values.push(v);
    this.marks.push(mark);
    while (this.values.length > this.cap) {
      this.values.shift();
      this.marks.shift();
    }
  }

  draw(threshold: number | null): void {
    const ctx = fitCanvas(this.canvas);
    const { width: w, height: h } = this.canvas;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    if (this.values.length < 2) return;

    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.values) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-6) hi = lo + 1;
    const y = (v: number) => h - ((v - lo) / (hi - lo)) * (h - 8) - 4;
    const x = (i: number) => (i / (this.cap - 1)) * w;

    if (threshold !== null && threshold >= lo && threshold <= hi) {
      ctx.strokeStyle = "rgba(255,106,43,0.55)";
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y(threshold));
      ctx.lineTo(w, y(threshold));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = "#ffb000";
    ctx.lineWidth = Math.min(2, w / 400);
    ctx.beginPath();
    for (let i = 0; i < this.values.length; i++) {
      const px = x(i);
      const py = y(this.values[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(255,176,0,0.9)";
    for (let i = 0; i < this.marks.length; i++) {
      if (this.marks[i]) ctx.fillRect(x(i) - 1, 0, 2, 6);
    }
  }
}

/** 16 tone rows that light as symbols go out. The transmit-side counterpart to the waterfall. */
export class ToneLadder {
  private canvas: HTMLCanvasElement;
  private rows: number;
  private levels: Float32Array;

  constructor(canvas: HTMLCanvasElement, rows: number) {
    this.canvas = canvas;
    this.rows = rows;
    this.levels = new Float32Array(rows);
  }

  hit(row: number): void {
    if (row >= 0 && row < this.rows) this.levels[row] = 1;
  }

  draw(decay = 0.06): void {
    const ctx = fitCanvas(this.canvas);
    const { width: w, height: h } = this.canvas;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    const rowH = h / this.rows;
    for (let i = 0; i < this.rows; i++) {
      const v = this.levels[i];
      this.levels[i] = Math.max(0, v - decay);
      const y = h - (i + 1) * rowH;
      ctx.fillStyle = `rgba(255,176,0,${0.08 + v * 0.9})`;
      ctx.fillRect(0, y + 1, w * (0.12 + v * 0.88), rowH - 2);
    }
  }
}

/** Scrolling hex dump of symbols on the wire. Cheap, and reads as telemetry. */
export class SymbolLog {
  private el: HTMLElement;
  private lines: string[] = [];
  private cap: number;

  constructor(mount: HTMLElement, cap = 14) {
    this.el = document.createElement("pre");
    this.el.className = "symlog";
    mount.appendChild(this.el);
    this.cap = cap;
  }

  push(line: string): void {
    this.lines.push(line);
    while (this.lines.length > this.cap) this.lines.shift();
    this.el.textContent = this.lines.join("\n");
  }
}

export function hexPreview(bytes: Uint8Array, n = 12): string {
  let s = "";
  for (let i = 0; i < Math.min(n, bytes.length); i++) s += bytes[i].toString(16).padStart(2, "0") + " ";
  return s.trim() + (bytes.length > n ? " ..." : "");
}
