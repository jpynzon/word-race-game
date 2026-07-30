import {
  COUNTDOWN_SECONDS,
  GAME_MODE,
  LETTER_ENTRY_DURATION_MS,
  PHASE,
  REJECTION,
} from "../js/constants.js";
import { normaliseSettings } from "./GameSettings.js";
import { pairingForRound } from "./Pairings.js";
import { awardPoint, createScores, reconcileScores } from "./ScoreManager.js";
import { createSubmissionQueue } from "./SubmissionQueue.js";
import { createCountdown, createDeadlineTimer } from "./Timer.js";
import { normaliseLetter } from "./Validator.js";

/**
 * The round state machine. Host-only — a guest never runs any of this.
 *
 *   LETTER_ENTRY ──▶ COUNTDOWN ──▶ RACE ──▶ RESULT ──▶ (next round)
 *        │                           │
 *        └── everyone committed      └── first valid word, or the timer
 *
 * The two modes differ only in how the collected letters become a rule:
 *
 *   DUEL      two players; one letter starts the word, the other ends it
 *   CONTAINS  three or four; the word must contain every letter
 *
 * Both share the timer, the scoring, the submission queue and the re-deal logic,
 * so mode handling is confined to buildRule() and seat assignment.
 *
 * TWO THINGS WORTH KNOWING
 *
 * 1. Committed letters never enter the store before the reveal. They live in a
 *    private map here, and only `committed: {playerId: true}` booleans are
 *    published. If the letters were in state they would be in the snapshot, and
 *    a player could read their opponents' letters out of memory before the
 *    reveal — which would quietly ruin the game.
 *
 * 2. In DUEL, seats alternate every round. Ending a word is much harder than
 *    starting one (try ending on Q, X or V), so a fixed assignment would hand
 *    one player the harder job for the whole match. CONTAINS needs no seats:
 *    every letter is equal.
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
      if (!match.rule) return Promise.resolve({ ok: false, reason: REJECTION.WRONG_PHASE });
      return validator.validate(submission.word, {
        ...match.rule,
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
   * A short-lived message every player should see. It rides in the snapshot
   * rather than being sent separately, so no two screens can show different
   * notices — or show one twice.
   */
  function notice(text, tone = "info") {
    noticeCounter += 1;
    return { id: noticeCounter, text, tone };
  }

  /** @returns {object} the current, validated settings */
  function settings() {
    const state = store.getState();
    return normaliseSettings(state.match.settings, state.playerOrder.length);
  }

  /**
   * Decides who plays this round and which side of the rule each one owns.
   *
   * This is the only place the three modes diverge on participation:
   *
   *   DUEL         both players, every round
   *   CONTAINS     everyone, every round
   *   ROUND_ROBIN  two duellists from the rotation; the rest observe
   *
   * In the two-letter modes the starter and ender swap on alternate rounds,
   * because ending a word is much harder than starting one (try ending on Q, X
   * or V) and a fixed assignment would hand one player the harder job all match.
   *
   * @param {object} state
   * @param {number} roundNumber 1-based
   * @param {string} mode
   * @returns {{activeIds: string[], starterId: string|null, enderId: string|null, pairing: object|null}}
   */
  function assignRoles(state, roundNumber, mode) {
    /* Only connected players can be dealt in. A player whose tab died would
       otherwise be paired anyway and the round would sit in letter entry until
       the 45-second auto-commit rescued it — so everyone waits on someone who
       is not there. Their seat and score are still held for a reconnect; they
       just get skipped in the rotation while they are away. */
    const available = state.playerOrder.filter((id) => state.players[id]?.connected);

    if (mode === GAME_MODE.CONTAINS) {
      return {
        activeIds: available,
        starterId: null,
        enderId: null,
        pairing: null,
      };
    }

    let pair;
    let pairing = null;
    if (mode === GAME_MODE.ROUND_ROBIN) {
      pairing = pairingForRound(available, state.match.rotationIndex);
      if (!pairing) {
        return { activeIds: [], starterId: null, enderId: null, pairing: null };
      }
      pair = [pairing.aId, pairing.bId];
    } else {
      pair = [available[0], available[1]];
    }

    if (!pair[0] || !pair[1]) {
      return { activeIds: [], starterId: null, enderId: null, pairing: null };
    }

    const swap = roundNumber % 2 === 0;
    const starterId = swap ? pair[1] : pair[0];
    const enderId = swap ? pair[0] : pair[1];
    return { activeIds: [starterId, enderId], starterId, enderId, pairing };
  }

  /** @returns {string[]} the players who must commit and may submit this round */
  function activePlayers() {
    const { match } = store.getState();
    return match.activeIds ?? [];
  }

  /**
   * Turns the committed letters into the round's rule.
   *
   * @returns {object|null} null if a letter is missing
   */
  function buildRule() {
    const state = store.getState();
    const config = settings();

    if (config.mode === GAME_MODE.CONTAINS) {
      const active = activePlayers();
      const contributions = active
        .filter((id) => secretLetters.has(id))
        .map((id) => ({ playerId: id, letter: secretLetters.get(id) }));

      if (contributions.length !== active.length) return null;

      return {
        mode: GAME_MODE.CONTAINS,
        letters: contributions.map((c) => c.letter),
        contributions,
        minWordLength: config.minWordLength,
      };
    }

    const { starterId, enderId } = state.match;
    const start = secretLetters.get(starterId);
    const end = secretLetters.get(enderId);
    if (!start || !end) return null;

    return {
      mode: GAME_MODE.DUEL,
      start,
      end,
      letters: [start, end],
      contributions: [
        { playerId: starterId, letter: start },
        { playerId: enderId, letter: end },
      ],
      minWordLength: config.minWordLength,
    };
  }

  /* ---- Phase: letter entry ---------------------------------------------- */

  function beginRound({ notice: carriedNotice = null } = {}) {
    if (stopped) return;
    clearTimers();
    secretLetters.clear();

    const state = store.getState();
    const roundNumber = state.match.roundNumber + 1;
    const roundId = state.match.roundId + 1;
    const config = settings();

    const roles = assignRoles(state, roundNumber, config.mode);

    // Announce the pairing so observers know why they are sitting this one out.
    const pairingNotice =
      carriedNotice ??
      (roles.pairing && state.playerOrder.length > 2
        ? notice(
            `Up next: ${state.players[roles.starterId]?.name ?? "?"} vs ${
              state.players[roles.enderId]?.name ?? "?"
            }.`,
            "info",
          )
        : null);

    queue.reset(roundId);

    store.setMatch({
      phase: PHASE.LETTER_ENTRY,
      roundNumber,
      roundId,
      settings: config,
      activeIds: roles.activeIds,
      starterId: roles.starterId,
      enderId: roles.enderId,
      // Only round robin advances the rotation; the other modes ignore it.
      rotationIndex:
        config.mode === GAME_MODE.ROUND_ROBIN
          ? state.match.rotationIndex + 1
          : state.match.rotationIndex,
      committed: {},
      rule: null,
      countdownEndsAt: null,
      raceEndsAt: null,
      result: null,
      notice: pairingNotice,
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
   * than a dead round. Everyone is told it happened.
   */
  function autoCommitStragglers() {
    const state = store.getState();
    if (state.match.phase !== PHASE.LETTER_ENTRY) return;

    // Only the players who owe a letter — observers never do.
    const active = activePlayers();
    const missing = active.filter((id) => !secretLetters.has(id));
    if (missing.length === 0) return;

    const names = missing.map((id) => state.players[id]?.name ?? "a player");
    for (const id of missing) secretLetters.set(id, randomPlayableLetter());

    store.setMatch({
      committed: Object.fromEntries(active.map((id) => [id, true])),
      notice: notice(
        `Time's up — a letter was picked for ${names.join(" and ")}.`,
        "info",
      ),
    });
    onChange();
    beginCountdown();
  }

  /** Weighted toward letters that actually appear in words. */
  function randomPlayableLetter() {
    const pool = "aabcdeeefghiillmnooprsstuw";
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ---- Phase: countdown ------------------------------------------------- */

  function beginCountdown() {
    if (stopped) return;
    letterTimer?.stop();

    const endsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
    store.setMatch({ phase: PHASE.COUNTDOWN, countdownEndsAt: endsAt });
    onChange();

    countdown = createCountdown({ endsAt, onCount: () => {}, onDone: reveal });
    countdown.start();
  }

  /* ---- Phase: reveal and race ------------------------------------------- */

  function reveal() {
    if (stopped) return;
    const rule = buildRule();

    if (!rule) {
      // Should not happen; re-deal rather than reveal a half-formed rule.
      beginRound({ notice: notice("A letter went missing. Re-dealing.", "bad") });
      return;
    }

    /* Both modes can deal an impossible hand: 90 of the 676 letter pairs have no
       English word, and four random letters share no word surprisingly often.
       Running a timer on one of those isn't a challenge, it's a dead round the
       players get blamed for — so re-deal and say why. */
    if (!validator.isPlayableRule(rule)) {
      const shown = rule.letters.map((l) => l.toUpperCase()).join(", ");
      beginRound({
        notice: notice(
          rule.mode === GAME_MODE.CONTAINS
            ? `No word contains ${shown} — new letters.`
            : `No English word runs from ${rule.start.toUpperCase()} to ${rule.end.toUpperCase()} — new letters.`,
          "info",
        ),
      });
      return;
    }

    const raceDurationMs = settings().raceDurationMs;
    const raceEndsAt = Date.now() + raceDurationMs;
    store.setMatch({
      phase: PHASE.RACE,
      rule,
      countdownEndsAt: null,
      raceEndsAt,
    });
    onChange();

    raceTimer = createDeadlineTimer({
      endsAt: raceEndsAt,
      durationMs: raceDurationMs,
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
      // fallback never waits on a download. The letter-hunt oracle needs it too.
      await dictionary.prepare();

      store.setMatch({
        roundNumber: 0,
        rotationIndex: 0,
        settings: settings(),
        scores: createScores(state.playerOrder),
        usedWords: [],
        result: null,
        notice: null,
      });
      beginRound();
    },

    /**
     * Records a committed letter. Advances to the countdown once everyone is in.
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

      // Observers have no letter to give. Enforced here rather than only in the
      // UI, because the UI is on a machine we do not control.
      const active = activePlayers();
      if (!active.includes(playerId)) {
        return { ok: false, reason: REJECTION.NOT_PLAYING };
      }

      const letter = normaliseLetter(rawLetter);
      if (!letter) return { ok: false, reason: REJECTION.NOT_ALPHA };

      // Idempotent: a duplicate commit for the same round is a no-op, not a
      // second letter.
      if (secretLetters.has(playerId)) return { ok: true };

      secretLetters.set(playerId, letter);
      store.setMatch({ committed: { ...state.match.committed, [playerId]: true } });
      onChange();

      if (active.every((id) => secretLetters.has(id))) beginCountdown();
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
      // Observers watch. Checked on the host, so a spectator cannot steal a
      // round by sending a word their own UI never offered them.
      if (!activePlayers().includes(submission.playerId)) {
        onRejection(submission.playerId, REJECTION.NOT_PLAYING);
        return;
      }
      queue.offer(submission);
    },

    /** Deals the next round. Only meaningful from RESULT. */
    nextRound() {
      if (store.getState().match.phase !== PHASE.RESULT) return;
      beginRound();
    },

    /** Zeroes scores and used words, then deals a fresh first round. */
    restartMatch() {
      clearTimers();
      const state = store.getState();
      store.setMatch({
        roundNumber: 0,
        rotationIndex: 0,
        settings: settings(),
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
        activeIds: [],
        rule: null,
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
        committedBy: [...secretLetters.keys()],
      };
    },
  };
}
