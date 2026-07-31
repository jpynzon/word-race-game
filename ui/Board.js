import {
  CONFETTI_COUNT,
  GAME_MODE,
  PHASE,
  ROLE,
  SUBMIT_PENDING_TIMEOUT_MS,
  TIMER_CRITICAL_FRACTION,
  TIMER_WARN_FRACTION,
} from "../js/constants.js";
import { createDeadlineTimer } from "../game/Timer.js";
import { createScoreboard } from "./Scoreboard.js";
import { createCountdownView } from "./Countdown.js";

/**
 * The game screen.
 *
 * A single render function drives every phase and both modes. It reads state and
 * rewrites the board; it never decides anything. That keeps the "everyone sees
 * the same thing" guarantee honest — every player runs identical rendering code
 * over identical state.
 *
 * The tile row is built from the roster, so a two-player duel and a four-player
 * letter hunt share one code path. The only asymmetry is intentional: during
 * letter entry the local player sees an input where their own tile will be, and
 * everyone else's tile shows face-down. Their letters are not merely hidden with
 * CSS — they are not in the snapshot at all, so they are not in the page to be
 * found.
 */
export function createBoard({ dom, announcer, toaster, actions }) {
  const scoreboard = createScoreboard({ root: dom.scoreboard });
  const countdownView = createCountdownView({ root: dom.overlayRoot, announcer });

  let raceTimer = null;
  let lastNoticeId = 0;
  let lastPhase = null;
  let lastRoundId = 0;

  /**
   * Live duellist activity, for spectators. View-only state: it arrives through
   * targeted messages rather than the snapshot, precisely so it cannot reach a
   * duellist about their rival.
   * @type {Map<string, {length: number, attempts: number}>}
   */
  const activity = new Map();

  /** The state from the most recent render, so the feed can refresh alone. */
  let lastState = null;

  /** Guards the submit button's pending state. @see beginSubmitting */
  let pendingTimer = null;
  const SUBMIT_LABEL = "Submit word";

  /** Releases the submit button. Safe to call when it was never pending. */
  function releaseSubmit() {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    if (!dom.wordSubmit) return;
    dom.wordSubmit.disabled = false;
    dom.wordSubmit.textContent = SUBMIT_LABEL;
    dom.wordSubmit.removeAttribute("aria-busy");
  }

  /* ---- Small builders -------------------------------------------------- */

  /**
   * @param {{
   *   seat: number, glyph: string, role: string,
   *   faceDown?: boolean, empty?: boolean, reveal?: boolean
   * }} spec
   */
  function tile({ seat, glyph, role, faceDown = false, empty = false, reveal = false }) {
    const node = document.createElement("div");
    node.className = `tile tile--seat-${seat}`;
    if (faceDown) node.classList.add("tile--hidden");
    if (empty) node.classList.add("tile--empty");
    if (reveal) node.classList.add("tile--reveal");

    if (role) {
      const label = document.createElement("span");
      label.className = "tile__role";
      label.textContent = role;
      node.append(label);
    }

    const value = document.createElement("span");
    value.className = "tile__glyph";
    value.textContent = glyph;
    node.append(value);
    return node;
  }

  /** The local player's letter picker, shaped exactly like the tile it becomes. */
  function letterField({ seat, role }) {
    const input = document.createElement("input");
    input.className = `letter-field tile--seat-${seat}`;
    input.type = "text";
    input.maxLength = 1;
    input.autocapitalize = "characters";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", role ? `Your letter — it ${role} the word` : "Your letter");
    input.dataset.autofocus = "";

    // Commit on a single keystroke: this is a race, so demanding a second action
    // to confirm one character would just be friction.
    input.addEventListener("input", () => {
      const letter = input.value.replace(/[^a-z]/gi, "").slice(0, 1);
      input.value = letter.toUpperCase();
      if (letter) actions.submitLetter(letter);
    });
    return input;
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

  /**
   * One ink band per tile. Neighbouring bands overlap and multiply, so the
   * number of overprint seams follows the roster.
   *
   * @param {number[]} seats seat indices, in row order
   */
  function renderBridge(seats) {
    dom.bridge.replaceChildren();
    for (const seat of seats) {
      const segment = document.createElement("span");
      segment.className = `bridge__seg tile--seat-${seat}`;
      dom.bridge.append(segment);
    }
  }

  /* ---- The tile row ----------------------------------------------------- */

  /**
   * Decides what each seat's tile looks like in the current phase.
   *
   * Row order is by seat, except in a duel where it follows the rule so it always
   * reads left-to-right as "starts … ends" no matter which seat you occupy.
   */
  function renderTiles(state) {
    const { match } = state;

    /** @type {{playerId: string, seat: number, role: string}[]} */
    let row;
    if (match.starterId && match.enderId) {
      // Two-letter modes: the row follows the rule, not the seating, so it always
      // reads left-to-right as "starts … ends" whichever seat you occupy.
      row = [
        {
          playerId: match.starterId,
          seat: state.playerOrder.indexOf(match.starterId),
          role: "starts",
        },
        {
          playerId: match.enderId,
          seat: state.playerOrder.indexOf(match.enderId),
          role: "ends",
        },
      ];
    } else {
      // Letter hunt: one tile per active player, in seat order.
      const active = match.activeIds?.length ? match.activeIds : state.playerOrder;
      row = active.map((playerId) => ({
        playerId,
        seat: state.playerOrder.indexOf(playerId),
        role: "",
      }));
    }

    renderBridge(row.map((entry) => entry.seat));

    const revealed = match.rule
      ? new Map(match.rule.contributions.map((c) => [c.playerId, c.letter]))
      : null;
    const justRevealed = lastPhase === PHASE.COUNTDOWN && match.phase === PHASE.RACE;

    const nodes = row.map((entry) => {
      const slot = document.createElement("div");
      slot.className = "standoff__slot";

      // Revealed: show the real letter.
      if (revealed?.has(entry.playerId)) {
        slot.append(
          tile({
            seat: entry.seat,
            glyph: revealed.get(entry.playerId),
            role: entry.role,
            reveal: justRevealed,
          }),
        );
        return slot;
      }

      const committed = Boolean(match.committed[entry.playerId]);
      const isLocal = entry.playerId === state.localPlayerId;

      // Still choosing: your own tile is an input until you commit. An observer
      // is never in this row, so this cannot offer them a letter to pick.
      if (match.phase === PHASE.LETTER_ENTRY && isLocal && !committed) {
        slot.append(letterField({ seat: entry.seat, role: entry.role }));
        return slot;
      }

      slot.append(
        tile({
          seat: entry.seat,
          glyph: "•",
          role: entry.role,
          faceDown: committed,
          empty: !committed,
        }),
      );
      return slot;
    });

    dom.tiles.replaceChildren(...nodes);

    if (justRevealed) {
      dom.standoff.classList.add("is-revealing");
      setTimeout(() => dom.standoff.classList.remove("is-revealing"), 700);
    }
  }

  /* ---- Supporting panels ------------------------------------------------ */

  /** @returns {boolean} whether the local player is sitting this round out */
  function isObserver(state) {
    const active = state.match.activeIds ?? [];
    return active.length > 0 && !active.includes(state.localPlayerId);
  }

  /** A banner naming who is duelling, for the players who are only watching. */
  function observerBanner(state) {
    const { match } = state;
    const a = state.players[match.starterId]?.name ?? "?";
    const b = state.players[match.enderId]?.name ?? "?";

    const line = document.createElement("p");
    line.className = "note board__watching";
    line.textContent =
      match.phase === PHASE.LETTER_ENTRY
        ? `${a} and ${b} are choosing letters. You're watching this round.`
        : `Watching ${a} vs ${b}.`;
    return line;
  }

  /**
   * The live commentary strip, for spectators only.
   *
   * Without it a race is thirty seconds of watching a bar shrink. With it you can
   * see both duellists typing, stalling and burning attempts — which is the part
   * that is actually fun to watch.
   *
   * Length and attempt counts only; never the words. And this data reaches
   * spectators through targeted messages, never the snapshot, so a duellist
   * cannot see it about their rival.
   */
  function renderSpectatorFeed(state) {
    const { match } = state;
    const active = match.activeIds ?? [];

    const strip = document.createElement("div");
    strip.className = "feed";

    for (const id of active) {
      const player = state.players[id];
      const live = activity.get(id) ?? { length: 0, attempts: 0 };
      const seat = state.playerOrder.indexOf(id);

      const row = document.createElement("div");
      row.className = `feed__row tile--seat-${seat}`;

      const name = document.createElement("span");
      name.className = "feed__name";
      name.textContent = player?.name ?? "?";

      // One pip per character typed. A length, shown as a shape — you can see
      // someone is eight letters in without learning a single letter of it.
      const pips = document.createElement("span");
      pips.className = "feed__pips";
      pips.setAttribute("aria-hidden", "true");
      for (let i = 0; i < Math.min(live.length, 12); i += 1) {
        const pip = document.createElement("i");
        pip.className = "feed__pip";
        pips.append(pip);
      }

      const state_ = document.createElement("span");
      state_.className = "feed__state";
      if (live.length > 0) state_.textContent = `typing · ${live.length}`;
      else if (live.attempts > 0) state_.textContent = "thinking";
      else state_.textContent = "…";

      row.append(name, pips, state_);

      if (live.attempts > 0) {
        const tries = document.createElement("span");
        tries.className = "badge feed__tries";
        tries.textContent = `${live.attempts} tried`;
        row.append(tries);
      }

      // Announced politely so a spectator using a screen reader gets the shape of
      // the race without it interrupting the round result.
      row.setAttribute(
        "aria-label",
        `${player?.name ?? "Player"}: ${live.length} characters typed, ${live.attempts} attempts`,
      );
      strip.append(row);
    }

    return strip;
  }

  function renderRule(state) {
    const { match } = state;
    dom.rule.replaceChildren();
    const observing = isObserver(state);

    if (match.phase === PHASE.LETTER_ENTRY) {
      if (observing) {
        dom.rule.append(observerBanner(state));
        return;
      }
      const line = document.createElement("p");
      line.className = "note";
      if (match.settings.mode === GAME_MODE.CONTAINS) {
        line.textContent =
          "Pick a letter. Everyone's letters have to appear in the winning word — nobody can see yours yet.";
      } else {
        line.textContent =
          match.starterId === state.localPlayerId
            ? "Pick the letter the word must start with. Your opponent can't see it."
            : "Pick the letter the word must end with. Your opponent can't see it.";
      }
      dom.rule.append(line);
      return;
    }

    if (observing && (match.phase === PHASE.RACE || match.phase === PHASE.COUNTDOWN)) {
      dom.rule.append(observerBanner(state));
    }

    if (!match.rule) return;
    if (match.phase !== PHASE.RACE && match.phase !== PHASE.RESULT) return;

    const line = document.createElement("p");
    line.className = "headline";
    if (match.rule.mode === GAME_MODE.CONTAINS) {
      const letters = match.rule.letters.map((l) => l.toUpperCase()).join(" · ");
      line.textContent = `Use every letter: ${letters}`;
    } else {
      line.innerHTML = `Starts <strong>${match.rule.start.toUpperCase()}</strong> · ends <strong>${match.rule.end.toUpperCase()}</strong>`;
    }
    dom.rule.append(line);

    const floor = document.createElement("p");
    floor.className = "note";
    floor.textContent = `${match.rule.minWordLength} letters or more.`;
    dom.rule.append(floor);

    // The live feed is what makes spectating watchable, so it goes right under
    // the rule while the race is on.
    if (observing && match.phase === PHASE.RACE) {
      dom.rule.append(renderSpectatorFeed(state));
    }
  }

  function renderWordForm(state) {
    const { match } = state;
    // An observer sees the race but has nothing to type into. The host enforces
    // this too; hiding the form is the courtesy, not the guard.
    const racing = match.phase === PHASE.RACE && !isObserver(state);
    const wasRacing = dom.wordForm.hidden === false;

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
    }

    /* Focus the moment the field appears, not merely when the round changes.
       The round changes during letter entry, while this field is still hidden —
       and focusing a hidden element silently does nothing, so the player used to
       arrive at a live race with no cursor and had to click before typing.
       Keying off the hidden→visible transition is what makes it reliable, and it
       also raises the keyboard on a phone exactly when it is wanted.

       Focused synchronously: the form was unhidden a few lines above, so the
       element is already focusable. An earlier version deferred this to
       requestAnimationFrame, which never fires while a tab is in the background —
       so a player returning to a running race found no cursor at all. The
       timeout is a second chance for browsers that ignore focus mid-layout. */
    if (!wasRacing) {
      const grabFocus = () => {
        if (dom.wordForm.hidden || dom.wordInput.disabled) return;
        if (document.activeElement === dom.wordInput) return;
        dom.wordInput.focus({ preventScroll: true });
      };
      grabFocus();
      setTimeout(grabFocus, 0);
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
    // Duration comes from the match settings, not a constant: the host chose it.
    const durationMs = match.settings.raceDurationMs;
    raceTimer = createDeadlineTimer({
      endsAt: match.raceEndsAt,
      durationMs,
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
    const observing = isObserver(state);

    // With observers present, who is up matters more than what to do next, so
    // the pairing takes the label.
    const hasBench = (match.activeIds?.length ?? 0) < state.playerOrder.length;
    if (hasBench && match.starterId && match.enderId) {
      const a = state.players[match.starterId]?.name ?? "?";
      const b = state.players[match.enderId]?.name ?? "?";
      dom.phaseLabel.textContent = `Round ${match.roundNumber} · ${a} vs ${b}`;
      return;
    }

    const labels = {
      [PHASE.LETTER_ENTRY]: observing
        ? `Round ${match.roundNumber} · watching`
        : `Round ${match.roundNumber} · choose your letter`,
      [PHASE.COUNTDOWN]: `Round ${match.roundNumber} · revealing`,
      [PHASE.RACE]: observing ? `Round ${match.roundNumber} · watching` : `Round ${match.roundNumber} · go`,
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
          : `${winner?.name ?? "Someone"} got it: ${match.result.word.toUpperCase()}`;
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
  function celebrate(seatIndex) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const inks = [
      "var(--ink-pink)",
      "var(--ink-blue)",
      "var(--ink-mint)",
      "var(--ink-tangerine)",
    ];
    const field = document.createElement("div");
    field.className = "confetti";
    field.style.setProperty("--player-ink", inks[seatIndex] ?? inks[0]);

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
      lastState = state;

      // Activity is per-round; a new deal starts everyone from silence.
      if (match.roundId !== lastRoundId) activity.clear();

      // The round ending is also an answer — a win, a draw, someone else got
      // there first — so the button is released on any of them, not only on a
      // rejection addressed to us.
      if (match.phase !== PHASE.RACE || match.roundId !== lastRoundId) releaseSubmit();

      // The countdown is an overlay driven by the deadline in the snapshot, so
      // every screen runs it off its own clock from the same target.
      if (match.phase === PHASE.COUNTDOWN && match.countdownEndsAt) {
        if (!countdownView.isShowing()) countdownView.show(match.countdownEndsAt);
      } else {
        countdownView.hide();
      }

      scoreboard.render(state);
      renderPhaseLabel(state);
      renderTiles(state);
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
          `${state.players[match.result.winnerId]?.name ?? "Someone"} won with ${match.result.word}`,
        );
      }
      if (match.phase === PHASE.RESULT && lastPhase !== PHASE.RESULT && match.result?.draw) {
        announcer.say("Round drawn. Nobody found a word.");
      }
      if (match.phase === PHASE.RACE && lastPhase === PHASE.COUNTDOWN && match.rule) {
        announcer.say(
          match.rule.mode === GAME_MODE.CONTAINS
            ? `Go. Your word must contain ${match.rule.letters.join(", ")}.`
            : `Go. Starts with ${match.rule.start}, ends with ${match.rule.end}.`,
        );
      }

      // Notices ride in the snapshot, so everyone toasts the same thing once.
      if (match.notice && match.notice.id !== lastNoticeId) {
        lastNoticeId = match.notice.id;
        toaster.show(match.notice.text, { tone: match.notice.tone });
      }

      lastPhase = match.phase;
      lastRoundId = match.roundId;
    },

    /**
     * A duellist's live activity, for spectators. Re-renders only the feed, not
     * the whole board — this arrives on every keystroke.
     *
     * @param {{playerId: string, length: number, attempts: number}} update
     */
    showActivity(update) {
      activity.set(update.playerId, {
        length: update.length,
        attempts: update.attempts,
      });
      // Swap just the feed rather than re-rendering the board: this fires on
      // every keystroke of every duellist. `lastState` is the state from the most
      // recent render, which is exactly what the feed was built from.
      const strip = dom.rule.querySelector(".feed");
      if (strip && lastState) strip.replaceWith(renderSpectatorFeed(lastState));
    },

    /**
     * Puts the submit button into its validating state.
     *
     * Two problems being solved at once. First, a submitted word has to travel to
     * the host, wait behind the submission queue, and clear a dictionary lookup —
     * easily a second, and on a relay rather more. With no feedback that reads as
     * a button that did nothing, and the player presses it again.
     *
     * Second, pressing Enter fires the form's submit without ever putting the
     * button in `:active`, so a keyboard submit had no visual response at all.
     * Adding the pressed class gives Enter exactly the same tactile confirmation
     * the mouse already got.
     */
    beginSubmitting() {
      if (!dom.wordSubmit) return;
      dom.wordSubmit.classList.add("is-pressed");
      setTimeout(() => dom.wordSubmit.classList.remove("is-pressed"), 160);

      dom.wordSubmit.disabled = true;
      dom.wordSubmit.textContent = "Validating word…";
      dom.wordSubmit.setAttribute("aria-busy", "true");

      // A stuck button is worse than a wrong label, so it always releases.
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(releaseSubmit, SUBMIT_PENDING_TIMEOUT_MS);
    },

    endSubmitting: releaseSubmit,

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
