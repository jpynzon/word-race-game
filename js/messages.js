import { FAILURE, REJECTION } from "./constants.js";

/**
 * Every player-facing sentence in the game.
 *
 * Game logic produces codes; this file turns codes into English. Keeping the
 * two apart means a rule can change without touching copy, copy can be
 * rewritten without touching rules, and nothing ever builds a sentence by
 * concatenating fragments in a branch.
 *
 * House style: say what happened and what to do about it. No apologies, no
 * blame, no exclamation marks doing the work that clear wording should.
 */

/** Terminal states that take over the screen. */
export const FAILURE_COPY = Object.freeze({
  [FAILURE.HOST_LEFT]: {
    label: "Room closed",
    title: "The host left the game",
    detail:
      "This room ran on the host's browser, so it ended when they closed the tab. Start your own room and send the code.",
  },
  [FAILURE.GUEST_LEFT]: {
    label: "Opponent left",
    title: "Your opponent left",
    detail: "Your room is still open. Share the code again to bring someone in.",
  },
  [FAILURE.KICKED]: {
    label: "Removed",
    title: "The host removed you from the room",
    detail:
      "Only the host can decide who is in their room. You can start your own and invite whoever you like.",
  },
  [FAILURE.ROOM_NOT_FOUND]: {
    label: "No such room",
    title: "Nobody is hosting that code",
    detail:
      "Room codes only exist while the host has the game open. Check the four digits, or ask them to create a new room.",
  },
  [FAILURE.ROOM_FULL]: {
    label: "Room full",
    title: "That room already has two players",
    detail: "Word Race is played one against one. Ask them for a fresh room.",
  },
  [FAILURE.ROOM_TAKEN]: {
    label: "Code unavailable",
    title: "Couldn't reserve a room code",
    detail: "Every code we tried was in use. Try creating the room again.",
  },
  [FAILURE.P2P_BLOCKED]: {
    label: "Connection blocked",
    title: "This network won't allow a direct connection",
    detail:
      "Players connect straight to each other, and something between you is blocking that — usually a workplace or school firewall. Try a different network, or a phone hotspot.",
  },
  [FAILURE.BROKER_UNREACHABLE]: {
    label: "Offline",
    title: "Can't reach the matchmaking service",
    detail:
      "Word Race needs one short connection to pair players up. Check your internet and try again.",
  },
  [FAILURE.VERSION_MISMATCH]: {
    label: "Version mismatch",
    title: "You're on different versions",
    detail: "One of you has an older copy of the page loaded. Both reload, then try again.",
  },
});

/** Why a submitted word did not count. Shown as a toast, mid-race. */
export const REJECTION_COPY = Object.freeze({
  [REJECTION.TOO_SHORT]: "That's shorter than this match allows.",
  [REJECTION.MISSING_LETTERS]: "Your word is missing one of the letters.",
  [REJECTION.TOO_LONG]: "That's longer than this game accepts.",
  [REJECTION.NOT_ALPHA]: "Letters only — no spaces, digits or punctuation.",
  [REJECTION.WRONG_START]: "That doesn't start with the right letter.",
  [REJECTION.WRONG_END]: "That doesn't end with the right letter.",
  [REJECTION.ALREADY_USED]: "That word already won a round.",
  [REJECTION.NOT_A_WORD]: "That isn't in the dictionary.",
  [REJECTION.WRONG_PHASE]: "Wait for the letters to be revealed.",
  [REJECTION.NOT_PLAYING]: "You're watching this round — your turn comes around.",
  [REJECTION.ROUND_OVER]: "This round is already decided.",
});

const FALLBACK_FAILURE = Object.freeze({
  label: "Disconnected",
  title: "Something went wrong",
  detail: "The connection ended unexpectedly. Start a new room to play again.",
});

/**
 * @param {string} code a FAILURE value
 * @returns {{label: string, title: string, detail: string}}
 */
export function describeFailure(code) {
  return FAILURE_COPY[code] ?? FALLBACK_FAILURE;
}

/**
 * @param {string} reason a REJECTION value
 * @returns {string}
 */
export function describeRejection(reason) {
  return REJECTION_COPY[reason] ?? "That word doesn't count.";
}
