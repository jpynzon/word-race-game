import {
  CONNECTION,
  FAILURE,
  HELLO_TIMEOUT_MS,
  PHASE,
  REJECTION,
  ROLE,
  SCREEN,
} from "../js/constants.js";
import { describeFailure } from "../js/messages.js";
import { createInitialMatch, createInitialState } from "../js/state.js";
import { createNetworkClient } from "../net/NetworkClient.js";
import { MSG } from "../net/Protocol.js";
import { createDictionaryService } from "../dict/DictionaryService.js";
import { canStart, capacityFor, normaliseSettings } from "./GameSettings.js";
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
 * whatever snapshot comes back. That is what makes "everyone always sees the
 * same game state" true by construction rather than by careful bookkeeping — a
 * guest holds no copy of the rules that could disagree.
 *
 * The cost is that the host is the server: when the host leaves, the room ends.
 * That is handled explicitly (FAILURE.HOST_LEFT), not hidden.
 *
 * Only the host builds a RoundManager and a DictionaryService. Guests asking the
 * dictionary independently could get different answers from a flaky API and
 * desync the match, so there is exactly one asker.
 *
 * IDENTITY
 *
 * The transport speaks in peer ids; the game speaks in player ids. The host owns
 * the mapping between them, which is what lets a player reconnect on a brand-new
 * peer id and still be recognised as the same player holding the same seat.
 */
