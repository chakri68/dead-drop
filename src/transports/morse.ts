/**
 * MORSE — a light, blinking.
 *
 * On-off keying at around ten baud, Manchester-coded (see core/ook.ts). The
 * transmitter prefers the phone's torch and falls back to flashing the whole
 * screen white; the receiver watches the mean luminance of its camera frames and
 * nothing else. It moves a couple of bytes a second and works in the dark across
 * a room, which is a strange combination of properties to have.
 */
import { frameSize } from "../core/frame.ts";
import { encodeOok, MIN_SAMPLES_PER_HALF_BIT, OokDecoder, type OokConfig } from "../core/ook.ts";
import { openCamera } from "./media.ts";
import { makeCanvas, Trace } from "../ui/visuals.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";

/**
 * Half-bit periods are chosen against camera frame rates, not against a target
 * bit rate. The decoder needs ~3 readings per half-bit and falls off a cliff
 * below that, so each mode names the camera it needs. A phone in a dark room
 * drops to 24 fps or lower to gather light — which is exactly when you'd be
 * using this — so the default assumes it.
 */
const PROFILES: Record<string, OokConfig> = {
  steady: { halfBitMs: 130, preambleHalfBits: 28 },
  standard: { halfBitMs: 100, preambleHalfBits: 28 },
  fast: { halfBitMs: 55, preambleHalfBits: 32 },
};

function profileFor(id: string): OokConfig {
  return PROFILES[id] ?? PROFILES.steady;
}

export const morse: Transport = {
  id: "morse",
  name: "Torch to camera",
  codename: "MORSE",
  tier: "Tier 0 — is it even data",
  caps: { bidirectional: false, estBps: 9, range: "across a dark room" },
  note: "Each mode needs a minimum camera frame rate — the receiver measures its own and will tell you if it is too slow. Cameras slow down in the dark, which is when you want this most.",
  // 16-byte symbols, not 8: the per-frame preamble and framing cost is fixed, so
  // bigger symbols mean fewer of them. Not 24 — at that size the header crosses
  // the threshold where it carries a filename and a full digest, which costs an
  // extra fragment and makes the whole transfer slower than 16 despite the
  // bigger blocks. Measured: 200 B takes 27.8 min at B=8, 17.7 at B=16, 30.3 at B=24.
  modes: [
    { id: "steady", label: "STEADY 3.8 bit/s — 24 FPS", blockSize: 16, headerEvery: 6 },
    { id: "standard", label: "STANDARD 5 bit/s — 30 FPS", blockSize: 16, headerEvery: 6 },
    { id: "fast", label: "FAST 9 bit/s — 60 FPS", blockSize: 16, headerEvery: 6 },
  ],

  async probe() {
    if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    const cfg = profileFor(ctx.mode.id);
    const panel = document.createElement("div");
    panel.className = "lamp";
    ctx.mount.appendChild(panel);

    // Torch is far better than the screen — brighter, and it doesn't have to be
    // pointed at the receiver. It needs a camera track to hang the constraint on.
    let camera: Awaited<ReturnType<typeof openCamera>> | null = null;
    try {
      camera = await openCamera();
      if (!camera.hasTorch) {
        camera.stop();
        camera = null;
      }
    } catch {
      camera = null;
    }
    ctx.log(camera ? "EMITTER ........ TORCH" : "EMITTER ........ SCREEN (NO TORCH)");
    ctx.log(`HALF-BIT ....... ${cfg.halfBitMs} ms`);
    ctx.meter.set(1);

    const set = async (on: boolean) => {
      if (camera) await camera.setTorch(on);
      panel.classList.toggle("on", on);
    };

    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted) break;
        const halfBits = encodeOok(frame, cfg);
        // Schedule against a fixed origin so setTimeout jitter doesn't accumulate.
        const start = performance.now();
        for (let i = 0; i < halfBits.length && !ctx.signal.aborted; i++) {
          const due = start + i * cfg.halfBitMs;
          const wait = due - performance.now();
          if (wait > 0) await sleep(wait, ctx.signal);
          await set(halfBits[i] === 1);
        }
        await set(false);
        await sleep(cfg.halfBitMs * 6, ctx.signal);
      }
    } finally {
      await set(false);
      camera?.stop();
    }
  },

  async *rx(ctx: TransportContext) {
    const cfg = profileFor(ctx.mode.id);
    const queue = new SymbolQueue();
    const feed = document.createElement("canvas");
    feed.className = "viz feed-small";
    ctx.mount.appendChild(feed);
    const trace = new Trace(makeCanvas(ctx.mount, "viz trace"));
    const feedCtx = feed.getContext("2d")!;

    const camera = await openCamera({ frameRate: 60 });
    const decoder = new OokDecoder(cfg, frameSize(ctx.mode.blockSize));
    ctx.log("WATCHING MEAN LUMINANCE");
    let rateReported = 0;
    ctx.signal.addEventListener("abort", () => {
      camera.stop();
      queue.close();
    }, { once: true });

    const loop = () => {
      if (ctx.signal.aborted) return;
      const luma = camera.meanLuma();
      const frame = decoder.push(performance.now(), luma);
      if (frame) queue.push(frame);
      ctx.meter.set(decoder.lock);
      trace.push(luma, frame ? 1 : 0);
      trace.draw(decoder.threshold);

      // Report the camera's actual rate once it has settled, and say plainly
      // when it can't support the selected mode.
      const now = performance.now();
      if (now - rateReported > 3000) {
        rateReported = now;
        const per = decoder.samplesPerHalfBit;
        ctx.log(
          per < MIN_SAMPLES_PER_HALF_BIT
            ? `CAMERA ${decoder.sampleRateHz.toFixed(0)} FPS — TOO SLOW FOR THIS MODE (${per.toFixed(1)} SAMPLES/HALF-BIT, NEED ${MIN_SAMPLES_PER_HALF_BIT})`
            : `CAMERA ${decoder.sampleRateHz.toFixed(0)} FPS  ${per.toFixed(1)} SAMPLES/HALF-BIT`,
        );
      }

      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(feed.clientWidth * dpr));
      const h = Math.max(1, Math.round(feed.clientHeight * dpr));
      if (feed.width !== w || feed.height !== h) {
        feed.width = w;
        feed.height = h;
      }
      if (camera.video.readyState >= 2) {
        const vw = camera.video.videoWidth || 1;
        const vh = camera.video.videoHeight || 1;
        const scale = Math.max(w / vw, h / vh);
        feedCtx.drawImage(camera.video, (w - vw * scale) / 2, (h - vh * scale) / 2, vw * scale, vh * scale);
      }
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
