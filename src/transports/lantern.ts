/**
 * LANTERN — screen to camera.
 *
 * An animated colour grid at 12 fps. Roughly 200 bytes a frame at the default
 * 24x24, so about 18 kbit/s across a table. Because it is fountain-coded the
 * receiver can be shaky, miss frames, look away for ten seconds and come back:
 * there is no state to lose, only symbols not yet collected.
 */
import { FRAME_OVERHEAD, frameSize } from "../core/frame.ts";
import { blockSizeFor, encodeGrid } from "../glyph/layout.ts";
import { detectGlyphs } from "../glyph/detect.ts";
import { drawGlyph } from "../glyph/render.ts";
import { openCamera } from "./media.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";

const GRIDS = { standard: 24, dense: 32 } as const;

function gridFor(modeId: string): number {
  return GRIDS[modeId as keyof typeof GRIDS] ?? GRIDS.standard;
}

const FPS = 12;

export const lantern: Transport = {
  id: "lantern",
  name: "Optical grid",
  codename: "LANTERN",
  tier: "Tier 2 — optical",
  caps: { bidirectional: false, estBps: 20_000, range: "across a table" },
  note: "Fill the receiver's frame with the grid and hold reasonably still. Dense mode doubles the rate and wants a better camera.",
  modes: [
    { id: "standard", label: "24x24 GRID", blockSize: blockSizeFor(GRIDS.standard, FRAME_OVERHEAD), headerEvery: 40 },
    { id: "dense", label: "32x32 GRID", blockSize: blockSizeFor(GRIDS.dense, FRAME_OVERHEAD), headerEvery: 40 },
  ],

  async probe() {
    if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    const N = gridFor(ctx.mode.id);
    const canvas = document.createElement("canvas");
    canvas.className = "viz glyph-tx";
    ctx.mount.appendChild(canvas);
    const draw = canvas.getContext("2d")!;
    ctx.meter.set(1);
    ctx.log(`GRID ${N}x${N}  ${ctx.mode.blockSize} B/FRAME  ${FPS} FPS`);
    ctx.log(`RATE ~${((ctx.mode.blockSize * 8 * FPS) / 1000).toFixed(1)} kbit/s`);

    for await (const frame of symbols) {
      if (ctx.signal.aborted) break;
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const size = Math.max(240, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * dpr));
      if (canvas.width !== size) {
        canvas.width = size;
        canvas.height = size;
      }
      drawGlyph(draw, N, encodeGrid(N, frame), size);
      await sleep(1000 / FPS, ctx.signal);
    }
  },

  async *rx(ctx: TransportContext) {
    const N = gridFor(ctx.mode.id);
    const wireLen = frameSize(ctx.mode.blockSize);
    const queue = new SymbolQueue();
    const canvas = document.createElement("canvas");
    canvas.className = "viz";
    ctx.mount.appendChild(canvas);
    const view = canvas.getContext("2d")!;

    const camera = await openCamera();
    ctx.log(`CAMERA OPEN  LOOKING FOR ${N}x${N} GRID`);
    ctx.signal.addEventListener("abort", () => {
      camera.stop();
      queue.close();
    }, { once: true });

    let lastDetect = 0;
    let quads: Array<Array<readonly [number, number]>> = [];
    let confidence = 0;

    const loop = () => {
      if (ctx.signal.aborted) return;
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      // Draw the feed letterboxed, then overlay whatever the detector found.
      const vw = camera.video.videoWidth || 1;
      const vh = camera.video.videoHeight || 1;
      const scale = Math.min(w / vw, h / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;
      view.fillStyle = "#000";
      view.fillRect(0, 0, w, h);
      if (camera.video.readyState >= 2) view.drawImage(camera.video, dx, dy, dw, dh);

      const now = performance.now();
      if (now - lastDetect > 1000 / 15) {
        lastDetect = now;
        const img = camera.grab(720);
        if (img) {
          const found = detectGlyphs(img, N);
          quads = [];
          confidence = 0;
          for (const det of found) {
            quads.push(det.quad.map((p) => [(p[0] / img.width) * dw + dx, (p[1] / img.height) * dh + dy] as const));
            confidence = Math.max(confidence, det.confidence);
            queue.push(det.bytes.subarray(0, wireLen));
          }
          // Decay rather than snap to zero, so the meter doesn't strobe between frames.
          ctx.meter.set(found.length ? confidence : ctx.meter.get() * 0.85);
        }
      }

      view.lineWidth = 2 * dpr;
      view.strokeStyle = "#ffb000";
      view.shadowColor = "rgba(255,176,0,0.7)";
      view.shadowBlur = 12;
      for (const q of quads) {
        view.beginPath();
        view.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i++) view.lineTo(q[i][0], q[i][1]);
        view.closePath();
        view.stroke();
      }
      view.shadowBlur = 0;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    try {
      yield* queue;
    } finally {
      camera.stop();
    }
  },
};
