import { ROOM_CODE_LENGTH, SCREEN } from "./constants.js";

/**
 * URL handling: deep-link invites in, shareable location out.
 *
 * Two jobs, kept separate on purpose:
 *
 *  1. Read an invite. `?room=4821` is the documented share format; the hash
 *     form `#/room/4821` is also accepted so a copied address bar still works.
 *  2. Mirror the current screen into the URL, so a refresh lands somewhere
 *     sensible and the browser back button has something to go back to.
 *
 * The router never decides what to show. It reports intent and the app decides,
 * which matters because leaving a live room needs a confirmation the router
 * has no business owning.
 */

const CODE_PATTERN = new RegExp(`^\\d{${ROOM_CODE_LENGTH}}$`);

/** @returns {boolean} whether a string is a well-formed room code */
export function isValidRoomCode(value) {
  return CODE_PATTERN.test(String(value ?? "").trim());
}

export function createRouter() {
  /** @type {((intent: {screen: string, roomCode: string|null}) => void)|null} */
  let backHandler = null;
  /** Set while we rewrite the URL ourselves, so we ignore our own events. */
  let suppressEvents = false;

  /**
   * Pulls a room code out of the current URL.
   * @returns {string|null} a valid 4-digit code, or null
   */
  function readInvite() {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("room");
    if (isValidRoomCode(fromQuery)) return fromQuery.trim();

    const fromHash = window.location.hash.match(/^#\/room\/(\d+)/);
    if (fromHash && isValidRoomCode(fromHash[1])) return fromHash[1];

    return null;
  }

  /**
   * @param {string} screen a SCREEN value
   * @param {string|null} roomCode
   * @returns {string} the hash this screen should live at
   */
  function hashFor(screen, roomCode) {
    switch (screen) {
      case SCREEN.CREATE:
        return "#/create";
      case SCREEN.JOIN:
        return "#/join";
      case SCREEN.LOBBY:
        return roomCode ? `#/room/${roomCode}` : "#/join";
      case SCREEN.GAME:
        return roomCode ? `#/room/${roomCode}/play` : "#/";
      default:
        return "#/";
    }
  }

  /** @returns {{screen: string, roomCode: string|null}} intent parsed from a hash */
  function parseHash() {
    const hash = window.location.hash || "#/";
    const room = hash.match(/^#\/room\/(\d+)(\/play)?/);
    if (room && isValidRoomCode(room[1])) {
      return { screen: room[2] ? SCREEN.GAME : SCREEN.LOBBY, roomCode: room[1] };
    }
    if (hash.startsWith("#/create")) return { screen: SCREEN.CREATE, roomCode: null };
    if (hash.startsWith("#/join")) return { screen: SCREEN.JOIN, roomCode: null };
    return { screen: SCREEN.HOME, roomCode: null };
  }

  return {
    readInvite,

    /**
     * Rewrites the URL to match the screen without adding history entries the
     * user did not ask for. The `?room=` parameter is dropped once consumed so
     * a refresh does not re-trigger the invite flow.
     *
     * @param {string} screen
     * @param {string|null} [roomCode]
     */
    syncUrl(screen, roomCode = null) {
      const target = `${window.location.pathname}${hashFor(screen, roomCode)}`;
      if (target === `${window.location.pathname}${window.location.hash}`) return;
      suppressEvents = true;
      window.history.replaceState({ screen, roomCode }, "", target);
      // Let the event loop drain the hashchange this triggered before listening again.
      setTimeout(() => {
        suppressEvents = false;
      }, 0);
    },

    /**
     * @param {string} roomCode
     * @returns {string} absolute, shareable invite URL
     */
    inviteLink(roomCode) {
      const url = new URL(window.location.href);
      url.hash = "";
      url.search = `?room=${roomCode}`;
      return url.toString();
    },

    /**
     * Registers a handler for browser-driven navigation (back/forward, or a
     * hand-edited hash).
     * @param {(intent: {screen: string, roomCode: string|null}) => void} handler
     */
    onNavigate(handler) {
      backHandler = handler;
    },

    /** Starts listening. Call once, after handlers are registered. */
    start() {
      const relay = () => {
        if (suppressEvents || !backHandler) return;
        backHandler(parseHash());
      };
      window.addEventListener("hashchange", relay);
      window.addEventListener("popstate", relay);
    },
  };
}
