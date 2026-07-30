import { DICTIONARY_TIMEOUT_MS, FREE_DICTIONARY_ENDPOINT } from "../../js/constants.js";

/**
 * dictionaryapi.dev — the primary source in practice.
 *
 * Chosen because it needs no API key and sends `Access-Control-Allow-Origin: *`,
 * so a static page can call it directly with no proxy and therefore no server.
 *
 * The distinction that matters here is **confident** vs **unknown**:
 *
 *   200 → the word exists            (confident)
 *   404 → the word does not exist    (confident)
 *   timeout, 5xx, network error → we learned nothing (not confident)
 *
 * Only a confident answer ends the provider chain. An unconfident one falls
 * through to the next provider, which is what stops a flaky network from
 * rejecting a perfectly good word mid-race.
 */
export function createFreeDictionaryProvider({
  endpoint = FREE_DICTIONARY_ENDPOINT,
  timeoutMs = DICTIONARY_TIMEOUT_MS,
} = {}) {
  return {
    name: "free-dictionary",

    /** @returns {boolean} always available; it needs no key */
    isConfigured() {
      return true;
    },

    /**
     * @param {string} word already lowercased and trimmed
     * @returns {Promise<{exists: boolean, source: string, confident: boolean}>}
     */
    async lookup(word) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${endpoint}${encodeURIComponent(word)}`, {
          signal: controller.signal,
        });

        if (response.ok) {
          return { exists: true, source: this.name, confident: true };
        }
        if (response.status === 404) {
          return { exists: false, source: this.name, confident: true };
        }
        // 429, 5xx: the service is unhappy, not the word.
        return { exists: false, source: this.name, confident: false };
      } catch {
        // Abort or network failure. We know nothing about the word.
        return { exists: false, source: this.name, confident: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
