import { createCountdown } from "../game/Timer.js";

/**
 * The 3-2-1 overlay.
 *
 * Driven by the deadline in the snapshot rather than by a message per beat, so
 * both screens count the same seconds off their own clocks and a dropped packet
 * cannot desync the count.
 *
 * Each beat replaces the number element outright. Restarting a CSS animation on
 * the same node needs a reflow hack; replacing the node is simpler and reads
 * exactly the same.
 *
 * @param {{root: HTMLElement, announcer: {say: (text: string) => void}}} deps
 */
export function createCountdownView({ root, announcer }) {
  let timer = null;
  let overlay = null;

  function teardown() {
    timer?.stop();
    timer = null;
    overlay?.remove();
    overlay = null;
    document.documentElement.removeAttribute("data-tension");
  }

  return {
    /**
     * @param {number} endsAt epoch ms
     * @param {() => void} [onDone] fired locally when the count reaches zero
     */
    show(endsAt, onDone) {
      teardown();

      overlay = document.createElement("div");
      overlay.className = "overlay";
      overlay.innerHTML = `
        <div class="countdown">
          <p class="eyebrow">Letters in. Get ready.</p>
          <p class="countdown__number" data-count>3</p>
        </div>
      `;
      root.append(overlay);

      // Pushes the paper grain harder while the clock runs, so the sheet looks
      // like it is being printed as the tension builds.
      document.documentElement.setAttribute("data-tension", "high");

      const slot = overlay.querySelector(".countdown");
      timer = createCountdown({
        endsAt,
        onCount: (secondsLeft) => {
          const fresh = document.createElement("p");
          fresh.className = "countdown__number";
          fresh.dataset.count = "";
          fresh.textContent = String(secondsLeft);
          overlay.querySelector("[data-count]")?.replaceWith(fresh);
          announcer.say(String(secondsLeft));
          void slot;
        },
        onDone: () => {
          teardown();
          onDone?.();
        },
      });
      timer.start();
    },

    hide: teardown,

    /** @returns {boolean} */
    isShowing() {
      return overlay !== null;
    },
  };
}
