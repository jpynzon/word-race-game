import { CONNECTION, ROLE } from "../js/constants.js";
import { selectEveryoneReady, selectLocalPlayer } from "../js/state.js";
import { renderPlayerCard } from "../ui/PlayerCard.js";
import { canStart, capacityFor } from "./GameSettings.js";

/** "Ada", "Ada and Bee", "Ada, Bee and Kwame" — up to five of them in a room. */
const NAME_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** @param {string[]} names @returns {string} */
function listNames(names) {
  return NAME_LIST.format(names);
}

/**
 * Renders the lobby: room code, every seat, and whatever the local player is
 * allowed to do next.
 *
 * The lobby is a pure function of state, with one exception: which row is
 * currently asking "remove this player?" is view state and lives here. It is
 * nobody else's business — least of all the other players' — and a card is
 * rebuilt on every snapshot, so it could not survive on the card itself.
 *
 * @param {{
 *   store: object,
 *   dom: {
 *     code: HTMLElement, players: HTMLElement,
 *     actions: HTMLElement, exit: HTMLElement, hint: HTMLElement
 *   },
 *   actions: {
 *     toggleReady: () => void,
 *     startGame: () => void,
 *     leaveRoom: () => void,
 *     kickPlayer: (playerId: string) => void
 *   }
 * }} deps
 */
export function createLobbyManager({ store, dom, actions }) {
  /** Which seat is mid-confirmation, if any. @type {string|null} */
  let pendingKickId = null;

  /** @param {string|null} playerId */
  function askToRemove(playerId) {
    pendingKickId = playerId;
    // Re-render from the store rather than patching the row: the ask is part of
    // the lobby's rendering now, and there is exactly one function that does it.
    render(store.getState());
  }

  /** Renders the code as separate tilted digit tiles. */
  function renderCode(roomCode) {
    dom.code.replaceChildren();
    for (const digit of String(roomCode ?? "").padEnd(4, "·")) {
      const cell = document.createElement("span");
      cell.className = "code__digit";
      cell.textContent = digit;
      dom.code.append(cell);
    }
    dom.code.setAttribute(
      "aria-label",
      `Room code: ${String(roomCode ?? "").split("").join(" ")}`,
    );
  }

  /**
   * One row per seat the current mode allows, so the empty rows tell you how
   * many more players the room is waiting for.
   */
  function renderPlayers(state) {
    dom.players.replaceChildren();
    const seats = capacityFor(state.match.settings.mode).max;
    // Past four seats the roster is taller than a phone screen, so the rows
    // tighten to keep the rules and the action bar within reach.
    dom.players.classList.toggle("roster--dense", seats > 4);

    // Only the host may remove anyone, and never themselves — the host leaving
    // ends the room, which is a different decision with its own button.
    const isHost = state.role === ROLE.HOST;

    for (let seat = 0; seat < seats; seat += 1) {
      const id = state.playerOrder[seat];
      const removable = isHost && Boolean(id) && id !== state.localPlayerId;
      dom.players.append(
        renderPlayerCard({
          player: id ? state.players[id] : null,
          seatIndex: seat,
          isLocal: id === state.localPlayerId,
          kick: removable
            ? {
                pending: pendingKickId === id,
                onAsk: () => askToRemove(id),
                onCancel: () => askToRemove(null),
                onConfirm: () => {
                  pendingKickId = null;
                  actions.kickPlayer(id);
                },
              }
            : null,
        }),
      );
    }
  }

  /** @returns {HTMLButtonElement} */
  function button(label, { variant = "", onClick, disabled = false }) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = variant ? `btn ${variant}` : "btn";
    node.textContent = label;
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }

  /**
   * Ready and start go in the main row; leave goes in its own row underneath.
   * Leaving cannot be undone — the room does not come back — so it is kept out
   * of thumb range of the button every player taps.
   */
  function renderActions(state) {
    dom.actions.replaceChildren();
    dom.exit.replaceChildren();
    const local = selectLocalPlayer(state);
    if (!local) return;

    const isHost = local.role === ROLE.HOST;
    const enoughPlayers = canStart(
      state.match.settings.mode,
      state.playerOrder.length,
    ).ok;
    const everyoneReady = selectEveryoneReady(state);

    dom.actions.append(
      button(local.ready ? "Not ready" : "I'm ready", {
        variant: local.ready ? "" : "btn--mint",
        onClick: actions.toggleReady,
      }),
    );

    if (isHost) {
      dom.actions.append(
        button("Start the match", {
          variant: "btn--primary",
          disabled: !enoughPlayers || !everyoneReady,
          onClick: actions.startGame,
        }),
      );
    }

    dom.exit.append(
      button("Leave the room", { variant: "btn--quiet", onClick: actions.leaveRoom }),
    );
  }

  /**
   * One sentence naming what the room is waiting on. Always says whose move it
   * is, because "waiting" without a subject is the least useful status there is.
   *
   * It sits in the sticky bar, on screen the whole time a player is in the
   * lobby, so it is worded for a full room rather than the two-player one the
   * game started out as.
   */
  function renderHint(state) {
    const local = selectLocalPlayer(state);
    const isHost = local?.role === ROLE.HOST;
    const seatCheck = canStart(state.match.settings.mode, state.playerOrder.length);

    if (state.connection === CONNECTION.CONNECTING) {
      dom.hint.textContent = "Connecting…";
      return;
    }
    if (!seatCheck.ok) {
      // canStart() already phrases how many more players are needed; the host
      // additionally gets told what to do about it.
      dom.hint.textContent = isHost
        ? `${seatCheck.message} Send the code or the invite link.`
        : seatCheck.message;
      return;
    }
    if (!selectEveryoneReady(state)) {
      const waitingOn = state.playerOrder
        .map((id) => state.players[id])
        .filter((player) => player && !player.ready)
        .map((player) => (player.id === state.localPlayerId ? "you" : player.name));
      dom.hint.textContent = `Waiting on ${listNames(waitingOn)}.`;
      return;
    }
    dom.hint.textContent = isHost
      ? "Everyone's ready — start whenever you like."
      : "Everyone's ready. The host starts the match.";
  }

  /** @param {object} state */
  function render(state) {
    // A player who left, or was removed, cannot still be mid-question.
    if (pendingKickId && !state.players[pendingKickId]) pendingKickId = null;

    renderCode(state.roomCode);
    renderPlayers(state);
    renderActions(state);
    renderHint(state);
  }

  return { render };
}
