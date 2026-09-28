# Handos prototype: 1v1 online Rock-Paper-Scissors

A small static web game hosted on GitHub Pages. Players connect peer-to-peer through PeerJS. It costs nothing to run and needs no build step.

## Shared spec

- Files: `index.html`, `style.css`, `js/game.js` (pure logic, no DOM, importable in Node 24 for tests — use `globalThis.crypto`), `js/net.js` (PeerJS wrapper, uses global `Peer`), `js/app.js` (UI + glue), `tests/game.test.mjs` (`node --test`).
- UI language Italian. Moves: "sasso" ✊, "carta" ✋, "forbice" ✌️. sasso beats forbice, forbice beats carta, carta beats sasso.
- Match: HP system. Each player starts with 20 HP. The round loser loses HP based on the winning move: sasso 5, carta 3, forbice 1. On a draw both lose 1 HP. HP floors at 0; a player at 0 HP loses. If both hit 0 in the same round the match is a draw. After the match both can press "Rivincita"; a new match starts when both requested it.
- Room code: 5 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Host PeerJS id = `"handos-proto-" + code`. If PeerJS errors with type `'unavailable-id'`, regenerate code. Guest uses a random PeerJS id and connects to the host id. Invite link = `location.origin + location.pathname + "?r=" + code`. Opening a link with `?r=` auto-joins.
- Only 2 players: host rejects any extra connection by sending `{t:"full"}` and closing it.
- Protocol (JSON over PeerJS DataConnection, reliable): `{t:"hello", name}`, `{t:"commit", round, hash}`, `{t:"reveal", round, move, salt}`, `{t:"rematch"}`, `{t:"full"}`.
- Commit-reveal ("busta chiusa") so nobody can peek at the opponent's move: on picking a move, generate salt (16 random bytes, hex), hash = hex SHA-256 of `` `${round}:${move}:${salt}` ``, send commit. Only after BOTH own and opponent commit for the round are known, send reveal. On receiving opponent reveal, verify hash and that move is valid; on mismatch, the match ends flagged as cheating ("L'avversario ha barato"). Then resolve the round.
- Disconnection: show "Avversario disconnesso" with a button back to home. No reconnection logic.
- Player name: optional input on home, saved in localStorage (wrapped in try/catch), default "Giocatore".
- No build step, no npm dependencies.

## Tasks

1. **Scaffold**: remove the Cloudflare leftovers and add the base files (`index.html`, `style.css`, placeholder JS modules, README, this plan).
2. **Game logic**: `js/game.js` (moves, round resolution, match state, room codes, commit-reveal hashing) plus `tests/game.test.mjs`.
3. **Networking**: `js/net.js` PeerJS wrapper (host/guest, room code retry, full-room rejection, message send/receive, disconnect events).
4. **UI**: `js/app.js` and `style.css` (home, lobby/invite link, game screen, result/rematch, cheating and disconnect screens).
5. **Polish and deploy**: end-to-end testing across two browsers, fixes, and GitHub Pages deployment.

## API: `js/game.js`

The header comment in `js/game.js` has the full details. Run the tests with `node --test` from the repo root. Node 24 does not accept a directory argument, so either pass no argument or use `node --test "tests/*.test.mjs"`.

- Constants: `MOVES`, `EMOJI`, `LABEL`, `MAX_HP` (20), `DAMAGE` (`{sasso:5, carta:3, forbice:1}`, keyed by the winning move), `DRAW_DAMAGE` (1), `ROOM_ALPHABET`.
- Functions: `isMove(x)`, `outcome(a, b)` (returns 1, -1 or 0), `makeSalt()`, `makeRoomCode()`, `async commitHash(round, move, salt)`, `async verifyReveal(hash, round, move, salt)`.
- `new Match()`
  - State fields: `round`, `hp {me, opp}`, `winner` (null, "me", "opp" or "draw"), `cheated`, `lastResult {round, me, opp, outcome, dmgMe, dmgOpp, hpMe, hpOpp}` (`dmg*` is the damage dealt that round, before HP is floored at 0; `hp*` is HP after it), `history`, `iWantRematch`, `oppWantsRematch`.
  - `async pick(move)` returns a `{t:"commit", round, hash}` message, or null when the pick isn't allowed.
  - `receiveCommit(msg)` stores the opponent's commit. A commit for round+1 that arrives early is buffered.
  - `revealReady()` and `takeReveal()`: after every `pick()` or `receiveCommit()`, check `if (m.revealReady()) send(m.takeReveal())`. `takeReveal()` resolves the round itself if the opponent's reveal already arrived, so re-render afterwards.
  - `async receiveReveal(msg)` returns `{resolved, cheated}`. If `cheated` is true, the match is over with `winner="me"`.
  - `requestRematch()` returns `{t:"rematch"}`, or null. It works only after the match is over. `receiveRematch()` returns true when it causes a reset. A reset to a fresh match happens as soon as both players want a rematch.

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
