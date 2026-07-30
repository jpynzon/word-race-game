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
 * This is the only file in the project that knows PeerJS exists. It implements
 * the transport interface the rest of the game codes against:
 *
 *   hostRoom(code) → Promise<{roomCode}>
 *   joinRoom(code) → Promise<void>
 *   send(object)
 *   close()
 *
 * Swapping to Firebase or Ably means writing one more file with these four
 * methods and changing a single line in GameManager. Nothing above this layer
 * mentions peers, ICE, or data channels.
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
 *   onData: (raw: unknown) => void,
 *   onPeerOpen: () => void,
 *   onPeerClose: () => void,
 *   onFailure: (code: string) => void,
 *   buildRejectMessage?: (code: string) => object
 * }} handlers
 */
export function createPeerTransport({
  onData,
  onPeerOpen,
  onPeerClose,
  onFailure,
  buildRejectMessage,
}) {
  /** @type {any} */ let peer = null;
  /** @type {any} */ let connection = null;
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

  /** Wires a DataConnection once it is the active one. */
  function adopt(conn) {
    connection = conn;

    conn.on("data", (raw) => {
      if (!closed) onData(raw);
    });

    conn.on("close", () => {
      if (connection === conn) connection = null;
      if (!closed && !tearingDown) onPeerClose();
    });

    conn.on("error", () => {
      if (connection === conn) connection = null;
      if (!closed && !tearingDown) onPeerClose();
    });

    if (!closed) onPeerOpen();
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
        reject(Object.assign(new Error("Broker timed out"), {
          failure: FAILURE.BROKER_UNREACHABLE,
        }));
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
          if (!closed && !tearingDown) onFailure(failure);
          return;
        }
        settled = true;
        clearTimeout(timer);
        instance.destroy();
        reject(Object.assign(new Error(err?.type ?? "peer error"), { failure }));
      });
    });
  }

  /** The broker link can drop without the peer connection dying; reopen it. */
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

  return {
    /**
     * Claims a room. Tries the supplied code first, then fresh random codes if
     * the broker says the id is already in use — which is exactly the room-code
     * collision case, handled without any server-side registry.
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
          // One opponent only. A third arrival is told why and dropped, rather
          // than silently ignored while its player stares at a spinner.
          if (connection || closed) {
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

      throw Object.assign(
        new Error("Could not find a free room code"),
        { failure: FAILURE.ROOM_TAKEN },
      );
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
        const conn = peer.connect(peerIdFor(roomCode, PEER_ID_PREFIX), {
          reliable: true,
        });

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(Object.assign(new Error("No data channel"), {
            failure: FAILURE.P2P_BLOCKED,
          }));
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
          reject(Object.assign(new Error(err?.type ?? "peer error"), {
            failure: classifyPeerError(err?.type),
          }));
        });
      });
    },

    /**
     * @param {object} message a protocol envelope
     * @returns {boolean} whether it went out
     */
    send(message) {
      if (!connection || closed) return false;
      try {
        connection.send(message);
        return true;
      } catch {
        return false;
      }
    },

    /** @returns {boolean} */
    isConnected() {
      return Boolean(connection) && !closed;
    },

    /** Tears everything down. Safe to call repeatedly. */
    close() {
      closed = true;
      tearingDown = true;
      try {
        connection?.close();
      } catch {
        /* already gone */
      }
      try {
        peer?.destroy();
      } catch {
        /* already gone */
      }
      connection = null;
      peer = null;
    },
  };
}
