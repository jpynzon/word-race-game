import { CONNECTION, ROLE } from "../js/constants.js";
import { selectEveryoneReady, selectLocalPlayer } from "../js/state.js";
import { renderPlayerCard } from "../ui/PlayerCard.js";
import { canStart, capacityFor } from "./GameSettings.js";

/**
 * Renders the lobby: room code, both seats, and whatever the local player is
 * allowed to do next.
 *
 * The lobby is a pure function of state. It never stores anything of its own,
 * so a snapshot arriving from the host produces exactly the same lobby on both
 * screens without any reconciliation.
 *
 * @param {{
 *   store: object,
 *   dom: {code: HTMLElement, players: HTMLElement, actions: HTMLElement, hint: HTMLElement},
 *   actions: {
 *     toggleReady: () => void,
 *     startGame: () => void,
 *     leaveRoom: () => void
 *   }
 * }} deps
 */
export function createLobbyManager({ store, dom, actions }) {
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
    for (let seat = 0; seat < seats; seat += 1) {
      const id = state.playerOrder[seat];
      dom.players.append(
        renderPlayerCard({
          player: id ? state.players[id] : null,
          seatIndex: seat,
          isLocal: id === state.localPlayerId,
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

  function renderActions(state) {
    dom.actions.replaceChildren();
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

    dom.actions.append(
      button("Leave", { variant: "btn--quiet", onClick: actions.leaveRoom }),
    );
  }

  /**
   * One sentence naming what the room is waiting on. Always says whose move it
   * is, because "waiting" without a subject is the least useful status there is.
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
      dom.hint.textContent = `Waiting on ${waitingOn.join(" and ")}.`;
      return;
    }
    dom.hint.textContent = isHost
      ? "Both ready — start whenever you like."
      : "Both ready. The host starts the match.";
  }

  return {
    /** @param {object} state */
    render(state) {
      renderCode(state.roomCode);
      renderPlayers(state);
      renderActions(state);
      renderHint(state);
    },
  };
}
