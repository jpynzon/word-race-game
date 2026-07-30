import { MAX_TOASTS, TOAST_DURATION_MS, TOAST_EXIT_MS } from "../js/constants.js";

/**
 * Transient messages. Used for things the player should notice but does not
 * need to acknowledge: a rejected word, a copied link, an opponent reconnecting.
 *
 * Anything that requires a decision belongs in a Modal instead.
 *
 * @param {HTMLElement} rail the fixed container toasts are appended to
 */
export function createToaster(rail) {
  /** @type {Set<HTMLElement>} */
  const live = new Set();

  function dismiss(node) {
    if (!live.has(node)) return;
    live.delete(node);
    node.dataset.leaving = "true";
    setTimeout(() => node.remove(), TOAST_EXIT_MS);
  }

  return {
    /**
     * @param {string} message plain text, already user-facing
     * @param {{tone?: "good"|"bad"|"info"|"neutral", duration?: number}} [options]
     */
    show(message, { tone = "neutral", duration = TOAST_DURATION_MS } = {}) {
      // Oldest first, so a burst of rejections does not bury the newest one.
      while (live.size >= MAX_TOASTS) dismiss(live.values().next().value);

      const node = document.createElement("output");
      node.className = tone === "neutral" ? "toast" : `toast toast--${tone}`;
      node.textContent = message;
      rail.append(node);
      live.add(node);

      setTimeout(() => dismiss(node), duration);
      return () => dismiss(node);
    },

    /** Clears everything on screen. Called when leaving a room. */
    clear() {
      for (const node of [...live]) dismiss(node);
    },
  };
}

/**
 * Writes to the single assertive live region. Reserved for round-critical
 * events — reveal, winner, draw — so it is not competing with toasts.
 *
 * @param {HTMLElement} region the `#announcer` element
 */
export function createAnnouncer(region) {
  let last = "";
  return {
    /** @param {string} message */
    say(message) {
      if (!message || message === last) {
        // Re-announce an identical string by forcing a change first.
        region.textContent = "";
      }
      last = message;
      region.textContent = message;
    },
  };
}
