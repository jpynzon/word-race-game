import {
  COUNTDOWN_SECONDS,
  LETTER_ENTRY_DURATION_MS,
  PHASE,
  REJECTION,
  WORD_RACE_DURATION_MS,
} from "../js/constants.js";
import { awardPoint, createScores, reconcileScores } from "./ScoreManager.js";
import { createSubmissionQueue } from "./SubmissionQueue.js";
import { createCountdown, createDeadlineTimer } from "./Timer.js";
import { normaliseLetter } from "./Validator.js";

/**
 * The round state machine. Host-only — a guest never runs any of this.
 *
 *   LETTER_ENTRY ──▶ COUNTDOWN ──▶ RACE ──▶ RESULT ──▶ (next round)
 *        │                            │
 *        └── both committed           └── first valid word, or the timer
 *
 * TWO THINGS WORTH KNOWING
 *
 * 1. Committed letters never enter the store before the reveal. They live in a
 *    private map here, and only `committed: {playerId: true}` booleans are
 *    published. If the letters were in state they would be in the snapshot, and
 *    a guest could read their opponent's letter out of memory before it was
 *    revealed — which would quietly ruin the game.
 *
 * 2. Seats alternate every round. The ending letter is much harder than the
 *    starting one (try ending on Q, X or V), so a fixed assignment would hand
 *    one player the harder job for the whole match.
 */
