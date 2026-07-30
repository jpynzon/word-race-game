import {
  CONNECTION,
  FAILURE,
  MAX_PLAYERS,
  ROLE,
  SCREEN,
} from "../js/constants.js";
import { describeFailure } from "../js/messages.js";
import { createInitialMatch, createInitialState } from "../js/state.js";
import { createNetworkClient } from "../net/NetworkClient.js";
import { MSG } from "../net/Protocol.js";

/**
 * The orchestrator, and the authority.
 *
 * Authority model, which everything else depends on:
 *
 *   GUEST                          HOST
 *     intent   ───────────────▶     validate → mutate → broadcast
 *     render  ◀───────────────      full state snapshot
 *
 * A guest never mutates authoritative state. It sends intents and renders
 * whatever snapshot comes back. That is what makes "both players always see the
 * same game state" true by construction rather than by careful bookkeeping — a
 * guest has no local copy of the rules that could disagree.
 *
 * The cost is that the host is the server: when the host leaves, the room ends.
 * That is handled explicitly (see FAILURE.HOST_LEFT) rather than hidden.
 */

const PLAYER_ID_KEY = "wordrace.playerId";

/**
 * A stable identity for this tab that survives reload, so a reconnecting
 * player can reclaim their seat and score instead of arriving as a stranger.
 *
 * @returns {string}
 */
