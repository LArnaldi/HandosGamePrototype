# Handos prototype: 1v1 online Rock-Paper-Scissors

A small static web game hosted on GitHub Pages. Players connect peer-to-peer through PeerJS. It costs nothing to run and needs no build step.

## Shared spec

- Files: `index.html`, `style.css`, `js/game.js` (pure logic, no DOM, importable in Node 24 for tests — use `globalThis.crypto`), `js/net.js` (PeerJS wrapper, uses global `Peer`), `js/app.js` (UI + glue), `tests/game.test.mjs` (`node --test`).
- UI language Italian. Moves: "sasso" ✊, "carta" ✋, "forbice" ✌️. sasso beats forbice, forbice beats carta, carta beats sasso.
- Structure: PARTITA (match) → ROUND → MANO (hand).
  - MANO: one RPS exchange (one commit-reveal). The hand loser loses HP based on the winning move: sasso 5, carta 3, forbice 1. On a draw both lose 1 HP. HP floors at 0.
  - ROUND: both start at 20 HP; hands are played until at least one player is at 0 HP. If exactly one is at 0, the other wins the round (+1 round point). If both reach 0 in the same hand, BOTH get +1 round point. HP then resets to 20 for the next round.
  - PARTITA: "al meglio di 3", extendable. The match is won by the player with at least 2 round points AND more round points than the opponent. If points are tied (2–2, 3–3, …) another round is played, indefinitely, until someone leads with ≥ 2. Examples: 1–0 then double KO → 2–1, match over; 1–1 then double KO → 2–2, continue; 2–2 then A wins → 3–2, A wins. There is no match draw.
  - After the match both can press "Rivincita"; a new match (0–0, round 1, full HP) starts when both requested it.
- Room code: 5 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Host PeerJS id = `"handos-proto-" + code`. If PeerJS errors with type `'unavailable-id'`, regenerate code. Guest uses a random PeerJS id and connects to the host id. Invite link = `location.origin + location.pathname + "?r=" + code`. Opening a link with `?r=` auto-joins.
- Only 2 players: host rejects any extra connection by sending `{t:"full"}` and closing it.
- Protocol (JSON over PeerJS DataConnection, reliable): `{t:"hello", name}`, `{t:"commit", hand, hash}`, `{t:"reveal", hand, move, salt}` (`hand` is a sequence number, 1-based and monotonic across the whole match, not reset per round), `{t:"rematch"}`, `{t:"full"}`.
- Commit-reveal ("busta chiusa") so nobody can peek at the opponent's move: on picking a move, generate salt (16 random bytes, hex), hash = hex SHA-256 of `` `${hand}:${move}:${salt}` ``, send commit. Only after BOTH own and opponent commit for the hand are known, send reveal. On receiving opponent reveal, verify hash and that move is valid; on mismatch, the match ends flagged as cheating ("L'avversario ha barato"). Then resolve the hand.
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

The header comment in `js/game.js` has the full details. Run the tests with `node --test` from the repo root. Node 24 does not accept a directory argument, so either pass no argument or use `node --test "tests/*.test.mjs"`.

- Constants: `MOVES`, `EMOJI`, `LABEL`, `MAX_HP` (20), `DAMAGE` (`{sasso:5, carta:3, forbice:1}`, keyed by the winning move), `DRAW_DAMAGE` (1), `ROUNDS_TO_WIN` (2), `ROOM_ALPHABET`.
- Functions: `isMove(x)`, `outcome(a, b)` (returns 1, -1 or 0), `matchWinner({me, opp})` (from round points: "me", "opp" or null), `makeSalt()`, `makeRoomCode()`, `async commitHash(hand, move, salt)`, `async verifyReveal(hash, hand, move, salt)`.
- `new Match()`
  - State fields:
    - `hand`: protocol hand sequence number (1-based, monotonic across the whole match). `roundNo` and `handInRound`: display counters, both 1-based.
    - `points {me, opp}`: round points. `hp {me, opp}`: HP in the current round.
    - `winner` (null, "me" or "opp"; never a draw), `cheated`, `iWantRematch`, `oppWantsRematch`.
    - `lastResult`: the last resolved hand, `{hand, roundNo, handInRound, me, opp, outcome, dmgMe, dmgOpp, hpMe, hpOpp, roundEnded, roundWinner, pointsMe, pointsOpp, matchOver}`. `dmg*` is the damage dealt that hand, before HP is floored at 0. `hp*` is HP right after the hand, before any round reset, so a KO shows as 0. `roundWinner` is null, "me", "opp" or "both". `points*` are the round points after the hand.
    - `history`: every hand's `lastResult`. `rounds`: finished rounds, `{roundNo, winner, hpMe, hpOpp}` with the final HP.
    - When a hand ends a round and the match goes on, `hp` resets to 20, `roundNo` increments and `handInRound` goes back to 1 immediately. When the match is over, `roundNo` and `hp` stay as they ended.
  - `async pick(move)` returns a `{t:"commit", hand, hash}` message, or null when the pick isn't allowed.
  - `receiveCommit(msg)` stores the opponent's commit. A commit for hand+1 that arrives early is buffered (also across a round boundary).
  - `revealReady()` and `takeReveal()`: after every `pick()` or `receiveCommit()`, check `if (m.revealReady()) send(m.takeReveal())`. `takeReveal()` resolves the hand itself if the opponent's reveal already arrived, so re-render afterwards.
  - `async receiveReveal(msg)` returns `{resolved, cheated}`. If `cheated` is true, the match is over with `winner="me"`.
  - `requestRematch()` returns `{t:"rematch"}`, or null. It works only after the match is over. `receiveRematch()` returns true when it causes a reset. A reset to a fresh match (0–0, round 1, hand 1, full HP) happens as soon as both players want a rematch.

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

Pure logic (no DOM, no network), importable in Node. `tests/rings.test.mjs` covers it. It imports `DAMAGE`, `DRAW_DAMAGE`, `MAX_HP` and `outcome` from `js/game.js`. It is not wired into `Match` or the UI yet.

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
