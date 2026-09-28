# Handos prototype: 1v1 online Rock-Paper-Scissors

A small static web game hosted on GitHub Pages. Players connect peer-to-peer through PeerJS. It costs nothing to run and needs no build step.

## Shared spec

- Files: `index.html`, `style.css`, `js/game.js` (pure logic, no DOM, importable in Node 24 for tests — use `globalThis.crypto`), `js/net.js` (PeerJS wrapper, uses global `Peer`), `js/app.js` (UI + glue), `tests/game.test.mjs` (`node --test`).
- UI language Italian. Moves: "sasso" ✊, "carta" ✋, "forbice" ✌️. sasso beats forbice, forbice beats carta, carta beats sasso.
- Match: first to 3 round wins. Draws don't count. After the match both can press "Rivincita"; a new match starts when both requested it.
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
