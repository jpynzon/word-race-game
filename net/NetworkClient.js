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
 *  - clock offset estimation, so the host can compare two players' submission
 *    times fairly instead of rewarding whoever has less latency
 *
 * Game logic subscribes by message type and never sees an invalid message.
 */

/**
 * @param {{
 *   role: "host"|"guest",
 *   createTransport?: typeof createPeerTransport
 * }} options
 */
export function createNetworkClient({ role, createTransport = createPeerTransport }) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  const dedupe = createDedupe();
  const lifecycle = { open: [], close: [], failure: [] };

  let outboundSeq = 0;
  let lastInboundAt = 0;
  let heartbeatTimer = null;
  let nextPingId = 1;
  /** @type {Map<number, number>} ping id → local send time */
  const pendingPings = new Map();

  /** Best (lowest-RTT) offset estimate: peerClock − localClock, in ms. */
  let peerClockOffsetMs = 0;
  let bestRttMs = Infinity;
  let sampleCount = 0;

  const droppedByReason = new Map();

  function emitLifecycle(kind, arg) {
    for (const fn of lifecycle[kind]) fn(arg);
  }

  function dispatch(message) {
    const set = handlers.get(message.type);
    if (!set) return;
    for (const fn of [...set]) fn(message.payload, message);
  }

  /**
   * Folds one ping/pong round trip into the offset estimate.
   *
   * Only the lowest-RTT sample is kept. On a jittery link the minimum round
   * trip is by far the most trustworthy sample, because a fast round trip
   * cannot have been delayed much in either direction, while a slow one gives
   * no clue which leg was slow.
   */
  function recordPong(payload) {
    const sentAt = pendingPings.get(payload.id);
    if (sentAt === undefined) return;
    pendingPings.delete(payload.id);

    const now = Date.now();
    const rtt = now - sentAt;
    sampleCount += 1;
    if (rtt >= bestRttMs) return;

    bestRttMs = rtt;
    // The peer replied at peerTime; assume that happened at the midpoint of the
    // round trip in local terms.
    peerClockOffsetMs = payload.peerTime - (sentAt + rtt / 2);
  }

  function sendPing() {
    const id = nextPingId;
    nextPingId += 1;
    pendingPings.set(id, Date.now());
    // Keep the map from growing on a link that never answers.
    if (pendingPings.size > PING_SAMPLE_COUNT * 4) {
      pendingPings.delete(pendingPings.keys().next().value);
    }
    transport.send(envelope(MSG.PING, { id }));
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastInboundAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!transport.isConnected()) return;
      // A silent peer is a lost peer: the channel can stay nominally open long
      // after the tab it belongs to has gone away.
      if (Date.now() - lastInboundAt > HEARTBEAT_TIMEOUT_MS) {
        emitLifecycle("close");
        return;
      }
      sendPing();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const transport = createTransport({
    onData(raw) {
      lastInboundAt = Date.now();

      const result = validateMessage(raw, role);
      if (!result.ok) {
        droppedByReason.set(result.reason, (droppedByReason.get(result.reason) ?? 0) + 1);
        return;
      }

      const { message } = result;

      // Liveness traffic is handled here and never reaches game logic.
      if (message.type === MSG.PING) {
        transport.send(
          envelope(MSG.PONG, { id: message.payload.id, peerTime: Date.now() }),
        );
        return;
      }
      if (message.type === MSG.PONG) {
        recordPong(message.payload);
        return;
      }

      if (!dedupe.accept("peer", message)) return;
      dispatch(message);
    },

    onPeerOpen() {
      startHeartbeat();
      // Front-load the offset samples so the first round already has an estimate.
      for (let i = 0; i < PING_SAMPLE_COUNT; i += 1) {
        setTimeout(sendPing, i * 120);
      }
      emitLifecycle("open");
    },

    onPeerClose() {
      stopHeartbeat();
      emitLifecycle("close");
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
     * @param {string} type one of MSG
     * @param {object} [payload]
     * @returns {boolean} whether the message reached the transport
     */
    send(type, payload = {}) {
      outboundSeq += 1;
      return transport.send(envelope(type, payload, outboundSeq));
    },

    /**
     * @param {string} type one of MSG
     * @param {(payload: object, message: object) => void} handler
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
     * Converts a timestamp taken on the peer's clock into local time.
     *
     * Best-effort by construction: without a shared time source the estimate
     * can only ever be as good as the link's minimum round trip. Good enough to
     * stop latency deciding rounds; not good enough to arbitrate a photo finish,
     * which is why arrival order remains the tiebreaker.
     *
     * @param {number} peerTimestamp
     * @returns {number} the equivalent local timestamp
     */
    toLocalTime(peerTimestamp) {
      return peerTimestamp - peerClockOffsetMs;
    },

    /** @returns {number|null} best round-trip estimate, or null if unmeasured */
    latencyMs() {
      return Number.isFinite(bestRttMs) ? Math.round(bestRttMs) : null;
    },

    /** @returns {boolean} */
    isConnected() {
      return transport.isConnected();
    },

    /** @returns {object} counters for the diagnostics in each phase's verification */
    diagnostics() {
      return {
        role,
        outboundSeq,
        offsetMs: Math.round(peerClockOffsetMs),
        bestRttMs: Number.isFinite(bestRttMs) ? Math.round(bestRttMs) : null,
        pingSamples: sampleCount,
        dropped: Object.fromEntries(droppedByReason),
      };
    },

    close() {
      stopHeartbeat();
      transport.close();
    },
  };
}

export { ROLE };
