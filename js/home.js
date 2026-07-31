import { SCREEN } from "./constants.js";
import { createProfileStore, sanitiseName } from "./profile.js";
import { isValidRoomCode } from "./router.js";
import { createHeroDemo } from "../ui/HeroDemo.js";
import { createScreens } from "../ui/Screen.js";

/**
 * The landing page.
 *
 * Deliberately knows nothing about networking, game state or the store. Its only
 * job is to find out who you are and what you want to do, then hand off to
 * play.html — which is where a connection is opened.
 *
 * That ordering is what makes the two-document split safe. A live WebRTC
 * connection cannot survive a navigation, so the connection must be created
 * *after* the last page load, never before it. The landing page therefore never
 * connects; it only routes.
 */
function boot() {
  const dom = {
    screens: document.getElementById("screens"),
    heroLetterA: document.getElementById("hero-letter-a"),
    heroLetterB: document.getElementById("hero-letter-b"),
    heroWord: document.getElementById("hero-word"),
    createName: document.getElementById("create-name"),
    joinCode: document.getElementById("join-code"),
    joinName: document.getElementById("join-name"),
  };

  const profile = createProfileStore();
  const screens = createScreens(dom.screens);
  const heroDemo = createHeroDemo({
    letterA: dom.heroLetterA,
    letterB: dom.heroLetterB,
    word: dom.heroWord,
  });

  const createForm = document.querySelector('[data-form="create"]');
  const joinForm = document.querySelector('[data-form="join"]');

  /** @param {string} screen a SCREEN value */
  function show(screen, options = {}) {
    if (screen === SCREEN.HOME) heroDemo.start();
    else heroDemo.stop();
    screens.show(screen, options);
    // Hash only, so the shareable URL stays the clean root for search engines.
    const hash = screen === SCREEN.HOME ? "" : `#/${screen}`;
    history.replaceState(null, "", `${location.pathname}${hash}`);
  }

  /**
   * Hands off to the app. The name and the intent are both in storage, so the
   * URL carries no state that a host could rewrite away — the query string is
   * kept only as a belt-and-braces fallback.
   *
   * @param {{host?: boolean, room?: string}} intent
   */
  function launch(intent) {
    profile.setIntent(intent);
    const query = new URLSearchParams(
      intent.host ? { host: "1" } : { room: intent.room },
    ).toString();
    location.href = `./play.html?${query}`;
  }

  /** @returns {string|null} */
  function readName(input, errorNode) {
    const name = sanitiseName(input.value);
    if (name.length === 0) {
      errorNode.textContent = "Add a name so your opponents know who they're racing.";
      input.focus();
      return null;
    }
    errorNode.textContent = "";
    return name;
  }

  /**
   * Fills the name fields from the saved profile so a returning player never
   * retypes their name, and relabels the buttons to say what will happen. The
   * field stays editable — remembering a name is a convenience, not a commitment.
   */
  function applySavedProfile() {
    const saved = profile.name();
    if (!saved) return;
    dom.createName.value = saved;
    dom.joinName.value = saved;
    createForm.querySelector('[type="submit"]').textContent = `Create a room as ${saved}`;
    joinForm.querySelector('[type="submit"]').textContent = `Join as ${saved}`;
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    switch (trigger.dataset.action) {
      case "go-home":
        event.preventDefault();
        show(SCREEN.HOME);
        break;
      case "go-create":
        show(SCREEN.CREATE);
        break;
      case "go-join":
        show(SCREEN.JOIN);
        break;
      default:
        break;
    }
  });

  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = readName(dom.createName, createForm.querySelector("[data-error]"));
    if (!name) return;
    profile.rememberName(name);
    launch({ host: true });
  });

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
    if (!name) return;
    profile.rememberName(name);
    launch({ room: code });
  });

  dom.joinCode.addEventListener("input", () => {
    dom.joinCode.value = dom.joinCode.value.replace(/\D/g, "");
  });

  /* ---- Entry ---------------------------------------------------------
     An invite link lands here with `?room=1234`. The code is filled in, and if
     the name is already known there is nothing left to type — focus goes to the
     button so rejoining after a closed browser is one tap. */
  applySavedProfile();

  const params = new URLSearchParams(location.search);
  const invited = params.get("room");

  if (isValidRoomCode(invited)) {
    dom.joinCode.value = invited.trim();
    show(SCREEN.JOIN, { focus: false });
    if (profile.hasName()) {
      joinForm.querySelector('[type="submit"]').focus({ preventScroll: true });
    } else {
      dom.joinName.focus();
    }
  } else if (location.hash === "#/create") {
    show(SCREEN.CREATE);
  } else if (location.hash === "#/join") {
    show(SCREEN.JOIN);
  } else {
    show(SCREEN.HOME);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
