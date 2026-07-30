import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PING_SAMPLE_COUNT,
  ROLE,
} from "../js/constants.js";
import { createDedupe, validateMessage } from "./Events.js";
import { createPeerTransport } from "./PeerTransport.js";
import { envelope, MSG } from "./Protocol.js";

/**
 * The messaging layer between a raw transport and game logic.
 *
 * Responsibilities, all of them things every caller would otherwise reimplement:
 *
 *  - sequence numbers on outbound messages
 *  - validation and direction checking on inbound messages (via Events.js)
 *  - duplicate suppression
 *  - liveness: a heartbeat that notices a peer which stopped answering without
 *    ever closing its channel
 *  - clock offset estimation, so the host can compare players' submission times
 *    fairly instead of rewarding whoever has the least latency
 *
 * MULTI-PEER
 *
 * A host can hold up to three guests, so every one of those concerns is tracked
 * **per peer**. A shared dedupe counter would silently swallow the second
 * player's messages whenever their sequence numbers happened to lag the first's,
 * and a shared clock offset would apply one player's latency correction to
 * everybody. Both are per-peer maps for that reason.
 *
 * Game logic subscribes by message type and never sees an invalid message.
 */

/**
 * @param {{
 *   role: "host"|"guest",
 *   maxPeers?: () => number,
 *   createTransport?: typeof createPeerTransport
 * }} options
 */
