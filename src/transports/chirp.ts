/**
 * CHIRP — speaker to microphone.
 *
 * The first channel that crosses actual air. 16-tone MFSK; see core/modem.ts for
 * the on-air format. Audible sounds like a dial-up ghost and carries about
 * 400 bit/s; ultrasonic is near-silent, half the rate, and depends entirely on
 * whether the phones involved can emit and hear 18 kHz — many can't, which is
 * what the probe tone in the UI is for.
 */
import { BANDS, Demodulator, TONES, configFor, modulate, toneFreq } from "../core/modem.ts";
import { frameSize } from "../core/frame.ts";
import { hann, magnitudes } from "../core/dsp.ts";
import { openMic, playPcm } from "./media.ts";
import { SymbolQueue, type Transport, type TransportContext, type TxContext } from "./types.ts";
import { makeCanvas, ToneLadder, Waterfall } from "../ui/visuals.ts";

const FFT = 2048;

function bandFor(modeId: string) {
  return modeId === "ultrasonic" ? BANDS.ultrasonic : BANDS.audible;
}

export const chirp: Transport = {
  id: "chirp",
  name: "Audio modem",
  codename: "CHIRP",
  tier: "Tier 1 — acoustic",
  caps: { bidirectional: false, estBps: 400, range: "across a room" },
  note: "Turn off anything that might helpfully 'clean up' the audio. Ultrasonic range is a metre or two and depends on the speaker.",
  modes: [
    { id: "audible", label: BANDS.audible.label, blockSize: BANDS.audible.blockSize, headerEvery: 16 },
    { id: "ultrasonic", label: BANDS.ultrasonic.label, blockSize: BANDS.ultrasonic.blockSize, headerEvery: 10 },
  ],

  async probe() {
    if (typeof AudioContext === "undefined") return "unsupported";
    if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    const band = bandFor(ctx.mode.id);
    const context = new AudioContext();
    await context.resume();
    const cfg = configFor(band, context.sampleRate);

    const canvas = makeCanvas(ctx.mount);
    const ladder = new ToneLadder(canvas, TONES);
    ctx.log(`MODEM ${band.label} @ ${(context.sampleRate / 1000).toFixed(1)} kHz`);
    ctx.log(`SYMBOL ${(cfg.symbolSamples / context.sampleRate * 1000).toFixed(1)} ms  ${TONES} TONES`);
    ctx.meter.set(1);

    let raf = 0;
    const paint = () => {
      ladder.draw(0.05);
      raf = requestAnimationFrame(paint);
    };
    paint();

    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted) break;
        const pcm = modulate(cfg, frame);
        // Light the ladder in step with playback so the visual matches the sound.
        const symbolMs = (cfg.symbolSamples / context.sampleRate) * 1000;
        let i = 0;
        const timer = setInterval(() => {
          ladder.hit(i % 2 === 0 ? 0 : TONES - 1);
          if (i > cfg.preambleSymbols) ladder.hit((frame[Math.min(frame.length - 1, (i - cfg.preambleSymbols) >> 1)] ?? 0) & 0x0f);
          i++;
        }, symbolMs);
        await playPcm(context, pcm, ctx.signal);
        clearInterval(timer);
      }
    } finally {
      cancelAnimationFrame(raf);
      await context.close().catch(() => {});
    }
  },

  async *rx(ctx: TransportContext) {
    const band = bandFor(ctx.mode.id);
    const queue = new SymbolQueue();
    const canvas = makeCanvas(ctx.mount);

    // Declared before the mic opens: audio frames can arrive the instant it does.
    let onSamples: (s: Float32Array) => void = () => {};
    const mic = await openMic((samples) => onSamples(samples));
    const cfg = configFor(band, mic.sampleRate);
    const demod = new Demodulator(cfg, frameSize(band.blockSize));
    const waterfall = new Waterfall(canvas, {
      sampleRate: mic.sampleRate,
      fftSize: FFT,
      minFreq: toneFreq(cfg, 0) - 400,
      maxFreq: toneFreq(cfg, TONES - 1) + 400,
    });
    waterfall.clear();

    ctx.log(`LISTENING ${band.label} @ ${(mic.sampleRate / 1000).toFixed(1)} kHz`);

    const window = hann(FFT);
    const mags = new Float32Array(FFT);
    let spectrumBuf = new Float32Array(0);

    onSamples = (samples: Float32Array) => {
      demod.push(samples, (frame) => queue.push(frame));
      ctx.meter.set(demod.lock);

      // Independent of the demodulator: the waterfall shows what is actually
      // in the band, including the interference that is eating the transfer.
      const merged = new Float32Array(spectrumBuf.length + samples.length);
      merged.set(spectrumBuf);
      merged.set(samples, spectrumBuf.length);
      spectrumBuf = merged;
      while (spectrumBuf.length >= FFT) {
        magnitudes(spectrumBuf.subarray(0, FFT), window, mags);
        waterfall.push(mags);
        spectrumBuf = spectrumBuf.slice(FFT / 2);
      }
    };

    ctx.signal.addEventListener("abort", () => {
      mic.stop();
      queue.close();
    }, { once: true });

    try {
      yield* queue;
    } finally {
      mic.stop();
    }
  },
};
