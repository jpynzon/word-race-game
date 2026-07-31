import { FAILURE, TRANSPORT } from "../js/constants.js";
import { createPeerTransport, generateRoomCode } from "./PeerTransport.js";
import { createRelayTransport } from "./RelayTransport.js";

/**
 * Runs several transports as one, so a room is reachable by whichever path a
 * given player's network permits.
 *
 * WHY THIS IS NOT JUST A FALLBACK CHAIN
 *
 * The obvious design — try WebRTC, and if it fails use the relay — is broken for
 * the host. Consider a host whose network is fine and a guest behind a strict
 * firewall: the host would open WebRTC, succeed, and stop. The guest would fail
 * at WebRTC, fall back to the relay, and find nobody listening. They would never
 * meet, and the failure would look like "no such room".
 *
 * So the two roles behave differently, and that asymmetry is the whole point:
 *
 *   HOST   opens every transport at once and accepts guests on any of them.
 *          Succeeds as long as at least one comes up.
 *   GUEST  tries them in order and keeps the first that connects. Direct is
 *          first, so a good network still gets the fast path.
 *
 * A host can therefore be talking to one guest directly and another through the
 * relay simultaneously, without any of the game logic above noticing.
 *
 * PEER KEY NAMESPACING
 *
 * Every peer key is prefixed with its transport's name (`direct:abc`,
 * `relay:r-9f2`). Two transports could otherwise hand out colliding ids, and
 * NetworkClient keys its per-peer dedupe, clock offset and heartbeat state by
 * peer key — a collision would cross two players' wires.
 */

/** @param {string} name @param {string} peerKey */
const brand = (name, peerKey) => `${name}:${peerKey}`;

/** @param {string} branded @returns {{name: string, peerKey: string}} */
function unbrand(branded) {
  const cut = branded.indexOf(":");
  return cut === -1
    ? { name: "", peerKey: branded }
    : { name: branded.slice(0, cut), peerKey: branded.slice(cut + 1) };
}

/**
 * @param {{
 *   onData: (raw: unknown, peerKey: string) => void,
 *   onPeerOpen: (peerKey: string) => void,
 *   onPeerClose: (peerKey: string) => void,
 *   onFailure: (code: string) => void,
 *   buildRejectMessage?: (code: string) => object,
 *   maxPeers?: () => number,
 *   factories?: {name: string, create: Function}[]
 * }} options
 */