export function createGameManager({
  store,
  toaster,
  navigate,
  onWordRejected,
  onSpectatorActivity,
  profile,
  createNetwork = createNetworkClient,
}) {
  /** @type {ReturnType<typeof createNetworkClient>|null} */
  let net = null;
  /** @type {ReturnType<typeof createRoundManager>|null} */
  let round = null;
  /** @type {ReturnType<typeof createDictionaryService>|null} */
  let dictionary = null;

  /** Host only. transport peer id → game player id, and back. */
  const peerToPlayer = new Map();
  const playerToPeer = new Map();

  /** Identity comes from the durable profile. @see js/profile.js */
  const resolveLocalPlayerId = () => profile.playerId();

  /* ---- Snapshots ------------------------------------------------------
     The authoritative slice only. Identity, role and which screen you are
     looking at stay local — publishing them would let the host move a guest's
     cursor, so to speak.

     Note what is absent: committed letters. `match.committed` carries booleans,
     never the letters themselves, so nobody can read an opponent's letter out of
     the snapshot before the reveal. */

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

  /** Host only. Pushes current state to every guest. */
  function broadcast() {
    if (!net || store.getState().role !== ROLE.HOST) return;
    net.send(MSG.SNAPSHOT, { state: buildSnapshot() });
  }

  /* ---- Spectator activity relay ---------------------------------------
     Live activity from the duellists, so watching a race is not just watching a
     bar shrink. Host-side only, and addressed exclusively at players who are
     observing this round.

     Never broadcast, and never in a snapshot. Telling a duellist their opponent
     is six characters in, or has already burned three attempts, is real
     competitive information. Spectators cannot submit, so for them it is theatre;
     for a rival it would be a tell. */

  /** Rejected attempts per player, this round. Reset on every deal. */
  let attemptsThisRound = new Map();
  let attemptsRoundId = -1;

  /**
   * @param {string} playerId whose activity this is
   * @param {number} length current word length
   */
  function relayActivityToObservers(playerId, length) {
    const state = store.getState();
    if (state.role !== ROLE.HOST) return;

    const active = state.match.activeIds ?? [];
    // Nobody is benched, so there is no audience to relay to.
    if (active.length === 0 || active.length >= state.playerOrder.length) return;
    if (!active.includes(playerId)) return;

    const payload = {
      playerId,
      length,
      attempts: attemptsThisRound.get(playerId) ?? 0,
    };

    for (const observerId of state.playerOrder) {
      if (active.includes(observerId)) continue;
      if (observerId === state.localPlayerId) {
        onSpectatorActivity(payload);
        continue;
      }
      const peerKey = playerToPeer.get(observerId);
      if (peerKey) net?.sendTo(peerKey, MSG.ACTIVITY_RELAY, payload);
    }
  }

  /** Bumps a player's attempt count and lets the audience know. */
  function noteFailedAttempt(playerId) {
    const { match } = store.getState();
    if (attemptsRoundId !== match.roundId) {
      attemptsRoundId = match.roundId;
      attemptsThisRound = new Map();
    }
    attemptsThisRound.set(playerId, (attemptsThisRound.get(playerId) ?? 0) + 1);
    relayActivityToObservers(playerId, 0);
  }

  /** @returns {number} guest seats this mode allows, excluding the host */
  function guestCapacity() {
    const state = store.getState();
    return capacityFor(state.match.settings.mode).max - 1;
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
        // A genuine failed guess is worth showing the audience; a rejection for
        // not being in the round is just a misdirected click.
        if (reason !== REJECTION.NOT_PLAYING && reason !== REJECTION.ROUND_OVER) {
          noteFailedAttempt(playerId);
        }

        // The reason itself is routed to whoever submitted, and only to them:
        // nobody else has any business learning what someone tried.
        if (playerId === store.getState().localPlayerId) {
          onWordRejected(reason);
          return;
        }
        const peerKey = playerToPeer.get(playerId);
        if (peerKey) net?.sendTo(peerKey, MSG.WORD_REJECTED, { reason });
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
    peerToPlayer.clear();
    playerToPeer.clear();
    const fresh = createInitialState();
    fresh.localPlayerId = resolveLocalPlayerId();
    store.replace(fresh);
  }

  /* ---- Host ------------------------------------------------------------ */

  /** @param {string} rawName */
  async function createRoom(rawName) {
    // Committing to a room is the moment the name is worth keeping.
    const name = profile.rememberName(rawName);
    const localPlayerId = resolveLocalPlayerId();
    store.set({ connection: CONNECTION.CONNECTING, failure: null });

    net = createNetwork({ role: ROLE.HOST, maxPeers: guestCapacity });

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
    /* A connection that opens but never says HELLO must not hold a seat. This
       happens for real: the data channel can open on our side while the joining
       player's side never finishes negotiating, and the half-open connection
       still answers heartbeats, so it looks perfectly healthy. Left alone it
       occupies a seat forever and genuine reconnects are refused as "room full". */
    /** @type {Map<string, number>} peer id → timeout handle */
    const helloDeadlines = new Map();

    function armHelloDeadline(peerKey) {
      clearTimeout(helloDeadlines.get(peerKey));
      helloDeadlines.set(
        peerKey,
        setTimeout(() => {
          if (!peerToPlayer.has(peerKey)) net?.dropPeer(peerKey);
        }, HELLO_TIMEOUT_MS),
      );
    }

    net.on(MSG.HELLO, (payload, _message, peerKey) => {
      clearTimeout(helloDeadlines.get(peerKey));
      const state = store.getState();

      /* Two tabs of one browser share a localStorage profile, so a guest can
         arrive carrying an id already in use. The host is the authority on
         identity, so it renames the newcomer and returns the assigned id in
         WELCOME. Without this the two players would collapse into one seat. */
      let assignedId = payload.playerId;
      const alreadySeated = state.players[assignedId];
      const isReturning =
        Boolean(alreadySeated) && !state.players[assignedId].connected;

      if (alreadySeated && !isReturning) {
        let suffix = 2;
        while (state.players[`${payload.playerId}-${suffix}`]) suffix += 1;
        assignedId = `${payload.playerId}-${suffix}`;
      }

      const reclaiming = Boolean(state.players[assignedId]);
      if (!reclaiming && state.playerOrder.length >= capacityFor(state.match.settings.mode).max) {
        net.sendTo(peerKey, MSG.REJECT, { code: FAILURE.ROOM_FULL });
        return;
      }

      // A match in progress cannot absorb a new player mid-round: the rule was
      // built from the letters of whoever was seated at the deal.
      if (!reclaiming && state.match.phase !== PHASE.LOBBY) {
        net.sendTo(peerKey, MSG.REJECT, { code: FAILURE.ROOM_FULL });
        return;
      }

      peerToPlayer.set(peerKey, assignedId);
      playerToPeer.set(assignedId, peerKey);

      const player = {
        id: assignedId,
        name: payload.name,
        role: ROLE.GUEST,
        connected: true,
        // Readiness and score survive a reconnect; the seat belongs to the player.
        ready: reclaiming ? (state.players[assignedId].ready ?? false) : false,
      };

      const playerOrder = reclaiming
        ? state.playerOrder
        : [...state.playerOrder, assignedId];

      store.set({
        connection: CONNECTION.CONNECTED,
        players: { ...state.players, [assignedId]: player },
        playerOrder,
        // The minimum word length floor rises with the seat count in letter-hunt
        // mode, so settings are re-normalised whenever the roster changes.
        match: {
          ...state.match,
          settings: normaliseSettings(state.match.settings, playerOrder.length),
        },
      });

      net.sendTo(peerKey, MSG.WELCOME, { playerId: assignedId, state: buildSnapshot() });
      broadcast();
      toaster.show(reclaiming ? `${player.name} is back.` : `${player.name} joined.`, {
        tone: "good",
      });
    });

    net.on(MSG.READY, (payload, _message, peerKey) => {
      const id = peerToPlayer.get(peerKey);
      if (id) setReady(id, payload.ready);
    });

    net.on(MSG.LETTER, (payload, _message, peerKey) => {
      const id = peerToPlayer.get(peerKey);
      if (!id || !round) return;
      // The letter goes into RoundManager's private map, never into state.
      round.submitLetter(id, payload.letter);
    });

    net.on(MSG.WORD, (payload, _message, peerKey) => {
      const id = peerToPlayer.get(peerKey);
      if (!id || !round) return;
      round.submitWord({
        playerId: id,
        word: payload.word,
        // Convert this peer's clock into ours before anything compares times.
        correctedTime: net.toLocalTime(peerKey, payload.clientTime),
        roundId: payload.roundId,
      });
    });

    net.on(MSG.ACTIVITY, (payload, _message, peerKey) => {
      const id = peerToPlayer.get(peerKey);
      const { match } = store.getState();
      if (!id || payload.roundId !== match.roundId) return;
      relayActivityToObservers(id, payload.length);
    });

    net.on(MSG.LEAVE, (_payload, _message, peerKey) => {
      const id = peerToPlayer.get(peerKey);
      if (!id) return;
      const state = store.getState();
      const players = { ...state.players };
      const name = players[id]?.name ?? "A player";
      delete players[id];
      peerToPlayer.delete(peerKey);
      playerToPeer.delete(id);

      const playerOrder = state.playerOrder.filter((pid) => pid !== id);
      store.set({
        players,
        playerOrder,
        connection: playerOrder.length > 1 ? CONNECTION.CONNECTED : CONNECTION.WAITING,
      });

      // Too few players to continue means back to the lobby, not a broken board.
      if (!canStart(store.getState().match.settings.mode, playerOrder.length).ok) {
        round?.returnToLobby();
      }
      broadcast();
      toaster.show(`${name} left the room.`, { tone: "info" });
    });

    net.onLifecycle({
      open(peerKey) {
        armHelloDeadline(peerKey);
      },
      close(peerKey) {
        clearTimeout(helloDeadlines.get(peerKey));
        helloDeadlines.delete(peerKey);

        const id = peerToPlayer.get(peerKey);
        peerToPlayer.delete(peerKey);
        if (!id) return;
        playerToPeer.delete(id);

        // The seat is kept, not cleared: score and readiness belong to the
        // player, and a reconnect reclaims both.
        const state = store.getState();
        if (!state.players[id]) return;
        store.set({
          connection: CONNECTION.WAITING,
          players: {
            ...state.players,
            [id]: { ...state.players[id], connected: false, ready: false },
          },
        });

        if (!canStart(state.match.settings.mode, state.playerOrder.length).ok) {
          // Keep the room, drop the match: a rule built for four cannot be
          // raced by two.
          if (state.match.phase !== PHASE.LOBBY) round?.returnToLobby();
        }
        broadcast();
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
   * @param {string} rawName
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

    net = createNetwork({ role: ROLE.GUEST, maxPeers: () => 1 });

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

    net.on(MSG.ACTIVITY_RELAY, (payload) => onSpectatorActivity(payload));

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

    /**
     * Host only. Changes the match rules from the lobby.
     *
     * Settings are re-normalised against the current roster, because the minimum
     * word length floor depends on how many letters the mode collects — four
     * players means nothing under four letters can ever be valid.
     *
     * @param {object} patch partial settings
     */
    updateSettings(patch) {
      const state = store.getState();
      if (state.role !== ROLE.HOST) return;
      if (state.match.phase !== PHASE.LOBBY) {
        toaster.show("Settings can only change in the lobby.", { tone: "info" });
        return;
      }

      const next = normaliseSettings(
        { ...state.match.settings, ...patch },
        state.playerOrder.length,
      );

      // Switching to a mode that seats fewer players than are present would
      // silently drop somebody, so it is refused rather than half-applied.
      const capacity = capacityFor(next.mode);
      if (state.playerOrder.length > capacity.max) {
        toaster.show(
          `That mode is capped at ${capacity.max} players. Someone has to leave first.`,
          { tone: "bad" },
        );
        return;
      }

      store.setMatch({ settings: next });
      broadcast();
    },

    /** Host only. Deals the first round. */
    async startGame() {
      const state = store.getState();
      if (state.role !== ROLE.HOST) return;

      const verdict = canStart(state.match.settings.mode, state.playerOrder.length);
      if (!verdict.ok) {
        toaster.show(verdict.message, { tone: "info" });
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
     * Reports how long the local player's word currently is, so spectators have
     * something to watch. Length only — never the text.
     *
     * @param {number} length
     */
    reportActivity(length) {
      const state = store.getState();
      if (state.match.phase !== PHASE.RACE) return;
      if (!(state.match.activeIds ?? []).includes(state.localPlayerId)) return;

      if (state.role === ROLE.HOST) {
        relayActivityToObservers(state.localPlayerId, length);
        return;
      }
      net?.send(MSG.ACTIVITY, { length, roundId: state.match.roundId });
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
      net?.send(MSG.WORD, { word, roundId: state.match.roundId, clientTime: Date.now() });
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
        seats: [...peerToPlayer.entries()],
      };
    },
  };
}
