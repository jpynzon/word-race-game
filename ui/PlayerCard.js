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
 *   score?: number,
 *   turnStatus?: "duelling"|"watching"|null,
 *   kick?: {
 *     pending: boolean,
 *     onAsk: () => void,
 *     onConfirm: () => void,
 *     onCancel: () => void
 *   }|null
 * }} options `turnStatus` is about this round (named apart from the connection
 *   status below), and is only passed when some players are benched — a mode
 *   where everyone plays should not label everybody redundantly.
 *
 *   `kick` is passed only for rows the host may remove. Removal is a two-tap
 *   gesture: whether this row is mid-ask is `pending`, and the caller owns that
 *   state, because a card is rebuilt from scratch on every snapshot.
 * @returns {HTMLLIElement}
 */
export function renderPlayerCard({
  player,
  seatIndex,
  isLocal = false,
  showScore = false,
  score = 0,
  turnStatus = null,
  kick = null,
}) {
  const row = document.createElement("li");
  // Seat colour is positional: pink, blue, mint, tangerine.
  row.className = `player player--seat-${seatIndex}`;

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
  // Only worth saying when it is the slower path; "direct" is the unremarkable
  // default and labelling it would just be noise.
  if (player.via === "relay") {
    const via = document.createElement("span");
    via.className = "badge badge--relay";
    via.textContent = "Relay";
    via.title = "Connected through a relay because a direct connection was blocked";
    meta.append(via);
  }
  if (isLocal) {
    const you = document.createElement("span");
    you.className = "badge badge--you";
    you.textContent = "You";
    meta.append(you);
  }
  if (turnStatus) {
    const tag = document.createElement("span");
    tag.className = turnStatus === "duelling" ? "badge badge--duelling" : "badge";
    tag.textContent = turnStatus === "duelling" ? "Duelling" : "Watching";
    meta.append(tag);
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

  if (kick) row.append(renderKickControl(player, kick));

  return row;
}

/**
 * The host's remove control: an × that turns into a yes/no pair rather than
 * acting on the first tap. Removing somebody cannot be undone from their side —
 * they land on an error screen and have to be invited back — so it does not
 * happen on a single mis-tap next to the ready button.
 *
 * @param {object} player
 * @param {{pending: boolean, onAsk: Function, onConfirm: Function, onCancel: Function}} kick
 * @returns {HTMLSpanElement}
 */
function renderKickControl(player, kick) {
  const wrap = document.createElement("span");
  wrap.className = "player__kick";

  /** @param {string} label @param {string} className @param {Function} onClick */
  const control = (label, className, onClick, ariaLabel) => {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
    node.addEventListener("click", onClick);
    return node;
  };

  if (!kick.pending) {
    wrap.append(
      control("×", "kick", () => kick.onAsk(), `Remove ${player.name} from the room`),
    );
    return wrap;
  }

  wrap.classList.add("player__kick--asking");
  wrap.append(
    control("Remove", "kick kick--yes", () => kick.onConfirm(), `Remove ${player.name}`),
    control("Keep", "kick kick--no", () => kick.onCancel(), `Keep ${player.name}`),
  );
  return wrap;
}
