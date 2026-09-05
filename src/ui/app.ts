/**
 * The terminal.
 *
 * Everything the user touches. Role, transport, payload, key, and then a loop
 * that pulls symbols out of the pipeline and hands them to whichever channel is
 * selected — or collects them from it. The app never knows how a symbol crossed
 * the gap, which is the whole point of the architecture.
 */
import { formatCode, parseCode, randomCode } from "../core/crypto.ts";
import { RxSession, TxSession, type Payload, type RxSnapshot, type TransportProfile } from "../core/pipeline.ts";
import { Signal } from "../core/signal.ts";
import { utf8 } from "../core/bytes.ts";
import {
  clear as clearLedger,
  formatBytes,
  formatDuration,
  formatRate,
  history,
  record,
  totals,
} from "../core/ledger.ts";
import { TRANSPORTS, transportById } from "../transports/index.ts";
import { loopbackLoss } from "../transports/loopback.ts";
import type { ProbeResult, Transport, TransportMode } from "../transports/types.ts";
import { el, section } from "./dom.ts";
import { bar, group, Readout, type Line } from "./readout.ts";

type Role = "tx" | "rx";

interface Completion {
  bytes: Uint8Array;
  name: string;
  mime: string;
  isText: boolean;
  verified: boolean;
}

const STORAGE_KEY = "dead-drop/prefs";

export class App {
  private role: Role = "tx";
  private transport: Transport = TRANSPORTS[0];
  private mode: TransportMode = TRANSPORTS[0].modes[0];
  private code = randomCode();
  private payloadText = "";
  private payloadFile: { name: string; mime: string; bytes: Uint8Array } | null = null;
  private probes = new Map<string, ProbeResult>();

  private controller: AbortController | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private hiddenAt = 0;
  private hiddenMs = 0;
  private txSession: TxSession | null = null;
  private rxSession: RxSession | null = null;
  private rxSnapshot: RxSnapshot | null = null;
  private startedAt = 0;
  private completion: Completion | null = null;
  private pending: { transport: Transport; mode: TransportMode } | null = null;
  private stopping = false;
  private status = "IDLE";
  private meter = new Signal<number>(0);
  private logLines: string[] = [];

  private root: HTMLElement;
  private stage!: HTMLElement;
  private sidebar!: HTMLElement;
  private readout!: Readout;
  private logEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private statsEl!: HTMLElement;
  private escalateEl!: HTMLElement;
  private ledgerEl!: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async mount(): Promise<void> {
    this.restorePrefs();
    this.buildShell();
    this.meter.subscribe(() => this.paint());
    document.addEventListener("visibilitychange", () => this.onVisibility());
    await this.runProbes();
    this.renderSidebar();
    this.paint();
    void this.renderLedger();
    setInterval(() => this.paint(), 200);
  }

  // --- setup -------------------------------------------------------------

