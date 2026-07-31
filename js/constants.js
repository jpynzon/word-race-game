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

/** The largest room any mode allows. Seat arrays and the lobby size to this. */
export const MAX_PLAYERS = 6;
export const MAX_NAME_LENGTH = 14;

/* ---- Game modes ---------------------------------------------------------
   Two ways to build the rule from the players' letters. Both share the same
   settings, the same timer, and the same scoring — only the shape of the rule
   and the seat count differ. */

export const GAME_MODE = Object.freeze({
  /** Two players. The word starts with one letter and ends with the other. */
  DUEL: "duel",
  /** Three or four players. The word must contain every player's letter. */
  CONTAINS: "contains",
  /**
   * Two to four players. Same rule as a duel, but only two play each round
   * while the rest watch, and the pairing rotates so everyone faces everyone.
   */
  ROUND_ROBIN: "round-robin",
});

/** Seat counts each mode supports. */
export const MODE_CAPACITY = Object.freeze({
  [GAME_MODE.DUEL]: { min: 2, max: 2 },
  [GAME_MODE.CONTAINS]: { min: 2, max: 6 },
  [GAME_MODE.ROUND_ROBIN]: { min: 3, max: 6 },
});

/* ---- Host-configurable settings ----------------------------------------
   Defaults and bounds live here; game/GameSettings.js owns validation. Bounds
   exist because these arrive over the network from the host and a hostile or
   buggy peer must not be able to set a zero-second timer. */

/** Offered as discrete choices rather than a free number: a slider inviting
 *  someone to pick 7 seconds helps nobody. */
export const RACE_DURATION_CHOICES_MS = Object.freeze([
  15_000, 30_000, 45_000, 60_000, 90_000,
]);

export const RACE_DURATION_BOUNDS_MS = Object.freeze({ min: 10_000, max: 180_000 });
export const MIN_WORD_LENGTH_BOUNDS = Object.freeze({ min: 2, max: 10 });

export const DEFAULT_SETTINGS = Object.freeze({
  mode: GAME_MODE.DUEL,
  raceDurationMs: 30_000,
  minWordLength: 2,
});

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

/* ---- Connection paths ---------------------------------------------------
   Direct WebRTC is the fast path and the default. Some networks — symmetric
   NAT, corporate and school firewalls — will not permit it at all, so there is
   a relay fallback that goes over plain WSS on a standard port.

   The host listens on BOTH at once. A fallback chain alone would not work: if
   the host were on WebRTC and a guest could only reach the relay, they would
   never meet. Guests try direct first and fall back. */

export const TRANSPORT = Object.freeze({
  /** WebRTC, peers talking straight to each other. Lowest latency. */
  DIRECT: "direct",
  /** Messages relayed through a public broker over WSS. Works almost anywhere. */
  RELAY: "relay",
});

/** STUN lets a peer discover its own public address. Free, no account. */
export const ICE_SERVERS = Object.freeze([
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]);

/**
 * TURN relays the media/data itself and is what rescues the hardest networks
 * while staying on WebRTC. Empty by default because every TURN provider needs
 * credentials, and requiring an account would break this game's zero-setup
 * promise — the MQTT relay below covers the same cases without one.
 *
 * Fill this in to prefer relayed WebRTC over the message relay:
 *   { urls: "turn:host:3478", username: "user", credential: "pass" }
 */
export const TURN_SERVERS = Object.freeze([]);

/**
 * Public MQTT-over-WSS brokers, tried in order. Port 443/8084 WSS gets through
 * effectively any firewall that allows normal HTTPS.
 *
 * These are open community brokers: no signup, no keys, and no privacy. See the
 * README — a word game's traffic is low-stakes, and pointing this at your own
 * broker closes the gap.
 */
export const RELAY_BROKER_URLS = Object.freeze([
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://test.mosquitto.org:8081/mqtt",
]);

export const RELAY_TOPIC_PREFIX = "wordrace/v1";
export const MQTT_CLIENT_URL = "https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js";

/** How long a guest waits for the host's presence message before giving up. */
export const RELAY_PRESENCE_TIMEOUT_MS = 6_000;
/** How long a host waits to see whether a code is already claimed on the relay. */
export const RELAY_CLAIM_WAIT_MS = 1_500;
/** Host re-announces presence this often, so a late guest still finds the room. */
export const RELAY_PRESENCE_INTERVAL_MS = 4_000;

/** How long the host holds a disconnected player's seat open before releasing it. */
export const RECONNECT_GRACE_MS = 20_000;

/**
 * How long a newly opened connection has to identify itself with HELLO.
 *
 * A data channel can open on the host's side while the joining player's side
 * never finishes negotiating, leaving a connection that will never introduce
 * itself. Without a deadline that silent connection holds the only guest seat
 * forever and every genuine reconnect is refused as "room full".
 */
export const HELLO_TIMEOUT_MS = 10_000;

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

/**
 * How often a duellist reports their word length to the spectators. A message
 * per keystroke would flood the same channel the race is being decided on.
 */
export const ACTIVITY_THROTTLE_MS = 220;

export const TOAST_DURATION_MS = 3_400;
export const TOAST_EXIT_MS = 200;
export const MAX_TOASTS = 3;
export const CONFETTI_COUNT = 34;

/* ---- Enumerations ------------------------------------------------------
   Plain frozen objects rather than strings scattered through the codebase,
   so a typo is a runtime error at the source instead of a silent no-op. */

export const SCREEN = Object.freeze({
  /* index.html */
  HOME: "home",
  CREATE: "create",
  JOIN: "join",
  /* play.html */
  CONNECTING: "connecting",
  LOBBY: "lobby",
  GAME: "game",
  ERROR: "error",
});

/**
 * How long the submit button stays in its "validating" state before giving up on
 * hearing back. A dictionary lookup plus a relay round trip is the worst case;
 * past that, something went wrong and a stuck button is worse than a wrong label.
 */
export const SUBMIT_PENDING_TIMEOUT_MS = 8_000;

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
  /** CONTAINS mode: the word is missing one or more of the required letters. */
  MISSING_LETTERS: "missing-letters",
  ALREADY_USED: "already-used",
  NOT_A_WORD: "not-a-word",
  WRONG_PHASE: "wrong-phase",
  ROUND_OVER: "round-over",
  /** Round-robin: this player is observing, not duelling, this round. */
  NOT_PLAYING: "not-playing",
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
