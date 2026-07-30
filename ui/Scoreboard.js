import { MAX_PLAYERS } from "../js/constants.js";
import { renderPlayerCard } from "./PlayerCard.js";

/**
 * The two players and their scores, above the board.
 *
 * Rows are rebuilt from state on every render, with one exception: when a score
 * goes up, the new number gets a bump animation. That needs the *previous*
 * value, so this view keeps a small map of what it last displayed. It is view
 * state — the authoritative tally lives in the store — but it is the reason the
 * scoreboard can celebrate a point instead of silently swapping a digit.
 *
 * @param {{root: HTMLElement}} deps
 */
export function createScoreboard({ root }) {
  /** @type {Map<string, number>} playerId → last rendered score */
  const lastShown = new Map();

  return {
    /** @param {object} state */
    render(state) {
      const list = document.createElement("ul");
      list.className = "stack stack--tight";

      /** @type {string[]} ids whose score just increased */
      const climbed = [];

      for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
        const id = state.playerOrder[seat];
        if (!id) continue;
        const score = state.match.scores[id] ?? 0;
        if (lastShown.has(id) && score > lastShown.get(id)) climbed.push(id);
        lastShown.set(id, score);

        list.append(
          renderPlayerCard({
            player: state.players[id],
            seatIndex: seat,
            isLocal: id === state.localPlayerId,
            showScore: true,
            score,
          }),
        );
      }

      root.replaceChildren(list);

      for (const id of climbed) {
        const node = list.querySelector(`[data-score-for="${id}"]`);
        node?.classList.add("is-scoring");
      }
    },

    /** Forgets displayed scores, so a restart does not animate a drop to zero. */
    reset() {
      lastShown.clear();
    },
  };
}
