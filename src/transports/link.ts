/**
 * LINK — WebRTC with no signalling server.
 *
 * The usual objection to "serverless WebRTC" is that it isn't: someone has to
 * carry the SDP offer and answer between the peers. Here the slow channels carry
 * it. The offer goes up on screen as a glyph grid, the other phone reads it with
 * its camera, the answer comes back the same way, and then a data channel opens
 * over the local network at megabytes a second.
 *
 * ICE is restricted to host candidates — no STUN, no TURN — so nothing in the
 * handshake or the transfer ever leaves the local network.
 */
import { concat, utf8 } from "../core/bytes.ts";
import { decompress, maybeCompress } from "../core/crypto.ts";
import { frameSize, parseFrame } from "../core/frame.ts";
import { scanBlob, showBlob } from "./handshake.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";
import { hexPreview, SymbolLog } from "../ui/visuals.ts";

const LABEL = "dead-drop";

async function packSdp(sdp: string): Promise<Uint8Array> {
  const raw = utf8.encode(sdp);
  const packed = await maybeCompress(raw);
  return packed ? concat(new Uint8Array([1]), packed) : concat(new Uint8Array([0]), raw);
}

async function unpackSdp(blob: Uint8Array): Promise<string> {
  const body = blob.subarray(1);
  return utf8.decode(blob[0] === 1 ? await decompress(body) : body);
}

function newPeer(): RTCPeerConnection {
  // Empty iceServers keeps gathering to host candidates: LAN or hotspot only.
  return new RTCPeerConnection({ iceServers: [] });
}

/** Trickle ICE would need a live back-channel, which is the thing we don't have. */
function gathered(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", check);
    signal.addEventListener("abort", () => resolve(), { once: true });
    // Some stacks never report "complete" on a host-only gather.
    setTimeout(resolve, 2500);
  });
}

function candidateList(pc: RTCPeerConnection, log: (s: string) => void): void {
  pc.addEventListener("icecandidate", (e) => {
    if (!e.candidate?.candidate) return;
    const parts = e.candidate.candidate.split(" ");
    log(`ICE ............ ${parts[7] ?? "?"} ${parts[4] ?? ""}:${parts[5] ?? ""}`);
  });
}

function stepButton(mount: HTMLElement, label: string): Promise<void> {
  return new Promise((resolve) => {
    const b = document.createElement("button");
    b.className = "btn primary step";
    b.textContent = label;
    b.onclick = () => {
      b.remove();
      resolve();
    };
    mount.appendChild(b);
  });
}

