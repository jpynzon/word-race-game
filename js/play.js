import { ACTIVITY_THROTTLE_MS, PHASE, SCREEN } from "./constants.js";
import { describeRejection } from "./messages.js";
import { createProfileStore } from "./profile.js";
import { createRouter, isValidRoomCode } from "./router.js";
import { createStore } from "./state.js";
import { createGameManager } from "../game/GameManager.js";
import { createLobbyManager } from "../game/LobbyManager.js";
import { createBoard } from "../ui/Board.js";
import { createScreens } from "../ui/Screen.js";
import { createSettingsPanel } from "../ui/SettingsPanel.js";
import { createAnnouncer, createToaster } from "../ui/Toast.js";

/**
 * The app: everything from the moment a connection is opened.
 *
 * Split from the landing page because the two have genuinely different jobs — one
 * is a static, crawlable page, this one is a stateful session. The split is only
 * safe in this direction: a live WebRTC connection cannot survive a navigation,
 * so it is opened here, after the last page load, and every in-game navigation
 * stays inside this document.
 *
 * Arrives with either `?host=1` or `?room=1234`, and takes the player's name from
 * the saved profile.
 */
function boot() {
  const dom = {
    screens: document.getElementById("screens"),
    toastRail: document.getElementById("toast-rail"),
    announcer: document.getElementById("announcer"),
    overlayRoot: document.getElementById("overlay-root"),

    connectingLabel: document.getElementById("connecting-label"),
    connectingDetail: document.getElementById("connecting-detail"),

    lobbyCode: document.getElementById("lobby-code"),
    lobbyPlayers: document.getElementById("lobby-players"),
    lobbyActions: document.getElementById("lobby-actions"),
    lobbyHint: document.getElementById("lobby-hint"),
    lobbySettings: document.getElementById("lobby-settings"),

    scoreboard: document.getElementById("scoreboard"),
    phaseLabel: document.getElementById("phase-label"),
    standoff: document.getElementById("board-standoff"),
    tiles: document.getElementById("board-tiles"),
    bridge: document.getElementById("board-bridge"),
    rule: document.getElementById("board-rule"),
    wordForm: document.getElementById("word-form"),
    wordInput: document.getElementById("word-input"),
    wordSubmit: document.getElementById("word-submit"),
    timer: document.getElementById("timer"),
    timerFill: document.getElementById("timer-fill"),
    gameActions: document.getElementById("game-actions"),

    errorLabel: document.getElementById("error-code"),
    errorTitle: document.getElementById("error-title"),
    errorDetail: document.getElementById("error-detail"),
    errorActions: document.getElementById("error-actions"),
  };

  const store = createStore();
  const profile = createProfileStore();
  const router = createRouter();
  const screens = createScreens(dom.screens);
  const toaster = createToaster(dom.toastRail);
  const announcer = createAnnouncer(dom.announcer);

  /**
   * Single place that changes what the player is looking at.
   *
   * SCREEN.HOME is not a screen in this document — it is the other document — so
   * asking for it is a page navigation. Everything else stays here, which is what
   * keeps the connection alive.
   *
   * @param {string} screen a SCREEN value
   */
  function navigate(screen, options = {}) {
    if (screen === SCREEN.HOME) {
      leavingDeliberately = true;
      location.href = "./";
      return;
    }
    screens.show(screen, options);
    store.set({ screen });
    router.syncUrl(screen, store.getState().roomCode);
  }

  let board = null;

  const game = createGameManager({
    store,
    toaster,
    navigate,
    profile,
    onWordRejected: (reason) => {
      board?.endSubmitting();
      board?.rejectWord(describeRejection(reason));
    },
    onSpectatorActivity: (update) => board?.showActivity(update),
  });

  board = createBoard({
    dom: {
      scoreboard: dom.scoreboard,
      phaseLabel: dom.phaseLabel,
      standoff: dom.standoff,
      tiles: dom.tiles,
      bridge: dom.bridge,
      rule: dom.rule,
      wordForm: dom.wordForm,
      wordInput: dom.wordInput,
      wordSubmit: dom.wordSubmit,
      timer: dom.timer,
      timerFill: dom.timerFill,
      actions: dom.gameActions,
      overlayRoot: dom.overlayRoot,
    },
    announcer,
    toaster,
    actions: {
      submitLetter: (letter) => game.submitLetter(letter),
      nextRound: () => game.nextRound(),
      restartMatch: () => game.restartMatch(),
      returnToLobby: () => game.returnToLobby(),
    },
  });

  const settingsPanel = createSettingsPanel({
    root: dom.lobbySettings,
    onChange: (patch) => game.updateSettings(patch),
  });

  const lobby = createLobbyManager({
    store,
    dom: {
      code: dom.lobbyCode,
      players: dom.lobbyPlayers,
      actions: dom.lobbyActions,
      hint: dom.lobbyHint,
    },
    actions: {
      toggleReady: () => game.toggleReady(),
      startGame: () => game.startGame(),
      leaveRoom: () => game.leaveRoom(),
    },
  });

  /* ---- Rendering ------------------------------------------------------ */
  store.subscribe((state) => {
    // The match phase decides which screen you are on, for every role. A guest
    // has no local game logic, so this is how it follows the host into and out of
    // a match: the snapshot changes the phase, and the screen follows.
    const inMatch = state.match.phase !== PHASE.LOBBY;
    if (inMatch && state.screen === SCREEN.LOBBY) navigate(SCREEN.GAME, { focus: false });
    if (!inMatch && state.screen === SCREEN.GAME) {
      board.teardown();
      navigate(SCREEN.LOBBY);
    }

    if (state.screen === SCREEN.LOBBY) {
      lobby.render(state);
      settingsPanel.render(state);
    }
    if (state.screen === SCREEN.GAME) board.render(state);
    if (state.screen === SCREEN.ERROR) renderFailure(state);
  });

  function renderFailure(state) {
    const failure = state.failure;
    if (!failure) return;
    dom.errorLabel.textContent = failure.label;
    dom.errorTitle.textContent = failure.title;
    dom.errorDetail.textContent = failure.detail;

    dom.errorActions.replaceChildren();
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn btn--primary";
    again.textContent = "Back to the start";
    again.addEventListener("click", () => game.reset());
    dom.errorActions.append(again);
  }

  /* ---- The word race --------------------------------------------------
     Submitting does not clear the field: if the word is rejected the player
     almost always wants to edit what they typed, not retype it. */
  dom.wordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const word = dom.wordInput.value.trim();
    if (word.length === 0) return;
    // Feedback before the round trip. Validation can take a dictionary lookup
    // plus a relay hop, which is easily long enough to look like nothing happened.
    board.beginSubmitting();
    game.submitWord(word);
  });

  /* Typing activity for the spectators. Throttled and length-only: a message per
     keystroke would flood the same channel the race is being decided on, and the
     text itself must never leave this tab. */
  let activityTimer = null;
  let lastReportedLength = -1;
  dom.wordInput.addEventListener("input", () => {
    const length = dom.wordInput.value.trim().length;
    if (length === lastReportedLength || activityTimer !== null) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      const current = dom.wordInput.value.trim().length;
      lastReportedLength = current;
      game.reportActivity(current);
    }, ACTIVITY_THROTTLE_MS);
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    switch (trigger.dataset.action) {
      case "go-home":
        event.preventDefault();
        game.leaveRoom();
        break;
      case "copy-invite":
        copyInvite();
        break;
      default:
        break;
    }
  });

  async function copyInvite() {
    const { roomCode } = store.getState();
    if (!roomCode) return;
    // Invites point at the landing page, not here: a guest needs to give a name
    // before a connection is worth opening.
    const link = router.inviteLink(roomCode);
    try {
      await navigator.clipboard.writeText(link);
      toaster.show("Invite link copied.", { tone: "good" });
    } catch {
      toaster.show(link, { tone: "info", duration: 9_000 });
    }
  }

  /* ---- Leaving --------------------------------------------------------
     Navigating away destroys the connection and, if you are the host, the room.
     A closed tab is unrecoverable, so the browser is asked to confirm — but only
     while a match is actually live, never for an idle lobby. */
  let leavingDeliberately = false;
  window.addEventListener("beforeunload", (event) => {
    if (leavingDeliberately) return;
    const state = store.getState();
    if (state.match.phase === PHASE.LOBBY) return;
    event.preventDefault();
    event.returnValue = "";
  });

  // Back out of the app rather than trying to route inside it.
  router.onNavigate(() => {
    const state = store.getState();
    router.syncUrl(state.screen, state.roomCode);
  });
  router.start();

  /* ---- Entry ----------------------------------------------------------
     Intent comes from storage first, the query string second. Static hosts
     rewrite URLs — `serve`'s clean-URLs turns `/play.html?host=1` into `/play`
     and drops the query outright — so anything load-bearing cannot live only in
     the address bar. */
  const params = new URLSearchParams(location.search);
  const intent = profile.takeIntent() ?? {};
  const wantsHost = intent.host === true || params.get("host") === "1";

  /* Room code, in order of trust: the handoff, then the query string, then the
     hash. The hash matters because the app keeps `#/room/8440` in the URL while
     you play — so refreshing mid-match rejoins the room instead of dumping you
     back on the landing page. A former host lands on "nobody is hosting that
     code", which is exactly what happened. */
  const room = isValidRoomCode(intent.room)
    ? intent.room
    : (params.get("room") ?? router.readInvite());
  const name = profile.name();

  if (!name || (!wantsHost && !isValidRoomCode(room))) {
    // Nothing to act on — the landing page is where identity and intent come from.
    location.replace("./");
    return;
  }

  navigate(SCREEN.CONNECTING, { focus: false });
  if (wantsHost) {
    dom.connectingLabel.textContent = "Creating your room";
    game.createRoom(name);
  } else {
    dom.connectingLabel.textContent = `Joining room ${room}`;
    game.joinRoom(room.trim(), name);
  }

  // Handles for the browser-driven end-to-end checks.
  window.__wordRace = { store, router, screens, toaster, announcer, game, board, profile, navigate };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
