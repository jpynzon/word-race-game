import { MAX_NAME_LENGTH, SCREEN } from "./constants.js";
import { createRouter, isValidRoomCode } from "./router.js";
import { createStore } from "./state.js";
import { createHeroDemo } from "../ui/HeroDemo.js";
import { createScreens } from "../ui/Screen.js";
import { createAnnouncer, createToaster } from "../ui/Toast.js";

/**
 * Composition root.
 *
 * This is the only place that reaches into the DOM for top-level elements and
 * the only place that wires modules together. Everything it builds receives its
 * dependencies as arguments, so nothing below this file holds a global.
 */
function boot() {
  const dom = {
    screens: document.getElementById("screens"),
    toastRail: document.getElementById("toast-rail"),
    announcer: document.getElementById("announcer"),
    mastheadSlot: document.getElementById("masthead-slot"),
    heroLetterA: document.getElementById("hero-letter-a"),
    heroLetterB: document.getElementById("hero-letter-b"),
    heroWord: document.getElementById("hero-word"),
    joinCode: document.getElementById("join-code"),
    joinName: document.getElementById("join-name"),
    createName: document.getElementById("create-name"),
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

  /* Networking and gameplay land in the next phases. Until then the setup
     screens are fully interactive and stop at the point they would connect. */
  const game = {
    async createRoom(name) {
      toaster.show(`Ready to host as ${name} — connecting lands in the next phase.`, {
        tone: "info",
      });
    },
    async joinRoom(code, name) {
      toaster.show(`Ready to join ${code} as ${name} — connecting lands in the next phase.`, {
        tone: "info",
      });
    },
  };

  /**
   * Single place that changes what the player is looking at. Screen-entry side
   * effects (starting the hero loop, syncing the URL) belong here so no caller
   * has to remember them.
   *
   * @param {string} screen a SCREEN value
   * @param {{focus?: boolean}} [options]
   */
  function goto(screen, options = {}) {
    if (screen === SCREEN.HOME) heroDemo.start();
    else heroDemo.stop();

    screens.show(screen, options);
    store.set({ screen });
    router.syncUrl(screen, store.getState().roomCode);
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

  /* ---- Global click delegation ---------------------------------------
     One listener for every `[data-action]` control, so screens can be
     re-rendered freely without rebinding handlers. */
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case "go-home":
        event.preventDefault();
        goto(SCREEN.HOME);
        break;
      case "go-create":
        goto(SCREEN.CREATE);
        break;
      case "go-join":
        goto(SCREEN.JOIN);
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
      // Clipboard access is denied in some contexts; show the link instead of failing silently.
      toaster.show(link, { tone: "info", duration: 9_000 });
    }
  }

  /* ---- Setup forms --------------------------------------------------- */
  const createForm = document.querySelector('[data-form="create"]');
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const errorNode = createForm.querySelector("[data-error]");
    const name = readName(dom.createName, errorNode);
    if (name) game.createRoom(name);
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
    if (name) game.joinRoom(code, name);
  });

  // Codes are numeric only; strip anything else as it is typed.
  dom.joinCode.addEventListener("input", () => {
    dom.joinCode.value = dom.joinCode.value.replace(/\D/g, "");
  });

  /* ---- Browser navigation -------------------------------------------
     Back out of a setup screen freely. Backing out of a live room needs a
     confirmation, which arrives with the room itself in the next phase. */
  router.onNavigate((intent) => {
    if (intent.screen === SCREEN.LOBBY || intent.screen === SCREEN.GAME) return;
    goto(intent.screen);
  });
  router.start();

  /* ---- Entry ---------------------------------------------------------
     An invite link skips straight to the join form with the code filled in,
     so the only thing left to do is say who you are. */
  const invitedCode = router.readInvite();
  if (invitedCode) {
    dom.joinCode.value = invitedCode;
    goto(SCREEN.JOIN, { focus: false });
    dom.joinName.focus();
  } else {
    goto(SCREEN.HOME);
  }

  // Handles for the browser-driven end-to-end checks in each phase's verification.
  window.__wordRace = { store, router, screens, toaster, announcer, goto };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
