/**
 * The status readout. Dotted leaders, uppercase, one fact per line:
 *
 *   > TRANSPORT ......... CHIRP / ULTRASONIC
 *   > RX LOCK ........... ########..  81%
 *
 * Deliberately over-dramatic, per the brief. It is also the fastest way to read
 * six live numbers at once, which is the actual justification.
 */
const WIDTH = 20;

export interface Line {
  label: string;
  value: string;
  tone?: "normal" | "accent" | "warn" | "muted";
}

export function leader(label: string, value: string): string {
  const dots = Math.max(1, WIDTH - label.length);
  return `> ${label} ${".".repeat(dots)} ${value}`;
}

/** Ten-cell meter. Blocks rather than a styled div so it lives in the same monospace grid. */
export function bar(fraction: number, cells = 10): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export class Readout {
  private el: HTMLElement;

  constructor(mount: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "readout";
    mount.appendChild(this.el);
  }

  render(lines: Line[]): void {
    // Rebuilt wholesale each frame: a dozen spans is nothing, and diffing them
    // would be more code than it saves.
    this.el.replaceChildren(
      ...lines.map((line) => {
        const row = document.createElement("div");
        row.className = `rline tone-${line.tone ?? "normal"}`;
        row.textContent = leader(line.label, line.value);
        return row;
      }),
    );
  }
}

export function group(n: number): string {
  return n.toLocaleString("en-US");
}
