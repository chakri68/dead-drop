/**
 * QR-CLASSIC — animated standard QR codes.
 *
 * The fallback for when LANTERN's custom grid is too much for the receiving
 * camera. Lower rate, much higher tolerance, and the decode is done by the
 * platform's own `BarcodeDetector` rather than by us — which is exactly why the
 * mode hides itself when that API is absent. We ship a QR encoder, not a decoder.
 *
 * `BarcodeDetector` hands back a string, not bytes, so frames ride as base64.
 * That costs a third of the capacity and is still simpler than fighting whatever
 * text decoding the platform decides to apply to raw binary.
 */
import { fromBase64, toBase64 } from "../core/bytes.ts";
import { frameSize, parseFrame } from "../core/frame.ts";
import { QR_CONFIGS, drawQr, encodeQr } from "../glyph/qr.ts";
import { openCamera } from "./media.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";

const MODES: Record<string, { config: string; blockSize: number }> = {
  v10: { config: "10L", blockSize: 192 },
  v15: { config: "15L", blockSize: 384 },
};

const FPS = 6;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

const Detector = (): BarcodeDetectorCtor | undefined =>
  (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;

export const qrClassic: Transport = {
  id: "qr",
  name: "Animated QR",
  codename: "QR-CLASSIC",
  tier: "Tier 2 — optical",
  caps: { bidirectional: false, estBps: 9_000, range: "across a table" },
  note: "Hidden unless the device has a native BarcodeDetector — we ship a QR encoder, not a decoder. Slower than LANTERN, far more forgiving of a bad camera.",
  modes: [
    { id: "v10", label: "VERSION 10-L", blockSize: MODES.v10.blockSize, headerEvery: 24 },
    { id: "v15", label: "VERSION 15-L", blockSize: MODES.v15.blockSize, headerEvery: 24 },
  ],

  async probe() {
    const D = Detector();
    if (!D || !navigator.mediaDevices?.getUserMedia) return "unsupported";
    try {
      const formats = (await D.getSupportedFormats?.()) ?? ["qr_code"];
      return formats.includes("qr_code") ? "ok" : "unsupported";
    } catch {
      return "unsupported";
    }
  },

  async tx(symbols, ctx: TxContext) {
    const cfg = QR_CONFIGS[MODES[ctx.mode.id].config];
    const canvas = document.createElement("canvas");
    canvas.className = "viz glyph-tx";
    ctx.mount.appendChild(canvas);
    const draw = canvas.getContext("2d")!;
    ctx.meter.set(1);
    ctx.log(`QR VERSION ${cfg.version}-${cfg.ec}  ${ctx.mode.blockSize} B/FRAME  ${FPS} FPS`);

    for await (const frame of symbols) {
      if (ctx.signal.aborted) break;
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const size = Math.max(240, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * dpr));
      if (canvas.width !== size) {
        canvas.width = size;
        canvas.height = size;
      }
      drawQr(draw, encodeQr(new TextEncoder().encode(toBase64(frame)), cfg), size);
      await sleep(1000 / FPS, ctx.signal);
    }
  },

  async *rx(ctx: TransportContext) {
    const queue = new SymbolQueue();
    const detector = new (Detector()!)({ formats: ["qr_code"] });
    const canvas = document.createElement("canvas");
    canvas.className = "viz";
    ctx.mount.appendChild(canvas);
    const view = canvas.getContext("2d")!;
    const camera = await openCamera();
    const size = frameSize(ctx.mode.blockSize);
    ctx.log("BARCODE DETECTOR ACTIVE");

    ctx.signal.addEventListener("abort", () => {
      camera.stop();
      queue.close();
    }, { once: true });

    let busy = false;
    const loop = async () => {
      if (ctx.signal.aborted) return;
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

        if (!busy) {
          busy = true;
          try {
            const codes = await detector.detect(camera.video);
            let hit = false;
            for (const code of codes) {
              const frame = fromBase64(code.rawValue);
              if (frame.length !== size || !parseFrame(frame, ctx.mode.blockSize)) continue;
              queue.push(frame);
              hit = true;
            }
            ctx.meter.set(hit ? 1 : ctx.meter.get() * 0.9);
          } catch {
            /* detector hiccup; try again next frame */
          }
          busy = false;
        }
      }
      requestAnimationFrame(() => void loop());
    };
    void loop();

    try {
      yield* queue;
    } finally {
      camera.stop();
    }
  },
};
