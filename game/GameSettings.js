import {
  DEFAULT_SETTINGS,
  GAME_MODE,
  MIN_WORD_LENGTH_BOUNDS,
  MODE_CAPACITY,
  RACE_DURATION_BOUNDS_MS,
} from "../js/constants.js";

/**
 * Match settings: the mode, how long the race runs, and how short a word may be.
 *
 * The host edits these in the lobby and they ride in the snapshot, so every
 * player sees the same rules before the first letter is picked.
 *
 * Everything arriving from the network is clamped rather than trusted. A guest
 * receiving `raceDurationMs: 0` from a buggy or hostile host would otherwise get
 * a race that ends before it starts, and `minWordLength: 1` would break the
 * two-letter floor the game is built on.
 */

/** @returns {object} a fresh settings object at defaults */
export function createSettings() {
  return { ...DEFAULT_SETTINGS };
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The number of letters a mode collects.
 *
 * CONTAINS takes one per seated player. DUEL and ROUND_ROBIN always take two,
 * however many people are in the room — round robin seats four but only two
 * duel per round.
 *
 * @param {string} mode
 * @param {number} playerCount
 * @returns {number}
 */
export function requiredLetterCount(mode, playerCount) {
  return mode === GAME_MODE.CONTAINS ? Math.max(2, playerCount) : 2;
}

/**
 * The shortest word that could satisfy a mode.
 *
 * In CONTAINS mode a word has to fit every player's letter, so with four
 * players nothing under four letters can ever be valid. Allowing the host to
 * set a lower minimum would advertise a rule the dictionary can never satisfy,
 * so the floor rises with the seat count.
 *
 * @param {string} mode
 * @param {number} playerCount
 * @returns {number}
 */
export function minimumViableWordLength(mode, playerCount) {
  return Math.max(MIN_WORD_LENGTH_BOUNDS.min, requiredLetterCount(mode, playerCount));
}

/**
 * Normalises settings, clamping every field into range.
 *
 * @param {object} raw candidate settings, possibly from the network
 * @param {number} [playerCount] seats currently filled, used for the length floor
 * @returns {object} settings safe to act on
 */
export function normaliseSettings(raw, playerCount = 2) {
  const source = raw && typeof raw === "object" ? raw : {};

  const mode = Object.values(GAME_MODE).includes(source.mode)
    ? source.mode
    : DEFAULT_SETTINGS.mode;

  const floor = minimumViableWordLength(mode, playerCount);

  return {
    mode,
    raceDurationMs: clampInt(
      source.raceDurationMs,
      RACE_DURATION_BOUNDS_MS.min,
      RACE_DURATION_BOUNDS_MS.max,
      DEFAULT_SETTINGS.raceDurationMs,
    ),
    minWordLength: clampInt(
      source.minWordLength,
      floor,
      MIN_WORD_LENGTH_BOUNDS.max,
      Math.max(floor, DEFAULT_SETTINGS.minWordLength),
    ),
  };
}

/**
 * @param {string} mode
 * @returns {{min: number, max: number}} seat range for the mode
 */
export function capacityFor(mode) {
  return MODE_CAPACITY[mode] ?? MODE_CAPACITY[GAME_MODE.DUEL];
}

/**
 * Whether a match can start with this many players.
 *
 * @param {string} mode
 * @param {number} playerCount
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function canStart(mode, playerCount) {
  const { min, max } = capacityFor(mode);
  if (playerCount < min) {
    const needed = min - playerCount;
    const subject = mode === GAME_MODE.DUEL ? "A duel" : "This mode";
    return {
      ok: false,
      message: `${subject} needs ${min} players — ${needed} more to go.`,
    };
  }
  if (playerCount > max) {
    return { ok: false, message: `This mode is capped at ${max} players.` };
  }
  return { ok: true };
}

/**
 * Human-readable summary of the rule a mode produces. Used in the lobby so
 * players know what they are agreeing to before the match starts.
 *
 * @param {string} mode
 * @returns {{name: string, rule: string}}
 */
export function describeMode(mode) {
  if (mode === GAME_MODE.CONTAINS) {
    return {
      name: "Letter hunt",
      rule: "Everyone picks a letter. Your word has to contain all of them, anywhere.",
    };
  }
  if (mode === GAME_MODE.ROUND_ROBIN) {
    return {
      name: "Round robin",
      rule: "Two duel each round while everyone else watches. Pairings rotate until everyone has faced everyone.",
    };
  }
  return {
    name: "Duel",
    rule: "One letter each. Your word starts with the first and ends with the second.",
  };
}

/**
 * @param {number} ms
 * @returns {string} e.g. "30s", "1m 30s"
 */
export function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
