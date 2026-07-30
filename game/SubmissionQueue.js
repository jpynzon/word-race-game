import { SUBMIT_COALESCE_WINDOW_MS } from "../js/constants.js";

/**
 * Decides who won the race — and it is the single most delicate thing in this
 * codebase.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * Validating a word requires an async dictionary call. The obvious
 * implementation validates each submission as it arrives:
 *
 *     onWord(sub) { if (await validate(sub)) declareWinner(sub) }   // WRONG
 *
 * Two submissions milliseconds apart start two concurrent lookups, and those
 * lookups can resolve **in either order** — a cached word resolves instantly
 * while an uncached one waits on the network. So the player who submitted
 * *second* routinely wins. Worse, it is nondeterministic, so it looks like
 * random unfairness rather than a bug.
 *
 * THE FIX, IN TWO PARTS
 *
 * 1. Serialize. Exactly one validation is ever in flight. The queue drains one
 *    item at a time, fully awaiting each before touching the next, and the
 *    first valid word ends the round. Concurrency cannot reorder what never
 *    runs concurrently.
 *
 * 2. Order fairly before draining. Raw arrival order punishes whoever has more
 *    latency: a guest 80ms away always loses a photo finish they actually won.
 *    So the first submission opens a short coalescing window, and everything
 *    inside it is sorted by offset-corrected client time — when each player
 *    actually pressed the key — with arrival ordinal as the tiebreaker.
 *
 * The window costs a few dozen milliseconds before a winner is announced. In
 * exchange, the player who pressed first wins, which is the promise the game
 * makes.
 */

/**
 * @param {{
 *   validate: (submission: object) => Promise<{ok: boolean, reason?: string, word?: string, source?: string}>,
 *   onWinner: (submission: object, result: object) => void,
 *   onRejected: (submission: object, reason: string) => void,
 *   coalesceWindowMs?: number
 * }} deps
 */
export function createSubmissionQueue({
  validate,
  onWinner,
  onRejected,
  coalesceWindowMs = SUBMIT_COALESCE_WINDOW_MS,
}) {
  /** @type {object[]} */
  let buffer = [];
  let arrivalCounter = 0;
  let windowTimer = null;
  let draining = false;
  /** Once a winner is found the round is over; later arrivals are told so. */
  let settled = false;
  let currentRoundId = 0;

  /**
   * Earlier corrected client time wins. Arrival ordinal breaks exact ties, so
   * the result is always deterministic — never a coin flip.
   */
  function byFairestFirst(a, b) {
    if (a.correctedTime !== b.correctedTime) return a.correctedTime - b.correctedTime;
    return a.arrival - b.arrival;
  }

  async function drain() {
    windowTimer = null;
    if (draining) return;
    draining = true;

    try {
      while (buffer.length > 0 && !settled) {
        buffer.sort(byFairestFirst);
        const submission = buffer.shift();

        // Fully awaited. Nothing else in this queue runs until this resolves —
        // that single `await` is what makes the outcome deterministic.
        let result;
        try {
          result = await validate(submission);
        } catch {
          result = { ok: false, reason: "not-a-word" };
        }

        // A round can end while we were awaiting (a timeout, or the opponent
        // disconnecting). Do not crown a winner for a round that is over.
        if (settled || submission.roundId !== currentRoundId) continue;

        if (result.ok) {
          settled = true;
          onWinner(submission, result);
          return;
        }
        onRejected(submission, result.reason);
      }
    } finally {
      draining = false;
    }

    // Submissions that landed while we were awaiting still need handling.
    if (buffer.length > 0 && !settled) scheduleDrain(0);
  }

  function scheduleDrain(delayMs) {
    if (windowTimer !== null || draining) return;
    windowTimer = setTimeout(drain, delayMs);
  }

  return {
    /**
     * Accepts a submission for consideration.
     *
     * @param {{
     *   playerId: string,
     *   word: string,
     *   correctedTime: number,
     *   roundId: number
     * }} submission correctedTime must already be in host-local terms
     * @returns {boolean} false if the round is already decided
     */
    offer(submission) {
      if (submission.roundId !== currentRoundId) return false;
      if (settled) {
        onRejected(submission, "round-over");
        return false;
      }

      arrivalCounter += 1;
      buffer.push({ ...submission, arrival: arrivalCounter });

      // The first submission of a round opens the fairness window. Later ones
      // inside it join the same batch rather than starting their own.
      scheduleDrain(buffer.length === 1 ? coalesceWindowMs : 0);
      return true;
    },

    /**
     * Opens a fresh round. Anything still buffered belongs to the old round and
     * is discarded rather than allowed to decide the new one.
     *
     * @param {number} roundId
     */
    reset(roundId) {
      if (windowTimer !== null) clearTimeout(windowTimer);
      windowTimer = null;
      buffer = [];
      settled = false;
      currentRoundId = roundId;
    },

    /** Ends the round without a winner (timeout, or the room emptying). */
    settle() {
      settled = true;
      buffer = [];
      if (windowTimer !== null) clearTimeout(windowTimer);
      windowTimer = null;
    },

    /** @returns {boolean} */
    isSettled() {
      return settled;
    },

    /** @returns {object} counters for the end-to-end race-condition test */
    diagnostics() {
      return {
        currentRoundId,
        buffered: buffer.length,
        settled,
        draining,
        totalOffered: arrivalCounter,
      };
    },
  };
}
