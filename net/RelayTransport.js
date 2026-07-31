import {
  FAILURE,
  MQTT_CLIENT_URL,
  RELAY_BROKER_URLS,
  RELAY_CLAIM_WAIT_MS,
  RELAY_PRESENCE_INTERVAL_MS,
  RELAY_PRESENCE_TIMEOUT_MS,
  RELAY_TOPIC_PREFIX,
} from "../js/constants.js";

/**
 * Relay transport: the fallback for networks that will not allow WebRTC.
 *
 * Implements exactly the same interface as PeerTransport — hostRoom, joinRoom,
 * send, sendTo, close — so nothing above this layer knows or cares which one is
 * carrying the game. That interface existing is the only reason this file could
 * be added without touching a line of game logic.
 *
 * Messages go over MQTT on plain WSS to a public broker. Port 443/8084 WSS gets
 * through effectively any firewall that permits normal HTTPS, which is precisely
 * the situation where direct WebRTC fails.
 *
 * TOPOLOGY
 *
 * The same star as WebRTC, expressed in topics:
 *
 *   <prefix>/<code>/host          host presence, retained — how a guest knows
 *                                 the room exists, and how a second host knows
 *                                 the code is taken
 *   <prefix>/<code>/to-host       every guest publishes here; the host subscribes
 *   <prefix>/<code>/all           host broadcasts here; every guest subscribes
 *   <prefix>/<code>/to/<peerId>   host addresses one guest
 *
 * Each message is wrapped as `{ from, body }`. The wrapper carries identity,
 * which MQTT does not, and `body` is the untouched protocol envelope — so
 * Events.js validates exactly the same shape on either transport.
 *
 * LIVENESS
 *
 * MQTT has no per-peer disconnect event, so there is nothing here that
 * corresponds to a data channel closing. Detecting a departed player is left
 * entirely to NetworkClient's heartbeat, which already treats a silent peer as a
 * lost one and frees its seat.
 *
 * PRIVACY
 *
 * A public broker is public: anyone subscribing to the topic can read the
 * traffic. Committed letters never travel before the reveal — they stay in the
 * host's memory — so what is exposed is names, scores and already-revealed
 * letters. Low stakes for a word game, and pointing RELAY_BROKER_URLS at your
 * own broker closes it entirely. Documented in the README rather than hidden.
 */

/** Cached loader, so several transports in one page share one script tag. */
let mqttLoader = null;

/** @returns {Promise<any>} the mqtt global */
function loadMqttClient() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  if (mqttLoader) return mqttLoader;

  mqttLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MQTT_CLIENT_URL;
    script.async = true;
    script.onload = () =>
      window.mqtt
        ? resolve(window.mqtt)
        : reject(
            Object.assign(new Error("mqtt loaded but absent"), {
              failure: FAILURE.BROKER_UNREACHABLE,
            }),
          );
    script.onerror = () =>
      reject(
        Object.assign(new Error("mqtt script failed"), {
          failure: FAILURE.BROKER_UNREACHABLE,
        }),
      );
    document.head.append(script);
  });
  return mqttLoader;
}

/** @returns {string} a short random id for this client */
function mintPeerId() {
  const rand =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `r-${rand}`;
}

/**
 * @param {{
 *   onData: (raw: unknown, peerKey: string) => void,
 *   onPeerOpen: (peerKey: string) => void,
 *   onPeerClose: (peerKey: string) => void,
 *   onFailure: (code: string) => void,
 *   buildRejectMessage?: (code: string) => object,
 *   maxPeers?: () => number,
 *   brokerUrls?: string[]
 * }} handlers
 */