function resolveLocalPlayerId() {
  const existing = sessionStorage.getItem(PLAYER_ID_KEY);
  if (existing) return existing;
  const id =
    typeof crypto?.randomUUID === "function"
      ? `p-${crypto.randomUUID().slice(0, 8)}`
      : `p-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

/**
 * @param {{
 *   store: object,
 *   toaster: object,
 *   navigate: (screen: string) => void,
 *   createNetwork?: typeof createNetworkClient
 * }} deps
 */
export function createGameManager({
  store,
  toaster,
  navigate,
  createNetwork = createNetworkClient,
}) {
  /** @type {ReturnType<typeof createNetworkClient>|null} */
  let net = null;

  /* ---- Snapshots ------------------------------------------------------
     The snapshot is the authoritative slice only. Identity, role, and which
     screen you are looking at are local concerns and stay local — sending them
     would let the host move the guest's cursor, so to speak. */

  /** @returns {object} the authoritative slice of state */
  function buildSnapshot() {
    const state = store.getState();
    return {
      roomCode: state.roomCode,
      players: state.players,
      playerOrder: state.playerOrder,
      match: state.match,
    };
  }

  /** @param {object} snapshot */
  function applySnapshot(snapshot) {
    store.set({
      roomCode: snapshot.roomCode,
      players: snapshot.players,
      playerOrder: snapshot.playerOrder,
      match: snapshot.match,
    });
  }

  /** Host only. Pushes current state to the guest. */
  function broadcast() {
    if (!net || store.getState().role !== ROLE.HOST) return;
    net.send(MSG.SNAPSHOT, { state: buildSnapshot() });
  }

  /* ---- Failure --------------------------------------------------------- */

  /** @param {string} code a FAILURE value */
  function fail(code) {
    const copy = describeFailure(code);
    store.set({ connection: CONNECTION.CLOSED, failure: { code, ...copy } });
    navigate(SCREEN.ERROR);
  }

  /** Drops the network and returns the store to a clean pre-room state. */
  function teardown() {
    net?.close();
    net = null;
    const fresh = createInitialState();
    fresh.localPlayerId = resolveLocalPlayerId();
    store.replace(fresh);
  }

  /* ---- Host ------------------------------------------------------------ */

  /** @param {string} name */
  async function createRoom(name) {
    const localPlayerId = resolveLocalPlayerId();
    store.set({ connection: CONNECTION.CONNECTING, failure: null });

    net = createNetwork({ role: ROLE.HOST });

    let roomCode;
    try {
      ({ roomCode } = await net.hostRoom());
    } catch (error) {
      net?.close();
      net = null;
      fail(error.failure ?? FAILURE.BROKER_UNREACHABLE);
      return;
    }

    store.set({
      role: ROLE.HOST,
      roomCode,
      localPlayerId,
      connection: CONNECTION.WAITING,
      players: {
        [localPlayerId]: {
          id: localPlayerId,
          name,
          role: ROLE.HOST,
          connected: true,
          ready: false,
        },
      },
      playerOrder: [localPlayerId],
      match: createInitialMatch(),
    });

    registerHostHandlers();
    navigate(SCREEN.LOBBY);
  }

  function registerHostHandlers() {
    net.on(MSG.HELLO, (payload) => {
      const state = store.getState();

      // A returning player reclaims their seat rather than taking a new one.
      const isReturning = Boolean(state.players[payload.playerId]);
      if (!isReturning && state.playerOrder.length >= MAX_PLAYERS) {
        net.send(MSG.REJECT, { code: FAILURE.ROOM_FULL });
        return;
      }

      const player = {
        id: payload.playerId,
        name: payload.name,
        role: ROLE.GUEST,
        connected: true,
        ready: isReturning ? (state.players[payload.playerId].ready ?? false) : false,
      };

      store.set({
        connection: CONNECTION.CONNECTED,
        players: { ...state.players, [player.id]: player },
        playerOrder: isReturning
          ? state.playerOrder
          : [...state.playerOrder, player.id],
      });

      net.send(MSG.WELCOME, { playerId: player.id, state: buildSnapshot() });
      broadcast();
      toaster.show(
        isReturning ? `${player.name} is back.` : `${player.name} joined.`,
        { tone: "good" },
      );
    });

    net.on(MSG.READY, (payload, message) => {
      const state = store.getState();
      const guestId = state.playerOrder.find((id) => id !== state.localPlayerId);
      if (!guestId) return;
      setReady(guestId, payload.ready);
      void message;
    });

    net.on(MSG.LEAVE, () => {
      const state = store.getState();
      const guestId = state.playerOrder.find((id) => id !== state.localPlayerId);
      if (!guestId) return;
      const players = { ...state.players };
      const name = players[guestId]?.name ?? "Your opponent";
      delete players[guestId];
      store.set({
        players,
        playerOrder: state.playerOrder.filter((id) => id !== guestId),
        connection: CONNECTION.WAITING,
      });
      broadcast();
      toaster.show(`${name} left the room.`, { tone: "info" });
    });

    net.onLifecycle({
      close() {
        // The seat is kept, not cleared: the score and readiness belong to the
        // player, and Phase 5 lets them reclaim both on reconnect.
        const state = store.getState();
        const guestId = state.playerOrder.find((id) => id !== state.localPlayerId);
        if (!guestId || !state.players[guestId]) return;
        store.set({
          connection: CONNECTION.WAITING,
          players: {
            ...state.players,
            [guestId]: { ...state.players[guestId], connected: false, ready: false },
          },
        });
        toaster.show(`${state.players[guestId].name} dropped out.`, { tone: "bad" });
      },
      failure(code) {
        fail(code);
      },
    });
  }

  /* ---- Guest ----------------------------------------------------------- */

  /**
   * @param {string} roomCode
   * @param {string} name
   */
  async function joinRoom(roomCode, name) {
    const localPlayerId = resolveLocalPlayerId();
    store.set({
      connection: CONNECTION.CONNECTING,
      role: ROLE.GUEST,
      roomCode,
      localPlayerId,
      failure: null,
    });

    net = createNetwork({ role: ROLE.GUEST });

    try {
      await net.joinRoom(roomCode);
    } catch (error) {
      net?.close();
      net = null;
      fail(error.failure ?? FAILURE.ROOM_NOT_FOUND);
      return;
    }

    registerGuestHandlers();
    net.send(MSG.HELLO, { playerId: localPlayerId, name });
  }

  function registerGuestHandlers() {
    net.on(MSG.WELCOME, (payload) => {
      store.set({ connection: CONNECTION.CONNECTED, localPlayerId: payload.playerId });
      applySnapshot(payload.state);
      navigate(SCREEN.LOBBY);
    });

    net.on(MSG.SNAPSHOT, (payload) => {
      applySnapshot(payload.state);
    });

    net.on(MSG.REJECT, (payload) => {
      net?.close();
      net = null;
      fail(payload.code);
    });

    net.on(MSG.ROOM_CLOSED, (payload) => {
      net?.close();
      net = null;
      fail(payload.code);
    });

    net.onLifecycle({
      close() {
        // Reconnect handling arrives in Phase 5. Until then, losing the host is
        // stated plainly instead of leaving the player on a frozen board.
        if (!net) return;
        fail(FAILURE.HOST_LEFT);
      },
      failure(code) {
        fail(code);
      },
    });
  }

  /* ---- Shared intents -------------------------------------------------- */

  /**
   * Host-side readiness mutation. The guest reaches this by sending MSG.READY;
   * the host reaches it directly. Both paths converge here so there is one
   * implementation of the rule.
   *
   * @param {string} playerId
   * @param {boolean} ready
   */
  function setReady(playerId, ready) {
    const state = store.getState();
    const player = state.players[playerId];
    if (!player) return;
    store.set({
      players: { ...state.players, [playerId]: { ...player, ready } },
    });
    broadcast();
  }

  return {
    createRoom,
    joinRoom,

    /** Flips the local player's readiness, whichever side they are on. */
    toggleReady() {
      const state = store.getState();
      const local = state.players[state.localPlayerId];
      if (!local) return;
      if (state.role === ROLE.HOST) {
        setReady(local.id, !local.ready);
      } else {
        // Optimistic: the host's snapshot is authoritative and will correct this
        // if it disagrees, but the button should not feel laggy.
        store.set({
          players: { ...state.players, [local.id]: { ...local, ready: !local.ready } },
        });
        net?.send(MSG.READY, { ready: !local.ready });
      }
    },

    /** Placeholder until Phase 2 owns the round machine. */
    startGame() {
      toaster.show("The round machine lands in the next phase.", { tone: "info" });
    },

    leaveRoom() {
      const state = store.getState();
      if (state.role === ROLE.GUEST) net?.send(MSG.LEAVE, {});
      if (state.role === ROLE.HOST) net?.send(MSG.ROOM_CLOSED, { code: FAILURE.HOST_LEFT });
      teardown();
      navigate(SCREEN.HOME);
    },

    /** Called when the player dismisses a failure screen. */
    reset() {
      teardown();
      navigate(SCREEN.HOME);
    },

    /** @returns {object|null} network counters, for end-to-end verification */
    diagnostics() {
      return net?.diagnostics() ?? null;
    },
  };
}
