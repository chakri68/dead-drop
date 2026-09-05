/**
 * BLE — Bluetooth GATT, with a caveat worth stating plainly.
 *
 * The spec asked for the transmitter to advertise a GATT service and the
 * receiver to connect to it. A browser cannot do that. Web Bluetooth is
 * central-only by design: `navigator.bluetooth` can scan for and connect to
 * peripherals, and there is no API anywhere in the platform for advertising one.
 * Phone-to-phone over BLE is not reachable from a web page, full stop.
 *
 * What *is* reachable: both devices connect, as centrals, to the same nearby
 * peripheral running Nordic UART Service — an ESP32, a micro:bit, an nRF dongle
 * — and it relays bytes between them. So this transport is a bridge, not a
 * direct link, and it needs a third piece of hardware. That is a real cost and
 * the UI says so rather than pretending.
 *
 * Frames are SLIP-delimited and written in 20-byte chunks, because the ATT MTU
 * is 23 bytes until negotiated and Chrome doesn't tell us whether it was.
 */
import { frameSize, parseFrame } from "../core/frame.ts";
import { SlipDecoder, slipEncode } from "./wire.ts";
import { SymbolQueue, sleep, type Transport, type TransportContext, type TxContext } from "./types.ts";
import { hexPreview, SymbolLog } from "../ui/visuals.ts";

const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // central writes here
const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // peripheral notifies here
const CHUNK = 20;

async function connect(): Promise<{
  device: BluetoothDevice;
  write: BluetoothRemoteGATTCharacteristic;
  notify: BluetoothRemoteGATTCharacteristic;
}> {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [NUS_SERVICE] }],
    optionalServices: [NUS_SERVICE],
  });
  const server = await device.gatt!.connect();
  const service = await server.getPrimaryService(NUS_SERVICE);
  return {
    device,
    write: await service.getCharacteristic(NUS_RX),
    notify: await service.getCharacteristic(NUS_TX),
  };
}

export const ble: Transport = {
  id: "ble",
  name: "Bluetooth LE relay",
  codename: "BLE",
  tier: "Tier 3 — radio & cable",
  caps: { bidirectional: true, estBps: 8_000, range: "~10 m" },
  note: "Needs a relay peripheral running Nordic UART Service (ESP32, micro:bit). Browsers cannot advertise GATT, so phone-to-phone BLE is not possible from a web page — this bridges through hardware instead.",
  modes: [{ id: "nus", label: "NORDIC UART SERVICE", blockSize: 128, headerEvery: 48 }],

  async probe() {
    if (!navigator.bluetooth) return "unsupported";
    // Chrome on Linux/Android can report availability; treat unknown as ok and
    // let requestDevice surface the real answer.
    try {
      const available = await navigator.bluetooth.getAvailability?.();
      return available === false ? "unsupported" : "ok";
    } catch {
      return "ok";
    }
  },

  async tx(symbols, ctx: TxContext) {
    const { device, write } = await connect();
    const log = new SymbolLog(ctx.mount);
    ctx.log(`LINKED ......... ${device.name ?? "PERIPHERAL"}`);
    ctx.meter.set(1);
    let n = 0;
    try {
      for await (const frame of symbols) {
        if (ctx.signal.aborted || !device.gatt?.connected) break;
        const bytes = slipEncode(frame);
        for (let o = 0; o < bytes.length; o += CHUNK) {
          const slice = bytes.subarray(o, Math.min(o + CHUNK, bytes.length));
          // writeValueWithoutResponse is several times faster, but not every
          // stack exposes it; fall back rather than fail.
          if (write.writeValueWithoutResponse) await write.writeValueWithoutResponse(slice as BufferSource);
          else await write.writeValue(slice as BufferSource);
        }
        if (++n % 8 === 0) log.push(`TX ${String(n).padStart(6)}  ${hexPreview(frame, 8)}`);
        await sleep(4, ctx.signal);
      }
    } finally {
      device.gatt?.disconnect();
    }
  },

  async *rx(ctx: TransportContext) {
    const { device, notify } = await connect();
    const queue = new SymbolQueue();
    const log = new SymbolLog(ctx.mount);
    const slip = new SlipDecoder();
    const size = frameSize(ctx.mode.blockSize);
    ctx.log(`LINKED ......... ${device.name ?? "PERIPHERAL"}`);
    ctx.meter.set(1);

    let n = 0;
    const onValue = (e: Event) => {
      const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      slip.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), (frame) => {
        if (frame.length !== size || !parseFrame(frame, ctx.mode.blockSize)) return;
        if (++n % 8 === 0) log.push(`RX ${String(n).padStart(6)}  ${hexPreview(frame, 8)}`);
        queue.push(frame);
      });
    };
    notify.addEventListener("characteristicvaluechanged", onValue);
    await notify.startNotifications();
    device.addEventListener("gattserverdisconnected", () => queue.close());
    ctx.signal.addEventListener("abort", () => {
      device.gatt?.disconnect();
      queue.close();
    }, { once: true });

    try {
      yield* queue;
    } finally {
      notify.removeEventListener("characteristicvaluechanged", onValue);
      device.gatt?.disconnect();
    }
  },
};
