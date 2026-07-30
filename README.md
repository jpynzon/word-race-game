# Word Race

A real-time two-player word duel that runs entirely in the browser. No backend, no accounts, no build step.

Everyone secretly picks **one letter**. After a three-second countdown the letters reveal simultaneously and everyone races to type a real English word that fits them. Fastest valid word takes the round.

**Three modes**, all sharing the same settings, timer and scoring:

```
Duel · 2 players            the word starts with one letter, ends with the other
  M …………………… T             moment · market · merit

Round robin · 2–4 players   same rule, but two duel each round while the rest
  Bob vs Cara               watch; pairings rotate until everyone has met

Letter hunt · 3–4 players   the word must contain every letter, anywhere
  B  ·  A  ·  N             bandit · brain · abandon
```

---

## Table of contents

- [Playing it](#playing-it)
- [Game modes and settings](#game-modes-and-settings)
- [Running it locally](#running-it-locally)
- [How the multiplayer works](#how-the-multiplayer-works)
- [Why PeerJS, and what it costs](#why-peerjs-and-what-it-costs)
- [The hard part: who won the race](#the-hard-part-who-won-the-race)
- [Word validation](#word-validation)
- [Keeping letters secret](#keeping-letters-secret)
- [Reconnecting](#reconnecting)
- [Unwinnable letter pairs](#unwinnable-letter-pairs)
- [Project layout](#project-layout)
- [Design](#design)
- [Accessibility](#accessibility)
- [Deploying](#deploying)
- [Configuration](#configuration)
- [Testing](#testing)
- [Known limitations](#known-limitations)
- [Future improvements](#future-improvements)
- [Credits](#credits)

---

## Playing it

1. One player creates a room and gets a four-digit code.
2. They share the code, or the invite link: `https://your-host/?room=4821`
3. Everyone else opens it, and the code is already filled in.
4. The host picks the mode and rules. Everyone marks ready. The host starts.
5. Each round: pick a secret letter → 3·2·1 → all letters flip up → race to type a word.

In a duel, rounds alternate who supplies the starting letter, because ending a word on `Q` is much harder than starting one with it. In a letter hunt every letter is equal, so there is nothing to alternate.

---

## Game modes and settings

The host configures the match in the lobby. Settings ride in the state snapshot, so every player sees the same rules before the first letter is picked — nobody discovers the timer changed once the race is already running. Guests see the same panel read-only.

| Setting | Choices | Notes |
| --- | --- | --- |
| **Mode** | Duel (2) · Round robin (2–4) · Letter hunt (3–4) | Switching to a mode that seats fewer players than are present is refused rather than silently evicting someone |
| **Time to find a word** | 15s · 30s · 45s · 60s · 90s | Discrete choices, because a slider inviting someone to pick 7 seconds helps nobody |
| **Minimum word length** | 2–10 | The floor rises with the seat count in letter hunt (see below) |

Settings lock once a match is running. Changing them mid-round would rewrite a rule players are already racing against, so the host is told to go back to the lobby first.

**Two constraints that are enforced rather than trusted.**

*The minimum length floor.* In letter hunt a word has to fit every player's letter, so with four players nothing under four letters can ever be valid. Letting the host set a lower minimum would advertise a rule the dictionary can never satisfy, so the floor tracks the seat count and the impossible choices are shown disabled rather than hidden.

*Clamping.* Settings arrive over the network, so `normaliseSettings()` clamps every field on receipt. A guest handed `raceDurationMs: 0` by a buggy or hostile host would otherwise get a race that ends before it starts.

**Duplicate letters use set semantics.** If two players both pick `E`, the word needs one `E`, not two. With four letters to satisfy the mode is hard enough already, and *"your word needs two E's because we both picked E"* is a rule nobody would guess from the instructions.

### Round robin and observers

Only two people play each round; everyone else watches. That means the round machine cannot assume "everyone picks a letter and races", so `match.activeIds` names who is playing and everyone absent from it is an observer. It is published in the snapshot rather than derived client-side, so the board never has to re-implement the pairing rule to know who is up.

Observers see the board, the revealed letters and the running clock — spectating is dull otherwise — but get no letter tile and no word field, and the scoreboard tags everyone *Duelling* or *Watching*.

**The rules are enforced on the host, not in the UI.** A spectator's `submitLetter` and `submitWord` are both refused with `NOT_PLAYING`, because the UI that hides those controls runs on a machine we do not control. Verified by having the host itself observe a round and try to submit: refused, and the submission never even reached the queue.

**Pairings use the circle method, not a nested loop.** The obvious enumeration —

```js
for (i) for (j > i) pairs.push([i, j])      // unfair
```

— produces every pairing exactly once but in a badly lopsided order. With four players it deals `0-1, 0-2, 0-3, 1-2, 1-3, 2-3`, so player 0 duels three rounds back to back and then sits out three, and nobody wants to be player 3 watching the first half of every cycle. The circle method fixes one seat and rotates the rest, which cuts the longest consecutive run from 3 to 2 and keeps appearances even. An odd roster gets a phantom bye seat, so three players get a clean three-pairing cycle.

The schedule is derived from the current roster each round rather than stored, so someone joining or leaving reshapes the rotation instead of leaving stale pairings pointing at a player who left.

---

## Running it locally

There is no build step and no dependencies to install. Any static file server works:

```bash
npx serve --listen 4173 word-race
```

Then open `http://localhost:4173`.

To play against yourself while developing, open the invite link in a **second browser profile or a private window**, not just a second tab — two tabs of the same browser share one `localStorage` profile. The host detects that collision and renames the second player, so it does work, but separate profiles are a cleaner simulation of two real devices.

`file://` will not work: the app uses ES modules, which browsers refuse to load over the file protocol.

---

## How the multiplayer works

The topology is a **star**: the host holds one connection per guest, and guests are never connected to each other. That falls out of the authority model for free — every message a guest cares about comes from the host anyway, so a full mesh would multiply connections for nothing.

The whole architecture follows from one decision: **the host is the authority.**

```
GUEST                                HOST
  │                                    │
  │  intent  ────────────────────────▶  │  validate → mutate state → broadcast
  │          (letter, word, ready)      │
  │                                     │
  │  ◀──────────────────────  full state snapshot
  │            render
```

A guest never mutates authoritative state. It sends *intents* and renders whatever snapshot comes back. This is why "both players always see the same game state" is true **by construction** rather than by careful bookkeeping — a guest holds no copy of the rules that could drift out of agreement.

Everything else is a consequence:

- **One tally, one dictionary, one clock.** The host owns the scores, does every dictionary lookup, and runs every timer. Clients asking a flaky API independently could get different answers and desync the match, so exactly one asks.
- **Per-peer bookkeeping.** Sequence numbers, duplicate suppression and clock offsets are tracked per connection. A shared dedupe counter would silently swallow one player's messages whenever their sequence numbers lagged another's, and a shared clock offset would apply one player's latency correction to everybody.
- **Snapshots, not deltas.** Every transition broadcasts the full authoritative slice. It costs a few hundred bytes and removes an entire category of bug: there is no way to miss a delta and drift.
- **Deadlines, not countdowns.** Timers are absolute end times carried in the snapshot, so both screens compute remaining time from their own clock. A throttled background tab shows the right number on its next tick instead of lagging, and a reconnecting player lands on the correct value immediately.

The room code *is* the network address. The host claims the peer id `wordrace-v1-4821`, so a guest holding the code already knows where to connect. That is what removes the need for a server — there is no room registry to look anything up in. A code collision needs no coordination either: if the broker says the id is taken, the host generates a new code and retries.

---

## Why PeerJS, and what it costs

The brief was "frontend only", but real-time multiplayer needs networking. Rather than pretend otherwise, here is the actual trade space:

| Option | Backend | Setup | Latency | Survives host leaving |
| --- | --- | --- | --- | --- |
| **PeerJS / WebRTC** ✅ | none | none | best (peer-to-peer) | **no** |
| Firebase Realtime DB | managed | project + config keys | datacenter round-trip | yes |
| Supabase Realtime | managed | account + anon keys | datacenter round-trip | yes |
| Ably / Pusher | managed | paid tier + API keys | datacenter round-trip | yes |

PeerJS wins on the brief's own terms — zero backend, zero signup, zero keys, and the lowest possible latency because the data goes device-to-device instead of through a datacenter. For a game decided in milliseconds, that last point matters.

**It costs two real things, both handled explicitly rather than hidden:**

1. **The host is the server.** Close the host's tab and the room ends. The guest gets an honest "The host left the game" screen explaining why, with a way out — not a frozen board.
2. **No TURN server.** The free broker handles signalling only. On most networks the peers connect directly; on restrictive ones (symmetric NAT, strict corporate or school firewalls) they cannot. That case is detected by timeout and reported as *"This network won't allow a direct connection"* with a suggestion to try a hotspot — deliberately distinguished from "no such room", because they need different fixes.

Both limitations are contained by keeping PeerJS in exactly one file behind a four-method interface:

```js
hostRoom(code) → Promise<{roomCode}>
joinRoom(code) → Promise<void>
send(object)
close()
```

`net/PeerTransport.js` is the only file in the project that knows PeerJS exists. Swapping to Firebase means writing one more file with those four methods and changing a single line in `GameManager`. Nothing above that layer mentions peers, ICE, or data channels.

---

## The hard part: who won the race

This is the most delicate code in the project, and the reason `game/SubmissionQueue.js` exists.

Validating a word requires an **async dictionary call**. The obvious implementation is wrong:

```js
onWord(sub) { if (await validate(sub)) declareWinner(sub) }   // WRONG
```

Two submissions milliseconds apart start two concurrent lookups, and those lookups can resolve **in either order** — a cached word returns instantly while an uncached one waits on the network. So the player who submitted *second* routinely wins. Worse, it is nondeterministic, so it reads as random unfairness rather than a bug.

Measured, with the first presser given the slow lookup:

| Implementation | First presser wins |
| --- | --- |
| Naive concurrent validation | **0 / 5** |
| `SubmissionQueue` | **10 / 10** |

The fix has two parts:

**1. Serialize.** Exactly one validation is ever in flight. The queue drains one item at a time, fully awaiting each before touching the next, and the first valid word ends the round. Concurrency cannot reorder what never runs concurrently.

**2. Order fairly before draining.** Raw arrival order punishes latency: a guest 80 ms away always loses a photo finish they actually won. So the first submission opens a short coalescing window (120 ms), and everything inside it is sorted by **offset-corrected client time** — when each player actually pressed the key — with arrival ordinal as a deterministic tiebreaker.

Clock offset is estimated by ping/pong, keeping only the **lowest-RTT sample**. On a jittery link the fastest round trip is by far the most trustworthy: a fast round trip cannot have been delayed much in either direction, while a slow one gives no clue which leg was slow. This is best-effort by nature and documented as such — good enough that latency does not decide rounds, not good enough to arbitrate a true photo finish, which is why arrival order remains the tiebreaker.

Other race conditions, each with a named cause:

- **Duplicate submissions** — every intent carries `{roundId, seq}`; the host ignores stale rounds and already-seen sequence numbers. Covers double-taps, key repeat, and re-delivery after a reconnect.
- **Late winners** — a round can end while a validation is still awaiting. The queue re-checks `roundId` after every `await` and refuses to crown a winner for a round that is already over.
- **Malformed messages** — one validator in `net/Events.js` gates every inbound message on shape, type, and *direction* before dispatch. A guest cannot send a `SNAPSHOT` and rewrite the host's state. Drops are counted, never thrown.

---

## Word validation

Two genuinely separate questions, deliberately not merged.

**Does it follow the rules?** (`game/Validator.js`) — synchronous, pure, and checked first so a word with the wrong first letter never costs a network round trip. Length ≥ 2, letters only, correct start and end, not already used this match. Returns a typed reason code; `js/messages.js` owns the English.

**Does the word exist?** (`dict/DictionaryService.js`) — a provider chain, each implementing:

```js
async lookup(word) → { exists: boolean, source: string, confident: boolean }
```

| Order | Provider | Notes |
| --- | --- | --- |
| 1 | Merriam-Webster | Best quality. Inert unless an API key is configured. |
| 2 | Free Dictionary (`dictionaryapi.dev`) | The primary in practice — no key, and `Access-Control-Allow-Origin: *`, so a static page can call it with no proxy. |
| 3 | Local wordlist | Always answers. The only offline path. |

The chain stops at the first **confident** answer. That distinction is the important part:

- `200` → the word exists *(confident)*
- `404` → the word does not exist *(confident)*
- timeout, `5xx`, network error → we learned nothing *(not confident, fall through)*

Without it, a flaky network reads as "not a word" and steals rounds from players.

**Urban Dictionary is deliberately excluded.** It would accept slang and typos as English, which in a word race means accepting nonsense. It remains possible as an opt-in extra provider, never in the default chain.

Results are memoised per match, so a word retried mid-race costs no second round trip and cannot change its answer between attempts.

---

## Keeping letters secret

The whole game collapses if you can see your opponent's letter early, so it is not merely hidden with CSS.

Committed letters live in a **private map inside `RoundManager`**, outside the store. Only `committed: {playerId: true}` booleans are published. Because the snapshot is built from the store, the letters are physically not in the payload the guest receives — there is nothing in the page to find.

Verified adversarially: with the host committed, the guest's entire serialized state contains `letters: null`, the only letter-related key is that boolean map, and the opponent's tile renders a placeholder.

---

## Reconnecting

Identity is split across two storage lifetimes, and conflating them is what makes reconnection either work or not:

- **`localStorage`** — survives closing the browser. Holds the display name and player id, so someone whose browser closed by accident can reopen the invite link and reclaim their seat and score without retyping anything.
- **`sessionStorage`** — dies with the tab. Holds *this tab's* id.

Both are needed. `localStorage` is shared by every tab on the origin, so if identity came from it alone, two tabs of one browser would claim the same player id — and since the host keys seats and scores by id, two players would collapse into one seat. The per-tab copy keeps them distinct; the durable copy provides the fallback for the first tab to ask. If a collision still happens, **the host is the authority on identity** and renames the guest, returning the assigned id in `WELCOME` for the guest to adopt.

On a return visit the code and name are both pre-filled and focus lands on the submit button, so rejoining is one tap with zero typing.

The host keeps a disconnected player's seat, readiness and score rather than clearing them — the seat belongs to the player.

Two bugs found and fixed while building this, both worth knowing about if you touch the transport:

1. **The heartbeat freed the wrong thing.** When a peer goes silent the heartbeat concludes it is gone — but it originally only *notified* the game layer without clearing the transport's connection reference. The transport kept holding a corpse and refused every genuine reconnect as "room full". It now drops the connection too.
2. **An unidentified connection held the seat.** A data channel can open on the host's side while the joining player's side never finishes negotiating. That half-open connection still answers heartbeats, so it looks perfectly healthy, and it occupied the only guest seat forever. A connection now has `HELLO_TIMEOUT_MS` to introduce itself or it is dropped.

---

## Unwinnable hands

**90 of the 676 possible letter pairs have no English word at all** — `qj`, `xz`, `vq`, `zx` and friends. In letter hunt it is worse: four random letters share no word surprisingly often (`jqvx` has nothing, and so do plenty of less obvious sets). Running a timer on one of those is not a challenge; it is a dead round players will read as the game being broken.

So the local wordlist doubles as an oracle, and the host checks the dealt hand at reveal:

- **Duel** — on load the list indexes every first+last letter pair that has at least one word, so the check is a single `Set` lookup.
- **Letter hunt** — precomputing is not an option, since four letters from an alphabet of 26 is far too many combinations to index. It scans instead: a linear pass over 37k words with an early bail on the first missing letter, which runs in a couple of milliseconds and costs nothing next to the dictionary round trip it prevents.

If a hand is unplayable the round is re-dealt with an explanation:

> No English word runs from Q to J — new letters.
> No word contains J, Q, V, X — new letters.

All 26 letters stay available in both modes, and no round is ever unwinnable.

---

## Project layout

```
index.html                   all screens; toggled with [hidden]

css/
  reset.css                  reset + @layer order declaration
  variables.css              design tokens
  layout.css                 shell, screens, board geometry
  components.css             buttons, tiles, cards, inputs
  animations.css             keyframes + reduced-motion

js/
  app.js                     composition root — the only place that wires things
  constants.js               every tunable value in the game
  state.js                   the single store + selectors
  router.js                  invite links in, shareable URL out
  profile.js                 durable identity and remembered name
  messages.js                every player-facing sentence

game/
  GameManager.js             orchestrator and authority
  RoundManager.js            the round state machine (host only)
  SubmissionQueue.js         decides who won the race
  Validator.js               synchronous word rules, all modes
  GameSettings.js            settings defaults, clamping, mode capacity
  Pairings.js                round-robin rotation (circle method)
  ScoreManager.js            pure score transformations
  Timer.js                   deadline-based timers
  LobbyManager.js            lobby rendering

net/
  Protocol.js                wire format and message types
  Events.js                  inbound validation + dedupe
  NetworkClient.js           sequencing, heartbeat, clock offset
  PeerTransport.js           the only file that knows PeerJS exists

ui/
  Screen.js  Board.js  Scoreboard.js  Countdown.js
  SettingsPanel.js  PlayerCard.js  HeroDemo.js  Toast.js

dict/
  DictionaryService.js       the provider chain
  providers/                 Merriam-Webster · Free Dictionary · local list

assets/
  wordlist.txt               36,869 words
  favicon.svg
```

Conventions worth knowing before contributing:

- **No global mutable state.** `app.js` creates one store and passes it down. Every module receives its dependencies as arguments, which also makes each one testable with a throwaway store.
- **No magic numbers.** If a number has meaning it has a name in `constants.js`.
- **Codes, not sentences.** Game logic emits typed reason codes; only `messages.js` writes English.
- **CSS uses `@layer`** (`reset, tokens, layout, components, animations`), so load order decides the cascade instead of selector specificity. A token override belongs in the tokens layer or it will lose.

---

## Design

The direction is **sticker arcade**: chunky rounded type, 3px ink outlines, hard offset shadows, a dot-grid sheet, and nothing sitting perfectly square. Two typefaces, both rounded — **Baloo 2** for display and letter tiles, **Nunito** for everything else. There is deliberately no monospace: the room code sits in fixed-width digit boxes and the countdown in a fixed container, so the layout cannot reflow as digits change and tabular figures buy nothing.

**The signature is the overprint.** Seats are inked pink, blue, mint and tangerine, and one ink band per player is laid in a row behind the tiles. Neighbouring bands overlap and `mix-blend-mode: multiply` turns each seam into a darker overprint — marking exactly where the players' letters join to make one word. One band per player rather than a fixed pair, so a duel gets a single seam in the middle and a four-player letter hunt gets three: the effect scales with the roster instead of being special-cased.

Getting it working involved two instructive failures:

- Adding `transform: rotate()` to the tiles for playfulness silently killed the effect. A transform creates a **stacking context**, so each tile isolated its own blend and two blended layers in separate stacking contexts can never blend with each other. The bands had to move out of the tiles entirely. The same trap governs the reveal animation: the growth transform goes on the `.bridge` row, never on an individual band, because a transformed band would stop blending with its neighbours. The row already carries `isolation: isolate`, so transforming it changes nothing about the blend.
- Then a decorative "VS" star burst was added in the gap — and at 42% of tile width it was wider than the gap, covering the overprint completely. It got cut. A "VS" badge is generic party-game decoration; the overprint is specific to this game, and only one of them could have the spot.

Motion is spent in three orchestrated places and nowhere else: the **countdown** (the number stamps down, the tiles lean toward each other, the paper grain intensifies), the **reveal** (both tiles flip together on a split-flap board), and the **win** (the board jolts out of register like a misprinted colour pass, then confetti in the winner's ink). One house easing, `--ease-boing`, overshoots and settles so things land rather than fade in.

Grain and the dot grid are generated from an inline SVG filter and a repeating gradient — no image requests, and they scale to any viewport.

---

## Accessibility

- Mobile-first and fluid to desktop, with a dedicated landscape treatment that scales tiles off the short axis. No horizontal scrolling at any width.
- Touch targets ≥ 44px throughout.
- Visible keyboard focus, and focus moves to the new screen on every transition rather than being stranded on a control that no longer exists.
- `prefers-reduced-motion` collapses transitions to instant state changes. The countdown still counts, because the number is the information, not the animation.
- A single assertive live region announces the round-critical moments — reveal, winner, draw — so the game is playable without sight. Toasts use a separate polite region so the two do not compete.

---

## Deploying

It is static files. Anything that serves them works — GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3.

```bash
# GitHub Pages: push, then enable Pages on the branch/folder.
```

Two requirements:

- **HTTPS.** WebRTC needs a secure context. `localhost` is exempt; a deployed HTTP origin is not.
- **Serve `assets/wordlist.txt` with gzip** if you can. It is 302 KB raw and about 100 KB compressed. Most hosts do this automatically.

No environment variables, no server-side anything.

---

## Configuration

Everything lives in `js/constants.js`.

| Constant | Default | Meaning |
| --- | --- | --- |
| `COUNTDOWN_SECONDS` | `3` | Beats before the reveal |
| `DEFAULT_SETTINGS` | duel · 30s · 2 | What a new room starts with |
| `RACE_DURATION_CHOICES_MS` | 15/30/45/60/90s | The options the host is offered |
| `RACE_DURATION_BOUNDS_MS` | 10s–180s | Hard clamp on anything arriving over the wire |
| `MIN_WORD_LENGTH_BOUNDS` | 2–10 | Hard clamp on the length setting |
| `MODE_CAPACITY` | duel 2 · hunt 3–4 | Seats each mode allows |
| `LETTER_ENTRY_DURATION_MS` | `45_000` | Soft cap; then a letter is picked for you |
| `SUBMIT_COALESCE_WINDOW_MS` | `120` | Fairness window for near-simultaneous submits |
| `DICTIONARY_TIMEOUT_MS` | `2_500` | Per-provider budget |
| `CONNECT_TIMEOUT_MS` | `12_000` | After this, report the network as blocking P2P |
| `HELLO_TIMEOUT_MS` | `10_000` | Time to identify before the seat is released |
| `MERRIAM_WEBSTER_API_KEY` | `""` | Set it to promote Merriam-Webster to primary |

**Adding a TURN server** for restrictive networks — in `net/PeerTransport.js`, pass an ICE config to the `Peer` constructor:

```js
new PeerCtor(id, {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:your-turn-host:3478", username: "user", credential: "pass" },
    ],
  },
});
```

**Swapping the transport** — write `net/FirebaseTransport.js` implementing `hostRoom`, `joinRoom`, `send`, `close` (plus the optional `dropConnection` and `isConnected`), then change the `createTransport` default in `net/NetworkClient.js`. No game logic changes.

---

## Testing

There is no test runner. Verification was done by driving two real browser tabs and asserting against live state, which for a networked game catches things a unit test cannot.

`window.__wordRace` exposes `{ store, game, board, profile, router, navigate }` for exactly this. Useful checks:

```js
// State parity — must be byte-identical on both peers.
const snap = () => { const s = __wordRace.store.getState();
  return JSON.stringify({ players: s.players, order: s.playerOrder, match: s.match }); };

// Network counters: dropped messages, clock offset, ping samples.
__wordRace.game.diagnostics();
```

What was verified end to end: room creation on the public broker, join by code and by URL, ready sync in both directions, byte-identical state across peers, letter secrecy (adversarial search of a guest's state and DOM), the countdown and simultaneous reveal, seat alternation, every word-rule case in both modes, live dictionary acceptance and fallback to the local list when the API timed out, the dead-hand oracle for pairs and for letter sets, host-leave detection, the submission race (10/10 against a 0/5 naive control), and profile prefill on return visits.

**Three-player letter hunt** was verified with three live tabs: one host holding two peer connections, three tiles and three overprint seams rendered, letters `B·A·N` collected secretly, `bad` refused for a missing letter, `bandit` accepted, and all three snapshots byte-identical afterwards. Settings guards were checked too — locked mid-match, duel refused while three players are seated, and the length floor held at 3.

**Three-player round robin** was verified across two rounds: round 1 paired Bob vs Cara with the *host* observing (0 letter inputs, word field hidden, scoreboard tagging), the observing host's word submission refused without reaching the queue, then round 2 rotated to Cara vs Ada with Bob benched. The rotation itself is checked separately for 2, 3 and 4 players — every pairing exactly once, equal appearances, and the longest consecutive run held at 2.

**Note on background tabs:** Chrome throttles `setTimeout` to roughly 1 second in a backgrounded tab, so anything driving the game from a hidden tab needs generous wait budgets. This is also why `Timer.js` is deadline-based — correctness does not depend on interval accuracy.

---

## Known limitations

- **The host is the server.** Closing the host's tab ends the room. Rooms are not host-independent.
- **No TURN server**, so a minority of restrictive networks cannot connect at all. Detected and explained, not silently retried.
- **Four players maximum.** The authority model extends further, but the board and scoreboard are built for four seats.
- **Nobody can join a match already in progress** — the rule was built from the letters of whoever was seated at the deal. Late arrivals are refused until the room returns to the lobby. (Round robin has observers, but they are seated players waiting their turn, not drop-in spectators.)
- **Round robin has no standings view.** Scores accumulate correctly, but there is no cross-table showing who beat whom.
- **Dropping below the minimum ends the match**, not the room. If a letter hunt falls to two players everyone returns to the lobby rather than racing a rule built for three.
- **Nothing persists but your name.** Scores live in memory for the length of the match.
- **Latency compensation is best-effort.** It stops latency from deciding rounds; it cannot arbitrate a true photo finish.
- **The local wordlist is a fallback, not a referee.** 36,869 frequency-ranked words. Obscure but valid words rely on the API being reachable.
- **Guest-side reconnect is partly unverified.** The identity and prefill half is confirmed working; full transport-level seat reclamation was hard to exercise reliably in a backgrounded-tab test environment, and the two fixes described above were made in response to real failures observed there.

---

## Future improvements

- A `FirebaseTransport` for host-independent rooms that survive the host leaving.
- Spectators and more than two players.
- Word definitions on the result screen — the API already returns them.
- Rematch with the same opponent, and match history.
- An optional typing indicator. The protocol has a slot reserved and it is deliberately unimplemented: during a race, seeing your opponent type six characters tells you they have found something.
- A "not me" control to clear the saved profile.
- Sound. A split-flap clack on reveal and a bell on a win would carry a lot of the feel.

---

## Credits

- **Networking** — [PeerJS](https://peerjs.com/) over its free public signalling broker.
- **Dictionary** — [Free Dictionary API](https://dictionaryapi.dev/), with optional [Merriam-Webster](https://dictionaryapi.com/).
- **Wordlist** — the 50k most frequent English words from [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) intersected with [dwyl/english-words](https://github.com/dwyl/english-words), giving 36,869 words that people actually use and that genuinely exist. Brand names and acronyms fall out naturally.
- **Type** — [Baloo 2](https://fonts.google.com/specimen/Baloo+2) and [Nunito](https://fonts.google.com/specimen/Nunito) via Google Fonts.