export function createMultiTransport({
  onData,
  onPeerOpen,
  onPeerClose,
  onFailure,
  buildRejectMessage,
  maxPeers = () => 1,
  factories,
}) {
  const plan =
    factories ?? [
      { name: TRANSPORT.DIRECT, create: createPeerTransport },
      { name: TRANSPORT.RELAY, create: createRelayTransport },
    ];

  /** @type {Map<string, any>} transport name → live transport */
  const built = new Map();
  /** Which transports actually came up. */
  const activeNames = new Set();
  let closed = false;

  /**
   * Builds one transport, wrapping its callbacks so every peer key that crosses
   * the boundary is branded with the transport it belongs to.
   */
  function build(name, create) {
    const transport = create({
      onData: (raw, peerKey) => onData(raw, brand(name, peerKey)),
      onPeerOpen: (peerKey) => {
        activeNames.add(name);
        onPeerOpen(brand(name, peerKey));
      },
      onPeerClose: (peerKey) => onPeerClose(brand(name, peerKey)),
      // A single transport failing is not fatal while another still carries the
      // room; only a total loss is escalated.
      onFailure: (code) => {
        if (anyLive()) return;
        onFailure(code);
      },
      buildRejectMessage,
      maxPeers,
    });
    built.set(name, transport);
    return transport;
  }

  /** @returns {boolean} whether any transport still has a live peer */
  function anyLive() {
    for (const transport of built.values()) {
      if (transport.isConnected()) return true;
    }
    return false;
  }

  return {
    /**
     * Opens the room on every transport that will come up.
     *
     * The code has to be settled before the relay is told about it, because both
     * paths must advertise the same one — so WebRTC claims a code first (it is
     * the one with a real id registry and therefore the one that can reject a
     * collision) and the relay is then given that code to match.
     *
     * @param {string} [preferredCode]
     * @returns {Promise<{roomCode: string, modes: string[]}>}
     */
    async hostRoom(preferredCode) {
      const results = [];
      let code = preferredCode ?? generateRoomCode();

      // Direct first, so its code claim is authoritative.
      const direct = plan.find((entry) => entry.name === TRANSPORT.DIRECT);
      if (direct) {
        try {
          const transport = build(direct.name, direct.create);
          ({ roomCode: code } = await transport.hostRoom(code));
          activeNames.add(direct.name);
          results.push(direct.name);
        } catch (error) {
          built.delete(direct.name);
          results.push(null);
          void error;
        }
      }

      // Everything else advertises the same code, in parallel.
      const others = plan.filter((entry) => entry.name !== TRANSPORT.DIRECT);
      await Promise.all(
        others.map(async (entry) => {
          try {
            const transport = build(entry.name, entry.create);
            await transport.hostRoom(code);
            activeNames.add(entry.name);
            results.push(entry.name);
          } catch {
            built.get(entry.name)?.close();
            built.delete(entry.name);
          }
        }),
      );

      const modes = [...activeNames];
      if (built.size === 0) {
        throw Object.assign(new Error("no transport could host"), {
          failure: FAILURE.BROKER_UNREACHABLE,
        });
      }
      return { roomCode: code, modes };
    },

    /**
     * Joins by trying each transport in order and keeping the first that works.
     *
     * "No such room" from the direct path is not conclusive while another path is
     * untried, so the most informative failure is remembered and only reported if
     * everything fails.
     *
     * @param {string} roomCode
     * @returns {Promise<{mode: string}>}
     */
    async joinRoom(roomCode) {
      let bestFailure = null;

      for (const entry of plan) {
        let transport;
        try {
          transport = build(entry.name, entry.create);
          // eslint-disable-next-line no-await-in-loop
          await transport.joinRoom(roomCode);
          activeNames.add(entry.name);
          return { mode: entry.name };
        } catch (error) {
          transport?.close();
          built.delete(entry.name);
          // A blocked network says nothing about whether the room exists, so a
          // later "room not found" is the more useful message to keep.
          if (!bestFailure || error.failure === FAILURE.ROOM_NOT_FOUND) {
            bestFailure = error;
          }
        }
      }

      throw bestFailure ??
        Object.assign(new Error("no transport could join"), {
          failure: FAILURE.P2P_BLOCKED,
        });
    },

    /** @returns {string[]} transports currently carrying traffic */
    modes() {
      return [...activeNames];
    },

    /**
     * @param {string} peerKey branded key
     * @returns {string} which transport this peer is on
     */
    modeFor(peerKey) {
      return unbrand(peerKey).name;
    },

    /**
     * Broadcasts on every live transport. A host may be serving one guest
     * directly and another through the relay.
     *
     * @param {object} message
     * @returns {number} peers reached
     */
    send(message) {
      if (closed) return 0;
      let delivered = 0;
      for (const transport of built.values()) delivered += transport.send(message) || 0;
      return delivered;
    },

    /**
     * @param {string} peerKey branded key
     * @param {object} message
     * @returns {boolean}
     */
    sendTo(peerKey, message) {
      if (closed) return false;
      const { name, peerKey: raw } = unbrand(peerKey);
      return built.get(name)?.sendTo(raw, message) ?? false;
    },

    /** @param {string} [peerKey] @returns {boolean} */
    isConnected(peerKey) {
      if (closed) return false;
      if (peerKey === undefined) return anyLive();
      const { name, peerKey: raw } = unbrand(peerKey);
      return built.get(name)?.isConnected(raw) ?? false;
    },

    /** @returns {string[]} every live peer, branded */
    peerKeys() {
      const keys = [];
      for (const [name, transport] of built) {
        for (const raw of transport.peerKeys()) keys.push(brand(name, raw));
      }
      return keys;
    },

    /** @param {string} [peerKey] omit to drop every peer on every transport */
    dropConnection(peerKey) {
      if (peerKey === undefined) {
        for (const transport of built.values()) transport.dropConnection?.();
        return;
      }
      const { name, peerKey: raw } = unbrand(peerKey);
      built.get(name)?.dropConnection?.(raw);
    },

    close() {
      closed = true;
      for (const transport of built.values()) {
        try {
          transport.close();
        } catch {
          /* already gone */
        }
      }
      built.clear();
      activeNames.clear();
    },
  };
}
