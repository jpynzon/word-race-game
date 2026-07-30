import { LOCAL_WORDLIST_URL } from "../../js/constants.js";

/**
 * The always-available fallback, and the game's only offline path.
 *
 * The bundled list is 36,869 words: the 50k most frequent English words
 * intersected with a full dictionary, so it is both words people actually reach
 * for and words that genuinely exist — no brand names, acronyms or junk. See
 * README for provenance.
 *
 * It also answers a question no remote dictionary can answer cheaply:
 * *does any word at all bridge these two letters?* Ninety of the 676 possible
 * letter pairs have no English word (qj, xz, vq…). Knowing that up front is
 * what lets the game skip a round nobody could ever win instead of making both
 * players wait out a thirty-second timer.
 */
export function createLocalWordListProvider({ url = LOCAL_WORDLIST_URL } = {}) {
  /** @type {Set<string>|null} */
  let words = null;
  /** @type {Set<string>|null} first+last letter pairs that have at least one word */
  let bridges = null;
  /** @type {Promise<void>|null} in-flight load, so concurrent callers share one fetch */
  let loading = null;

  async function load() {
    if (words) return;
    if (loading) return loading;

    loading = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Wordlist ${response.status}`);
      const text = await response.text();

      const nextWords = new Set();
      const nextBridges = new Set();
      for (const line of text.split("\n")) {
        const word = line.trim();
        if (word.length < 2) continue;
        nextWords.add(word);
        nextBridges.add(word[0] + word[word.length - 1]);
      }
      words = nextWords;
      bridges = nextBridges;
    })();

    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  return {
    name: "local",

    /** Pulls the list into memory. Called at match start so a mid-race
     *  fallback never has to wait on a download. */
    prepare: load,

    /** @returns {boolean} whether the list is in memory */
    isReady() {
      return words !== null;
    },

    /**
     * @param {string} word already lowercased and trimmed
     * @returns {Promise<{exists: boolean, source: string, confident: boolean}>}
     */
    async lookup(word) {
      await load();
      return { exists: words.has(word), source: "local", confident: true };
    },

    /**
     * @param {string} start single lowercase letter
     * @param {string} end single lowercase letter
     * @returns {boolean} true if at least one known word bridges the pair
     */
    hasBridge(start, end) {
      if (!bridges) return true; // unknown: assume playable rather than block a round
      return bridges.has(`${start}${end}`);
    },

    /** @returns {number} */
    size() {
      return words?.size ?? 0;
    },
  };
}
