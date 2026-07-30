import {
  CONNECT_TIMEOUT_MS,
  FAILURE,
  MAX_ROOM_CODE_ATTEMPTS,
  PEER_ID_PREFIX,
  ROOM_CODE_LENGTH,
} from "../js/constants.js";
import { peerIdFor } from "./Protocol.js";

/**
 * PeerJS transport.
 *
 * The only file in the project that knows PeerJS exists. It implements the
 * interface the rest of the game codes against:
 *
 *   hostRoom(code) → Promise<{roomCode}>
 *   joinRoom(code) → Promise<void>
 *   send(object)                    broadcast to every peer
 *   sendTo(peerKey, object)         one peer
 *   close()
 *
 * Swapping to Firebase or Ably means writing one more file with these methods
 * and changing a single line in NetworkClient. Nothing above this layer mentions
 * peers, ICE, or data channels.
 *
 * TOPOLOGY
 *
 * A star, with the host at the centre. The host holds one connection per guest;
 * a guest holds exactly one, to the host. Guests are never connected to each
 * other, which falls out of the host-authoritative model for free: every message
 * a guest cares about comes from the host anyway, so a full mesh would multiply
 * connections for nothing.
 *
 * Why the room code is the address: the host claims the peer id
 * `wordrace-v1-4821`, so a guest holding the code already knows where to
 * connect. That is what removes the need for a server — there is no room
 * registry to look anything up in.
 */

/** @returns {string} a fresh random room code, zero-padded */
export function generateRoomCode() {
  const max = 10 ** ROOM_CODE_LENGTH;
  return String(Math.floor(Math.random() * max)).padStart(ROOM_CODE_LENGTH, "0");
}

/** Maps a PeerJS error type onto one of our FAILURE codes. */
function classifyPeerError(type) {
  switch (type) {
    case "unavailable-id":
      return FAILURE.ROOM_TAKEN;
    case "peer-unavailable":
      return FAILURE.ROOM_NOT_FOUND;
    case "browser-incompatible":
    case "webrtc":
      return FAILURE.P2P_BLOCKED;
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
    default:
      return FAILURE.BROKER_UNREACHABLE;
  }
}

/**
 * @param {{
 *   onData: (raw: unknown, peerKey: string) => void,
 *   onPeerOpen: (peerKey: string) => void,
 *   onPeerClose: (peerKey: string) => void,
 *   onFailure: (code: string) => void,
 *   buildRejectMessage?: (code: string) => object,
 *   maxPeers?: () => number
 * }} handlers `maxPeers` is a function, not a number, because the host can
 *   change the game mode in the lobby and the seat limit changes with it.
 */
