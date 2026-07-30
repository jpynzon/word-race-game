/**
 * The wire format.
 *
 * Every message is an envelope: `{ v, type, seq, sentAt, payload }`.
 *
 *  v       protocol version. Mismatched versions are refused at join rather
 *          than allowed to desync halfway through a match.
 *  type    one of MSG below.
 *  seq     per-sender monotonic counter. The host uses it to drop duplicates,
 *          which is what makes a double-tapped submit button harmless.
 *  sentAt  the sender's clock. Never trusted directly — NetworkClient measures
 *          a clock offset and corrects it before any comparison.
 *
 * Direction matters and is documented per type, because the authority model
 * depends on it: guests send intents, the host sends state.
 */

export const PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
  /* guest → host: "here is who I am, let me in" */
  HELLO: "hello",
  /* host → guest: "you're in, here is your identity" */
  WELCOME: "welcome",
  /* host → guest: "you're not in", with a FAILURE code */
  REJECT: "reject",

  /* host → guest: the entire authoritative state. The only way guest state
     changes. Sent on join, on every transition, and on reconnect. */
  SNAPSHOT: "snapshot",

  /* guest → host: intents */
  READY: "ready",
  LETTER: "letter",
  WORD: "word",
  LEAVE: "leave",

  /**
   * guest → host: "my word is this many characters long right now".
   *
   * Length only, never the text. It exists so spectators have something to
   * watch during a race, and it is relayed ONLY to spectators — see
   * ACTIVITY_RELAY. It must never enter a snapshot.
   */
  ACTIVITY: "activity",

  /* host → guest: your word didn't count, and why. Addressed to one player,
     unlike a notice, because only the submitter needs to see it. */
  WORD_REJECTED: "word-rejected",

  /**
   * host → spectator: live activity from the duellists.
   *
   * Sent with sendTo, addressed only at players who are observing this round.
   * Deliberately NOT part of the snapshot: telling a duellist that their
   * opponent is six characters in, or has already burned three attempts, would
   * hand them real competitive information. Spectators cannot submit, so for
   * them it is pure theatre.
   */
  ACTIVITY_RELAY: "activity-relay",

  /* host → guest: the room is over */
  ROOM_CLOSED: "room-closed",

  /* both ways: liveness and clock offset estimation */
  PING: "ping",
  PONG: "pong",
});

/** Types a host will accept from a guest. Anything else is dropped. */
export const GUEST_TO_HOST = Object.freeze([
  MSG.HELLO,
  MSG.READY,
  MSG.LETTER,
  MSG.WORD,
  MSG.LEAVE,
  MSG.ACTIVITY,
  MSG.PING,
  MSG.PONG,
]);

/** Types a guest will accept from the host. Anything else is dropped. */
export const HOST_TO_GUEST = Object.freeze([
  MSG.WELCOME,
  MSG.REJECT,
  MSG.SNAPSHOT,
  MSG.WORD_REJECTED,
  MSG.ACTIVITY_RELAY,
  MSG.ROOM_CLOSED,
  MSG.PING,
  MSG.PONG,
]);

/**
 * Builds an envelope. `seq` is supplied by the caller (NetworkClient owns the
 * counter) so this stays a pure function.
 *
 * @param {string} type one of MSG
 * @param {object} [payload]
 * @param {number} [seq]
 * @returns {object} envelope ready to serialise
 */
export function envelope(type, payload = {}, seq = 0) {
  return {
    v: PROTOCOL_VERSION,
    type,
    seq,
    sentAt: Date.now(),
    payload,
  };
}

/**
 * The peer id a room code maps to. The room code *is* the address, which is
 * the whole reason this game needs no server: a guest who knows the code knows
 * where to connect.
 *
 * @param {string} roomCode
 * @param {string} prefix PEER_ID_PREFIX
 * @returns {string}
 */
export function peerIdFor(roomCode, prefix) {
  return `${prefix}${roomCode}`;
}
