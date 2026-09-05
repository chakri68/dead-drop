/**
 * Shared camera and audio plumbing. Four transports point a camera at something
 * and three make noise, so the permission dance, the frame grabbing and the
 * worklet fallback live here once.
 */
import type { ImageLike } from "../glyph/render.ts";

// --- camera --------------------------------------------------------------

export interface CameraHandle {
  video: HTMLVideoElement;
  hasTorch: boolean;
  setTorch(on: boolean): Promise<boolean>;
  /** Current frame as RGBA, downscaled so the detector isn't handed 4K. */
  grab(maxWidth: number): ImageLike | null;
  /** Mean luminance of the centre of frame — all MORSE needs. */
  meanLuma(): number;
  stop(): void;
}

export async function openCamera(opts: { facingMode?: string; frameRate?: number } = {}): Promise<CameraHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: opts.facingMode ?? "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: opts.frameRate ?? 30 },
    },
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const video = document.createElement("video");
  video.srcObject = stream;
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  await video.play().catch(() => {});

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };

  const draw = (maxWidth: number): { w: number; h: number } | null => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, maxWidth / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    return { w, h };
  };

  return {
    video,
    hasTorch: !!caps.torch,
    async setTorch(on: boolean) {
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        return true;
      } catch {
        return false;
      }
    },
    grab(maxWidth: number) {
      const size = draw(maxWidth);
      if (!size) return null;
      const img = ctx.getImageData(0, 0, size.w, size.h);
      return { data: img.data, width: img.width, height: img.height };
    },
    meanLuma() {
      const size = draw(64);
      if (!size) return 0;
      const d = ctx.getImageData(0, 0, size.w, size.h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      return sum / (d.length / 4) / 255;
    },
    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}

// --- audio ---------------------------------------------------------------

/**
 * The worklet is a string because it has to be a separate module at runtime and
 * this project doesn't have a build step for one. It does nothing but forward
 * raw frames — all the DSP happens on the main thread where it can be tested.
 */
const TAP_WORKLET = `
class DDTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('dd-tap', DDTap);
`;

export interface MicHandle {
  context: AudioContext;
  sampleRate: number;
  stop(): void;
}

export async function openMic(onFrames: (samples: Float32Array) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Every one of these would eat a modem signal alive.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const mute = context.createGain();
  mute.gain.value = 0;
  mute.connect(context.destination);

  let node: AudioNode;
  try {
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const worklet = new AudioWorkletNode(context, "dd-tap");
    worklet.port.onmessage = (e) => onFrames(e.data as Float32Array);
    node = worklet;
  } catch {
    // Safari and older Chromium: ScriptProcessor is deprecated but universal.
    const sp = context.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => onFrames(new Float32Array(e.inputBuffer.getChannelData(0)));
    node = sp;
  }
  source.connect(node);
  node.connect(mute);

  return {
    context,
    sampleRate: context.sampleRate,
    stop() {
      try {
        source.disconnect();
        node.disconnect();
        mute.disconnect();
      } catch {
        /* already torn down */
      }
      for (const t of stream.getTracks()) t.stop();
      void context.close();
    },
  };
}

/** Play a PCM buffer, resolving when it has finished (or the session aborts). */
export function playPcm(context: AudioContext, samples: Float32Array, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = context.createBufferSource();
    src.buffer = buffer;
    src.connect(context.destination);
    const onAbort = () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      resolve();
    };
    src.onended = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    src.start();
  });
}
