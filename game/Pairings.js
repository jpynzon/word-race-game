/**
 * Round-robin pairings.
 *
 * In round-robin mode two players duel each round while everyone else watches,
 * and the pairing rotates so that eventually everyone faces everyone.
 *
 * The obvious way to enumerate pairs is a nested loop:
 *
 *     for (i) for (j > i) pairs.push([i, j])      // unfair
 *
 * It produces every pairing exactly once, but the order is badly lopsided. With
 * four players it deals 0-1, 0-2, 0-3, 1-2, 1-3, 2-3 — so player 0 duels three
 * rounds back to back and then sits out three. Nobody wants to be player 3,
 * watching the first three rounds of every cycle.
 *
 * So this uses the **circle method** instead: fix one player, rotate the rest,
 * and read off pairs from opposite ends each turn. Every pairing still appears
 * exactly once, but consecutive duels involve different people — with four
 * players each adjacent pair of duels covers all four, so nobody waits long.
 *
 * An odd roster gets a bye seat. Whoever draws the bye simply has no duel that
 * turn, which is what gives three players a clean three-pairing cycle.
 */

const BYE = Symbol("bye");

/**
 * Every pairing exactly once, ordered so participation is spread evenly.
 *
 * @param {string[]} playerIds seated players, in seat order
 * @returns {[string, string][]} pairings, in rotation order
 */
export function buildRoundRobinSchedule(playerIds) {
  const ids = [...playerIds];
  if (ids.length < 2) return [];
  if (ids.length === 2) return [[ids[0], ids[1]]];

  // An odd count needs a phantom seat so the circle has something to pair
  // against; that player rests for the turn.
  if (ids.length % 2 === 1) ids.push(BYE);

  const size = ids.length;
  /** @type {[string, string][]} */
  const schedule = [];
  let circle = [...ids];

  for (let turn = 0; turn < size - 1; turn += 1) {
    for (let i = 0; i < size / 2; i += 1) {
      const a = circle[i];
      const b = circle[size - 1 - i];
      if (a !== BYE && b !== BYE) schedule.push([a, b]);
    }
    // Rotate everything except the first seat.
    circle = [circle[0], circle[size - 1], ...circle.slice(1, size - 1)];
  }

  return schedule;
}

/**
 * The pairing for a given round.
 *
 * The schedule is derived from the current roster rather than stored, so a
 * player joining or leaving reshapes the rotation on the next round instead of
 * leaving stale pairings pointing at someone who left.
 *
 * @param {string[]} playerIds seated players, in seat order
 * @param {number} rotationIndex how many round-robin rounds have been dealt
 * @returns {{aId: string, bId: string, cycleLength: number, cyclePosition: number}|null}
 */
export function pairingForRound(playerIds, rotationIndex) {
  const schedule = buildRoundRobinSchedule(playerIds);
  if (schedule.length === 0) return null;

  const cyclePosition = ((rotationIndex % schedule.length) + schedule.length) % schedule.length;
  const [aId, bId] = schedule[cyclePosition];
  return { aId, bId, cycleLength: schedule.length, cyclePosition };
}

/**
 * A human-readable description of where the rotation stands, for the lobby and
 * the board. Says who is up and how far through the cycle we are, because
 * "round 4" means nothing without knowing the cycle is six long.
 *
 * @param {object} players id → player record
 * @param {{aId: string, bId: string, cycleLength: number, cyclePosition: number}} pairing
 * @returns {string}
 */
export function describePairing(players, pairing) {
  const a = players[pairing.aId]?.name ?? "someone";
  const b = players[pairing.bId]?.name ?? "someone";
  return `${a} vs ${b} · duel ${pairing.cyclePosition + 1} of ${pairing.cycleLength}`;
}
