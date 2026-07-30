import {
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
  REJECTION,
} from "../js/constants.js";

/**
 * The game's rules about a word, separate from the question of whether the word
 * exists.
 *
 * Everything here is synchronous and pure. That separation is deliberate: rules
 * are cheap, certain and testable, while dictionary lookups are slow, remote
 * and fallible. Checking rules first means a word with the wrong first letter
 * never costs a network round trip, which matters when a race is being decided
 * in milliseconds.
 *
 * Returns a typed reason code, never a sentence — messages.js owns the English.
 */

/**
 * @param {string} rawWord what the player typed
 * @param {{start: string, end: string, usedWords: string[]}} round
 * @returns {{ok: true, word: string} | {ok: false, reason: string}}
 */
export function checkWordRules(rawWord, { start, end, usedWords }) {
  const word = String(rawWord ?? "").trim().toLowerCase();

  if (word.length < MIN_WORD_LENGTH) return { ok: false, reason: REJECTION.TOO_SHORT };
  if (word.length > MAX_WORD_LENGTH) return { ok: false, reason: REJECTION.TOO_LONG };

  // Letters only. Rejecting hyphens and apostrophes keeps "first letter" and
  // "last letter" unambiguous, which the whole game rests on.
  if (!/^[a-z]+$/.test(word)) return { ok: false, reason: REJECTION.NOT_ALPHA };

  if (word[0] !== String(start).toLowerCase()) {
    return { ok: false, reason: REJECTION.WRONG_START };
  }
  if (word[word.length - 1] !== String(end).toLowerCase()) {
    return { ok: false, reason: REJECTION.WRONG_END };
  }

  if (usedWords.includes(word)) return { ok: false, reason: REJECTION.ALREADY_USED };

  return { ok: true, word };
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
 * @param {{dictionary: {lookup: Function, hasBridge: Function}}} deps
 */
export function createValidator({ dictionary }) {
  return {
    /** Synchronous rules only. @see checkWordRules */
    checkRules: checkWordRules,

    /**
     * Full validation: rules first, then existence.
     *
     * @param {string} rawWord
     * @param {{start: string, end: string, usedWords: string[]}} round
     * @returns {Promise<{ok: true, word: string, source: string} | {ok: false, reason: string, word: string}>}
     */
    async validate(rawWord, round) {
      const rules = checkWordRules(rawWord, round);
      if (!rules.ok) {
        return { ok: false, reason: rules.reason, word: String(rawWord ?? "").trim().toLowerCase() };
      }

      const { exists, source } = await dictionary.lookup(rules.word);
      if (!exists) {
        return { ok: false, reason: REJECTION.NOT_A_WORD, word: rules.word };
      }
      return { ok: true, word: rules.word, source };
    },

    /**
     * @param {string} start
     * @param {string} end
     * @returns {boolean} whether any word can bridge this pair
     */
    isPlayablePair(start, end) {
      return dictionary.hasBridge(
        String(start).toLowerCase(),
        String(end).toLowerCase(),
      );
    },
  };
}
