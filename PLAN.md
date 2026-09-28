# Handos prototype: 1v1 online Rock-Paper-Scissors

A small static web game hosted on GitHub Pages. Players connect peer-to-peer through PeerJS. It costs nothing to run and needs no build step.

## Shared spec

- Files: `index.html`, `style.css`, `js/game.js` (pure logic, no DOM, importable in Node 24 for tests — use `globalThis.crypto`), `js/net.js` (PeerJS wrapper, uses global `Peer`), `js/rings.js` (ring database and effect engine), `js/app.js` (UI + glue), `tests/*.test.mjs` (`node --test`).
- UI language Italian. Moves: "sasso" ✊, "carta" ✋, "forbice" ✌️. sasso beats forbice, forbice beats carta, carta beats sasso.
- Structure: PARTITA (match) → ROUND → MANO (hand).
  - MANO: one RPS exchange (one commit-reveal). The hand loser loses HP based on the winning move: sasso 5, carta 3, forbice 1. On a draw both lose 1 HP. HP floors at 0.
  - ROUND: both start at 20 HP; hands are played until at least one player is at 0 HP. If exactly one is at 0, the other wins the round (+1 round point). If both reach 0 in the same hand, BOTH get +1 round point. HP then resets to 20 for the next round.
  - PARTITA: "al meglio di 3", extendable. The match is won by the player with at least 2 round points AND more round points than the opponent. If points are tied (2–2, 3–3, …) another round is played, indefinitely, until someone leads with ≥ 2. Examples: 1–0 then double KO → 2–1, match over; 1–1 then double KO → 2–2, continue; 2–2 then A wins → 3–2, A wins. There is no match draw.
  - After the match each player picks "Rivincita con gli stessi anelli" or "Rivincita cambiando anelli"; a new match (0–0, round 1, full HP) starts when both requested it. If either wants to change, both go through the deck phase again (each player's previous deck is preselected); otherwise the decks are kept and the match starts at the round-1 d10.
- Room code: 5 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Host PeerJS id = `"handos-proto-" + code`. If PeerJS errors with type `'unavailable-id'`, regenerate code. Guest uses a random PeerJS id and connects to the host id. Invite link = `location.origin + location.pathname + "?r=" + code`. Opening a link with `?r=` auto-joins.
- Only 2 players: host rejects any extra connection by sending `{t:"full"}` and closing it.
- Protocol (JSON over PeerJS DataConnection, reliable and ordered): see "Protocol" below. `{t:"hello", name}` and `{t:"full"}` are handled by `app.js`/`net.js`; every other message is handled by `Match`.
- Commit-reveal ("busta chiusa") so nobody can peek at the opponent's choice: every secret choice (deck, d10 seed, table, move + rings) is first sent as a SHA-256 hash with a random 16-byte hex salt, and revealed only after BOTH commits for it are known. A reveal that does not match its commit, or that breaks the rules (wrong deck/table size, rings not owned, invalid placement), ends the match flagged as cheating ("L'avversario ha barato"), won by the honest player.
- Disconnection: show "Avversario disconnesso" with a button back to home. No reconnection logic.
- Player name: optional input on home, saved in localStorage (wrapped in try/catch), default "Giocatore".
- No build step, no npm dependencies.

## Tasks

1. **Scaffold**: remove the Cloudflare leftovers and add the base files (`index.html`, `style.css`, placeholder JS modules, README, this plan).
2. **Game logic**: `js/game.js` (moves, hand/round/match resolution, match state, room codes, commit-reveal hashing) plus `tests/game.test.mjs`.
3. **Networking**: `js/net.js` PeerJS wrapper (host/guest, room code retry, full-room rejection, message send/receive, disconnect events).
4. **UI**: `js/app.js` and `style.css` (home, lobby/invite link, game screen, result/rematch, cheating and disconnect screens).
5. **Polish and deploy**: end-to-end testing across two browsers, fixes, and GitHub Pages deployment.

## API: `js/game.js`

The header comment in `js/game.js` has the full details. Run the tests with `node --test` from the repo root. Node 24 does not accept a directory argument, so either pass no argument or use `node --test "tests/*.test.mjs"`. `tests/game.test.mjs` covers the pure helpers, `tests/match.test.mjs` plays host + guest `Match` instances against each other through an in-memory bus (immediate, random-delay and manual delivery).

- Constants: `MOVES`, `EMOJI`, `LABEL`, `MAX_HP` (20), `DAMAGE` (`{sasso:5, carta:3, forbice:1}`, keyed by the winning move), `DRAW_DAMAGE` (1), `ROUNDS_TO_WIN` (2), `ROOM_ALPHABET`, `PHASES`.
- Functions: `isMove(x)`, `outcome(a, b)` (returns 1, -1 or 0), `matchWinner({me, opp})` (from round points: "me", "opp" or null), `makeSalt()`, `makeRoomCode()`, `isValidDeck(ids)`, `isValidTable(ids, size, deck)`.
- Hashes (all async, hex SHA-256): `commitHash(hand, move, rings, salt)` of `` `${hand}:${move}:${rings.join(",")}:${salt}` ``, `verifyReveal(hash, hand, move, rings, salt)`, `deckHash(deck, salt)` of `` `deck:${sorted ids}:${salt}` ``, `tableHash(round, table, salt)` of `` `table:${round}:${sorted ids}:${salt}` ``, `seedHash(round, seed)` of `` `seed:${round}:${seed}` ``, `rollD10(round, seedHost, seedGuest)` = 1 + (first 4 bytes of SHA-256 of `` `${round}:${seedHost}:${seedGuest}` `` as a big-endian uint32, mod 10).
- `new Match({role: "host" | "guest", send})`: one match from the local player's view. `send(msg)` is called for every outgoing protocol message, in order (without it, messages are pushed to `m.outbox`). All methods are async and queued internally, so they never interleave; `idle()` returns a promise for the end of the queue.
  - Actions, each returning `true` when accepted:
    - `chooseDeck(ids)`: phase "deck", exactly `DECK_SIZE` distinct ring ids.
    - `chooseTable(ids)`: phase "table", exactly `d10` distinct ids from my deck.
    - `pick(move, rings)`: phase "hand", rings in finger order (left to right), checked with `validatePlacement` against my active table.
    - `receive(msg)`: any opponent message. Malformed, unknown or out-of-phase messages are ignored (returns false).
    - `requestRematch({changeDeck})`: phase "over". Forced to `changeDeck: true` when a deck is missing (cheat detected in the deck phase).
  - State fields:
    - `role`, `phase`: "deck" (choose decks) → "roll" (seed exchange, no user action) → "table" (choose table) → "hand" (play hands) → back to "roll" when a round ends, or "over". `submitted` / `oppSubmitted`: whether I / the opponent have committed a choice in the current phase.
    - `deck {me, opp}` (sorted ids; `opp` is null until revealed), `prevDeck` (my deck of the previous match, for preselection), `d10` (null until rolled), `table {me, opp}`, `active {me, opp}` (table rings not used yet this round; a ring is "used" if it is on the table but not active).
    - `myMove`, `myRings`: my committed choice for the current hand.
    - `hand`: protocol hand sequence number (1-based, monotonic across the whole match). `roundNo` and `handInRound`: display counters, both 1-based.
    - `points {me, opp}`: round points. `hp {me, opp}`: HP in the current round.
    - `winner` (null, "me" or "opp"; never a draw), `cheated`, `iWantRematch`, `oppWantsRematch`, `rematchChangeDeck {me, opp}` (null until requested).
    - `lastResult`: the last resolved hand: `{hand, roundNo, handInRound, me, opp, outcome, first, ringsMe, ringsOpp, log, baseDmgMe, baseDmgOpp, dmgMe, dmgOpp, healMe, healOpp, hpBeforeMe, hpBeforeOpp, hpMe, hpOpp, stolenMe, stolenOpp, roundEnded, roundWinner, pointsMe, pointsOpp, matchOver}`. `first` is "me" or "opp" (the faster player). `log` comes from `resolveHand`. `baseDmg*` is the damage before rings, `dmg*` and `heal*` are the final pools, `hp*` is HP right after the hand, before any round reset (a KO shows as 0). `stolenMe` are my rings disabled by the opponent's Ladro. `roundWinner` is null, "me", "opp" or "both".
    - `history`: every hand's `lastResult`. `rounds`: finished rounds, `{roundNo, winner, hpMe, hpOpp}` with the final HP.
    - When a round ends and the match goes on, `hp` resets to 20, `roundNo` increments, `handInRound` goes back to 1, `d10`/`table`/`active` are cleared and the phase goes to "roll". When the match is over, everything stays as it ended.

## Protocol

`host` / `guest` is the canonical order for every shared random value, so both clients compute the same numbers. `round` and `hand` are 1-based; `hand` is monotonic across the whole match. Commits for the current or the next round/hand are held until needed; the first message for a given slot wins. Salts and seeds are 32-char hex, hashes 64-char hex.

| Message | Sent when |
|---|---|
| `{t:"deck-commit", hash}` | The player confirms their deck (phase "deck"). Followed by `seed-commit` for round 1, unless it was already sent in `rematch`. |
| `{t:"deck-reveal", deck, salt}` | Both deck commits are known. |
| `{t:"seed-commit", round, hash}` | Round 1: with `deck-commit`. Round R+1: with `table-commit` of round R. |
| `{t:"seed-reveal", round, seed}` | Both seed commits are known and the roll is due: round 1 right after `deck-reveal`, round R > 1 as soon as round R−1 ends. `d10 = rollD10(round, seedHost, seedGuest)`. |
| `{t:"table-commit", round, hash}` | The player confirms their table (exactly `d10` rings of their deck). |
| `{t:"table-reveal", round, table, salt}` | Both table commits are known. |
| `{t:"commit", hand, hash}` | The player confirms move + rings. |
| `{t:"order", hand, first}` | Host → guest only, `first` is "host" or "guest". The host is the arbiter of speed: when the host creates its own commit it records whether the guest's commit for that hand had already been received (first = "guest") or not (first = "host"). Sent as soon as both commits are known, before the host's reveal. |
| `{t:"reveal", hand, move, rings, salt}` | Both commits are known; the host sends it right after `order`, the guest only after receiving `order` for that hand (so the host cannot choose the order after seeing the guest's move). |
| `{t:"rematch", changeDeck, seed}` | Phase "over". `seed` is `seedHash(1, seed)` for round 1 of the next match. |

Hand resolution: both clients call `resolveHand` from their own view, with `first` mapped to "me"/"opp" and ``rng = makeRng(SHA-256(`${hand}:${saltHost}:${saltGuest}`))``, and get mirrored results. Then HP = `hpAfter`, the rings placed by both players (cancelled ones included) and the rings disabled by Ladro are removed from the active tables, and the usual round/match rules apply.

## API: `js/net.js`

The header comment in `js/net.js` has the full details. It uses the global `Peer` (PeerJS 1.5.4 from unpkg), but only when a function is called, never at import time. `tests/net.test.mjs` exercises it with a fake `Peer`.

- `hostRoom({onCode, onOpponent, onMessage, onClose, onError})` returns a handle.
  - It registers the peer id `"handos-proto-" + code`. If the id is taken (`'unavailable-id'`), it picks a new code, up to 5 attempts.
  - `onCode(code)` fires once the peer is registered. `onOpponent()` fires when the first guest's connection opens.
  - Any extra guest is sent `{t:"full"}` and then disconnected.
- `joinRoom(code, {onOpen, onMessage, onClose, onError})` returns a handle.
  - The code is trimmed, uppercased and validated. The guest gets a random peer id and connects with `{reliable: true, serialization: "json"}`.
  - `onOpen()` fires when the connection is open. A `{t:"full"}` reply turns into `onError("Stanza piena.", "full")`, which can arrive just after `onOpen`. The join attempt times out after 15 seconds.
- Shared callbacks:
  - `onMessage(msg)` fires for every protocol message.
  - `onClose()` fires once when the opponent connection drops after it was open.
  - `onError(text, type)` fires once for a fatal error that happens before an opponent is connected. `text` is an Italian message (for example "Stanza non trovata. Controlla il codice."). `type` is the PeerJS error type, or one of `"full"`, `"invalid-code"` or `"timeout"`.
  - After either `onClose` or `onError`, the session is torn down.
  - Signaling-server errors are ignored once the P2P link is up. A lost signaling connection triggers `peer.reconnect()`.
- Handle methods:
  - `send(msg)` returns `true`, or `false` when not connected.
  - `close()` (alias `destroy()`) tears the session down without firing any callback. It also runs automatically on `beforeunload`.
- `buildInviteLink(code)`, `readRoomFromUrl()` (returns a valid code from `?r=`, or null), `normalizeCode(code)`, `isRoomCode(code)`, `ID_PREFIX`.

## Rings

Design (fixed, decided by the user):

- There are 20 rings. Before the match each player picks 10 of them as their deck (`DECK_SIZE`). Both players may pick the same rings.
- At the start of each round a shared d10 (1..10) is rolled. Each player secretly chooses exactly that many rings from their deck to put on their table. The tables are revealed at the same time, and both players see each other's table.
- In each hand, besides the move, a player places rings from their own table on the extended fingers of the move: `SLOTS = {sasso: 0, carta: 5, forbice: 2}`. Fingers are ordered left to right. A ring used in a hand is disabled until the next round (new d10, new table).
- Damage model: the hand starts from the base damage pools (the loser takes `DAMAGE[winning move]`, the winner takes 0; on a draw both take `DRAW_DAMAGE`) and heal pools at 0. Then the rings apply, one at a time, and each one changes the pools at the moment it applies, so order matters. Damage pools never go below 0. "Win", "lose" and "draw" are from the ring owner's point of view. At the end, `hpAfter = clamp(hp − dmg + heal, 0, MAX_HP)`.
- Application order: the rings of the player who confirmed their full move first ("faster") apply first, left to right. Then the slower player's rings apply, left to right. There are two exceptions:
  - Ombra is a pre-pass. If the faster player has Ombra, all of the slower player's rings are cancelled this hand, including their Ombra. If only the slower player has Ombra, all of the faster player's rings are cancelled. Cancelled rings still count as used.
  - Fenice is checked at the very end. If its (uncancelled) owner would end the hand at 0 HP, they stay at 1.

| # | id | Name | Effect |
|---|----|------|--------|
| 1 | `gigante` | Anello del Gigante | If you win: +1 damage for each other uncancelled ring on your fingers this hand. |
| 2 | `scriba` | Anello dello Scriba | +2 damage if you win with Carta. |
| 3 | `lama` | Anello della Lama | +2 damage if you win with Forbice. |
| 4 | `ferro` | Anello di Ferro | You take 2 less damage (current pool, min 0). |
| 5 | `nebbia` | Anello della Nebbia | If you lose, your pool becomes min(current, 1). |
| 6 | `specchio` | Anello dello Specchio | If you lose, the opponent's pool += floor(your current pool / 2). |
| 7 | `vampiro` | Anello del Vampiro | If you win, heal 2. |
| 8 | `guaritore` | Anello del Guaritore | Heal 3, whatever the outcome. |
| 9 | `fenice` | Anello della Fenice | If this hand would bring you to 0 HP, you stay at 1 (end check). |
| 10 | `pace` | Anello della Pace | On a draw your pool becomes 0. |
| 11 | `caos` | Anello del Caos | On a draw the opponent's pool += 2. |
| 12 | `tuono` | Anello del Tuono | If you win: +3 damage. If you lose: +1 to your own pool. |
| 13 | `doppio-taglio` | Anello del Doppio Taglio | If you win, the opponent's pool ×2. If you lose, your pool ×2. |
| 14 | `rabbia` | Anello della Rabbia | If you win: +floor((MAX_HP − your HP at start of hand) / 5) damage. |
| 15 | `tramonto` | Anello del Tramonto | +4 damage if you win and your HP at start of hand is ≤ 10. |
| 16 | `sacrificio` | Anello del Sacrificio | Your pool += 2 always. If you win, the opponent's pool += 4. |
| 17 | `sorte` | Anello della Sorte | If you win: +1d6 damage (rng). |
| 18 | `ombra` | Anello dell'Ombra | Cancels all the opponent's rings this hand (pre-pass). |
| 19 | `ladro` | Anello del Ladro | If you win: disable one random still-active ring on the opponent's table. |
| 20 | `montagna` | Anello della Montagna | If the opponent won with Sasso, your pool becomes 0. |

## API: `js/rings.js`

Pure logic (no DOM, no network), importable in Node. `tests/rings.test.mjs` covers it. It imports `DAMAGE`, `DRAW_DAMAGE`, `MAX_HP`, `outcome` and `isMove` from `js/game.js`, and `Match` in `js/game.js` imports it back (an ES module cycle that is safe because neither module uses the other's exports at load time).

- Constants: `SLOTS`, `DECK_SIZE` (10), `RINGS` (20 × `{id, name, gem, icon, text}`: the id is a stable kebab slug, `gem` is a CSS color, `icon` is an emoji and `text` is short Italian rules text), `RING_BY_ID`.
- `validatePlacement(move, ringIds, activeTable)` returns a bool. It checks that `ringIds.length ≤ SLOTS[move]`, that there are no duplicates, and that every id is a known ring in `activeTable`.
- `resolveHand({moves:{me,opp}, rings:{me,opp}, first, hp:{me,opp}, myActiveTable, oppActiveTable, rng})`:
  - `rings.*` are ring ids in finger order. `first` is `"me"` or `"opp"` (the faster player). `hp` is the HP at the start of the hand. `*ActiveTable` are the rings still active on each table after removing the ones used this hand. `rng()` returns floats in [0, 1).
  - It returns `{dmg, heal, hpAfter, outcome, log, stolen}`.
    - `dmg` and `heal` are the final pools, `{me, opp}`. `hpAfter` is clamped to 0..MAX_HP with Fenice applied. `outcome` is 1, 0 or -1 from "me".
    - `log` is `[{owner, id, cancelled, note}]` in application order. `note` is short Italian text such as "+2 danni", "nessun effetto" or "annullato dall'Ombra".
    - `stolen.me` holds my ring ids that the opponent's Ladro disabled. `stolen.opp` holds the opponent's ids that my Ladro disabled.
  - Randomness: Sorte rolls `1 + floor(rng() * 6)`. Ladro picks index `floor(rng() * n)` from the victim's active table sorted by id. rng is called only when the effect triggers (a win, and a non-empty table for Ladro), in application order (faster player first). So both clients, each computing from its own view with the same rng sequence, get mirrored identical results. The mirror property is tested on 2000 random scenarios.
  - It throws on an invalid move, an invalid `first`, or an unknown ring id.
- `makeRng(seedHexOrBytes)` returns a deterministic PRNG (mulberry32 seeded by FNV-1a over up to 32 seed bytes). The seed can be a hex string or a byte array, and both forms give the same stream for the same bytes.
