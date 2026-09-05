import type { Transport } from "./types.ts";
import { loopback } from "./loopback.ts";
import { morse } from "./morse.ts";
import { haptic } from "./haptic.ts";
import { chirp } from "./chirp.ts";
import { lantern } from "./lantern.ts";
import { qrClassic } from "./qrclassic.ts";
import { paper } from "./paper.ts";
import { ble } from "./ble.ts";
import { nfc } from "./nfc.ts";
import { link } from "./link.ts";
import { wire } from "./wire.ts";

/** Roughly slowest to fastest — the order the spec asks for, and the order that reads best. */
export const TRANSPORTS: Transport[] = [
  loopback,
  morse,
  haptic,
  chirp,
  lantern,
  qrClassic,
  paper,
  ble,
  nfc,
  link,
  wire,
];

export function transportById(id: string): Transport | undefined {
  return TRANSPORTS.find((t) => t.id === id);
}