export function createNetworkClient({
  role,
  maxPeers = () => 1,
  createTransport = createPeerTransport,
}) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  const lifecycle = { open: [], close: [], failure: [] };

  let outboundSeq = 0;
  let heartbeatTimer = null;
  let nextPingId = 1;

  /**
   * Per-peer bookkeeping. Keyed by the transport's peer id.
   * @type {Map<string, {
   *   dedupe: ReturnType<typeof createDedupe>,
   *   lastInboundAt: number,
   *   pendingPings: Map<number, number>,
   *   clockOffsetMs: number,
   *   bestRttMs: number,
   *   pingSamples: number
   * }>}
   */
  const peers = new Map();

  const droppedByReason = new Map();

  function peerState(peerKey) {
    let entry = peers.get(peerKey);
    if (!entry) {
      entry = {
        dedupe: createDedupe(),
        lastInboundAt: Date.now(),
        pendingPings: new Map(),
        clockOffsetMs: 0,
        bestRttMs: Infinity,
        pingSamples: 0,
      };
      peers.set(peerKey, entry);
    }
    return entry;
  }

  function emitLifecycle(kind, ...args) {
    for (const fn of lifecycle[kind]) fn(...args);
  }

  function dispatch(message, peerKey) {
    const set = handlers.get(message.type);
    if (!set) return;
    for (const fn of [...set]) fn(message.payload, message, peerKey);
  }

  /**
   * Folds one ping/pong round trip into a peer's offset estimate.
   *
   * Only the lowest-RTT sample is kept. On a jittery link the minimum round trip
   * is by far the most trustworthy sample: a fast round trip cannot have been
   * delayed much in either direction, while a slow one gives no clue which leg
   * was slow.
   */
  function recordPong(peerKey, payload) {
    const state = peerState(peerKey);
    const sentAt = state.pendingPings.get(payload.id);
    if (sentAt === undefined) return;
    state.pendingPings.delete(payload.id);

    const rtt = Date.now() - sentAt;
    state.pingSamples += 1;
    if (rtt >= state.bestRttMs) return;

    state.bestRttMs = rtt;
    // The peer replied at peerTime; assume that happened at the midpoint of the
    // round trip in local terms.
    state.clockOffsetMs = payload.peerTime - (sentAt + rtt / 2);
  }

  function sendPing(peerKey) {
    const state = peerState(peerKey);
    const id = nextPingId;
    nextPingId += 1;
    state.pendingPings.set(id, Date.now());
    // Keep the map from growing on a link that never answers.
    if (state.pendingPings.size > PING_SAMPLE_COUNT * 4) {
      state.pendingPings.delete(state.pendingPings.keys().next().value);
    }
    transport.sendTo(peerKey, envelope(MSG.PING, { id }));
  }

  function startHeartbeat() {
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setInterval(() => {
      for (const peerKey of transport.peerKeys()) {
        const state = peerState(peerKey);

        // A silent peer is a lost peer: the channel can stay nominally open long
        // after the tab it belongs to has gone away.
        //
        // Dropping the transport's connection here is essential, not tidy-up.
        // The close event we never received would have freed the seat;
        // concluding the peer is gone without freeing it leaves the transport
        // holding a corpse, and it then refuses that player's reconnect as
        // "room full".
        if (Date.now() - state.lastInboundAt > HEARTBEAT_TIMEOUT_MS) {
          transport.dropConnection(peerKey);
          peers.delete(peerKey);
          emitLifecycle("close", peerKey);
          continue;
        }
        sendPing(peerKey);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const transport = createTransport({
    maxPeers,

    onData(raw, peerKey) {
      const state = peerState(peerKey);
      state.lastInboundAt = Date.now();

      const result = validateMessage(raw, role);
      if (!result.ok) {
        droppedByReason.set(result.reason, (droppedByReason.get(result.reason) ?? 0) + 1);
        return;
      }

      const { message } = result;

      // Liveness traffic is handled here and never reaches game logic.
      if (message.type === MSG.PING) {
        transport.sendTo(
          peerKey,
          envelope(MSG.PONG, { id: message.payload.id, peerTime: Date.now() }),
        );
        return;
      }
      if (message.type === MSG.PONG) {
        recordPong(peerKey, message.payload);
        return;
      }

      if (!state.dedupe.accept(peerKey, message)) return;
      dispatch(message, peerKey);
    },

    onPeerOpen(peerKey) {
      peerState(peerKey).lastInboundAt = Date.now();
      startHeartbeat();
      // Front-load the offset samples so the first round already has an estimate.
      for (let i = 0; i < PING_SAMPLE_COUNT; i += 1) {
        setTimeout(() => {
          if (transport.isConnected(peerKey)) sendPing(peerKey);
        }, i * 120);
      }
      emitLifecycle("open", peerKey);
    },

    onPeerClose(peerKey) {
      peers.delete(peerKey);
      if (transport.peerKeys().length === 0) stopHeartbeat();
      emitLifecycle("close", peerKey);
    },

    onFailure(code) {
      stopHeartbeat();
      emitLifecycle("failure", code);
    },

    buildRejectMessage(code) {
      return envelope(MSG.REJECT, { code });
    },
  });

  return {
    /** @param {string} [preferredCode] @returns {Promise<{roomCode: string}>} */
    hostRoom(preferredCode) {
      return transport.hostRoom(preferredCode);
    },

    /** @param {string} roomCode @returns {Promise<void>} */
    joinRoom(roomCode) {
      return transport.joinRoom(roomCode);
    },

    /**
     * Broadcasts to every peer.
     *
     * @param {string} type one of MSG
     * @param {object} [payload]
     * @returns {number} how many peers it reached
     */
    send(type, payload = {}) {
      outboundSeq += 1;
      return transport.send(envelope(type, payload, outboundSeq));
    },

    /**
     * Sends to one peer. Used for anything addressed to a single player, like
     * telling them why their word was refused — the others have no business
     * seeing what someone else tried.
     *
     * @param {string} peerKey
     * @param {string} type
     * @param {object} [payload]
     * @returns {boolean}
     */
    sendTo(peerKey, type, payload = {}) {
      outboundSeq += 1;
      return transport.sendTo(peerKey, envelope(type, payload, outboundSeq));
    },

    /**
     * @param {string} type one of MSG
     * @param {(payload: object, message: object, peerKey: string) => void} handler
     * @returns {() => void} unsubscribe
     */
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
      return () => handlers.get(type)?.delete(handler);
    },

    /** @param {{open?: Function, close?: Function, failure?: Function}} hooks */
    onLifecycle(hooks) {
      for (const [kind, fn] of Object.entries(hooks)) {
        if (fn) lifecycle[kind].push(fn);
      }
    },

    /**
     * Converts a timestamp taken on a peer's clock into local time.
     *
     * Best-effort by construction: without a shared time source the estimate can
     * only ever be as good as the link's minimum round trip. Good enough to stop
     * latency deciding rounds; not good enough to arbitrate a photo finish,
     * which is why arrival order remains the tiebreaker.
     *
     * @param {string} peerKey
     * @param {number} peerTimestamp
     * @returns {number} the equivalent local timestamp
     */
    toLocalTime(peerKey, peerTimestamp) {
      const state = peers.get(peerKey);
      return peerTimestamp - (state?.clockOffsetMs ?? 0);
    },

    /**
     * @param {string} [peerKey] omit for the best across all peers
     * @returns {number|null} round-trip estimate in ms, or null if unmeasured
     */
    latencyMs(peerKey) {
      if (peerKey !== undefined) {
        const rtt = peers.get(peerKey)?.bestRttMs;
        return Number.isFinite(rtt) ? Math.round(rtt) : null;
      }
      const all = [...peers.values()].map((p) => p.bestRttMs).filter(Number.isFinite);
      return all.length ? Math.round(Math.min(...all)) : null;
    },

    /** @param {string} [peerKey] @returns {boolean} */
    isConnected(peerKey) {
      return transport.isConnected(peerKey);
    },

    /** @returns {string[]} live peer ids */
    peerKeys() {
      return transport.peerKeys();
    },

    /**
     * Drops one peer link, or all, while keeping the room open.
     * @param {string} [peerKey]
     */
    dropPeer(peerKey) {
      transport.dropConnection?.(peerKey);
      if (peerKey === undefined) {
        peers.clear();
        stopHeartbeat();
      } else {
        peers.delete(peerKey);
      }
    },

    /** @returns {object} counters for the end-to-end verification */
    diagnostics() {
      return {
        role,
        outboundSeq,
        peerCount: transport.peerKeys().length,
        peers: Object.fromEntries(
          [...peers].map(([key, p]) => [
            key,
            {
              offsetMs: Math.round(p.clockOffsetMs),
              bestRttMs: Number.isFinite(p.bestRttMs) ? Math.round(p.bestRttMs) : null,
              pingSamples: p.pingSamples,
            },
          ]),
        ),
        dropped: Object.fromEntries(droppedByReason),
      };
    },

    close() {
      stopHeartbeat();
      peers.clear();
      transport.close();
    },
  };
}

export { ROLE };
