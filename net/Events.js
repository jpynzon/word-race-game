import { MAX_NAME_LENGTH, MAX_WORD_LENGTH } from "../js/constants.js";
import { HOST_TO_GUEST, GUEST_TO_HOST, MSG, PROTOCOL_VERSION } from "./Protocol.js";

/**
 * The gate every inbound message passes through.
 *
 * A peer on the other end of a DataChannel is not trustworthy: it may be an
 * older build, a hand-crafted message from the console, or a corrupted frame.
 * Game logic should never have to ask "is this the right shape?", so exactly
 * one place asks, and everything downstream can assume a valid message.
 *
 * Invalid messages are dropped and counted, never thrown.
 */

/** Reasons a message was refused. Surfaced in diagnostics, not to players. */
export const DROP = Object.freeze({
  NOT_AN_OBJECT: "not-an-object",
  BAD_VERSION: "bad-version",
  UNKNOWN_TYPE: "unknown-type",
  WRONG_DIRECTION: "wrong-direction",
  BAD_PAYLOAD: "bad-payload",
});

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * Per-type payload checks. A type absent from this map has no payload
 * requirements beyond being an object.
 *
 * @type {Record<string, (payload: object) => boolean>}
 */
const PAYLOAD_RULES = Object.freeze({
  [MSG.HELLO]: (p) =>
    isNonEmptyString(p.name, MAX_NAME_LENGTH) && isNonEmptyString(p.playerId, 64),

  [MSG.WELCOME]: (p) => isNonEmptyString(p.playerId, 64) && isPlainObject(p.state),

  [MSG.REJECT]: (p) => isNonEmptyString(p.code, 64),

  [MSG.SNAPSHOT]: (p) => isPlainObject(p.state),

  [MSG.READY]: (p) => typeof p.ready === "boolean",

  // Exactly one letter, A-Z. Anything else is a client bug or a tamper attempt.
  [MSG.LETTER]: (p) =>
    typeof p.letter === "string" &&
    /^[a-z]$/i.test(p.letter) &&
    Number.isInteger(p.roundId),

  [MSG.WORD]: (p) =>
    isNonEmptyString(p.word, MAX_WORD_LENGTH) &&
    Number.isInteger(p.roundId) &&
    Number.isFinite(p.clientTime),

  [MSG.WORD_REJECTED]: (p) => isNonEmptyString(p.reason, 64),

  [MSG.ROOM_CLOSED]: (p) => isNonEmptyString(p.code, 64),

  [MSG.PING]: (p) => Number.isFinite(p.id),
  // `peerTime` is the responder's own clock at the moment it replied. It is the
  // raw material for the offset estimate, never used as a timestamp directly.
  [MSG.PONG]: (p) => Number.isFinite(p.id) && Number.isFinite(p.peerTime),
});

/**
 * Validates a decoded message.
 *
 * @param {unknown} raw the parsed message from the transport
 * @param {"host"|"guest"} localRole who is receiving it, so direction can be checked
 * @returns {{ok: true, message: object} | {ok: false, reason: string}}
 */
export function validateMessage(raw, localRole) {
  if (!isPlainObject(raw)) return { ok: false, reason: DROP.NOT_AN_OBJECT };
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, reason: DROP.BAD_VERSION };

  if (typeof raw.type !== "string" || !Object.values(MSG).includes(raw.type)) {
    return { ok: false, reason: DROP.UNKNOWN_TYPE };
  }

  // A host must only ever act on guest intents, and vice versa. This is what
  // stops a guest from, say, sending a SNAPSHOT and rewriting the host's state.
  const allowed = localRole === "host" ? GUEST_TO_HOST : HOST_TO_GUEST;
  if (!allowed.includes(raw.type)) return { ok: false, reason: DROP.WRONG_DIRECTION };

  const payload = isPlainObject(raw.payload) ? raw.payload : null;
  if (!payload) return { ok: false, reason: DROP.BAD_PAYLOAD };

  const rule = PAYLOAD_RULES[raw.type];
  if (rule && !rule(payload)) return { ok: false, reason: DROP.BAD_PAYLOAD };

  return {
    ok: true,
    message: {
      type: raw.type,
      seq: Number.isInteger(raw.seq) ? raw.seq : 0,
      sentAt: Number.isFinite(raw.sentAt) ? raw.sentAt : 0,
      payload,
    },
  };
}

/**
 * Tracks which (sender, type, seq) triples have already been handled.
 *
 * Duplicate delivery is normal, not exceptional: a player double-taps submit, a
 * key repeats, or a message is re-sent after a reconnect. Deduplicating here
 * keeps every downstream handler free of "have I already seen this?" logic.
 */
export function createDedupe() {
  /** @type {Map<string, number>} highest seq seen per sender+type */
  const highest = new Map();

  return {
    /**
     * @param {string} senderId
     * @param {object} message a validated message
     * @returns {boolean} true if this is new and should be handled
     */
    accept(senderId, message) {
      // seq 0 means "unsequenced" (pings, snapshots); always let those through.
      if (message.seq === 0) return true;

      const key = `${senderId}:${message.type}`;
      const seen = highest.get(key) ?? 0;
      if (message.seq <= seen) return false;
      highest.set(key, message.seq);
      return true;
    },

    /** Clears history for a sender. Called when a seat is released. */
    forget(senderId) {
      for (const key of [...highest.keys()]) {
        if (key.startsWith(`${senderId}:`)) highest.delete(key);
      }
    },
  };
}
