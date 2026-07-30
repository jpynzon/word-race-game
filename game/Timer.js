/**
 * Deadline-based timers.
 *
 * Every timer here is defined by an **absolute end time**, never by counting
 * down a remaining value. That choice matters for a networked game:
 *
 *  - the host puts the deadline in the snapshot, so both screens compute the
 *    same remaining time from their own clock instead of trying to keep two
 *    countdowns in step
 *  - a background tab whose intervals were throttled shows the correct value on
 *    its very next tick rather than lagging by however long it was asleep
 *  - a player who reconnects mid-round lands on the right number immediately
 *
 * Nothing in this file touches the DOM or the store; it reports progress and
 * lets the caller decide what that means.
 */

/**
 * A repeating ticker that runs until a deadline passes.
 *
 * @param {{
 *   endsAt: number,
 *   durationMs: number,
 *   intervalMs?: number,
 *   onTick: (progress: {remainingMs: number, fraction: number}) => void,
 *   onDone: () => void
 * }} options
 */
export function createDeadlineTimer({
  endsAt,
  durationMs,
  intervalMs = 100,
  onTick,
  onDone,
}) {
  let handle = null;
  let finished = false;

  function report() {
    const remainingMs = Math.max(0, endsAt - Date.now());
    const fraction = durationMs > 0 ? remainingMs / durationMs : 0;
    onTick({ remainingMs, fraction });

    if (remainingMs > 0 || finished) return;
    finished = true;
    stop();
    onDone();
  }

  function stop() {
    if (handle !== null) clearInterval(handle);
    handle = null;
  }

  return {
    start() {
      stop();
      report(); // paint the correct value immediately, not one interval late
      if (finished) return;
      handle = setInterval(report, intervalMs);
    },
    stop() {
      finished = true;
      stop();
    },
    /** @returns {number} */
    remainingMs() {
      return Math.max(0, endsAt - Date.now());
    },
  };
}

/**
 * A whole-second countdown, for the 3-2-1 before the reveal.
 *
 * Fires `onCount` once per distinct second so the caller can restart an
 * animation per beat, then `onDone` at zero.
 *
 * @param {{
 *   endsAt: number,
 *   onCount: (secondsLeft: number) => void,
 *   onDone: () => void
 * }} options
 */
export function createCountdown({ endsAt, onCount, onDone }) {
  let handle = null;
  let lastAnnounced = null;

  function report() {
    const remainingMs = Math.max(0, endsAt - Date.now());
    // Ceiling, so 2.4s remaining reads as "3" — the number a player expects to
    // see while the third second is still running.
    const secondsLeft = Math.ceil(remainingMs / 1000);

    if (secondsLeft !== lastAnnounced) {
      lastAnnounced = secondsLeft;
      if (secondsLeft > 0) onCount(secondsLeft);
    }

    if (remainingMs > 0) return;
    stop();
    onDone();
  }

  function stop() {
    if (handle !== null) clearInterval(handle);
    handle = null;
  }

  return {
    start() {
      stop();
      report();
      if (handle === null && Math.max(0, endsAt - Date.now()) > 0) {
        // 80ms keeps the digit flip visually on the second boundary.
        handle = setInterval(report, 80);
      }
    },
    stop,
  };
}
