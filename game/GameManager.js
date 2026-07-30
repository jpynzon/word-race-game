import {
  CONNECTION,
  FAILURE,
  HELLO_TIMEOUT_MS,
  MAX_PLAYERS,
  PHASE,
  ROLE,
  SCREEN,
} from "../js/constants.js";
import { describeFailure } from "../js/messages.js";
import { createInitialMatch, createInitialState } from "../js/state.js";
import { createNetworkClient } from "../net/NetworkClient.js";
import { MSG } from "../net/Protocol.js";
import { createDictionaryService } from "../dict/DictionaryService.js";
import { createRoundManager } from "./RoundManager.js";
import { createValidator } from "./Validator.js";

/**
 * The orchestrator, and the authority.
 *
 *   GUEST                          HOST
 *     intent   ───────────────▶     validate → mutate → broadcast
 *     render  ◀───────────────      full state snapshot
 *
 * A guest never mutates authoritative state. It sends intents and renders
 * whatever snapshot comes back. That is what makes "both players always see the
 * same game state" true by construction rather than by careful bookkeeping — a
 * guest holds no copy of the rules that could disagree.
 *
 * The cost is that the host is the server: when the host leaves, the room ends.
 * That is handled explicitly (FAILURE.HOST_LEFT), not hidden.
 *
 * Only the host builds a RoundManager and a DictionaryService. A guest asking
 * the dictionary independently could get a different answer from a flaky API and
 * desync the match, so there is exactly one asker.
 */

/**
 * @param {{
 *   store: object,
 *   toaster: object,
 *   navigate: (screen: string) => void,
 *   onWordRejected: (reason: string) => void,
 *   profile: object,
 *   createNetwork?: typeof createNetworkClient
 * }} deps
 */
