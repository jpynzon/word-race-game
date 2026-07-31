import { CONNECTION, PHASE, SCREEN } from "./constants.js";
import { createSettings } from "../game/GameSettings.js";

/**
 * The single store for the whole app.
 *
 * There is no module-level mutable state anywhere in this project. `app.js`
 * creates exactly one store and hands it to the managers that need it, which
 * keeps ownership explicit and makes every manager trivially testable with a
 * throwaway store.
 *
 * Only the host mutates match state from game logic. A guest's store is
 * overwritten wholesale by snapshots arriving from the host, which is what
 * makes "both players see the same state" true by construction.
 */

/** @returns {object} a fresh, fully-populated state tree */
export function createInitialState() {
  return {
    screen: SCREEN.HOME,
    /** @type {"host"|"guest"|null} */
    role: null,
    connection: CONNECTION.IDLE,
    roomCode: null,
    /** Stable identity for this browser tab; survives reload via sessionStorage. */
    localPlayerId: null,
    /** Round-trip estimate to the peer, in ms. Null until measured. */
    latencyMs: null,

    /**
     * Which connection paths this room is reachable on — a host normally has
     * both `direct` and `relay` open at once. Local, not part of the snapshot:
     * every player's path is their own.
     * @type {string[]}
     */
    transportModes: [],

    /**
     * @type {Record<string, {
     *   id: string, name: string, role: string,
     *   connected: boolean, ready: boolean
     * }>}
     */
    players: {},
    /** Seating order. Index 0 is the host. */
    playerOrder: [],

    match: createInitialMatch(),

    /** @type {{code: string, title: string, detail: string}|null} */
    failure: null,
  };
}

/** @returns {object} match state as it looks before the first round */
export function createInitialMatch() {
  return {
    phase: PHASE.LOBBY,
    roundNumber: 0,
    /** Monotonic id; every intent carries it so stale messages are droppable. */
    roundId: 0,

    /** The match rules every player agreed to. Host-editable in the lobby. */
    settings: createSettings(),

    /**
     * Who is actually playing this round — the players who must commit a letter
     * and who may submit a word. Everyone seated but absent from this list is an
     * observer.
     *
     * It is everyone in DUEL and CONTAINS, and just the two duellists in
     * ROUND_ROBIN. Publishing it rather than deriving it client-side means the
     * board never has to re-implement the pairing rule to know who is up.
     *
     * @type {string[]}
     */
    activeIds: [],

    /** How many round-robin rounds have been dealt; drives the rotation. */
    rotationIndex: 0,

    /** Who supplies the starting and ending letter (DUEL and ROUND_ROBIN). */
    /** @type {string|null} */
    starterId: null,
    /** @type {string|null} */
    enderId: null,

    /** Who has committed a letter. Never carries the letter itself. */
    /** @type {Record<string, boolean>} */
    committed: {},

    /**
     * The revealed rule, null until the countdown finishes.
     *
     * `contributions` is the ordered list of who supplied which letter, and is
     * what the board renders — one tile per contribution — so the same shape
     * serves a two-player duel and a four-player letter hunt.
     *
     * @type {{
     *   mode: string,
     *   start?: string,
     *   end?: string,
     *   letters: string[],
     *   contributions: {playerId: string, letter: string}[],
     *   minWordLength: number
     * }|null}
     */
    rule: null,

    /** @type {number|null} epoch ms when the countdown ends */
    countdownEndsAt: null,
    /** @type {number|null} epoch ms when the race ends */
    raceEndsAt: null,

    /**
     * @type {{
     *   winnerId: string|null, word: string|null,
     *   source: string|null, draw: boolean
     * }|null}
     */
    result: null,

    /** @type {Record<string, number>} */
    scores: {},
    /** Lowercase words already spent this match; a word may only win once. */
    /** @type {string[]} */
    usedWords: [],

    /**
     * A short message both players should see, carried in the snapshot so the
     * two screens cannot disagree about it. The UI toasts it when `id` changes.
     * @type {{id: number, text: string, tone: string}|null}
     */
    notice: null,
  };
}

/**
 * Creates an observable store.
 *
 * Listeners are notified once per microtask rather than once per write, so a
 * manager can make several related updates in one tick without the UI
 * rendering a half-applied state.
 *
 * @param {object} [initial] starting state; defaults to a fresh tree
 */
export function createStore(initial = createInitialState()) {
  let state = initial;
  const listeners = new Set();
  let flushQueued = false;

  function flush() {
    flushQueued = false;
    for (const listener of [...listeners]) listener(state);
  }

  function scheduleFlush() {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(flush);
  }

  return {
    /** @returns {object} the current state; treat it as immutable */
    getState() {
      return state;
    },

    /**
     * Shallow-merges a patch into the root of the state tree.
     * @param {object|((s: object) => object)} patch
     */
    set(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      scheduleFlush();
    },

    /**
     * Shallow-merges a patch into `state.match`. Convenience for the round
     * machine, which touches match state far more than anything else.
     * @param {object|((m: object) => object)} patch
     */
    setMatch(patch) {
      const next = typeof patch === "function" ? patch(state.match) : patch;
      state = { ...state, match: { ...state.match, ...next } };
      scheduleFlush();
    },

    /**
     * Replaces the whole tree. Used only when a guest applies a host snapshot.
     * @param {object} next
     */
    replace(next) {
      state = next;
      scheduleFlush();
    },

    /**
     * @param {(s: object) => void} listener called after every batched change
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* ---- Selectors ---------------------------------------------------------
   Derived reads live here so no component has to know the shape of the tree. */

/** @returns {object|null} the local player record */
export function selectLocalPlayer(state) {
  return state.players[state.localPlayerId] ?? null;
}

/** @returns {object|null} the other seat's player record, if occupied */
export function selectOpponent(state) {
  const id = state.playerOrder.find((pid) => pid !== state.localPlayerId);
  return id ? state.players[id] : null;
}

/** @returns {boolean} true when this tab is the authority */
export function selectIsHost(state) {
  return state.role === "host";
}

/** @returns {boolean} every seated player is currently connected */
export function selectAllConnected(state) {
  const ids = state.playerOrder;
  return ids.length > 0 && ids.every((id) => state.players[id]?.connected);
}

/**
 * @returns {boolean} everyone present has marked themselves ready
 *
 * Seat count is checked by canStart(), not here — this answers only "is anyone
 * still deciding?", which is what the lobby hint needs.
 */
export function selectEveryoneReady(state) {
  const ids = state.playerOrder;
  return ids.length > 0 && ids.every((id) => state.players[id]?.ready);
}

/**
 * @returns {"starter"|"ender"|null} which side of the rule a player owns
 */
export function selectSeat(state, playerId) {
  if (state.match.starterId === playerId) return "starter";
  if (state.match.enderId === playerId) return "ender";
  return null;
}

/** @returns {boolean} whether the local player still owes a letter this round */
export function selectAwaitingLocalLetter(state) {
  return (
    state.match.phase === PHASE.LETTER_ENTRY && !state.match.committed[state.localPlayerId]
  );
}