export function createPeerTransport({
  onData,
  onPeerOpen,
  onPeerClose,
  onFailure,
  buildRejectMessage,
  maxPeers = () => 1,
}) {
  /** @type {any} */ let peer = null;
  /** @type {Map<string, any>} peer id → DataConnection */
  const connections = new Map();
  let closed = false;
  /** Set while deliberately tearing down, so teardown does not look like a fault. */
  let tearingDown = false;

  /** @returns {any} the PeerJS constructor, or throws a classified failure */
  function requirePeerLibrary() {
    if (typeof window.Peer !== "function") {
      throw Object.assign(new Error("PeerJS did not load"), {
        failure: FAILURE.BROKER_UNREACHABLE,
      });
    }
    return window.Peer;
  }

  /**
   * Whether a connection is genuinely usable.
   *
   * Holding a reference is not the same as having a peer. A DataConnection can
   * close underneath us — the tab went away, the network dropped — without its
   * `close` event ever arriving. Asking PeerJS directly is the only reliable
   * answer, and getting it wrong makes reconnects impossible: the transport
   * refuses a returning player because it thinks their seat is still taken.
   *
   * @param {any} conn
   * @returns {boolean}
   */
  function isLive(conn) {
    return Boolean(conn) && conn.open !== false;
  }

  /** @returns {string[]} peer ids with a live connection */
  function livePeerKeys() {
    return [...connections.entries()].filter(([, c]) => isLive(c)).map(([key]) => key);
  }

  /** Forgets dead connections so their seats become available again. */
  function reapDead() {
    for (const [key, conn] of [...connections]) {
      if (!isLive(conn)) connections.delete(key);
    }
  }

  /** Wires a DataConnection and adds it to the star. */
  function adopt(conn) {
    const key = conn.peer;
    connections.set(key, conn);

    conn.on("data", (raw) => {
      if (!closed) onData(raw, key);
    });

    const forget = () => {
      if (connections.get(key) === conn) connections.delete(key);
      if (!closed && !tearingDown) onPeerClose(key);
    };
    conn.on("close", forget);
    conn.on("error", forget);

    if (!closed) onPeerOpen(key);
  }

  /** Builds a Peer and resolves once the broker has assigned it an id. */
  function openPeer(PeerCtor, id) {
    return new Promise((resolve, reject) => {
      const instance = id ? new PeerCtor(id) : new PeerCtor();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        instance.destroy();
        reject(
          Object.assign(new Error("Broker timed out"), {
            failure: FAILURE.BROKER_UNREACHABLE,
          }),
        );
      }, CONNECT_TIMEOUT_MS);

      instance.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(instance);
      });

      instance.on("error", (err) => {
        const failure = classifyPeerError(err?.type);
        if (settled) {
          // Post-open faults are runtime problems, not connection problems.
          // `peer-unavailable` here means some *other* peer vanished, which for
          // a host with several guests must not tear down the whole room.
          if (!closed && !tearingDown && failure !== FAILURE.ROOM_NOT_FOUND) {
            onFailure(failure);
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        instance.destroy();
        reject(Object.assign(new Error(err?.type ?? "peer error"), { failure }));
      });
    });
  }

  /** The broker link can drop without the peer connections dying; reopen it. */
  function watchBrokerLink(instance) {
    instance.on("disconnected", () => {
      if (closed || tearingDown) return;
      try {
        instance.reconnect();
      } catch {
        onFailure(FAILURE.BROKER_UNREACHABLE);
      }
    });
  }

  /**
   * Releases one connection, or all of them, without tearing down the peer — so
   * the room stays open and the seats become available again.
   *
   * @param {string} [peerKey] omit to drop every connection
   */
  function dropConnection(peerKey) {
    const doomed = peerKey === undefined ? [...connections.keys()] : [peerKey];
    for (const key of doomed) {
      const conn = connections.get(key);
      connections.delete(key);
      try {
        conn?.close();
      } catch {
        /* already gone; we only needed to stop referencing it */
      }
    }
  }

  return {
    /**
     * Claims a room. Tries the supplied code first, then fresh random codes if
     * the broker says the id is in use — the room-code collision case, handled
     * with no server-side registry.
     *
     * @param {string} [preferredCode]
     * @returns {Promise<{roomCode: string}>}
     */
    async hostRoom(preferredCode) {
      const PeerCtor = requirePeerLibrary();
      let code = preferredCode ?? generateRoomCode();

      for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
        try {
          peer = await openPeer(PeerCtor, peerIdFor(code, PEER_ID_PREFIX));
        } catch (error) {
          if (error.failure === FAILURE.ROOM_TAKEN) {
            code = generateRoomCode();
            continue;
          }
          throw error;
        }

        watchBrokerLink(peer);
        peer.on("connection", (conn) => {
          // A dead connection is not an occupant. Clear those out first so a
          // player whose browser closed can take their seat back.
          reapDead();

          if (closed || livePeerKeys().length >= maxPeers()) {
            // A genuine surplus arrival is told why and dropped, rather than
            // silently ignored while its player stares at a spinner.
            conn.on("open", () => {
              if (buildRejectMessage) {
                try {
                  conn.send(buildRejectMessage(FAILURE.ROOM_FULL));
                } catch {
                  /* the channel is going away anyway */
                }
              }
              setTimeout(() => conn.close(), 100);
            });
            return;
          }
          conn.on("open", () => adopt(conn));
        });

        return { roomCode: code };
      }

      throw Object.assign(new Error("Could not find a free room code"), {
        failure: FAILURE.ROOM_TAKEN,
      });
    },

    /**
     * Connects to an existing room.
     *
     * A timeout here is the honest signal that the network is blocking WebRTC:
     * the broker accepted us and the host exists, but no data channel formed.
     * That is a different problem from "no such room" and gets its own code.
     *
     * @param {string} roomCode
     * @returns {Promise<void>}
     */
    async joinRoom(roomCode) {
      const PeerCtor = requirePeerLibrary();
      peer = await openPeer(PeerCtor, null);
      watchBrokerLink(peer);

      await new Promise((resolve, reject) => {
        let settled = false;
        const hostId = peerIdFor(roomCode, PEER_ID_PREFIX);
        const conn = peer.connect(hostId, { reliable: true });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            Object.assign(new Error("No data channel"), {
              failure: FAILURE.P2P_BLOCKED,
            }),
          );
        }, CONNECT_TIMEOUT_MS);

        conn.on("open", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          adopt(conn);
          resolve();
        });

        // A missing host surfaces on the peer, not the connection.
        peer.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            Object.assign(new Error(err?.type ?? "peer error"), {
              failure: classifyPeerError(err?.type),
            }),
          );
        });
      });
    },

    /**
     * Broadcasts to every live peer.
     *
     * @param {object} message a protocol envelope
     * @returns {number} how many peers it reached
     */
    send(message) {
      if (closed) return 0;
      let delivered = 0;
      for (const [key, conn] of [...connections]) {
        if (!isLive(conn)) {
          connections.delete(key);
          continue;
        }
        try {
          conn.send(message);
          delivered += 1;
        } catch {
          /* one bad channel must not stop the rest of the broadcast */
        }
      }
      return delivered;
    },

    /**
     * @param {string} peerKey
     * @param {object} message
     * @returns {boolean} whether it went out
     */
    sendTo(peerKey, message) {
      if (closed) return false;
      const conn = connections.get(peerKey);
      if (!isLive(conn)) return false;
      try {
        conn.send(message);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * @param {string} [peerKey] omit to ask whether any peer is connected
     * @returns {boolean}
     */
    isConnected(peerKey) {
      if (closed) return false;
      if (peerKey === undefined) return livePeerKeys().length > 0;
      return isLive(connections.get(peerKey));
    },

    /** @returns {string[]} live peer ids */
    peerKeys: livePeerKeys,

    /**
     * Drops one peer link, or all, while keeping the room open. Called when a
     * heartbeat concludes a peer is gone: without it the transport keeps holding
     * a dead connection and turns that seat into a permanent no-vacancy sign.
     */
    dropConnection,

    /** Tears everything down. Safe to call repeatedly. */
    close() {
      closed = true;
      tearingDown = true;
      dropConnection();
      try {
        peer?.destroy();
      } catch {
        /* already gone */
      }
      peer = null;
    },
  };
}
