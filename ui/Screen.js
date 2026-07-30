/**
 * Screen visibility and focus.
 *
 * All screens sit in the document at once and are toggled with `[hidden]`.
 * The only subtle part is focus: swapping screens without moving focus leaves
 * keyboard and screen-reader users stranded on a control that no longer
 * exists, so every switch parks focus on the new screen's `[data-autofocus]`
 * element, or its heading if there isn't one.
 *
 * @param {HTMLElement} root element containing the `[data-screen]` sections
 */
export function createScreens(root) {
  /** @type {Map<string, HTMLElement>} */
  const screens = new Map();
  for (const node of root.querySelectorAll("[data-screen]")) {
    screens.set(node.dataset.screen, node);
  }

  let current = null;

  return {
    /** @returns {string|null} the visible screen's name */
    current() {
      return current;
    },

    /**
     * @param {string} name a SCREEN value
     * @param {{focus?: boolean}} [options] pass `focus: false` to leave focus alone
     */
    show(name, { focus = true } = {}) {
      const next = screens.get(name);
      if (!next) throw new Error(`Unknown screen: ${name}`);
      if (current === name) return;

      for (const [key, node] of screens) node.hidden = key !== name;
      current = name;

      if (!focus) return;
      const target =
        next.querySelector("[data-autofocus]") ??
        next.querySelector("h1, h2, [tabindex]:not([tabindex='-1'])");
      if (!(target instanceof HTMLElement)) return;

      if (!target.hasAttribute("tabindex") && !isNativelyFocusable(target)) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
    },

    /** @param {string} name @returns {HTMLElement|undefined} */
    element(name) {
      return screens.get(name);
    },
  };
}

const FOCUSABLE = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA", "A"]);

function isNativelyFocusable(element) {
  return FOCUSABLE.has(element.tagName);
}