export function createRoundManager({
  store,
  validator,
  dictionary,
  onChange,
  onRejection,
}) {
  /** Committed letters, deliberately outside the store. @type {Map<string,string>} */
  const secretLetters = new Map();

  let letterTimer = null;
  let countdown = null;
  let raceTimer = null;
  let noticeCounter = 0;
  let stopped = false;

  const queue = createSubmissionQueue({
    validate: (submission) => {
      const { match } = store.getState();
      return validator.validate(submission.word, {
        start: match.letters?.start,
        end: match.letters?.end,
        usedWords: match.usedWords,
      });
    },
    onWinner: (submission, result) => finishWithWinner(submission, result),
    onRejected: (submission, reason) => onRejection(submission.playerId, reason),
  });

  function clearTimers() {
    letterTimer?.stop();
    countdown?.stop();
    raceTimer?.stop();
    letterTimer = null;
    countdown = null;
    raceTimer = null;
  }

  /**
   * A short-lived message both players should see. It rides in the snapshot
   * rather than being sent separately, so the two screens cannot show different
   * notices — or show one twice.
   */
  function notice(text, tone = "info") {
    noticeCounter += 1;
    return { id: noticeCounter, text, tone };
  }

  /**
   * @param {string[]} playerOrder
   * @param {number} roundNumber 1-based
   */
  function assignSeats(playerOrder, roundNumber) {
    const [first, second] = playerOrder;
    // Odd rounds: the host starts. Even rounds: the guest starts.
    return roundNumber % 2 === 1
      ? { starterId: first, enderId: second }
      : { starterId: second, enderId: first };
  }

  /* ---- Phase: letter entry ---------------------------------------------- */

  function beginRound({ notice: carriedNotice = null } = {}) {
    if (stopped) return;
    clearTimers();
    secretLetters.clear();

    const state = store.getState();
    const roundNumber = state.match.roundNumber + 1;
    const roundId = state.match.roundId + 1;
    const seats = assignSeats(state.playerOrder, roundNumber);

    queue.reset(roundId);

    store.setMatch({
      phase: PHASE.LETTER_ENTRY,
      roundNumber,
      roundId,
      ...seats,
      committed: {},
      letters: null,
      countdownEndsAt: null,
      raceEndsAt: null,
      result: null,
      notice: carriedNotice,
      scores: reconcileScores(state.match.scores, state.playerOrder),
    });
    onChange();

    // A soft cap so one idle player cannot stall the match forever.
    letterTimer = createDeadlineTimer({
      endsAt: Date.now() + LETTER_ENTRY_DURATION_MS,
      durationMs: LETTER_ENTRY_DURATION_MS,
      intervalMs: 500,
      onTick: () => {},
      onDone: autoCommitStragglers,
    });
    letterTimer.start();
  }

  /**
   * Picks for anyone who ran out of time. Chosen over ending the round in a
   * draw: a party game should keep moving, and an unexpected letter is more fun
   * than a dead round. Both players are told it happened.
   */
  function autoCommitStragglers() {
    const state = store.getState();
    if (state.match.phase !== PHASE.LETTER_ENTRY) return;

    const missing = state.playerOrder.filter((id) => !secretLetters.has(id));
    if (missing.length === 0) return;

    const names = missing.map((id) => state.players[id]?.name ?? "a player");
    for (const id of missing) {
      secretLetters.set(id, randomPlayableLetter());
    }
    store.setMatch({
      committed: Object.fromEntries(state.playerOrder.map((id) => [id, true])),
      notice: notice(`Time's up — a letter was picked for ${names.join(" and ")}.`, "info"),
    });
    onChange();
    beginCountdown();
  }

  /** Weighted toward letters that actually start and end words. */
  function randomPlayableLetter() {
    const pool = "aabcdeefghiklmnoprsstuw";
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ---- Phase: countdown ------------------------------------------------- */

  function beginCountdown() {
    if (stopped) return;
    letterTimer?.stop();

    const endsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
    store.setMatch({ phase: PHASE.COUNTDOWN, countdownEndsAt: endsAt });
    onChange();

    countdown = createCountdown({
      endsAt,
      onCount: () => {},
      onDone: reveal,
    });
    countdown.start();
  }

  /* ---- Phase: reveal and race ------------------------------------------- */

  function reveal() {
    if (stopped) return;
    const state = store.getState();
    const { starterId, enderId } = state.match;
    const start = secretLetters.get(starterId);
    const end = secretLetters.get(enderId);

    if (!start || !end) {
      // Should not happen; re-deal rather than reveal a half-formed rule.
      beginRound({ notice: notice("A letter went missing. Re-dealing.", "bad") });
      return;
    }

    // Ninety of the 676 letter pairs have no English word at all. Running a
    // thirty-second timer on one of those isn't a challenge, it's a bug the
    // players get blamed for — so re-deal and say why.
    if (!validator.isPlayablePair(start, end)) {
      beginRound({
        notice: notice(
          `No English word runs from ${start.toUpperCase()} to ${end.toUpperCase()} — new letters.`,
          "info",
        ),
      });
      return;
    }

    const raceEndsAt = Date.now() + WORD_RACE_DURATION_MS;
    store.setMatch({
      phase: PHASE.RACE,
      letters: { start, end },
      countdownEndsAt: null,
      raceEndsAt,
    });
    onChange();

    raceTimer = createDeadlineTimer({
      endsAt: raceEndsAt,
      durationMs: WORD_RACE_DURATION_MS,
      intervalMs: 250,
      onTick: () => {},
      onDone: finishAsDraw,
    });
    raceTimer.start();
  }

  /* ---- Phase: result ---------------------------------------------------- */

  function finishWithWinner(submission, result) {
    if (stopped) return;
    clearTimers();

    const state = store.getState();
    const winner = state.players[submission.playerId];
    store.setMatch({
      phase: PHASE.RESULT,
      raceEndsAt: null,
      result: {
        winnerId: submission.playerId,
        word: result.word,
        source: result.source ?? null,
        draw: false,
      },
      scores: awardPoint(state.match.scores, submission.playerId),
      usedWords: [...state.match.usedWords, result.word],
      notice: notice(`${winner?.name ?? "Someone"} got it: ${result.word}.`, "good"),
    });
    onChange();
  }

  function finishAsDraw() {
    if (stopped) return;
    clearTimers();
    queue.settle();

    store.setMatch({
      phase: PHASE.RESULT,
      raceEndsAt: null,
      result: { winnerId: null, word: null, source: null, draw: true },
      notice: notice("Nobody found one. Round drawn.", "info"),
    });
    onChange();
  }

  return {
    /** Loads the dictionary, zeroes the scores, and deals the first round. */
    async startMatch() {
      stopped = false;
      const state = store.getState();

      // Pull the local wordlist in before the clock matters, so a mid-race
      // fallback never waits on a download.
      await dictionary.prepare();

      store.setMatch({
        roundNumber: 0,
        roundId: store.getState().match.roundId,
        scores: createScores(state.playerOrder),
        usedWords: [],
        result: null,
        notice: null,
      });
      beginRound();
    },

    /**
     * Records a committed letter. Advances to the countdown once both are in.
     *
     * @param {string} playerId
     * @param {string} rawLetter
     * @returns {{ok: boolean, reason?: string}}
     */
    submitLetter(playerId, rawLetter) {
      const state = store.getState();
      if (state.match.phase !== PHASE.LETTER_ENTRY) {
        return { ok: false, reason: REJECTION.WRONG_PHASE };
      }
      if (!state.players[playerId]) return { ok: false, reason: REJECTION.WRONG_PHASE };

      const letter = normaliseLetter(rawLetter);
      if (!letter) return { ok: false, reason: REJECTION.NOT_ALPHA };

      // Idempotent: a duplicate commit for the same round is a no-op, not a
      // second letter.
      if (secretLetters.has(playerId)) return { ok: true };

      secretLetters.set(playerId, letter);
      store.setMatch({
        committed: { ...state.match.committed, [playerId]: true },
      });
      onChange();

      const everyoneIn = state.playerOrder.every((id) => secretLetters.has(id));
      if (everyoneIn) beginCountdown();
      return { ok: true };
    },

    /**
     * Offers a word to the queue. The queue — not this method — decides the
     * winner, because ordering across concurrent submissions is the whole
     * problem. @see SubmissionQueue
     *
     * @param {{playerId: string, word: string, correctedTime: number, roundId: number}} submission
     */
    submitWord(submission) {
      const { match } = store.getState();
      if (match.phase !== PHASE.RACE) {
        onRejection(submission.playerId, REJECTION.WRONG_PHASE);
        return;
      }
      if (submission.roundId !== match.roundId) {
        onRejection(submission.playerId, REJECTION.ROUND_OVER);
        return;
      }
      queue.offer(submission);
    },

    /** Deals the next round. Only meaningful from RESULT. */
    nextRound() {
      const { match } = store.getState();
      if (match.phase !== PHASE.RESULT) return;
      beginRound();
    },

    /** Zeroes scores and used words, then deals a fresh first round. */
    restartMatch() {
      clearTimers();
      const state = store.getState();
      store.setMatch({
        roundNumber: 0,
        scores: createScores(state.playerOrder),
        usedWords: [],
        result: null,
        notice: notice("New match.", "info"),
      });
      beginRound();
    },

    /** Drops everyone back to the lobby, keeping the room open. */
    returnToLobby() {
      clearTimers();
      queue.settle();
      secretLetters.clear();
      store.setMatch({
        phase: PHASE.LOBBY,
        committed: {},
        letters: null,
        countdownEndsAt: null,
        raceEndsAt: null,
        result: null,
        notice: null,
      });
      onChange();
    },

    /** Halts every timer. Called when the room closes. */
    stop() {
      stopped = true;
      clearTimers();
      queue.settle();
      secretLetters.clear();
    },

    /** @returns {object} internals for the race-condition verification */
    diagnostics() {
      return {
        queue: queue.diagnostics(),
        committedCount: secretLetters.size,
        // Deliberately not the letters themselves, even here.
        hasSecrets: [...secretLetters.keys()],
      };
    },
  };
}