export function createGameManager({
  store,
  toaster,
  navigate,
  onWordRejected,
  profile,
  createNetwork = createNetworkClient,
}) {
  /** Identity comes from the durable profile. @see js/profile.js */
  const resolveLocalPlayerId = () => profile.playerId();
  /** @type {ReturnType<typeof createNetworkClient>|null} */
  let net = null;
  /** @type {ReturnType<typeof createRoundManager>|null} */
  let round = null;
  /** @type {ReturnType<typeof createDictionaryService>|null} */
  let dictionary = null;

  /* ---- Snapshots ------------------------------------------------------
     The authoritative slice only. Identity, role and which screen you are
     looking at stay local — publishing them would let the host move the guest's
     cursor, so to speak.

     Note what is absent: committed letters. `match.committed` carries booleans,
     never the letters themselves, so a guest cannot read their opponent's letter
     out of the snapshot before the reveal. */

  /** @returns {object} */
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

  /** @returns {string|undefined} the other seat's id */
  function guestId() {
    const state = store.getState();
    return state.playerOrder.find((id) => id !== state.localPlayerId);
  }

  /* ---- Host-side round machine ----------------------------------------- */

  function ensureRoundMachine() {
    if (round) return round;
    dictionary = createDictionaryService();
    const validator = createValidator({ dictionary });
    round = createRoundManager({
      store,
      validator,
      dictionary,
      onChange: broadcast,
      onRejection(playerId, reason) {
        // Routed to whoever submitted, and only to them: the opponent has no
        // business learning what you tried.
        if (playerId === store.getState().localPlayerId) onWordRejected(reason);
        else net?.send(MSG.WORD_REJECTED, { reason });
      },
    });
    return round;
  }

  /* ---- Failure --------------------------------------------------------- */

  /** @param {string} code a FAILURE value */
  function fail(code) {
    const copy = describeFailure(code);
    round?.stop();
    store.set({ connection: CONNECTION.CLOSED, failure: { code, ...copy } });
    navigate(SCREEN.ERROR);
  }

  /** Drops the network and returns the store to a clean pre-room state. */
  function teardown() {
    round?.stop();
    round = null;
    dictionary = null;
    net?.close();
    net = null;
    const fresh = createInitialState();
    fresh.localPlayerId = resolveLocalPlayerId();
    store.replace(fresh);
  }

  /* ---- Host ------------------------------------------------------------ */

  /** @param {string} name */
  async function createRoom(rawName) {
    // Committing to a room is the moment the name is worth keeping.
    const name = profile.rememberName(rawName);
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
    /* A connection that opens but never says HELLO must not hold the guest seat.
       This happens for real: the data channel can open on our side while the
       joining player's side never finishes negotiating, and the half-open
       connection still answers heartbeats, so it looks perfectly healthy. Left
       alone it occupies the only seat and every genuine reconnect is refused as
       "room full". */
    let helloDeadline = null;

    function armHelloDeadline() {
      clearTimeout(helloDeadline);
      helloDeadline = setTimeout(() => {
        const id = guestId();
        const identified = id && store.getState().players[id]?.connected;
        if (!identified) net?.dropPeer();
      }, HELLO_TIMEOUT_MS);
    }

    net.on(MSG.HELLO, (payload) => {
      clearTimeout(helloDeadline);
      const state = store.getState();

      /* Two tabs of one browser share a localStorage profile, so a guest can
         arrive carrying the host's own id. Left alone the host would read that
         as itself reconnecting and both players would collapse into one seat.
         The host is the authority on identity, so it renames the guest and
         returns the assigned id in WELCOME. */
      let assignedId = payload.playerId;
      if (assignedId === state.localPlayerId) assignedId = `${assignedId}-2`;

      // A returning player reclaims their seat rather than taking a new one.
      const isReturning = Boolean(state.players[assignedId]);
      if (!isReturning && state.playerOrder.length >= MAX_PLAYERS) {
        net.send(MSG.REJECT, { code: FAILURE.ROOM_FULL });
        return;
      }

      const player = {
        id: assignedId,
        name: payload.name,
        role: ROLE.GUEST,
        connected: true,
        // Readiness and score survive a reconnect; the seat belongs to the player.
        ready: isReturning ? (state.players[assignedId].ready ?? false) : false,
      };

      store.set({
        connection: CONNECTION.CONNECTED,
        players: { ...state.players, [player.id]: player },
        playerOrder: isReturning ? state.playerOrder : [...state.playerOrder, player.id],
      });

      net.send(MSG.WELCOME, { playerId: player.id, state: buildSnapshot() });
      broadcast();
      toaster.show(isReturning ? `${player.name} is back.` : `${player.name} joined.`, {
        tone: "good",
      });
    });

    net.on(MSG.READY, (payload) => {
      const id = guestId();
      if (id) setReady(id, payload.ready);
    });

    net.on(MSG.LETTER, (payload) => {
      const id = guestId();
      if (!id || !round) return;
      // The letter goes into RoundManager's private map, never into state.
      round.submitLetter(id, payload.letter);
    });

    net.on(MSG.WORD, (payload) => {
      const id = guestId();
      if (!id || !round) return;
      round.submitWord({
        playerId: id,
        word: payload.word,
        // Convert the guest's clock into ours before anything compares times.
        correctedTime: net.toLocalTime(payload.clientTime),
        roundId: payload.roundId,
      });
    });

    net.on(MSG.LEAVE, () => {
      const state = store.getState();
      const id = guestId();
      if (!id) return;
      const players = { ...state.players };
      const name = players[id]?.name ?? "Your opponent";
      delete players[id];
      store.set({
        players,
        playerOrder: state.playerOrder.filter((pid) => pid !== id),
        connection: CONNECTION.WAITING,
      });
      // No opponent means no race. Park everyone in the lobby.
      round?.returnToLobby();
      broadcast();
      toaster.show(`${name} left the room.`, { tone: "info" });
    });

    net.onLifecycle({
      open() {
        armHelloDeadline();
      },
      close() {
        clearTimeout(helloDeadline);
        // The seat is kept, not cleared: score and readiness belong to the
        // player, and a reconnect reclaims both.
        const state = store.getState();
        const id = guestId();
        if (!id || !state.players[id]) return;
        store.set({
          connection: CONNECTION.WAITING,
          players: {
            ...state.players,
            [id]: { ...state.players[id], connected: false, ready: false },
          },
        });
        toaster.show(`${state.players[id].name} dropped out.`, { tone: "bad" });
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
  async function joinRoom(roomCode, rawName) {
    // A retry must not leave the previous attempt's peer alive: an orphaned
    // client keeps answering heartbeats and holds the seat it half-claimed.
    net?.close();
    net = null;

    const name = profile.rememberName(rawName);
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
      // The host may have assigned a different id than we asked for. Remember
      // the one it gave us, so a later rejoin reclaims this same seat.
      profile.adoptAssignedId(payload.playerId);
      store.set({ connection: CONNECTION.CONNECTED, localPlayerId: payload.playerId });
      applySnapshot(payload.state);
      navigate(SCREEN.LOBBY);
    });

    net.on(MSG.SNAPSHOT, (payload) => applySnapshot(payload.state));

    net.on(MSG.WORD_REJECTED, (payload) => onWordRejected(payload.reason));

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
        if (!net) return;
        fail(FAILURE.HOST_LEFT);
      },
      failure(code) {
        fail(code);
      },
    });
  }

  /* ---- Shared -------------------------------------------------------- */

  /**
   * Host-side readiness mutation. A guest reaches it via MSG.READY, the host
   * directly, so there is one implementation of the rule.
   *
   * @param {string} playerId
   * @param {boolean} ready
   */
  function setReady(playerId, ready) {
    const state = store.getState();
    const player = state.players[playerId];
    if (!player) return;
    store.set({ players: { ...state.players, [playerId]: { ...player, ready } } });
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
        return;
      }
      // Optimistic: the host's snapshot is authoritative and will correct this
      // if it disagrees, but the button should not feel laggy.
      store.set({
        players: { ...state.players, [local.id]: { ...local, ready: !local.ready } },
      });
      net?.send(MSG.READY, { ready: !local.ready });
    },

    /** Host only. Deals the first round. */
    async startGame() {
      const state = store.getState();
      if (state.role !== ROLE.HOST) return;
      if (state.playerOrder.length < MAX_PLAYERS) {
        toaster.show("Wait for your opponent to join.", { tone: "info" });
        return;
      }
      await ensureRoundMachine().startMatch();
    },

    /** Host only. */
    nextRound() {
      round?.nextRound();
    },

    /** Host only. */
    restartMatch() {
      round?.restartMatch();
    },

    /** Host only. */
    returnToLobby() {
      round?.returnToLobby();
    },

    /**
     * Commits the local player's secret letter.
     * @param {string} letter
     */
    submitLetter(letter) {
      const state = store.getState();
      if (state.role === ROLE.HOST) {
        round?.submitLetter(state.localPlayerId, letter);
        return;
      }
      net?.send(MSG.LETTER, { letter, roundId: state.match.roundId });
    },

    /**
     * Offers the local player's word.
     * @param {string} word
     */
    submitWord(word) {
      const state = store.getState();
      if (state.match.phase !== PHASE.RACE) return;

      if (state.role === ROLE.HOST) {
        round?.submitWord({
          playerId: state.localPlayerId,
          word,
          // The host's own clock needs no correction.
          correctedTime: Date.now(),
          roundId: state.match.roundId,
        });
        return;
      }
      net?.send(MSG.WORD, {
        word,
        roundId: state.match.roundId,
        clientTime: Date.now(),
      });
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

    /** @returns {object} counters for the end-to-end verification */
    diagnostics() {
      return {
        network: net?.diagnostics() ?? null,
        round: round?.diagnostics() ?? null,
        dictionary: dictionary?.diagnostics() ?? null,
      };
    },
  };
}
