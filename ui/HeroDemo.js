/**
 * The home screen's live demonstration.
 *
 * Rather than explain the rules, the hero plays one round of the game on loop:
 * two inked letters appear and the word that bridges them types itself out.
 * Every pair below is a genuine, checkable example, including one deliberately
 * hard pair (V/X) so the difficulty of the game is honest from the first screen.
 */

const PAIRS = Object.freeze([
  { start: "M", end: "T", word: "moment" },
  { start: "B", end: "E", word: "bridge" },
  { start: "S", end: "K", word: "spark" },
  { start: "G", end: "N", word: "garden" },
  { start: "V", end: "X", word: "vortex" },
  { start: "P", end: "O", word: "piano" },
  { start: "C", end: "W", word: "cashew" },
]);

const TYPE_MS = 105;
const HOLD_MS = 1_600;
const SWAP_MS = 420;

/**
 * @param {{
 *   letterA: HTMLElement, letterB: HTMLElement, word: HTMLElement
 * }} elements
 */
export function createHeroDemo({ letterA, letterB, word }) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** @type {number[]} */
  let timers = [];
  let index = 0;
  let running = false;

  const wait = (ms) =>
    new Promise((resolve) => {
      timers.push(setTimeout(resolve, ms));
    });

  function render(text, { caret }) {
    word.textContent = text;
    if (!caret) return;
    const bar = document.createElement("span");
    bar.className = "hero__caret";
    word.append(bar);
  }

  async function playOne(pair) {
    letterA.textContent = pair.start;
    letterB.textContent = pair.end;

    if (reduced.matches) {
      // No typing, no caret: show the finished example and hold it longer.
      render(pair.word, { caret: false });
      await wait(HOLD_MS * 2);
      return;
    }

    render("", { caret: true });
    await wait(SWAP_MS);
    for (let i = 1; i <= pair.word.length; i += 1) {
      if (!running) return;
      render(pair.word.slice(0, i), { caret: true });
      await wait(TYPE_MS);
    }
    render(pair.word, { caret: false });
    await wait(HOLD_MS);
  }

  async function loop() {
    while (running) {
      await playOne(PAIRS[index % PAIRS.length]);
      index += 1;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loop();
    },

    /** Stops the loop and clears pending timers, so leaving home costs nothing. */
    stop() {
      running = false;
      timers.forEach(clearTimeout);
      timers = [];
    },
  };
}
