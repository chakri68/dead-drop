/**
 * The ledger — every completed drop, locally, forever.
 *
 * This is the scoreboard. "You have moved 3.2 MB by sound" is a stranger and
 * better statistic than any transfer speed, and it only exists if something
 * keeps count.
 */

export interface LedgerEntry {
  id?: number;
  ts: number;
  role: "tx" | "rx";
  transport: string;
  codename: string;
  mode: string;
  bytes: number;
  durationMs: number;
  symbols: number;
  verified: boolean;
}

const DB_NAME = "dead-drop";
const STORE = "sessions";

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("ts", "ts");
      }
    };
    req.onsuccess = () => resolve(req.result);
    // A private window or a browser with storage disabled shouldn't break a transfer.
    req.onerror = () => resolve(null);
  });
}

export async function record(entry: LedgerEntry): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

export async function history(limit = 40): Promise<LedgerEntry[]> {
  const db = await open();
  if (!db) return [];
  const out = await new Promise<LedgerEntry[]>((resolve) => {
    const entries: LedgerEntry[] = [];
    const tx = db.transaction(STORE, "readonly");
    const cursor = tx.objectStore(STORE).index("ts").openCursor(null, "prev");
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || entries.length >= limit) return resolve(entries);
      entries.push(c.value as LedgerEntry);
      c.continue();
    };
    cursor.onerror = () => resolve(entries);
  });
  db.close();
  return out;
}

export interface Totals {
  bytes: number;
  sessions: number;
  perTransport: Map<string, { bytes: number; sessions: number; bestBps: number }>;
}

export async function totals(): Promise<Totals> {
  const entries = await history(5000);
  const perTransport = new Map<string, { bytes: number; sessions: number; bestBps: number }>();
  let bytes = 0;
  for (const e of entries) {
    bytes += e.bytes;
    const row = perTransport.get(e.codename) ?? { bytes: 0, sessions: 0, bestBps: 0 };
    row.bytes += e.bytes;
    row.sessions++;
    const bps = e.durationMs > 0 ? (e.bytes * 8000) / e.durationMs : 0;
    row.bestBps = Math.max(row.bestBps, bps);
    perTransport.set(e.codename, row);
  }
  return { bytes, sessions: entries.length, perTransport };
}

export async function clear(): Promise<void> {
  const db = await open();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatRate(bps: number): string {
  if (bps < 1000) return `${bps.toFixed(0)} bit/s`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} kbit/s`;
  return `${(bps / 1_000_000).toFixed(2)} Mbit/s`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
