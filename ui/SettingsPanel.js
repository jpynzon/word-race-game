import {
  GAME_MODE,
  MIN_WORD_LENGTH_BOUNDS,
  RACE_DURATION_CHOICES_MS,
} from "../js/constants.js";
import {
  capacityFor,
  describeMode,
  formatDuration,
  minimumViableWordLength,
} from "../game/GameSettings.js";

/**
 * The match rules, shown in the lobby.
 *
 * The host gets controls; everyone else gets the same information as read-only
 * text. Both render from the identical settings object in the snapshot, so a
 * guest is never looking at stale rules — and nobody discovers the timer changed
 * only once the race has started.
 *
 * @param {{
 *   root: HTMLElement,
 *   onChange: (patch: object) => void
 * }} deps
 */
export function createSettingsPanel({ root, onChange }) {
  /**
   * A row of mutually exclusive choices. Uses radio semantics rather than
   * buttons so arrow keys work and screen readers announce the group.
   *
   * @param {{
   *   legend: string, hint?: string, name: string,
   *   options: {value: any, label: string, sublabel?: string, disabled?: boolean}[],
   *   value: any,
   *   onPick: (value: any) => void
   * }} spec
   */
  function choiceGroup({ legend, hint, name, options, value, onPick }) {
    const group = document.createElement("fieldset");
    group.className = "settings__group";

    const caption = document.createElement("legend");
    caption.className = "settings__legend";
    caption.textContent = legend;
    group.append(caption);

    if (hint) {
      const note = document.createElement("p");
      note.className = "note settings__hint";
      note.textContent = hint;
      group.append(note);
    }

    const row = document.createElement("div");
    row.className = "settings__choices";

    for (const option of options) {
      const label = document.createElement("label");
      label.className = "choice";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.className = "choice__input";
      input.checked = option.value === value;
      input.disabled = Boolean(option.disabled);
      input.addEventListener("change", () => onPick(option.value));

      const face = document.createElement("span");
      face.className = "choice__face";

      const main = document.createElement("span");
      main.className = "choice__label";
      main.textContent = option.label;
      face.append(main);

      if (option.sublabel) {
        const sub = document.createElement("span");
        sub.className = "choice__sublabel";
        sub.textContent = option.sublabel;
        face.append(sub);
      }

      label.append(input, face);
      row.append(label);
    }

    group.append(row);
    return group;
  }

  /** Read-only rendering, for guests. */
  function renderSummary(state) {
    const { settings } = state.match;
    const mode = describeMode(settings.mode);

    const card = document.createElement("div");
    card.className = "card settings";
    card.innerHTML = `
      <p class="eyebrow">Match rules</p>
      <h2 class="card__title settings__mode">${mode.name}</h2>
      <p class="note">${mode.rule}</p>
      <ul class="settings__facts">
        <li><strong>${formatDuration(settings.raceDurationMs)}</strong> to find a word</li>
        <li><strong>${settings.minWordLength}</strong> letters minimum</li>
      </ul>
      <p class="note settings__who">Only the host can change these.</p>
    `;
    return card;
  }

  /** Interactive rendering, for the host. */
  function renderControls(state) {
    const { settings } = state.match;
    const seated = state.playerOrder.length;
    const floor = minimumViableWordLength(settings.mode, seated);

    const card = document.createElement("div");
    card.className = "card settings";

    const heading = document.createElement("p");
    heading.className = "eyebrow";
    heading.textContent = "Match rules";
    card.append(heading);

    /* ---- Mode ----
       Each option is disabled when the current roster does not fit it, because
       switching would otherwise have to evict somebody. */
    const modeOptions = [
      { value: GAME_MODE.DUEL, label: "Duel" },
      { value: GAME_MODE.ROUND_ROBIN, label: "Round robin" },
      { value: GAME_MODE.CONTAINS, label: "Letter hunt" },
    ].map(({ value, label }) => {
      const cap = capacityFor(value);
      return {
        value,
        label,
        sublabel: cap.min === cap.max ? `${cap.max} players` : `${cap.min}–${cap.max}`,
        disabled: seated > cap.max,
      };
    });

    card.append(
      choiceGroup({
        legend: "Game mode",
        hint: describeMode(settings.mode).rule,
        name: "wr-mode",
        value: settings.mode,
        options: modeOptions,
        onPick: (mode) => onChange({ mode }),
      }),
    );

    /* ---- Race duration ---- */
    card.append(
      choiceGroup({
        legend: "Time to find a word",
        name: "wr-duration",
        value: settings.raceDurationMs,
        options: RACE_DURATION_CHOICES_MS.map((ms) => ({
          value: ms,
          label: formatDuration(ms),
        })),
        onPick: (raceDurationMs) => onChange({ raceDurationMs }),
      }),
    );

    /* ---- Minimum word length ---- */
    const lengths = [];
    for (let n = MIN_WORD_LENGTH_BOUNDS.min; n <= MIN_WORD_LENGTH_BOUNDS.max; n += 1) {
      lengths.push(n);
    }
    card.append(
      choiceGroup({
        legend: "Minimum word length",
        hint:
          floor > MIN_WORD_LENGTH_BOUNDS.min
            ? `With ${seated} players every word needs at least ${floor} letters to fit all of them.`
            : undefined,
        name: "wr-minlen",
        value: settings.minWordLength,
        options: lengths.map((n) => ({
          value: n,
          label: String(n),
          // Below the floor no word could ever satisfy the rule, so those
          // choices are shown but unusable rather than hidden.
          disabled: n < floor,
        })),
        onPick: (minWordLength) => onChange({ minWordLength }),
      }),
    );

    return card;
  }

  return {
    /** @param {object} state */
    render(state) {
      const isHost = state.role === "host";
      const inLobby = state.match.phase === "lobby";
      root.replaceChildren(
        isHost && inLobby ? renderControls(state) : renderSummary(state),
      );
    },
  };
}
