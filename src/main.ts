import "./style.css";
import { App } from "./ui/app.ts";

/**
 * Boot.
 *
 * The overlay and the black ground come from the critical inline styles in
 * index.html, so the first paint is already correct — this only decides *when*
 * to hand over to the real UI. The title is revealed once the pixel font has
 * genuinely loaded, because a fallback renders it at a very different width and
 * the mismatch is obvious as it animates away.
 */
async function boot(): Promise<void> {
  const reveal = () => document.body.classList.add("fonts-ready");
  const handOver = () => {
    document.body.classList.remove("booting");
    document.body.classList.add("booted");
  };

  try {
    const root = document.querySelector<HTMLDivElement>("#app")!;
    await new App(root).mount();

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      reveal();
      handOver();
      return;
    }

    try {
      await Promise.race([
        document.fonts.load('12px "Press Start 2P"'),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    } catch {
      /* font loading unavailable; show the title anyway */
    }
    reveal();
    await new Promise((r) => setTimeout(r, 420));
  } finally {
    // Whatever happened above, never strand the user on a black screen.
    reveal();
    handOver();
  }
}

void boot();

// Offline is the entire premise, so registering this is not optional polish.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  globalThis.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
