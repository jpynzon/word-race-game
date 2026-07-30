/**
 * Every tunable value in the game lives here. Nothing downstream is allowed to
 * inline a duration, a length, or a threshold — if a number has meaning, it
 * gets a name in this file.
 */

/* ---- Room and identity --------------------------------------------------- */

/** Digits in a room code. The code doubles as the host's peer id. */
export const ROOM_CODE_LENGTH = 4;

/** Namespace prefix for peer ids, so `4821` cannot collide with an unrelated
 *  app on the same public broker. Bump the version if the wire format changes. */
export const PEER_ID_PREFIX = "wordrace-v1-";

/** How many times to retry with a fresh code when the broker says the id is taken. */
export const MAX_ROOM_CODE_ATTEMPTS = 6;

export const MAX_PLAYERS = 2;
export const MAX_NAME_LENGTH = 14;

/* ---- Round timing ------------------------------------------------------- */

export const COUNTDOWN_SECONDS = 3;

/** How long players get to race for a word before the round is a draw. */
export const WORD_RACE_DURATION_MS = 30_000;

/** Soft cap on secret letter selection, so one idle player cannot stall forever. */
export const LETTER_ENTRY_DURATION_MS = 45_000;

/** Pause on the result screen before the host may advance. */
export const RESULT_DWELL_MS = 1_200;

/** Timer bar switches colour at these fractions of time remaining. */
export const TIMER_WARN_FRACTION = 0.5;
export const TIMER_CRITICAL_FRACTION = 0.2;

/* ---- Networking --------------------------------------------------------- */

/** Give up on establishing the peer connection after this long. Exceeding it
 *  almost always means the network is blocking WebRTC rather than that the
 *  room does not exist. */
export const CONNECT_TIMEOUT_MS = 12_000;

/** How long the host holds a disconnected player's seat open before releasing it. */
export const RECONNECT_GRACE_MS = 20_000;

/** Backoff schedule for guest reconnect attempts, in milliseconds. */
export const RECONNECT_BACKOFF_MS = [400, 900, 1_800, 3_500, 6_000];

/** Clock-offset estimation: samples taken, and the gap between them. */
export const PING_SAMPLE_COUNT = 5;
export const PING_INTERVAL_MS = 350;

/** Heartbeat used to notice a peer that stopped responding without closing. */
export const HEARTBEAT_INTERVAL_MS = 2_500;
export const HEARTBEAT_TIMEOUT_MS = 8_000;

/** Submissions arriving inside this window are sorted by offset-corrected
 *  client time rather than raw arrival order, so a laggier player is not
 *  penalised for their latency. */
export const SUBMIT_COALESCE_WINDOW_MS = 120;

/* ---- Dictionary --------------------------------------------------------- */

/** Per-provider budget. Exceeding it falls through to the next provider. */
export const DICTIONARY_TIMEOUT_MS = 2_500;

export const FREE_DICTIONARY_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en/";
export const MERRIAM_WEBSTER_ENDPOINT =
  "https://www.dictionaryapi.com/api/v3/references/collegiate/json/";

/** Merriam-Webster requires a key. Paste one here to promote it to primary. */
export const MERRIAM_WEBSTER_API_KEY = "";

export const LOCAL_WORDLIST_URL = "./assets/wordlist.txt";

/* ---- Word rules -------------------------------------------------------- */

export const MIN_WORD_LENGTH = 2;
export const MAX_WORD_LENGTH = 24;
export const POINTS_PER_ROUND_WIN = 1;

/* ---- UI ---------------------------------------------------------------- */

export const TOAST_DURATION_MS = 3_400;
export const TOAST_EXIT_MS = 200;
export const MAX_TOASTS = 3;
export const CONFETTI_COUNT = 34;

/* ---- Enumerations ------------------------------------------------------
   Plain frozen objects rather than strings scattered through the codebase,
   so a typo is a runtime error at the source instead of a silent no-op. */

export const SCREEN = Object.freeze({
  HOME: "home",
  CREATE: "create",
  JOIN: "join",
  LOBBY: "lobby",
  GAME: "game",
  ERROR: "error",
});

export const ROLE = Object.freeze({
  HOST: "host",
  GUEST: "guest",
});

/** Which side of the rule a player supplies this round. */
export const SEAT = Object.freeze({
  STARTER: "starter",
  ENDER: "ender",
});

export const PHASE = Object.freeze({
  LOBBY: "lobby",
  LETTER_ENTRY: "letter-entry",
  COUNTDOWN: "countdown",
  RACE: "race",
  RESULT: "result",
  MATCH_OVER: "match-over",
});

export const CONNECTION = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  /** Host has a room but nobody has joined yet. */
  WAITING: "waiting",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  /** Terminal: could not establish or re-establish the peer link. */
  FAILED: "failed",
  /** Terminal: the room ended cleanly (host left, or we left). */
  CLOSED: "closed",
});

/** Why a word was refused. The UI maps these to sentences; game logic never
 *  builds user-facing strings itself. */
export const REJECTION = Object.freeze({
  TOO_SHORT: "too-short",
  TOO_LONG: "too-long",
  NOT_ALPHA: "not-alpha",
  WRONG_START: "wrong-start",
  WRONG_END: "wrong-end",
  ALREADY_USED: "already-used",
  NOT_A_WORD: "not-a-word",
  WRONG_PHASE: "wrong-phase",
  ROUND_OVER: "round-over",
});

/** Why the match ended or the connection died. */
export const FAILURE = Object.freeze({
  ROOM_TAKEN: "room-taken",
  ROOM_NOT_FOUND: "room-not-found",
  ROOM_FULL: "room-full",
  P2P_BLOCKED: "p2p-blocked",
  HOST_LEFT: "host-left",
  GUEST_LEFT: "guest-left",
  BROKER_UNREACHABLE: "broker-unreachable",
  VERSION_MISMATCH: "version-mismatch",
});
