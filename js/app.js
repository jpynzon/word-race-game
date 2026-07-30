import { MAX_NAME_LENGTH, SCREEN } from "./constants.js";
import { createRouter, isValidRoomCode } from "./router.js";
import { createStore } from "./state.js";
import { createGameManager } from "../game/GameManager.js";
import { createLobbyManager } from "../game/LobbyManager.js";
import { createHeroDemo } from "../ui/HeroDemo.js";
import { createScreens } from "../ui/Screen.js";
import { createAnnouncer, createToaster } from "../ui/Toast.js";

/**
 * Composition root.
 *
 * The only place that reaches for top-level DOM nodes and the only place that
 * wires modules together. Everything it builds receives its dependencies as
 * arguments, so nothing below this file holds a global or reaches sideways for
 * a collaborator.
 */
function boot() {
  const dom = {
    screens: document.getElementById("screens"),
    toastRail: document.getElementById("toast-rail"),
    announcer: document.getElementById("announcer"),
    heroLetterA: document.getElementById("hero-letter-a"),
    heroLetterB: document.getElementById("hero-letter-b"),
    heroWord: document.getElementById("hero-word"),
    joinCode: document.getElementById("join-code"),
    joinName: document.getElementById("join-name"),
    createName: document.getElementById("create-name"),
    lobbyCode: document.getElementById("lobby-code"),
    lobbyPlayers: document.getElementById("lobby-players"),
    lobbyActions: document.getElementById("lobby-actions"),
    lobbyHint: document.getElementById("lobby-hint"),
    errorLabel: document.getElementById("error-code"),
    errorTitle: document.getElementById("error-title"),
    errorDetail: document.getElementById("error-detail"),
    errorActions: document.getElementById("error-actions"),
  };

  const store = createStore();
  const router = createRouter();
  const screens = createScreens(dom.screens);
  const toaster = createToaster(dom.toastRail);
  const announcer = createAnnouncer(dom.announcer);
  const heroDemo = createHeroDemo({
    letterA: dom.heroLetterA,
    letterB: dom.heroLetterB,
    word: dom.heroWord,
  });

  /**
   * Single place that changes what the player is looking at. Screen-entry side
   * effects (starting the hero loop, syncing the URL) belong here so no caller
   * has to remember them.
   *
   * @param {string} screen a SCREEN value
   * @param {{focus?: boolean}} [options]
   */
  function navigate(screen, options = {}) {
    if (screen === SCREEN.HOME) heroDemo.start();
    else heroDemo.stop();

    screens.show(screen, options);
    store.set({ screen });
    router.syncUrl(screen, store.getState().roomCode);
  }

  const game = createGameManager({ store, toaster, navigate });

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

  /* ---- Rendering ------------------------------------------------------
     One subscription, and each screen renders only when it is the visible one.
     Because the store batches writes into a microtask, a burst of related
     updates produces a single render rather than a half-applied one. */
  store.subscribe((state) => {
    if (state.screen === SCREEN.LOBBY) lobby.render(state);
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

  /** Reads and validates a display name field. @returns {string|null} */
  function readName(input, errorNode) {
    const name = input.value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
    if (name.length === 0) {
      errorNode.textContent = "Add a name so your opponent knows who they're racing.";
      input.focus();
      return null;
    }
    errorNode.textContent = "";
    return name;
  }

  /**
   * Disables a form's submit button while an async action runs, so an impatient
   * double-click cannot start two connection attempts.
   *
   * @param {HTMLFormElement} form
   * @param {() => Promise<void>} action
   */
  async function withPending(form, action) {
    const submit = form.querySelector('[type="submit"]');
    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Connecting…";
    try {
      await action();
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  }

  /* ---- Global click delegation ---------------------------------------
     One listener for every `[data-action]` control, so screens can be
     re-rendered freely without rebinding handlers. */
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case "go-home":
        event.preventDefault();
        navigate(SCREEN.HOME);
        break;
      case "go-create":
        navigate(SCREEN.CREATE);
        break;
      case "go-join":
        navigate(SCREEN.JOIN);
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
    const link = router.inviteLink(roomCode);
    try {
      await navigator.clipboard.writeText(link);
      toaster.show("Invite link copied.", { tone: "good" });
    } catch {
      // Clipboard access is denied in some contexts; show the link rather than
      // failing silently, so the player can still copy it by hand.
      toaster.show(link, { tone: "info", duration: 9_000 });
    }
  }

  /* ---- Setup forms --------------------------------------------------- */
  const createForm = document.querySelector('[data-form="create"]');
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const errorNode = createForm.querySelector("[data-error]");
    const name = readName(dom.createName, errorNode);
    if (name) withPending(createForm, () => game.createRoom(name));
  });

  const joinForm = document.querySelector('[data-form="join"]');
  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const errorNode = joinForm.querySelector("[data-error]");
    const code = dom.joinCode.value.trim();
    if (!isValidRoomCode(code)) {
      errorNode.textContent = "Room codes are four digits.";
      dom.joinCode.focus();
      return;
    }
    const name = readName(dom.joinName, errorNode);
    if (name) withPending(joinForm, () => game.joinRoom(code, name));
  });

  // Codes are numeric only; strip anything else as it is typed.
  dom.joinCode.addEventListener("input", () => {
    dom.joinCode.value = dom.joinCode.value.replace(/\D/g, "");
  });

  /* ---- Browser navigation -------------------------------------------
     Back out of a setup screen freely. Leaving a live room has to go through
     GameManager so the opponent is told, so the browser button is ignored there
     in favour of the explicit Leave control. */
  router.onNavigate((intent) => {
    const current = store.getState();
    if (current.screen === SCREEN.LOBBY || current.screen === SCREEN.GAME) {
      router.syncUrl(current.screen, current.roomCode);
      return;
    }
    if (intent.screen === SCREEN.LOBBY || intent.screen === SCREEN.GAME) return;
    navigate(intent.screen);
  });
  router.start();

  /* ---- Entry ---------------------------------------------------------
     An invite link skips straight to the join form with the code filled in, so
     the only thing left to do is say who you are. */
  const invitedCode = router.readInvite();
  if (invitedCode) {
    dom.joinCode.value = invitedCode;
    navigate(SCREEN.JOIN, { focus: false });
    dom.joinName.focus();
  } else {
    navigate(SCREEN.HOME);
  }

  // Handles for the browser-driven end-to-end checks in each phase's verification.
  window.__wordRace = { store, router, screens, toaster, announcer, game, navigate };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