export function createRelayTransport({
  onData,
  onPeerOpen,
  onPeerClose,
  onFailure,
  buildRejectMessage,
  maxPeers = () => 1,
  brokerUrls = RELAY_BROKER_URLS,
}) {
  const selfId = mintPeerId();
  /** @type {any} */ let client = null;
  /** @type {Set<string>} guest peer ids the host has accepted */
  const peers = new Set();
  /** Guests hold exactly one peer: the host. */
  let hostPeerId = null;
  let roomCode = null;
  let isHost = false;
  let closed = false;
  let presenceTimer = null;

  const topic = {
    host: (code) => `${RELAY_TOPIC_PREFIX}/${code}/host`,
    toHost: (code) => `${RELAY_TOPIC_PREFIX}/${code}/to-host`,
    all: (code) => `${RELAY_TOPIC_PREFIX}/${code}/all`,
    to: (code, peerId) => `${RELAY_TOPIC_PREFIX}/${code}/to/${peerId}`,
  };

  /** Connects to the first broker that answers. */
  async function connectBroker() {
    const mqtt = await loadMqttClient();
    let lastError = null;

    for (const url of brokerUrls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const connected = await new Promise((resolve, reject) => {
          const candidate = mqtt.connect(url, {
            clientId: `wr-${selfId}-${Math.random().toString(36).slice(2, 6)}`,
            clean: true,
            connectTimeout: 6_000,
            reconnectPeriod: 2_000,
            keepalive: 30,
          });
          const timer = setTimeout(() => {
            candidate.end(true);
            reject(new Error(`timeout ${url}`));
          }, 7_000);
          candidate.once("connect", () => {
            clearTimeout(timer);
            resolve(candidate);
          });
          candidate.once("error", (err) => {
            clearTimeout(timer);
            candidate.end(true);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        });
        return connected;
      } catch (error) {
        lastError = error;
      }
    }

    throw Object.assign(
      new Error(`No relay broker reachable: ${lastError?.message ?? "unknown"}`),
      { failure: FAILURE.BROKER_UNREACHABLE },
    );
  }

  function publish(target, body) {
    if (!client || closed) return false;
    try {
      client.publish(target, JSON.stringify({ from: selfId, body }), { qos: 0 });
      return true;
    } catch {
      return false;
    }
  }

  /** Routes an inbound MQTT message into the transport's callbacks. */
  function handleMessage(receivedTopic, buffer) {
    if (closed) return;
    let wrapper;
    try {
      wrapper = JSON.parse(buffer.toString());
    } catch {
      return; // not ours, or corrupted
    }
    if (!wrapper || typeof wrapper.from !== "string") return;
    if (wrapper.from === selfId) return; // our own broadcast echoing back

    if (isHost) {
      if (receivedTopic !== topic.toHost(roomCode)) return;

      // First contact from a guest is the equivalent of a data channel opening.
      if (!peers.has(wrapper.from)) {
        if (peers.size >= maxPeers()) {
          if (buildRejectMessage) {
            publish(
              topic.to(roomCode, wrapper.from),
              buildRejectMessage(FAILURE.ROOM_FULL),
            );
          }
          return;
        }
        peers.add(wrapper.from);
        onPeerOpen(wrapper.from);
      }
      if (wrapper.body !== undefined) onData(wrapper.body, wrapper.from);
      return;
    }

    // Guest: everything worth hearing comes from the host.
    if (!hostPeerId) {
      hostPeerId = wrapper.from;
      onPeerOpen(hostPeerId);
    }
    if (wrapper.body !== undefined) onData(wrapper.body, hostPeerId);
  }

  function subscribe(...topics) {
    return new Promise((resolve, reject) => {
      client.subscribe(topics, { qos: 0 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Retained presence, so a guest arriving later still finds the room. */
  function announcePresence() {
    if (!client || closed || !isHost) return;
    client.publish(
      topic.host(roomCode),
      JSON.stringify({ from: selfId, hostId: selfId, at: Date.now() }),
      { qos: 0, retain: true },
    );
  }

  return {
    name: "relay",

    /**
     * Claims a room on the relay.
     *
     * Unlike the WebRTC broker there is no id to claim, so the code is checked
     * by listening for an existing retained presence message first. Present
     * means taken.
     *
     * @param {string} preferredCode the code already chosen by the caller
     * @returns {Promise<{roomCode: string}>}
     */
    async hostRoom(preferredCode) {
      client = await connectBroker();
      client.on("message", handleMessage);
      isHost = true;
      roomCode = preferredCode;

      // Look for a sitting tenant before moving in.
      const taken = await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }, RELAY_CLAIM_WAIT_MS);

        const probe = (t, buf) => {
          if (settled || t !== topic.host(roomCode)) return;
          let parsed = null;
          try {
            parsed = JSON.parse(buf.toString());
          } catch {
            parsed = null;
          }
          // An empty retained payload is a cleared claim, not an occupant.
          if (parsed && parsed.hostId && parsed.hostId !== selfId) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          }
        };
        client.on("message", probe);
        client.subscribe(topic.host(roomCode), { qos: 0 });
      });

      if (taken) {
        throw Object.assign(new Error("relay code taken"), {
          failure: FAILURE.ROOM_TAKEN,
        });
      }

      await subscribe(topic.toHost(roomCode));
      announcePresence();
      presenceTimer = setInterval(announcePresence, RELAY_PRESENCE_INTERVAL_MS);
      return { roomCode };
    },

    /**
     * Joins a room over the relay.
     *
     * Waits for the host's retained presence message: no presence means no room,
     * which is a genuinely different failure from "the network blocked us" and
     * gets its own code.
     *
     * @param {string} code
     * @returns {Promise<void>}
     */
    async joinRoom(code) {
      client = await connectBroker();
      client.on("message", handleMessage);
      isHost = false;
      roomCode = code;

      const found = await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        }, RELAY_PRESENCE_TIMEOUT_MS);

        const probe = (t, buf) => {
          if (settled || t !== topic.host(roomCode)) return;
          let parsed = null;
          try {
            parsed = JSON.parse(buf.toString());
          } catch {
            parsed = null;
          }
          if (parsed && parsed.hostId) {
            settled = true;
            clearTimeout(timer);
            hostPeerId = parsed.hostId;
            resolve(true);
          }
        };
        client.on("message", probe);
        client.subscribe(topic.host(roomCode), { qos: 0 });
      });

      if (!found) {
        throw Object.assign(new Error("no host on relay"), {
          failure: FAILURE.ROOM_NOT_FOUND,
        });
      }

      await subscribe(topic.all(roomCode), topic.to(roomCode, selfId));
      onPeerOpen(hostPeerId);
    },

    /**
     * @param {object} message a protocol envelope
     * @returns {number} peers it was addressed to
     */
    send(message) {
      if (closed) return 0;
      if (isHost) {
        return publish(topic.all(roomCode), message) ? peers.size : 0;
      }
      return publish(topic.toHost(roomCode), message) ? 1 : 0;
    },

    /**
     * @param {string} peerKey
     * @param {object} message
     * @returns {boolean}
     */
    sendTo(peerKey, message) {
      if (closed) return false;
      if (!isHost) return publish(topic.toHost(roomCode), message);
      return publish(topic.to(roomCode, peerKey), message);
    },

    /** @param {string} [peerKey] @returns {boolean} */
    isConnected(peerKey) {
      if (closed || !client?.connected) return false;
      if (peerKey === undefined) return isHost ? peers.size > 0 : Boolean(hostPeerId);
      return isHost ? peers.has(peerKey) : peerKey === hostPeerId;
    },

    /** @returns {string[]} */
    peerKeys() {
      if (closed) return [];
      return isHost ? [...peers] : hostPeerId ? [hostPeerId] : [];
    },

    /**
     * Forgets a peer so its seat frees up. There is no channel to close on MQTT;
     * the heartbeat is what decides someone has gone.
     * @param {string} [peerKey]
     */
    dropConnection(peerKey) {
      if (peerKey === undefined) {
        peers.clear();
        hostPeerId = null;
        return;
      }
      peers.delete(peerKey);
      if (hostPeerId === peerKey) hostPeerId = null;
    },

    close() {
      closed = true;
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = null;
      try {
        // Clear the retained claim, so the code is immediately reusable.
        if (isHost && client && roomCode) {
          client.publish(topic.host(roomCode), "", { qos: 0, retain: true });
        }
        client?.end(true);
      } catch {
        /* already gone */
      }
      client = null;
      peers.clear();
      hostPeerId = null;
      void onPeerClose;
      void onFailure;
    },
  };
}
