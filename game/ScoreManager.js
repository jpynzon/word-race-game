import { POINTS_PER_ROUND_WIN } from "../js/constants.js";

/**
 * Scores, as pure transformations.
 *
 * Nothing here mutates or stores anything: each function takes a scores map and
 * returns a new one. The host holds the only scores map, in the store, and puts
 * it in every snapshot — so there is exactly one tally and no chance of two
 * screens disagreeing about it.
 */

/**
 * @param {string[]} playerIds
 * @returns {Record<string, number>} everyone on zero
 */
export function createScores(playerIds) {
  return Object.fromEntries(playerIds.map((id) => [id, 0]));
}

/**
 * @param {Record<string, number>} scores
 * @param {string} playerId
 * @param {number} [points]
 * @returns {Record<string, number>} a new map with the award applied
 */
export function awardPoint(scores, playerId, points = POINTS_PER_ROUND_WIN) {
  return { ...scores, [playerId]: (scores[playerId] ?? 0) + points };
}

/**
 * Ensures every seated player has an entry, without disturbing existing totals.
 * Called when someone joins mid-match so the scoreboard has no gaps.
 *
 * @param {Record<string, number>} scores
 * @param {string[]} playerIds
 * @returns {Record<string, number>}
 */
export function reconcileScores(scores, playerIds) {
  const next = {};
  for (const id of playerIds) next[id] = scores[id] ?? 0;
  return next;
}

/**
 * @param {Record<string, number>} scores
 * @returns {{leaderIds: string[], top: number, tied: boolean}}
 */
export function summarise(scores) {
  const entries = Object.entries(scores);
  if (entries.length === 0) return { leaderIds: [], top: 0, tied: false };

  const top = Math.max(...entries.map(([, points]) => points));
  const leaderIds = entries.filter(([, points]) => points === top).map(([id]) => id);
  return { leaderIds, top, tied: leaderIds.length > 1 };
}
