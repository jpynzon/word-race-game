import {
  DICTIONARY_TIMEOUT_MS,
  MERRIAM_WEBSTER_API_KEY,
  MERRIAM_WEBSTER_ENDPOINT,
} from "../../js/constants.js";

/**
 * Merriam-Webster Collegiate — the best source when it is available.
 *
 * It sits first in the chain but stays inert unless a key is configured, because
 * it requires one and this game is meant to run with zero setup. Paste a key
 * into MERRIAM_WEBSTER_API_KEY in constants.js and it promotes itself to primary
 * with no other change.
 *
 * The response needs real parsing: the API answers a miss with an array of
 * *spelling suggestions* (strings) rather than an error, so a 200 does not by
 * itself mean the word exists. A hit is an array of entry objects whose `meta.id`
 * matches the word — checking that is what separates "found" from "did you mean".
 */
export function createMerriamWebsterProvider({
  endpoint = MERRIAM_WEBSTER_ENDPOINT,
  apiKey = MERRIAM_WEBSTER_API_KEY,
  timeoutMs = DICTIONARY_TIMEOUT_MS,
} = {}) {
  return {
    name: "merriam-webster",

    /** @returns {boolean} whether a key was supplied */
    isConfigured() {
      return typeof apiKey === "string" && apiKey.trim().length > 0;
    },

    /**
     * @param {string} word already lowercased and trimmed
     * @returns {Promise<{exists: boolean, source: string, confident: boolean}>}
     */
    async lookup(word) {
      if (!this.isConfigured()) {
        return { exists: false, source: this.name, confident: false };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const url = `${endpoint}${encodeURIComponent(word)}?key=${encodeURIComponent(apiKey)}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          return { exists: false, source: this.name, confident: false };
        }

        const body = await response.json();
        if (!Array.isArray(body) || body.length === 0) {
          return { exists: false, source: this.name, confident: true };
        }

        // All strings means "no entry, here are near misses".
        if (body.every((entry) => typeof entry === "string")) {
          return { exists: false, source: this.name, confident: true };
        }

        // A real entry's meta.id is the headword, sometimes suffixed (`bank:1`).
        const found = body.some((entry) => {
          const id = entry?.meta?.id;
          if (typeof id !== "string") return false;
          return id.split(":")[0].toLowerCase() === word;
        });

        return { exists: found, source: this.name, confident: true };
      } catch {
        return { exists: false, source: this.name, confident: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
