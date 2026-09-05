/**
 * HAPTIC — one phone buzzing against another.
 *
 * Stack the devices back to back. The transmitter drives its vibration motor
 * with the same Manchester code MORSE uses; the receiver reads DeviceMotion and
 * looks for the jitter a running motor puts into the accelerometer. It moves
 * about three bits a second, so a 64-byte note takes several minutes.
 *
 * This is the least practical thing in the project and it is in here on purpose.
 */
import { frameSize } from "../core/frame.ts";
import { encodeOok, OokDecoder, type OokConfig } from "../core/ook.ts";
import { makeCanvas, Trace } from "../ui/visuals.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";

const CFG: OokConfig = { halfBitMs: 160, preambleHalfBits: 20 };
/** Accelerometer energy is integrated over this long before the decoder sees a level. */
const WINDOW_MS = 55;

interface MotionPermission {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/** Half-bit levels -> a navigator.vibrate pattern (on, off, on, off ...). */
function toPattern(halfBits: Uint8Array, halfBitMs: number): number[] {
  const pattern: number[] = [];
  let current = 1; // vibrate() patterns always start with an "on" duration
  let run = 0;
  for (const v of halfBits) {
    if (v === current) run += halfBitMs;
    else {
      pattern.push(run);
      current = v;
      run = halfBitMs;
    }
  }
  pattern.push(run);
  return pattern;
}

export const haptic: Transport = {
  id: "haptic",
  name: "Vibration to accelerometer",
  codename: "HAPTIC",
  tier: "Tier 0 — is it even data",
  caps: { bidirectional: false, estBps: 3, range: "touching" },
  note: "Android only, and the two phones must be physically touching. Keep payloads under about 64 bytes unless you have somewhere to be.",
  // 16-byte symbols for the same reason as MORSE — see that file.
  modes: [{ id: "contact", label: "BACK TO BACK", blockSize: 16, headerEvery: 5 }],

  async probe() {
    if (typeof navigator.vibrate !== "function") return "unsupported";
    if (typeof DeviceMotionEvent === "undefined") return "unsupported";
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    ctx.log("STACK THE DEVICES BACK TO BACK");
    ctx.log(`HALF-BIT ....... ${CFG.halfBitMs} ms`);
    ctx.meter.set(1);
    const panel = document.createElement("div");
    panel.className = "lamp buzz";
    ctx.mount.appendChild(panel);

    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted) break;
        const pattern = toPattern(encodeOok(frame, CFG), CFG.halfBitMs);
        navigator.vibrate(pattern);
        panel.classList.add("on");
        const total = pattern.reduce((a, b) => a + b, 0);
        await sleep(total + 400, ctx.signal);
        panel.classList.remove("on");
      }
    } finally {
      navigator.vibrate(0);
    }
  },

  async *rx(ctx: TransportContext) {
    const queue = new SymbolQueue();
    const trace = new Trace(makeCanvas(ctx.mount, "viz trace tall"));
    const decoder = new OokDecoder(CFG, frameSize(ctx.mode.blockSize));

    const permission = (DeviceMotionEvent as unknown as MotionPermission).requestPermission;
    if (typeof permission === "function") {
      const granted = await permission.call(DeviceMotionEvent).catch(() => "denied");
      if (granted !== "granted") throw new Error("motion permission denied");
    }

    let prev: [number, number, number] | null = null;
    let energy = 0;
    let samples = 0;
    let windowStart = performance.now();

    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity ?? e.acceleration;
      if (!a || a.x === null) return;
      const cur: [number, number, number] = [a.x ?? 0, a.y ?? 0, a.z ?? 0];
      if (prev) {
        // First difference is a crude high-pass: gravity and slow hand movement
        // fall out, motor buzz survives.
        const d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
        energy += d * d;
        samples++;
      }
      prev = cur;

      const now = performance.now();
      if (now - windowStart >= WINDOW_MS) {
        const level = samples ? Math.min(1, Math.sqrt(energy / samples) / 3) : 0;
        energy = 0;
        samples = 0;
        windowStart = now;
        const frame = decoder.push(now, level);
        if (frame) queue.push(frame);
        ctx.meter.set(decoder.lock);
        trace.push(level, frame ? 1 : 0);
        trace.draw(decoder.threshold);
      }
    };

    globalThis.addEventListener("devicemotion", onMotion);
    ctx.log("READING ACCELEROMETER");
    ctx.signal.addEventListener("abort", () => {
      globalThis.removeEventListener("devicemotion", onMotion);
      queue.close();
    }, { once: true });

    try {
      yield* queue;
    } finally {
      globalThis.removeEventListener("devicemotion", onMotion);
    }
  },
};
