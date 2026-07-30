import {
  PHASE,
  ROLE,
  TIMER_CRITICAL_FRACTION,
  TIMER_WARN_FRACTION,
  WORD_RACE_DURATION_MS,
  CONFETTI_COUNT,
} from "../js/constants.js";
import { createDeadlineTimer } from "../game/Timer.js";
import { createScoreboard } from "./Scoreboard.js";
import { createCountdownView } from "./Countdown.js";

/**
 * The game screen.
 *
 * A single render function drives every phase. It reads state and rewrites the
 * board; it never decides anything. That keeps the "both players see the same
 * thing" guarantee honest — the host and the guest run identical rendering code
 * over identical state.
 *
 * The one asymmetry is intentional: during letter entry, the local player sees
 * an input where their tile will be and the opponent's tile shows face-down.
 * The opponent's letter is not merely hidden with CSS — it is not in the
 * snapshot at all, so it is not in the page to be found.
 */
export function createBoard({ dom, announcer, toaster, actions }) {
  const scoreboard = createScoreboard({ root: dom.scoreboard });
  const countdownView = createCountdownView({ root: dom.overlayRoot, announcer });

  let raceTimer = null;
  let lastNoticeId = 0;
  let lastPhase = null;
  let lastRoundId = 0;

  /* ---- Small builders -------------------------------------------------- */

  /**
   * @param {{side: "a"|"b", glyph: string, role: string, faceDown?: boolean, empty?: boolean}} spec
   */
  function tile({ side, glyph, role, faceDown = false, empty = false }) {
    const node = document.createElement("div");
    node.className = `tile tile--${side}`;
    if (faceDown) node.classList.add("tile--hidden");
    if (empty) node.classList.add("tile--empty");

    const label = document.createElement("span");
    label.className = "tile__role";
    label.textContent = role;

    const value = document.createElement("span");
    value.className = "tile__glyph";
    value.textContent = glyph;

    node.append(label, value);
    return node;
  }

  /** The local player's letter picker, shaped exactly like the tile it becomes. */
  function letterField({ side, role }) {
    const wrap = document.createElement("div");
    wrap.className = `tile tile--${side} tile--empty`;
    wrap.style.border = "none";
    wrap.style.boxShadow = "none";
    wrap.style.background = "none";

    const input = document.createElement("input");
    input.className = "letter-field";
    input.type = "text";
    input.maxLength = 1;
    input.autocapitalize = "characters";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", `Your letter — it ${role} the word`);
    input.dataset.autofocus = "";

    // Commit on a single keystroke: this is a race, so demanding a second
    // action to confirm one character would just be friction.
    input.addEventListener("input", () => {
      const letter = input.value.replace(/[^a-z]/gi, "").slice(0, 1);
      input.value = letter.toUpperCase();
      if (letter) actions.submitLetter(letter);
    });

    wrap.append(input);
    return wrap;
  }

  function button(label, { variant = "", onClick, disabled = false }) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = variant ? `btn ${variant}` : "btn";
    node.textContent = label;
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }

  /* ---- Phase renderers -------------------------------------------------- */

  function renderStandoff(state) {
    const { match } = state;
    const isStarter = match.starterId === state.localPlayerId;
    const localSide = isStarter ? "a" : "b";
    const opponentSide = isStarter ? "b" : "a";
    const localRole = isStarter ? "starts" : "ends";
    const opponentRole = isStarter ? "ends" : "starts";
    const opponentId = isStarter ? match.enderId : match.starterId;

    // Slot A always holds the starting letter, so the rule always reads
    // left-to-right as "starts … ends" regardless of which seat you are in.
    const slotFor = (side) => (side === "a" ? dom.slotA : dom.slotB);

    if (match.phase === PHASE.LETTER_ENTRY) {
      const committed = Boolean(match.committed[state.localPlayerId]);
      slotFor(localSide).replaceChildren(
        committed
          ? tile({ side: localSide, glyph: "•", role: localRole, faceDown: true })
          : letterField({ side: localSide, role: localRole }),
      );
      slotFor(opponentSide).replaceChildren(
        tile({
          side: opponentSide,
          glyph: "•",
          role: opponentRole,
          faceDown: Boolean(match.committed[opponentId]),
          empty: !match.committed[opponentId],
        }),
      );
      return;
    }

    if (match.phase === PHASE.COUNTDOWN) {
      dom.slotA.replaceChildren(tile({ side: "a", glyph: "•", role: "starts", faceDown: true }));
      dom.slotB.replaceChildren(tile({ side: "b", glyph: "•", role: "ends", faceDown: true }));
      return;
    }

    if (match.letters) {
      const a = tile({ side: "a", glyph: match.letters.start, role: "starts" });
      const b = tile({ side: "b", glyph: match.letters.end, role: "ends" });
      // Both flap at once — the rules say the letters are revealed together.
      const justRevealed = lastPhase === PHASE.COUNTDOWN && match.phase === PHASE.RACE;
      if (justRevealed) {
        a.classList.add("tile--reveal");
        b.classList.add("tile--reveal");
        dom.standoff.classList.add("is-revealing");
        setTimeout(() => dom.standoff.classList.remove("is-revealing"), 700);
      }
      dom.slotA.replaceChildren(a);
      dom.slotB.replaceChildren(b);
      return;
    }

    dom.slotA.replaceChildren(tile({ side: "a", glyph: "?", role: "starts", empty: true }));
    dom.slotB.replaceChildren(tile({ side: "b", glyph: "?", role: "ends", empty: true }));
  }

  function renderRule(state) {
    const { match } = state;
    dom.rule.replaceChildren();

    if (match.phase === PHASE.LETTER_ENTRY) {
      const isStarter = match.starterId === state.localPlayerId;
      const line = document.createElement("p");
      line.className = "note";
      line.textContent = isStarter
        ? "Pick the letter the word must start with. Your opponent can't see it."
        : "Pick the letter the word must end with. Your opponent can't see it.";
      dom.rule.append(line);
      return;
    }

    if (match.letters && (match.phase === PHASE.RACE || match.phase === PHASE.RESULT)) {
      const line = document.createElement("p");
      line.className = "headline";
      line.innerHTML = `Starts <strong>${match.letters.start.toUpperCase()}</strong> · ends <strong>${match.letters.end.toUpperCase()}</strong>`;
      dom.rule.append(line);
    }
  }

  function renderWordForm(state) {
    const { match } = state;
    const racing = match.phase === PHASE.RACE;
    dom.wordForm.hidden = !racing;
    dom.wordInput.disabled = !racing;

    if (!racing) {
      dom.wordInput.value = "";
      return;
    }
    // A new round means a clean field, but re-renders inside a round must not
    // wipe what the player is mid-way through typing.
    if (lastRoundId !== match.roundId) {
      dom.wordInput.value = "";
      dom.wordInput.classList.remove("is-rejected", "is-accepted");
      requestAnimationFrame(() => dom.wordInput.focus({ preventScroll: true }));
    }
  }

  function renderTimer(state) {
    const { match } = state;
    raceTimer?.stop();
    raceTimer = null;

    if (match.phase !== PHASE.RACE || !match.raceEndsAt) {
      dom.timer.hidden = true;
      return;
    }

    dom.timer.hidden = false;
    raceTimer = createDeadlineTimer({
      endsAt: match.raceEndsAt,
      durationMs: WORD_RACE_DURATION_MS,
      intervalMs: 100,
      onTick: ({ fraction }) => {
        dom.timerFill.style.transform = `scaleX(${fraction})`;
        dom.timer.dataset.urgency =
          fraction <= TIMER_CRITICAL_FRACTION
            ? "critical"
            : fraction <= TIMER_WARN_FRACTION
              ? "warn"
              : "calm";
      },
      onDone: () => {},
    });
    raceTimer.start();
  }

  function renderPhaseLabel(state) {
    const { match } = state;
    const labels = {
      [PHASE.LETTER_ENTRY]: `Round ${match.roundNumber} · choose your letter`,
      [PHASE.COUNTDOWN]: `Round ${match.roundNumber} · revealing`,
      [PHASE.RACE]: `Round ${match.roundNumber} · go`,
      [PHASE.RESULT]: `Round ${match.roundNumber} · result`,
    };
    dom.phaseLabel.textContent = labels[match.phase] ?? "";
  }

  function renderActions(state) {
    dom.actions.replaceChildren();
    const isHost = state.role === ROLE.HOST;
    const { match } = state;

    if (match.phase === PHASE.RESULT) {
      const summary = document.createElement("p");
      summary.className = "headline";
      if (match.result?.draw) {
        summary.textContent = "Round drawn — nobody found a word.";
      } else {
        const winner = state.players[match.result?.winnerId];
        const mine = match.result?.winnerId === state.localPlayerId;
        summary.textContent = mine
          ? `You got it: ${match.result.word.toUpperCase()}`
          : `${winner?.name ?? "Your opponent"} got it: ${match.result.word.toUpperCase()}`;
      }
      dom.actions.append(summary);

      if (isHost) {
        dom.actions.append(
          button("Next round", { variant: "btn--primary", onClick: actions.nextRound }),
        );
      } else {
        const waiting = document.createElement("p");
        waiting.className = "note";
        waiting.textContent = "Waiting for the host to deal the next round.";
        dom.actions.append(waiting);
      }
    }

    if (isHost && match.phase !== PHASE.RESULT) {
      dom.actions.append(
        button("Restart match", { variant: "btn--quiet", onClick: actions.restartMatch }),
      );
    }
    if (isHost) {
      dom.actions.append(
        button("Back to lobby", { variant: "btn--quiet", onClick: actions.returnToLobby }),
      );
    }
  }

  /* ---- Celebration ------------------------------------------------------ */

  /** Tiny paper tiles in the winner's ink. Removed as soon as they land. */
  function celebrate(winnerSeatIndex) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const field = document.createElement("div");
    field.className = "confetti";
    field.style.setProperty(
      "--player-ink",
      winnerSeatIndex === 1 ? "var(--ink-blue)" : "var(--ink-pink)",
    );

    for (let i = 0; i < CONFETTI_COUNT; i += 1) {
      const bit = document.createElement("span");
      bit.className = "confetti__bit";
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.setProperty("--drift", `${(Math.random() - 0.5) * 34}vw`);
      bit.style.setProperty("--spin", `${360 + Math.random() * 540}deg`);
      bit.style.setProperty("--fall", `${1.9 + Math.random() * 1.4}s`);
      bit.style.setProperty("--delay", `${Math.random() * 320}ms`);
      field.append(bit);
    }

    dom.overlayRoot.append(field);
    setTimeout(() => field.remove(), 4_000);
  }

  /* ---- Public ----------------------------------------------------------- */

  return {
    /** @param {object} state */
    render(state) {
      const { match } = state;

      // The countdown is an overlay driven by the deadline in the snapshot, so
      // both screens run it off their own clock from the same target.
      if (match.phase === PHASE.COUNTDOWN && match.countdownEndsAt) {
        if (!countdownView.isShowing()) countdownView.show(match.countdownEndsAt);
      } else {
        countdownView.hide();
      }

      scoreboard.render(state);
      renderPhaseLabel(state);
      renderStandoff(state);
      renderRule(state);
      renderWordForm(state);
      renderTimer(state);
      renderActions(state);

      // A win jolts the whole board out of register, then snaps back.
      if (
        match.phase === PHASE.RESULT &&
        lastPhase !== PHASE.RESULT &&
        match.result &&
        !match.result.draw
      ) {
        dom.standoff.classList.add("is-jolting");
        setTimeout(() => dom.standoff.classList.remove("is-jolting"), 520);
        celebrate(state.playerOrder.indexOf(match.result.winnerId));
        announcer.say(
          `${state.players[match.result.winnerId]?.name ?? "Opponent"} won with ${match.result.word}`,
        );
      }
      if (match.phase === PHASE.RESULT && lastPhase !== PHASE.RESULT && match.result?.draw) {
        announcer.say("Round drawn. Nobody found a word.");
      }
      if (match.phase === PHASE.RACE && lastPhase === PHASE.COUNTDOWN && match.letters) {
        announcer.say(
          `Go. Starts with ${match.letters.start}, ends with ${match.letters.end}.`,
        );
      }

      // Notices ride in the snapshot, so both players toast the same thing once.
      if (match.notice && match.notice.id !== lastNoticeId) {
        lastNoticeId = match.notice.id;
        toaster.show(match.notice.text, { tone: match.notice.tone });
      }

      lastPhase = match.phase;
      lastRoundId = match.roundId;
    },

    /** Feedback on the local player's own rejected word. */
    rejectWord(message) {
      dom.wordInput.classList.remove("is-accepted");
      dom.wordInput.classList.add("is-rejected");
      setTimeout(() => dom.wordInput.classList.remove("is-rejected"), 420);
      dom.wordInput.select();
      toaster.show(message, { tone: "bad" });
    },

    /** Feedback the moment a word is accepted, before the snapshot lands. */
    acceptWord() {
      dom.wordInput.classList.remove("is-rejected");
      dom.wordInput.classList.add("is-accepted");
    },

    /** Stops timers and clears view memory when the board is left. */
    teardown() {
      raceTimer?.stop();
      raceTimer = null;
      countdownView.hide();
      scoreboard.reset();
      lastPhase = null;
      lastRoundId = 0;
    },
  };
}