async function openChannel(
  pc: RTCPeerConnection,
  channel: RTCDataChannel,
  signal: AbortSignal,
): Promise<void> {
  if (channel.readyState === "open") return;
  await new Promise<void>((resolve, reject) => {
    channel.onopen = () => resolve();
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") reject(new Error("ICE failed — are both devices on the same network?"));
    });
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

export const link: Transport = {
  id: "link",
  name: "WebRTC via optical bootstrap",
  codename: "LINK",
  tier: "Tier 3 — radio & cable",
  caps: { bidirectional: true, estBps: 4_000_000, range: "same LAN or hotspot" },
  note: "Both devices must already share a network — a hotspot with no internet is ideal. The camera handshake replaces the signalling server; nothing leaves the LAN.",
  modes: [{ id: "host", label: "HOST CANDIDATES ONLY", blockSize: 4096, headerEvery: 128 }],

  async probe() {
    return typeof RTCPeerConnection === "function" ? "ok" : "unsupported";
  },

  async tx(symbols, ctx: TxContext) {
    const pc = newPeer();
    candidateList(pc, ctx.log);
    const channel = pc.createDataChannel(LABEL, { ordered: false, maxRetransmits: 0 });

    ctx.log("BUILDING OFFER");
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, ctx.signal);
    const offer = await packSdp(pc.localDescription!.sdp);

    const stage = document.createElement("div");
    stage.className = "handshake";
    ctx.mount.appendChild(stage);

    const showCtl = new AbortController();
    void showBlob(offer, stage, showCtl.signal, ctx.log);
    const nudge = document.createElement("p");
    nudge.className = "hint";
    nudge.textContent = "> POINT THE RECEIVER AT THIS GRID. WHEN IT SHOWS ITS OWN, PRESS BELOW.";
    stage.appendChild(nudge);
    await stepButton(stage, "SCAN ANSWER");
    showCtl.abort();
    nudge.remove();

    const answerBlob = await scanBlob(stage, ctx.signal, ctx.log);
    await pc.setRemoteDescription({ type: "answer", sdp: await unpackSdp(answerBlob) });
    ctx.log("ANSWER ACCEPTED — CONNECTING");
    await openChannel(pc, channel, ctx.signal);
    stage.remove();

    ctx.log("DATA CHANNEL OPEN");
    ctx.meter.set(1);
    const log = new SymbolLog(ctx.mount);
    // The receiver can say "stop" here, which is the one place in this project
    // where an ACK exists. Everywhere else the fountain just keeps running.
    channel.onmessage = (e) => {
      if (typeof e.data === "string" && e.data === "done") ctx.done?.();
    };

    let n = 0;
    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted || channel.readyState !== "open") break;
        // Don't outrun the transport: SCTP will buffer forever and then stall.
        while (channel.bufferedAmount > 1 << 20 && !ctx.signal.aborted) await sleep(8, ctx.signal);
        channel.send(frame as unknown as ArrayBufferView<ArrayBuffer>);
        if (++n % 64 === 0) log.push(`TX ${String(n).padStart(7)}  ${hexPreview(frame, 8)}`);
      }
    } finally {
      channel.close();
      pc.close();
    }
  },

  async *rx(ctx: TransportContext) {
    const pc = newPeer();
    candidateList(pc, ctx.log);
    const queue = new SymbolQueue();
    const size = frameSize(ctx.mode.blockSize);
    const stage = document.createElement("div");
    stage.className = "handshake";
    ctx.mount.appendChild(stage);

    let channel: RTCDataChannel | null = null;
    const channelReady = new Promise<RTCDataChannel>((resolve) => {
      pc.ondatachannel = (e) => resolve(e.channel);
    });

    ctx.log("SCANNING FOR OFFER");
    const offerBlob = await scanBlob(stage, ctx.signal, ctx.log);
    await pc.setRemoteDescription({ type: "offer", sdp: await unpackSdp(offerBlob) });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc, ctx.signal);
    const answer = await packSdp(pc.localDescription!.sdp);

    const showCtl = new AbortController();
    void showBlob(answer, stage, showCtl.signal, ctx.log);
    ctx.log("SHOWING ANSWER — LET THE SENDER SCAN IT");

    channel = await channelReady;
    await openChannel(pc, channel, ctx.signal);
    showCtl.abort();
    stage.remove();

    ctx.log("DATA CHANNEL OPEN");
    ctx.meter.set(1);
    const log = new SymbolLog(ctx.mount);
    let n = 0;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (e) => {
      const frame = new Uint8Array(e.data as ArrayBuffer);
      if (frame.length !== size || !parseFrame(frame, ctx.mode.blockSize)) return;
      if (++n % 64 === 0) log.push(`RX ${String(n).padStart(7)}  ${hexPreview(frame, 8)}`);
      queue.push(frame);
    };
    channel.onclose = () => queue.close();
    ctx.signal.addEventListener("abort", () => {
      channel?.close();
      pc.close();
      queue.close();
    }, { once: true });

    try {
      yield* queue;
    } finally {
      // Tell the far end to stop the fountain — the one optimisation a
      // bidirectional channel buys us.
      try {
        if (channel.readyState === "open") channel.send("done");
      } catch {
        /* already gone */
      }
      channel.close();
      pc.close();
    }
  },
};
