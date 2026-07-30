import { createFreeDictionaryProvider } from "./providers/FreeDictionaryProvider.js";
import { createLocalWordListProvider } from "./providers/LocalWordListProvider.js";
import { createMerriamWebsterProvider } from "./providers/MerriamWebsterProvider.js";

/**
 * "Does this word exist?" — behind one interface, with providers in priority
 * order.
 *
 * Every provider implements the same shape:
 *
 *   async lookup(word) → { exists: boolean, source: string, confident: boolean }
 *
 * The chain walks providers in order and stops at the first **confident**
 * answer. `confident: false` means the provider learned nothing (timeout, 5xx,
 * no API key) and the next one should try. Without that distinction a flaky
 * network would read as "not a word" and steal rounds from players.
 *
 * Order:
 *   1. Merriam-Webster  — best quality, inert until a key is configured
 *   2. Free Dictionary  — no key, CORS-open, the primary in practice
 *   3. Local wordlist   — always answers, and the only offline path
 *
 * Urban Dictionary is deliberately absent. It would accept slang and typos as
 * English, which in a word race means accepting nonsense. It stays available as
 * an opt-in extra provider, never in the default chain.
 *
 * Only the host ever calls this. Two clients asking independently could get two
 * different answers from a flaky API and desync the match, so there is exactly
 * one asker and one answer.
 */
export function createDictionaryService({ providers } = {}) {
  const chain = providers ?? [
    createMerriamWebsterProvider(),
    createFreeDictionaryProvider(),
    createLocalWordListProvider(),
  ];

  /** The local provider also answers bridge questions; find it once. */
  const local = chain.find((provider) => provider.name === "local") ?? null;

  /** word → resolved result, for this match. */
  const cache = new Map();

  return {
    /**
     * Warms anything that benefits from being ready before the clock starts.
     * Failing to prepare is not fatal — the chain still works, just slower on
     * first use — so this never rejects.
     */
    async prepare() {
      await Promise.allSettled(
        chain.filter((provider) => provider.prepare).map((provider) => provider.prepare()),
      );
    },

    /**
     * @param {string} rawWord
     * @returns {Promise<{exists: boolean, source: string}>}
     */
    async lookup(rawWord) {
      const word = String(rawWord).trim().toLowerCase();

      // Memoised per match: a word retried mid-race must not cost a second
      // round trip, and the answer must not change between attempts.
      if (cache.has(word)) return cache.get(word);

      let result = { exists: false, source: "none" };

      for (const provider of chain) {
        if (provider.isConfigured && !provider.isConfigured()) continue;

        let answer;
        try {
          answer = await provider.lookup(word);
        } catch {
          continue; // a throwing provider is an unconfident provider
        }

        if (answer?.confident) {
          result = { exists: answer.exists, source: answer.source };
          break;
        }
      }

      cache.set(word, result);
      return result;
    },

    /**
     * Whether any known word bridges these two letters.
     *
     * Ninety of the 676 letter pairs have no English word at all. Asking this
     * before the race starts is what lets the game re-deal instead of running a
     * timer nobody could beat.
     *
     * @param {string} start single lowercase letter
     * @param {string} end single lowercase letter
     * @returns {boolean} false only when we positively know the pair is dead
     */
    hasBridge(start, end) {
      if (!local || !local.isReady()) return true;
      return local.hasBridge(start, end);
    },

    /** @returns {object} state for the end-to-end checks */
    diagnostics() {
      return {
        providers: chain.map((provider) => ({
          name: provider.name,
          configured: provider.isConfigured ? provider.isConfigured() : true,
        })),
        localWords: local?.size?.() ?? 0,
        cached: cache.size,
      };
    },
  };
}