  private restorePrefs(): void {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
        transport?: string;
        mode?: string;
        role?: Role;
      };
      const t = saved.transport ? transportById(saved.transport) : undefined;
      if (t) {
        this.transport = t;
        this.mode = t.modes.find((m) => m.id === saved.mode) ?? t.modes[0];
      }
      if (saved.role === "tx" || saved.role === "rx") this.role = saved.role;
    } catch {
      /* first run, or storage disabled */
    }
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ transport: this.transport.id, mode: this.mode.id, role: this.role }),
      );
    } catch {
      /* storage disabled; preferences just don't persist */
    }
  }

  /**
   * Browsers clamp timers to roughly one per second in a hidden tab, which drops
   * a transmit loop from ~80 frames/s to ~1 — it looks exactly like a dead
   * channel. Nothing can be done about the clamp, so: hold a screen wake lock
   * while a session runs (the usual way a tab gets hidden is the screen locking),
   * and when it happens anyway, say so rather than let the user wonder.
   *
   * CHIRP is the exception — it is driven by audio events, not timers, and keeps
   * running. The screen-based channels can't transmit hidden regardless, since
   * the screen is the transmitter.
   */
  private async holdWakeLock(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      /* unsupported, or refused because the document is already hidden */
    }
  }

  private releaseWakeLock(): void {
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  private onVisibility(): void {
    if (!this.controller) return;
    if (document.hidden) {
      this.hiddenAt = performance.now();
      this.log("TAB HIDDEN ..... TIMERS THROTTLED TO ~1/s — TRANSFER IS CRAWLING");
    } else {
      const spent = performance.now() - this.hiddenAt;
      this.hiddenMs += spent;
      this.log(`TAB VISIBLE .... AFTER ${(spent / 1000).toFixed(0)}s IN BACKGROUND`);
      // A wake lock is released automatically when the page hides; take it back.
      void this.holdWakeLock();
    }
    this.paint();
  }

  private async runProbes(): Promise<void> {
    await Promise.all(
      TRANSPORTS.map(async (t) => {
        try {
          this.probes.set(t.id, await t.probe());
        } catch {
          this.probes.set(t.id, "unsupported");
        }
      }),
    );
  }

  private profileFor(mode: TransportMode): TransportProfile {
    return { blockSize: mode.blockSize, headerEvery: mode.headerEvery };
  }

  // --- shell -------------------------------------------------------------

  private buildShell(): void {
    const title = el("h1", {}, "DEAD DROP");
    const subtitle = el("p", { class: "tagline" }, "OFFLINE COURIER / NO SERVER / NO NETWORK");

    this.stage = el("div", { class: "stage" });
    const readoutHost = el("div", { class: "readout-host" });
    this.readout = new Readout(readoutHost);

    const well = el("div", { class: "well" }, this.stage, readoutHost);

    this.sidebar = el("aside", { class: "sidebar" });
    const resizer = el("div", { class: "resizer", title: "drag to resize" });
    this.installResizer(resizer);

    this.startBtn = el("button", { class: "btn primary", onclick: () => void this.toggle() }, "BEGIN") as HTMLButtonElement;
    this.statsEl = el("div", { class: "stats" });
    this.escalateEl = el("div", { class: "escalate" });
    const bottom = el(
      "div",
      { class: "controlbar" },
      this.startBtn,
      el("button", { class: "btn", onclick: () => this.rollCode() }, "NEW KEY"),
      this.escalateEl,
      this.statsEl,
    );

    this.root.replaceChildren(
      el("header", { class: "topbar" }, title, subtitle),
      el("main", { class: "shell" }, el("div", { class: "main-col" }, well, bottom), resizer, this.sidebar),
    );
  }

  /** Drag-to-resize between the stage and the sidebar. Desktop only; the CSS stacks below 900px. */
  private installResizer(handle: HTMLElement): void {
    let startX = 0;
    let startWidth = 0;
    const onMove = (e: PointerEvent) => {
      const next = Math.min(640, Math.max(300, startWidth - (e.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-w", `${next}px`);
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      globalThis.removeEventListener("pointermove", onMove);
      globalThis.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      startX = e.clientX;
      startWidth = this.sidebar.getBoundingClientRect().width;
      document.body.classList.add("resizing");
      globalThis.addEventListener("pointermove", onMove);
      globalThis.addEventListener("pointerup", onUp);
    });
  }

  // --- sidebar -----------------------------------------------------------

  private renderSidebar(): void {
    const roleChips = el(
      "div",
      { class: "chips" },
      ...(["tx", "rx"] as Role[]).map((r) =>
        el(
          "button",
          {
            class: `chip ${this.role === r ? "on" : ""}`,
            onclick: () => {
              if (this.controller) return;
              this.role = r;
              this.completion = null;
              this.savePrefs();
              this.renderSidebar();
              this.paint();
            },
          },
          r === "tx" ? "TRANSMIT" : "RECEIVE",
        ),
      ),
    );

    const transportList = el(
      "div",
      { class: "transport-list" },
      ...TRANSPORTS.filter((t) => this.probes.get(t.id) !== "unsupported" || t.id === this.transport.id).map((t) =>
        this.transportRow(t),
      ),
    );

    const unsupported = TRANSPORTS.filter((t) => this.probes.get(t.id) === "unsupported" && t.id !== this.transport.id);

    this.logEl = el("pre", { class: "log" });
    this.ledgerEl = el("div", { class: "ledger" });

    this.sidebar.replaceChildren(
      section("ROLE", roleChips),
      section(
        "TRANSPORT",
        transportList,
        unsupported.length
          ? el(
              "p",
              { class: "hint" },
              `UNSUPPORTED HERE: ${unsupported.map((t) => t.codename).join(", ")}`,
            )
          : null,
      ),
      section("CHANNEL", ...this.modeControls()),
      ...(this.role === "tx" ? [section("PAYLOAD", ...this.payloadControls())] : []),
      section("SESSION KEY", ...this.keyControls()),
      section("LOG", this.logEl),
      section("LEDGER", this.ledgerEl),
    );
    this.renderLog();
    void this.renderLedger();
  }

  private transportRow(t: Transport): HTMLElement {
    const probe = this.probes.get(t.id) ?? "ok";
    return el(
      "button",
      {
        class: `trow ${this.transport.id === t.id ? "active" : ""} ${probe !== "ok" ? "degraded" : ""}`,
        onclick: () => {
          if (this.controller) return;
          this.transport = t;
          this.mode = t.modes[0];
          this.completion = null;
          this.savePrefs();
          this.renderSidebar();
          this.paint();
        },
      },
      el("span", { class: "tcode" }, t.codename),
      el("span", { class: "tname" }, t.name),
      el("span", { class: `tprobe ${probe}` }, probe === "ok" ? "READY" : probe.toUpperCase()),
    );
  }

  private modeControls(): Node[] {
    const nodes: Node[] = [
      el(
        "div",
        { class: "chips" },
        ...this.transport.modes.map((m) =>
          el(
            "button",
            {
              class: `chip ${this.mode.id === m.id ? "on" : ""}`,
              onclick: () => {
                if (this.controller) return;
                this.mode = m;
                this.savePrefs();
                this.renderSidebar();
                this.paint();
              },
            },
            m.label,
          ),
        ),
      ),
    ];
    if (this.transport.note) nodes.push(el("p", { class: "hint" }, this.transport.note));
    if (this.transport.id === "loopback") {
      const label = el("span", { class: "slider-val" }, `${Math.round(loopbackLoss.rate * 100)}%`);
      const slider = el("input", {
        type: "range",
        min: "0",
        max: "90",
        value: String(Math.round(loopbackLoss.rate * 100)),
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          loopbackLoss.rate = v / 100;
          label.textContent = `${v}%`;
        },
      });
      nodes.push(el("label", { class: "slider" }, el("span", {}, "SIMULATED LOSS"), slider, label));
    }
    return nodes;
  }

  private payloadControls(): Node[] {
    const text = el("textarea", {
      class: "payload",
      rows: "4",
      placeholder: "MESSAGE TEXT",
      oninput: (e: Event) => {
        this.payloadText = (e.target as HTMLTextAreaElement).value;
        this.payloadFile = null;
        this.paint();
      },
    }) as HTMLTextAreaElement;
    text.value = this.payloadText;

    const fileInput = el("input", {
      type: "file",
      class: "hidden-file",
      onchange: async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        this.payloadFile = {
          name: file.name,
          mime: file.type || "application/octet-stream",
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
        this.payloadText = "";
        text.value = "";
        this.renderSidebar();
        this.paint();
      },
    }) as HTMLInputElement;

    return [
      text,
      el(
        "button",
        { class: "add-rule", onclick: () => fileInput.click() },
        this.payloadFile ? `${this.payloadFile.name} — ${formatBytes(this.payloadFile.bytes.length)}` : "+ ATTACH FILE",
      ),
      fileInput,
    ];
  }

  private keyControls(): Node[] {
    if (this.role === "tx") {
      return [el("div", { class: "keydisplay" }, formatCode(this.code)), el("p", { class: "hint" }, "READ THIS TO THE RECEIVER. 20 BITS — IT PROTECTS A RECORDING, NOT A SECRET.")];
    }
    const input = el("input", {
      type: "text",
      class: "keyinput",
      maxlength: "5",
      placeholder: "-----",
      value: formatCode(this.code),
      oninput: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value.toUpperCase();
        (e.target as HTMLInputElement).value = raw;
        const parsed = parseCode(raw);
        if (parsed !== null) {
          this.code = parsed;
          this.rxSession?.setCode(parsed);
        }
        this.paint();
      },
    });
    return [input, el("p", { class: "hint" }, "ENTER THE SENDER'S KEY. IT CAN BE TYPED MID-TRANSFER.")];
  }

  private rollCode(): void {
    if (this.controller) return;
    this.code = randomCode();
    this.renderSidebar();
    this.paint();
  }

  // --- running -----------------------------------------------------------

  private log(line: string): void {
    this.logLines.push(line);
    while (this.logLines.length > 60) this.logLines.shift();
    this.renderLog();
  }

  private renderLog(): void {
    if (!this.logEl) return;
    this.logEl.textContent = this.logLines.join("\n");
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private buildPayload(): Payload | null {
    if (this.payloadFile) {
      return {
        bytes: this.payloadFile.bytes,
        name: this.payloadFile.name,
        mime: this.payloadFile.mime,
        isText: false,
      };
    }
    const text = this.payloadText.trim();
    if (!text) return null;
    return { bytes: utf8.encode(text), name: "message.txt", mime: "text/plain", isText: true };
  }

  private async toggle(): Promise<void> {
    if (this.controller) {
      this.stopping = true;
      this.controller.abort();
      return;
    }
    this.completion = null;
    this.logLines = [];
    this.rxSnapshot = null;
    this.txSession = null;
    this.rxSession = null;
    this.stopping = false;
    this.hiddenMs = 0;
    this.meter.set(0);
    this.startedAt = performance.now();
    void this.holdWakeLock();

    // The session outlives any one channel, so escalation can swap the channel
    // underneath it without restarting the transfer.
    let channel = { transport: this.transport, mode: this.mode };
    for (;;) {
      await this.runChannel(channel.transport, channel.mode);
      if (this.stopping || this.completion || !this.pending) break;
      channel = this.pending;
      this.pending = null;
      this.transport = channel.transport;
      this.mode = channel.mode;
      this.log(`ESCALATED TO ... ${channel.transport.codename} / ${channel.mode.label}`);
      this.renderSidebar();
    }
    this.txSession = null;
    this.rxSession = null;
    this.releaseWakeLock();
    this.renderSidebar();
    this.paint();
  }

  /**
   * Transports a session can move onto without restarting. The constraint the
   * spec skipped: a symbol is a fixed size, baked into the header and the
   * decoder, so the new channel must be able to carry the size already in
   * flight. Faster channels almost always can — a big glyph happily carries an
   * 8-byte MORSE symbol, it just wastes most of the frame doing it.
   */
  private escalationTargets(): Array<{ transport: Transport; mode: TransportMode }> {
    const locked = this.mode.blockSize;
    const out: Array<{ transport: Transport; mode: TransportMode }> = [];
    for (const t of TRANSPORTS) {
      if (t.id === this.transport.id) continue;
      // Loopback is a bench instrument, not somewhere to escalate to.
      if (t.id === "loopback") continue;
      if (this.probes.get(t.id) !== "ok") continue;
      if (t.caps.estBps <= this.transport.caps.estBps) continue;
      const mode = t.modes.find((m) => m.blockSize >= locked);
      if (!mode) continue;
      out.push({ transport: t, mode: { ...mode, blockSize: locked } });
    }
    return out.sort((a, b) => b.transport.caps.estBps - a.transport.caps.estBps);
  }

  private escalate(target: { transport: Transport; mode: TransportMode }): void {
    if (!this.controller) return;
    this.pending = target;
    this.txSession?.setHeaderEvery(target.mode.headerEvery);
    this.log(`ESCALATING ..... ${this.transport.codename} -> ${target.transport.codename}`);
    this.controller.abort();
  }

  private async runChannel(transport: Transport, mode: TransportMode): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    this.stage.replaceChildren();
    delete this.stage.dataset.idle;
    this.meter.set(0);

    const ctx = {
      mode,
      signal: controller.signal,
      mount: this.stage,
      log: (s: string) => this.log(s),
      meter: this.meter,
      done: () => controller.abort(),
    };

    try {
      if (this.role === "tx") {
        const payload = this.buildPayload();
        if (!payload) {
          this.status = "NOTHING TO SEND";
          this.stopping = true;
          return;
        }
        this.status = "TRANSMITTING";
        this.paint();
        if (!this.txSession) {
          this.txSession = await TxSession.create(payload, this.code, { ...this.profileFor(mode) });
          this.log(`PAYLOAD ${payload.name} ${group(payload.bytes.length)} B -> ${this.txSession.K} BLOCKS`);
        }
        const session = this.txSession;
        await transport.tx(session.stream(controller.signal), { ...ctx, session });
      } else {
        this.status = "LISTENING";
        this.paint();
        if (!this.rxSession) {
          const rx = new RxSession(this.profileFor(mode));
          rx.setCode(this.code);
          rx.onUpdate = (s) => {
            this.rxSnapshot = s;
          };
          rx.onComplete = (r) => void this.onComplete(r);
          this.rxSession = rx;
        }
        const rx = this.rxSession;
        for await (const frame of transport.rx(ctx)) {
          if (controller.signal.aborted) break;
          rx.push(frame);
        }
      }
      if (!this.completion && !this.pending) {
        this.status = controller.signal.aborted ? "ABORTED" : "CHANNEL CLOSED";
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (this.pending) {
        this.log("CHANNEL CLOSED FOR ESCALATION");
      } else {
        // A dismissed device picker is a decision, not a fault; say so.
        this.status = /denied|NotAllowed|NotFound|permission/i.test(message)
          ? "PERMISSION DENIED"
          : /cancel|no port|no device|user gesture|abort/i.test(message)
            ? "CANCELLED"
            : "CHANNEL ERROR";
        this.log(`${this.status} ..... ${message.toUpperCase()}`);
        this.stopping = true;
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      if (!this.pending && this.role === "tx" && this.txSession) void this.logTx();
      this.paint();
    }
  }

  private async logTx(): Promise<void> {
    const session = this.txSession!;
    if (session.symbolsOut < 1) return;
    await record({
      ts: Date.now(),
      role: "tx",
      transport: this.transport.id,
      codename: this.transport.codename,
      mode: this.mode.id,
      bytes: session.payload.bytes.length,
      durationMs: performance.now() - this.startedAt,
      symbols: session.symbolsOut,
      verified: true,
    });
    void this.renderLedger();
  }

  private async onComplete(result: Completion): Promise<void> {
    this.completion = result;
    this.status = result.verified ? "DROP COMPLETE" : "INTEGRITY FAILED";
    const durationMs = performance.now() - this.startedAt;
    this.log(`> DROP COMPLETE. ${result.verified ? "INTEGRITY CONFIRMED." : "INTEGRITY FAILED."}`);
    this.controller?.abort();
    await record({
      ts: Date.now(),
      role: "rx",
      transport: this.transport.id,
      codename: this.transport.codename,
      mode: this.mode.id,
      bytes: result.bytes.length,
      durationMs,
      symbols: this.rxSnapshot?.symbolsAccepted ?? 0,
      verified: result.verified,
    });
    this.renderResult(result, durationMs);
    void this.renderLedger();
  }

  private renderResult(result: Completion, durationMs: number): void {
    const blob = new Blob([result.bytes as BlobPart], { type: result.mime });
    const url = URL.createObjectURL(blob);
    const rate = (result.bytes.length * 8000) / Math.max(1, durationMs);

    const actions = el("div", { class: "result-actions" });
    const download = el("a", { class: "btn primary", href: url, download: result.name }, "SAVE");
    actions.append(download);
    if (navigator.share) {
      actions.append(
        el(
          "button",
          {
            class: "btn",
            onclick: () => {
              const file = new File([result.bytes as BlobPart], result.name, { type: result.mime });
              void navigator.share({ files: [file], title: result.name }).catch(() => {});
            },
          },
          "SHARE",
        ),
      );
    }

    const body: Node[] = [
      el("div", { class: `verdict ${result.verified ? "ok" : "bad"}` },
        result.verified ? "> DROP COMPLETE. INTEGRITY CONFIRMED." : "> DROP COMPLETE. INTEGRITY FAILED."),
      el("p", { class: "hint" },
        `${result.name} — ${formatBytes(result.bytes.length)} in ${formatDuration(durationMs)} (${formatRate(rate)})`),
    ];
    if (result.isText) {
      const pre = el("pre", { class: "result-text" });
      pre.textContent = utf8.decode(result.bytes);
      body.push(pre);
    }
    body.push(actions);
    delete this.stage.dataset.idle;
    this.stage.replaceChildren(el("div", { class: "result" }, ...body));
  }

  // --- painting ----------------------------------------------------------

  private paint(): void {
    // Drives the mobile layout: a running session gives the stage more room.
    document.body.classList.toggle("running", !!this.controller);
    const lines: Line[] = [];
    lines.push({ label: "TRANSPORT", value: `${this.transport.codename} / ${this.mode.label}`, tone: "accent" });
    lines.push({ label: "ROLE", value: this.role === "tx" ? "TRANSMIT" : "RECEIVE" });
    lines.push({ label: "SESSION KEY", value: formatCode(this.code), tone: "accent" });

    if (this.role === "tx") {
      const payload = this.buildPayload();
      const session = this.txSession;
      lines.push({
        label: "PAYLOAD",
        value: payload
          ? `${payload.name}  ${group(payload.bytes.length)} B${session ? `  ->  ${session.K} BLOCKS` : ""}`
          : "— NOTHING STAGED —",
        tone: payload ? "normal" : "muted",
      });
      lines.push({
        label: "PASS",
        value: session ? `${session.pass}      SYMBOLS OUT ${group(session.symbolsOut)}` : "—",
      });
      lines.push({ label: "BLOCK SIZE", value: `${this.mode.blockSize} B  x  ${this.transport.caps.estBps} bit/s EST` });
    } else {
      const snap = this.rxSnapshot;
      lines.push({
        label: "PAYLOAD",
        value: snap?.name ? `${snap.name}  ${group(snap.plainLen ?? 0)} B` : snap?.plainLen ? `SEALED  ${group(snap.plainLen)} B` : "— WAITING —",
        tone: snap?.name ? "normal" : "muted",
      });
      lines.push({ label: "RX LOCK", value: `${bar(this.meter.get())}  ${Math.round(this.meter.get() * 100)}%`, tone: "accent" });
      // Before the header lands there is no denominator to show, but symbols are
      // still being banked as orphans and replayed the moment it arrives. Say so:
      // a bare "HEADER 0/?" reads as a stall when it is actually working.
      const banked = snap?.symbolsAccepted ?? 0;
      const [haveParts, wantParts] = snap?.headerParts ?? [0, 0];
      lines.push({
        label: "BLOCKS",
        value: snap?.K
          ? `${group(snap.blocks)} / ${group(snap.K)}`
          : wantParts
            ? `HEADER ${haveParts}/${wantParts}  (${group(banked)} BANKED)`
            : `AWAITING HEADER  (${group(banked)} BANKED)`,
        tone: snap?.K ? "normal" : "muted",
      });
      lines.push({
        label: "SYMBOLS",
        value: snap ? `${group(snap.symbolsAccepted)} GOOD   ${group(snap.framesBad)} REJECTED` : "0",
      });
      if (snap?.note) lines.push({ label: "NOTE", value: snap.note, tone: "warn" });
    }

    if (this.hiddenMs > 1500) {
      lines.push({
        label: "BACKGROUNDED",
        value: `${(this.hiddenMs / 1000).toFixed(0)}s THROTTLED — KEEP THIS TAB IN FRONT`,
        tone: "warn",
      });
    }

    const elapsed = this.controller ? performance.now() - this.startedAt : 0;
    lines.push({
      label: "STATUS",
      value: this.controller ? `${this.status}  ${formatDuration(elapsed)}` : this.status,
      tone: this.completion?.verified ? "accent" : this.status.includes("FAIL") || this.status.includes("ERROR") || this.status.includes("DENIED") ? "warn" : "normal",
    });

    if (!this.controller && !this.completion) this.renderIdle();
    this.readout.render(lines);
    this.startBtn.textContent = this.controller ? "ABORT" : this.role === "tx" ? "BEGIN TRANSMIT" : "BEGIN RECEIVE";
    this.startBtn.classList.toggle("danger", !!this.controller);

    const rate =
      this.role === "tx" && this.txSession && elapsed > 0
        ? (this.txSession.symbolsOut * this.mode.blockSize * 8000) / elapsed
        : this.rxSnapshot && elapsed > 0
          ? (this.rxSnapshot.symbolsAccepted * this.mode.blockSize * 8000) / elapsed
          : 0;
    const targets = this.controller ? this.escalationTargets() : [];
    this.escalateEl.replaceChildren(
      ...(targets.length
        ? [
            el("span", { class: "esc-label" }, "ESCALATE"),
            ...targets.slice(0, 4).map((t) =>
              el("button", { class: "chip esc", onclick: () => this.escalate(t) }, t.transport.codename),
            ),
          ]
        : []),
    );

    this.statsEl.replaceChildren(
      el("span", {}, this.transport.tier.split("—")[0].trim().toUpperCase()),
      el("span", {}, rate > 0 ? formatRate(rate) : "—"),
      el("span", { class: "stat-accent" }, this.controller ? "LIVE" : "STANDBY"),
    );
  }

  /**
   * Idle briefing. The stage is where the channel's live visual goes, and an
   * empty black rectangle before you press start reads as broken rather than
   * ready — so it explains what this channel is and what it needs of you.
   */
  private renderIdle(): void {
    const t = this.transport;
    const key = `${t.id}/${this.mode.id}/${this.role}`;
    if (this.stage.dataset.idle === key) return;
    this.stage.dataset.idle = key;

    const facts: Array<[string, string]> = [
      ["CHANNEL", `${t.name.toUpperCase()} / ${this.mode.label}`],
      ["TIER", t.tier.toUpperCase()],
      ["EST RATE", t.caps.estBps ? formatRate(t.caps.estBps) : "PER SHEET"],
      ["RANGE", t.caps.range.toUpperCase()],
      ["DIRECTION", t.caps.bidirectional ? "BIDIRECTIONAL" : "ONE WAY — NO ACKS"],
      ["SYMBOL", `${this.mode.blockSize} B PAYLOAD + 6 B FRAMING`],
    ];

    this.stage.replaceChildren(
      el(
        "div",
        { class: "briefing" },
        el("div", { class: "brief-code" }, t.codename),
        el(
          "div",
          { class: "brief-facts" },
          ...facts.map(([k, v]) => el("div", { class: "brief-row" }, el("span", {}, k), el("b", {}, v))),
        ),
        t.note ? el("p", { class: "hint brief-note" }, t.note) : null,
        el(
          "p",
          { class: "brief-go" },
          this.role === "tx"
            ? "> STAGE A PAYLOAD, READ THE KEY OUT, AND BEGIN."
            : "> ENTER THE SENDER'S KEY AND BEGIN. YOU CAN JOIN LATE.",
        ),
      ),
    );
  }

  private async renderLedger(): Promise<void> {
    if (!this.ledgerEl) return;
    const [entries, sum] = await Promise.all([history(6), totals()]);
    const rows: Node[] = [];
    for (const [codename, row] of [...sum.perTransport.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
      rows.push(
        el(
          "div",
          { class: "lrow" },
          el("span", { class: "lcode" }, codename),
          el("span", {}, formatBytes(row.bytes)),
          el("span", { class: "lmuted" }, formatRate(row.bestBps)),
        ),
      );
    }
    this.ledgerEl.replaceChildren(
      el("div", { class: "ltotal" }, sum.sessions ? `${formatBytes(sum.bytes)} MOVED ACROSS ${sum.sessions} DROP${sum.sessions === 1 ? "" : "S"}` : "NO DROPS YET"),
      ...rows,
      ...(entries.length
        ? [
            el("div", { class: "lsep" }, "RECENT"),
            ...entries.map((e) =>
              el(
                "div",
                { class: "lrow" },
                el("span", { class: "lcode" }, `${e.role === "tx" ? "TX" : "RX"} ${e.codename}`),
                el("span", {}, formatBytes(e.bytes)),
                el("span", { class: "lmuted" }, formatDuration(e.durationMs)),
              ),
            ),
            el(
              "button",
              {
                class: "add-rule",
                onclick: async () => {
                  await clearLedger();
                  void this.renderLedger();
                },
              },
              "CLEAR LEDGER",
            ),
          ]
        : []),
    );
  }
}
