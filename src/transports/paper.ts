/**
 * PAPER — print and scan.
 *
 * The actual dead drop. Same glyph codec as LANTERN, but the frames are static
 * and tiled across A4 instead of animated. Leave the sheet somewhere, walk away;
 * whoever picks it up photographs it page by page. Tile order doesn't matter and
 * neither does completeness — each tile is one fountain symbol, so a sheet with
 * a coffee ring on it still decodes as long as enough tiles survive.
 *
 * Capacity is honest rather than aspirational: at a cell size a home printer and
 * a phone camera can actually hold, a sheet is 12-25 KB, not the 40-60 KB the
 * spec estimated. The layout is a parameter; the UI reports what you'll get.
 */
import { FRAME_OVERHEAD } from "../core/frame.ts";
import { blockSizeFor, encodeGrid } from "../glyph/layout.ts";
import { detectGlyphs } from "../glyph/detect.ts";
import { buildPdf, layoutSheet, type PdfPage, type Tile } from "../glyph/pdf.ts";
import { openCamera } from "./media.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";

const N = 32;
const BLOCK = blockSizeFor(N, FRAME_OVERHEAD);

const SHEETS = {
  standard: { cols: 5, rows: 7, N, margin: 32 },
  dense: { cols: 7, rows: 10, N, margin: 24 },
} as const;

/** Extra tiles beyond K, so a partly ruined sheet still decodes. */
const REDUNDANCY = 1.35;

export const paper: Transport = {
  id: "paper",
  name: "Print and scan",
  codename: "PAPER",
  tier: "Tier 2 — optical",
  caps: { bidirectional: false, estBps: 0, range: "wherever you leave it" },
  note: "Print at 100% scale, no fit-to-page. Colour matters — a greyscale printer will produce a sheet that cannot decode.",
  modes: [
    { id: "standard", label: "35 TILES / SHEET", blockSize: BLOCK, headerEvery: 6 },
    { id: "dense", label: "70 TILES / SHEET", blockSize: BLOCK, headerEvery: 6 },
  ],

  async probe() {
    if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
    return "ok";
  },

  async tx(symbols, ctx: TxContext) {
    const layout = SHEETS[ctx.mode.id as keyof typeof SHEETS] ?? SHEETS.standard;
    const { positions, size, cellMm } = layoutSheet(layout);
    const perSheet = positions.length;
    const session = ctx.session;

    // One page per K/perSheet, plus redundancy. Fountain symbols are
    // interchangeable, so "more tiles" is the only tuning knob needed.
    const wanted = Math.max(perSheet, Math.ceil(session.K * REDUNDANCY) + 8);
    const sheets = Math.ceil(wanted / perSheet);
    ctx.log(`SHEET .......... ${layout.cols}x${layout.rows} TILES  ${cellMm.toFixed(2)} mm CELLS`);
    ctx.log(`CAPACITY ....... ${((perSheet * BLOCK) / 1024).toFixed(1)} KB / SHEET`);
    ctx.log(`GENERATING ..... ${sheets} SHEET${sheets === 1 ? "" : "S"}  ${wanted} TILES`);
    ctx.meter.set(1);

    const iterator = symbols[Symbol.asyncIterator]();
    const pages: PdfPage[] = [];
    for (let s = 0; s < sheets; s++) {
      const tiles: Tile[] = [];
      for (let i = 0; i < perSheet; i++) {
        const next = await iterator.next();
        if (next.done || ctx.signal.aborted) break;
        tiles.push({
          cells: encodeGrid(N, next.value),
          N,
          x: positions[i][0],
          y: positions[i][1],
          size,
        });
      }
      pages.push({
        tiles,
        caption: `DEAD DROP  SHEET ${s + 1}/${sheets}  ${N}x${N}  ${BLOCK}B/TILE  KEY REQUIRED  ${new Date().toISOString().slice(0, 10)}`,
      });
      if (ctx.signal.aborted) break;
    }

    const pdf = await buildPdf(pages);
    const blob = new Blob([pdf as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);

    const panel = document.createElement("div");
    panel.className = "paper-out";
    const link = document.createElement("a");
    link.href = url;
    link.download = `dead-drop-${Date.now()}.pdf`;
    link.className = "btn primary";
    link.textContent = `DOWNLOAD ${sheets} SHEET${sheets === 1 ? "" : "S"} (${(pdf.length / 1024).toFixed(0)} KB)`;
    const frame = document.createElement("iframe");
    frame.className = "pdf-preview";
    frame.src = url;
    panel.append(link, frame);
    ctx.mount.appendChild(panel);
    ctx.log("PDF READY — PRINT AT 100% SCALE");

    // Nothing further to transmit; the sheet is the channel now.
    while (!ctx.signal.aborted) await sleep(500, ctx.signal);
    URL.revokeObjectURL(url);
  },

  async *rx(ctx: TransportContext) {
    const queue = new SymbolQueue();
    const canvas = document.createElement("canvas");
    canvas.className = "viz";
    ctx.mount.appendChild(canvas);
    const view = canvas.getContext("2d")!;
    const camera = await openCamera();
    ctx.log("PHOTOGRAPH EACH SHEET — HOLD STEADY, FILL THE FRAME");

    ctx.signal.addEventListener("abort", () => {
      camera.stop();
      queue.close();
    }, { once: true });

    let lastDetect = 0;
    let outlines: Array<Array<readonly [number, number]>> = [];
    let tilesThisFrame = 0;

    const loop = () => {
      if (ctx.signal.aborted) return;
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const vw = camera.video.videoWidth || 1;
      const vh = camera.video.videoHeight || 1;
      const s = Math.min(w / vw, h / vh);
      const dw = vw * s;
      const dh = vh * s;
      const dx = (w - dw) / 2;
      const dy = (h - dh) / 2;
      view.fillStyle = "#000";
      view.fillRect(0, 0, w, h);
      if (camera.video.readyState >= 2) view.drawImage(camera.video, dx, dy, dw, dh);

      const now = performance.now();
      // Detection at this resolution costs a few hundred milliseconds; twice a
      // second is plenty when the subject is a sheet of paper holding still.
      if (now - lastDetect > 500) {
        lastDetect = now;
        // A sheet is many small tiles, so this wants more resolution and more
        // quads than LANTERN's single big grid.
        const img = camera.grab(1600);
        if (img) {
          const found = detectGlyphs(img, N, { workWidth: 1400, maxQuads: 80 });
          outlines = [];
          for (const det of found) {
            outlines.push(det.quad.map((p) => [(p[0] / img.width) * dw + dx, (p[1] / img.height) * dh + dy] as const));
            queue.push(det.bytes);
          }
          tilesThisFrame = found.length;
          ctx.meter.set(Math.min(1, found.length / 12));
          if (found.length) ctx.log(`TILES IN FRAME .. ${found.length}`);
        }
      }

      view.lineWidth = 1.5 * dpr;
      view.strokeStyle = "#ffb000";
      for (const q of outlines) {
        view.beginPath();
        view.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i++) view.lineTo(q[i][0], q[i][1]);
        view.closePath();
        view.stroke();
      }
      view.fillStyle = "#ffb000";
      view.font = `${12 * dpr}px monospace`;
      view.fillText(`${tilesThisFrame} TILES`, 8 * dpr, 18 * dpr);
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
