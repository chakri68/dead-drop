/**
 * Moving a small blob across the gap optically, outside the main pipeline.
 *
 * LINK needs to exchange SDP before it has a channel to exchange it over. That
 * blob is under a kilobyte and its delivery is interactive — someone is holding
 * a phone up to a screen — so it gets a much simpler scheme than the fountain:
 * fixed chunks, cycled forever, collected until complete.
 */
import { crc16 } from "../core/bytes.ts";
import { blockSizeFor, capacityBytes, encodeGrid } from "../glyph/layout.ts";
import { detectGlyphs } from "../glyph/detect.ts";
import { drawGlyph } from "../glyph/render.ts";
import { openCamera } from "./media.ts";
import { sleep } from "./types.ts";

const MAGIC = 0xb1;
const N = 24;
const HEAD = 7; // magic, idx, count, len(2), crc(2)
const CHUNK = blockSizeFor(N, HEAD);

function pack(blob: Uint8Array): Uint8Array[] {
  const count = Math.max(1, Math.ceil(blob.length / CHUNK));
  if (count > 255) throw new Error("handshake blob too large");
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const body = blob.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, blob.length));
    const f = new Uint8Array(HEAD + CHUNK);
    f[0] = MAGIC;
    f[1] = i;
    f[2] = count;
    f[3] = (blob.length >> 8) & 0xff;
    f[4] = blob.length & 0xff;
    f.set(body, 5);
    const c = crc16(f, 0, 5 + CHUNK);
    f[5 + CHUNK] = (c >>> 8) & 0xff;
    f[6 + CHUNK] = c & 0xff;
    frames.push(f);
  }
  return frames;
}

class Collector {
  private parts = new Map<number, Uint8Array>();
  private count = 0;
  private total = 0;

  get progress(): [number, number] {
    return [this.parts.size, this.count];
  }

  push(raw: Uint8Array): Uint8Array | null {
    if (raw.length < HEAD + CHUNK || raw[0] !== MAGIC) return null;
    const want = (raw[5 + CHUNK] << 8) | raw[6 + CHUNK];
    if (crc16(raw, 0, 5 + CHUNK) !== want) return null;
    const idx = raw[1];
    const count = raw[2];
    const total = (raw[3] << 8) | raw[4];
    if (count === 0 || idx >= count) return null;
    if (this.count && (count !== this.count || total !== this.total)) this.parts.clear();
    this.count = count;
    this.total = total;
    this.parts.set(idx, raw.slice(5, 5 + CHUNK));
    if (this.parts.size < count) return null;
    const out = new Uint8Array(count * CHUNK);
    for (const [i, part] of this.parts) out.set(part, i * CHUNK);
    return out.subarray(0, total);
  }
}

/** Cycle the blob's glyph frames on screen until aborted. */
export async function showBlob(
  blob: Uint8Array,
  mount: HTMLElement,
  signal: AbortSignal,
  log: (s: string) => void,
): Promise<void> {
  const frames = pack(blob);
  const canvas = document.createElement("canvas");
  canvas.className = "viz glyph-tx";
  mount.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  log(`SHOWING ${blob.length} B AS ${frames.length} GLYPH${frames.length === 1 ? "" : "S"}`);
  let i = 0;
  while (!signal.aborted) {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const size = Math.max(240, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * dpr));
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    drawGlyph(ctx, N, encodeGrid(N, frames[i % frames.length]), size);
    i++;
    await sleep(frames.length === 1 ? 400 : 120, signal);
  }
  canvas.remove();
}

/** Watch the camera until the whole blob has been collected. */
export async function scanBlob(
  mount: HTMLElement,
  signal: AbortSignal,
  log: (s: string) => void,
): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.className = "viz";
  mount.appendChild(canvas);
  const view = canvas.getContext("2d")!;
  const camera = await openCamera();
  const collector = new Collector();
  const cap = capacityBytes(N);

  try {
    for (;;) {
      if (signal.aborted) throw new Error("aborted");
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (camera.video.readyState >= 2) {
        const vw = camera.video.videoWidth || 1;
        const vh = camera.video.videoHeight || 1;
        const s = Math.min(w / vw, h / vh);
        view.fillStyle = "#000";
        view.fillRect(0, 0, w, h);
        view.drawImage(camera.video, (w - vw * s) / 2, (h - vh * s) / 2, vw * s, vh * s);
      }
      const img = camera.grab(720);
      if (img) {
        for (const det of detectGlyphs(img, N)) {
          const done = collector.push(det.bytes.subarray(0, cap));
          const [have, total] = collector.progress;
          if (total) log(`HANDSHAKE ...... ${have}/${total} GLYPHS`);
          if (done) return done;
        }
      }
      await sleep(70, signal);
    }
  } finally {
    camera.stop();
    canvas.remove();
  }
}
