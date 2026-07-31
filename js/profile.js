import { MAX_NAME_LENGTH } from "./constants.js";

/**
 * The player's durable profile: who they are, remembered between visits.
 *
 * Two separate lifetimes are at work here, and conflating them is what makes
 * reconnection either work or not:
 *
 *   localStorage   — survives closing the browser. Holds the name and the
 *                    player id, so someone who closes the tab by accident can
 *                    reopen the invite link and reclaim their seat and score
 *                    without retyping anything.
 *
 *   sessionStorage — dies with the tab. Holds *this tab's* id.
 *
 * Why both: localStorage is shared by every tab on the origin. If identity came
 * from localStorage alone, two tabs of the same browser would claim the same
 * player id — and since the host keys seats and scores by id, the two players
 * would be treated as one. Giving each tab its own session-scoped copy keeps
 * them distinct while the localStorage copy provides the durable fallback for
 * the first tab to ask.
 *
 * A same-browser collision is still possible (both tabs opened fresh, both
 * reading the same durable id), so the host renames a guest whose id matches
 * its own. See GameManager's HELLO handler.
 *
 * Storage can throw or be absent entirely — Safari private mode, embedded
 * webviews, disabled cookies — so every access is guarded and degrades to an
 * in-memory profile that simply does not outlive the page.
 */

const PROFILE_KEY = "wordrace.profile";
const TAB_ID_KEY = "wordrace.tabPlayerId";
const INTENT_KEY = "wordrace.intent";

/** In-memory fallback when neither storage is usable. */
let memoryProfile = null;

/** @returns {Storage|null} */
function safeStorage(kind) {
  try {
    const store = kind === "local" ? window.localStorage : window.sessionStorage;
    const probe = "__wordrace_probe__";
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** @returns {string} a fresh, collision-resistant player id */
function mintPlayerId() {
  if (typeof crypto?.randomUUID === "function") {
    return `p-${crypto.randomUUID().slice(0, 12)}`;
  }
  return `p-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * @param {unknown} raw
 * @returns {string} a trimmed, length-capped, whitespace-collapsed name
 */
export function sanitiseName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_NAME_LENGTH);
}

export function createProfileStore() {
  const local = safeStorage("local");
  const session = safeStorage("session");

  /** @returns {{playerId: string|null, name: string}} */
  function readDurable() {
    if (!local) return memoryProfile ?? { playerId: null, name: "" };
    try {
      const parsed = JSON.parse(local.getItem(PROFILE_KEY) ?? "null");
      if (!parsed || typeof parsed !== "object") return { playerId: null, name: "" };
      return {
        playerId: typeof parsed.playerId === "string" ? parsed.playerId : null,
        name: sanitiseName(parsed.name),
      };
    } catch {
      return { playerId: null, name: "" };
    }
  }

  function writeDurable(profile) {
    memoryProfile = profile;
    if (!local) return;
    try {
      local.setItem(PROFILE_KEY, JSON.stringify({ ...profile, updatedAt: Date.now() }));
    } catch {
      /* quota or private mode: the in-memory copy still serves this page */
    }
  }

  return {
    /**
     * This tab's player id, minted once and stable for the tab's life.
     *
     * Prefers the tab's own id, then the durable one, then a fresh one. The
     * durable id is only adopted by the first tab to ask, which is what keeps
     * two tabs in one browser from becoming the same player.
     *
     * @returns {string}
     */
    playerId() {
      const fromTab = session?.getItem(TAB_ID_KEY);
      if (fromTab) return fromTab;

      const durable = readDurable();
      let id = durable.playerId;

      // Another tab already took the durable id this session.
      const claimedElsewhere = session?.getItem(`${TAB_ID_KEY}.claimed`) === id;
      if (!id || claimedElsewhere) id = mintPlayerId();

      try {
        session?.setItem(TAB_ID_KEY, id);
      } catch {
        /* fall through: the id is still returned, just not persisted */
      }
      // Keep the durable copy pointing at a real id so a later visit can reuse it.
      if (!durable.playerId) writeDurable({ ...durable, playerId: id });
      return id;
    },

    /** @returns {string} the remembered display name, or "" */
    name() {
      return readDurable().name;
    },

    /** @returns {boolean} whether a name has been saved before */
    hasName() {
      return readDurable().name.length > 0;
    },

    /**
     * Saves the name for next time. Called once the player commits to it by
     * creating or joining a room, not on every keystroke.
     *
     * @param {string} rawName
     * @returns {string} the sanitised name that was stored
     */
    rememberName(rawName) {
      const name = sanitiseName(rawName);
      const durable = readDurable();
      writeDurable({ playerId: durable.playerId ?? this.playerId(), name });
      return name;
    },

    /**
     * Records the id the host assigned us, so a later rejoin presents the same
     * identity and reclaims the same seat. The host can rename a guest whose id
     * collided with its own, and that new id is the one worth remembering.
     *
     * @param {string} assignedId
     */
    adoptAssignedId(assignedId) {
      if (typeof assignedId !== "string" || assignedId.length === 0) return;
      try {
        session?.setItem(TAB_ID_KEY, assignedId);
      } catch {
        /* not fatal */
      }
      writeDurable({ ...readDurable(), playerId: assignedId });
    },

    /**
     * Records what the player wants to do next, for the landing page to hand to
     * the app across a document navigation.
     *
     * Deliberately not a query string. Static hosts rewrite URLs: `serve`'s
     * clean-URLs redirects `/play.html?host=1` to `/play` and drops the query
     * entirely, and other hosts have their own opinions. sessionStorage survives
     * a same-tab navigation untouched, and it keeps `?host=1` out of the address
     * bar as a bonus.
     *
     * @param {{host?: boolean, room?: string}} intent
     */
    setIntent(intent) {
      try {
        session?.setItem(INTENT_KEY, JSON.stringify(intent));
      } catch {
        /* the query-string fallback still covers this */
      }
    },

    /**
     * Reads and clears the pending intent, so a refresh does not silently
     * re-create a room the player already left.
     *
     * @returns {{host?: boolean, room?: string}|null}
     */
    takeIntent() {
      try {
        const raw = session?.getItem(INTENT_KEY);
        if (!raw) return null;
        session?.removeItem(INTENT_KEY);
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    },

    /** Forgets everything. Not wired to any UI yet; here for a "not me" control. */
    clear() {
      memoryProfile = null;
      try {
        local?.removeItem(PROFILE_KEY);
        session?.removeItem(TAB_ID_KEY);
      } catch {
        /* nothing to do */
      }
    },
  };
}
