import { ROLE } from "../js/constants.js";

/**
 * One row in the player list.
 *
 * Rendered as a fresh element each time rather than mutated in place: with two
 * players and a handful of fields there is nothing to gain from diffing, and a
 * pure render function cannot drift out of sync with state.
 */

/**
 * Connection and readiness, expressed once so the lobby and the scoreboard
 * cannot disagree about what "waiting" looks like.
 *
 * @param {object} player
 * @returns {{tone: string, text: string}}
 */
function describeStatus(player) {
  if (!player.connected) return { tone: "gone", text: "Disconnected" };
  if (player.ready) return { tone: "live", text: "Ready" };
  return { tone: "waiting", text: "Not ready yet" };
}

/**
 * @param {{
 *   player: object|null,
 *   seatIndex: number,
 *   isLocal?: boolean,
 *   showScore?: boolean,
 *   score?: number
 * }} options
 * @returns {HTMLLIElement}
 */
export function renderPlayerCard({
  player,
  seatIndex,
  isLocal = false,
  showScore = false,
  score = 0,
}) {
  const row = document.createElement("li");
  // Seat 0 is Player A (pink), seat 1 is Player B (blue).
  row.className = seatIndex === 1 ? "player player--b" : "player";

  if (!player) {
    row.classList.add("player--vacant");
    row.innerHTML = `
      <span class="player__chip" aria-hidden="true">?</span>
      <span class="player__body">
        <span class="player__name">Waiting for a player</span>
        <span class="player__meta">Share the room code</span>
      </span>
    `;
    return row;
  }

  const status = describeStatus(player);
  const chip = document.createElement("span");
  chip.className = "player__chip";
  chip.setAttribute("aria-hidden", "true");
  chip.textContent = player.name.slice(0, 1);

  const body = document.createElement("span");
  body.className = "player__body";

  const name = document.createElement("span");
  name.className = "player__name";
  name.textContent = player.name;

  const meta = document.createElement("span");
  meta.className = "player__meta";

  const dot = document.createElement("span");
  dot.className = `dot dot--${status.tone}`;
  meta.append(dot, document.createTextNode(status.text));

  if (player.role === ROLE.HOST) {
    const host = document.createElement("span");
    host.className = "badge badge--host";
    host.textContent = "Host";
    meta.append(host);
  }
  if (isLocal) {
    const you = document.createElement("span");
    you.className = "badge badge--you";
    you.textContent = "You";
    meta.append(you);
  }

  body.append(name, meta);
  row.append(chip, body);

  if (showScore) {
    const points = document.createElement("span");
    points.className = "player__score";
    points.dataset.scoreFor = player.id;
    points.textContent = String(score);
    // The number alone is ambiguous to a screen reader out of context.
    points.setAttribute("aria-label", `${player.name}: ${score} points`);
    row.append(points);
  }

  return row;
}
