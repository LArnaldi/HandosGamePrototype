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
