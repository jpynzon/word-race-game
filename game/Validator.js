import { GAME_MODE, MAX_WORD_LENGTH, MIN_WORD_LENGTH, REJECTION } from "../js/constants.js";

/**
 * The game's rules about a word, separate from the question of whether the word
 * exists.
 *
 * Everything here is synchronous and pure. That separation is deliberate: rules
 * are cheap, certain and testable, while dictionary lookups are slow, remote
 * and fallible. Checking rules first means a word with the wrong letters never
 * costs a network round trip, which matters when a race is decided in
 * milliseconds.
 *
 * Returns a typed reason code, never a sentence — messages.js owns the English.
 */

/**
 * The rule a round is asking players to satisfy.
 *
 * @typedef {object} RoundRule
 * @property {string} mode one of GAME_MODE
 * @property {string} [start] DUEL: required first letter
 * @property {string} [end] DUEL: required last letter
 * @property {string[]} [letters] CONTAINS: every letter that must appear
 * @property {number} minWordLength
 * @property {string[]} usedWords lowercase words already spent this match
 */

/**
 * Checks a word against a round's rule.
 *
 * @param {string} rawWord what the player typed
 * @param {RoundRule} rule
 * @returns {{ok: true, word: string} | {ok: false, reason: string}}
 */
export function checkWordRules(rawWord, rule) {
  const word = String(rawWord ?? "").trim().toLowerCase();
  const floor = Math.max(MIN_WORD_LENGTH, rule.minWordLength ?? MIN_WORD_LENGTH);

  if (word.length < floor) return { ok: false, reason: REJECTION.TOO_SHORT };
  if (word.length > MAX_WORD_LENGTH) return { ok: false, reason: REJECTION.TOO_LONG };

  // Letters only. Rejecting hyphens and apostrophes keeps "first letter" and
  // "last letter" unambiguous, which the duel rests on.
  if (!/^[a-z]+$/.test(word)) return { ok: false, reason: REJECTION.NOT_ALPHA };

  if (rule.mode === GAME_MODE.CONTAINS) {
    if (!containsAllLetters(word, rule.letters ?? [])) {
      return { ok: false, reason: REJECTION.MISSING_LETTERS };
    }
  } else {
    if (word[0] !== String(rule.start).toLowerCase()) {
      return { ok: false, reason: REJECTION.WRONG_START };
    }
    if (word[word.length - 1] !== String(rule.end).toLowerCase()) {
      return { ok: false, reason: REJECTION.WRONG_END };
    }
  }

  if ((rule.usedWords ?? []).includes(word)) {
    return { ok: false, reason: REJECTION.ALREADY_USED };
  }

  return { ok: true, word };
}

/**
 * Whether a word contains every required letter.
 *
 * Set semantics, not multiset: each *distinct* required letter must appear at
 * least once, and two players picking E does not demand two E's. With four
 * letters to satisfy the mode is hard enough already, and "your word needs two
 * E's because we both picked E" is a rule nobody would guess from the
 * instructions.
 *
 * @param {string} word lowercase
 * @param {string[]} letters required letters
 * @returns {boolean}
 */
export function containsAllLetters(word, letters) {
  const present = new Set(word);
  return letters.every((letter) => present.has(String(letter).toLowerCase()));
}

/**
 * Normalises a single committed letter.
 *
 * @param {string} rawLetter
 * @returns {string|null} a lowercase a-z letter, or null if unusable
 */
export function normaliseLetter(rawLetter) {
  const letter = String(rawLetter ?? "").trim().toLowerCase();
  return /^[a-z]$/.test(letter) ? letter : null;
}

/**
 * Builds the full validator, binding the rule check to a dictionary.
 *
 * @param {{dictionary: {lookup: Function, hasBridge: Function, hasWordContaining: Function}}} deps
 */
export function createValidator({ dictionary }) {
  return {
    /** Synchronous rules only. @see checkWordRules */
    checkRules: checkWordRules,

    /**
     * Full validation: rules first, then existence.
     *
     * @param {string} rawWord
     * @param {RoundRule} rule
     * @returns {Promise<{ok: true, word: string, source: string} | {ok: false, reason: string, word: string}>}
     */
    async validate(rawWord, rule) {
      const rules = checkWordRules(rawWord, rule);
      if (!rules.ok) {
        return {
          ok: false,
          reason: rules.reason,
          word: String(rawWord ?? "").trim().toLowerCase(),
        };
      }

      const { exists, source } = await dictionary.lookup(rules.word);
      if (!exists) return { ok: false, reason: REJECTION.NOT_A_WORD, word: rules.word };
      return { ok: true, word: rules.word, source };
    },

    /**
     * Whether a round's rule is satisfiable at all.
     *
     * Both modes can deal an impossible hand — 90 letter pairs have no English
     * word, and four random letters frequently share no word either. Asking
     * before the clock starts is what lets the game re-deal instead of running
     * a timer nobody could beat.
     *
     * @param {RoundRule} rule
     * @returns {boolean} false only when we positively know it is unplayable
     */
    isPlayableRule(rule) {
      if (rule.mode === GAME_MODE.CONTAINS) {
        return dictionary.hasWordContaining(rule.letters ?? [], rule.minWordLength ?? 2);
      }
      return dictionary.hasBridge(
        String(rule.start).toLowerCase(),
        String(rule.end).toLowerCase(),
      );
    },
  };
}
