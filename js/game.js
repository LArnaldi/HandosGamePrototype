// game.js: pure game logic (moves, match/round/hand rules, rings integration, room codes, commit-reveal
// protocol); no DOM, Node-testable.
//
// Structure: PARTITA (match) -> ROUND -> MANO (hand), with rings (see PLAN.md, "Rings").
//   DECK:    at the start of each match each player picks DECK_SIZE (10) distinct rings (commit-reveal).
//   ROUND:   a shared d10 is rolled "a due mani" (commit-reveal of one seed per player); each player then
//            secretly puts exactly d10 rings of their deck on their table (commit-reveal). Both start
//            at MAX_HP; hands are played until at least one player is at 0 HP. Exactly one at 0 -> the
//            other gets +1 round point; both at 0 in the same hand -> BOTH get +1. Every ring is active
//            again in the next round (new d10, new table).
//   MANO:    one commit-reveal of {move, rings in finger order}. The host decides who was faster
//            (see "order" below); rings.resolveHand() computes the damage. Used rings (both players',
//            cancelled included) are disabled until the end of the round, and so are rings disabled
//            by Ladro.
//   PARTITA: won by the player with >= ROUNDS_TO_WIN (2) round points AND strictly more than the
//            opponent; ties keep playing rounds. A detected cheater loses at once (winner "me").
//
// Protocol (all messages are JSON objects with a `t` field). "host"/"guest" is the canonical order
// used in every shared random value, so both clients compute the same numbers.
//   {t:"deck-commit", hash}            hash = deckHash(deck, salt)
//   {t:"deck-reveal", deck, salt}      sent once both deck commits are known
//   {t:"seed-commit", round, hash}     hash = seedHash(round, seed). Round 1: sent with deck-commit
//                                      (or inside "rematch"); round R+1: sent with table-commit of R.
//   {t:"seed-reveal", round, seed}     sent once both seed commits are known and the roll is due
//                                      (round 1: right after deck-reveal; round R>1: when R-1 ends).
//                                      d10 = rollD10(round, seedHost, seedGuest)
//   {t:"table-commit", round, hash}    hash = tableHash(round, table, salt)
//   {t:"table-reveal", round, table, salt}
//   {t:"commit", hand, hash}           hash = commitHash(hand, move, rings, salt)
//   {t:"order", hand, first}           host -> guest only; first = "host" | "guest". The host records,
//                                      when its own commit is created, whether the guest's commit had
//                                      already been received (-> "guest") or not (-> "host"). It is
//                                      sent before the host's reveal; the guest never reveals a hand
//                                      before receiving its order.
//   {t:"reveal", hand, move, rings, salt}
//   {t:"rematch", changeDeck, seed}    seed = seedHash(1, seed) for round 1 of the next match
//   `hand` is 1-based and monotonic across the whole match. Per-hand shared randomness (Sorte, Ladro):
//   makeRng(SHA-256(`${hand}:${saltHost}:${saltGuest}`)).
//
// API
//   MOVES, EMOJI, LABEL, ROOM_ALPHABET, PHASES
//   MAX_HP (20), DAMAGE {sasso:5, carta:3, forbice:1} (keyed by the WINNING move), DRAW_DAMAGE (1), ROUNDS_TO_WIN (2)
//   isMove(x);  outcome(a, b) -> 1 | -1 | 0 (a's point of view);  matchWinner({me, opp}) -> "me"|"opp"|null
//   makeSalt() -> 32-char hex;  makeRoomCode() -> 5 chars from ROOM_ALPHABET
//   async commitHash(hand, move, rings, salt);  async verifyReveal(hash, hand, move, rings, salt) -> bool
//   async deckHash(deck, salt);  async tableHash(round, table, salt);  async seedHash(round, seed)
//   async rollD10(round, seedHost, seedGuest) -> 1..10
//   isValidDeck(ids);  isValidTable(ids, size, deck)
//
//   class Match (one match, local player's view): new Match({role: "host"|"guest", send})
//     send(msg) is called for every outgoing message, in order (default: pushed to m.outbox).
//     Every method below is queued internally, so calls never interleave.
//     async chooseDeck(ids)             -> bool (phase "deck", DECK_SIZE distinct ring ids)
//     async chooseTable(ids)            -> bool (phase "table", exactly d10 ids from my deck)
//     async pick(move, rings)           -> bool (phase "hand"; rings in finger order, left to right)
//     async receive(msg)                -> bool (true if the message was accepted)
//     async requestRematch({changeDeck}) -> bool (phase "over")
//     idle()                            -> promise that settles when the queue is empty
//     state: role, phase ("deck"|"roll"|"table"|"hand"|"over"), submitted, oppSubmitted,
//            deck {me, opp}, prevDeck, d10, table {me, opp}, active {me, opp} (rings not yet used),
//            myMove, myRings, hand, roundNo, handInRound, hp {me, opp}, points {me, opp},
//            winner, cheated, iWantRematch, oppWantsRematch, rematchChangeDeck {me, opp},
//            lastResult, history, rounds (see PLAN.md)

import { DECK_SIZE, RING_BY_ID, validatePlacement, resolveHand, makeRng } from "./rings.js";

export const MOVES = ["sasso", "carta", "forbice"];
export const EMOJI = { sasso: "✊", carta: "✋", forbice: "✌️" };
export const LABEL = { sasso: "Sasso", carta: "Carta", forbice: "Forbice" };
export const MAX_HP = 20;
export const DAMAGE = { sasso: 5, carta: 3, forbice: 1 };
export const DRAW_DAMAGE = 1;
export const ROUNDS_TO_WIN = 2;
export const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PHASES = ["deck", "roll", "table", "hand", "over"];

const BEATS = { sasso: "forbice", forbice: "carta", carta: "sasso" };

export function isMove(x) {
  return typeof x === "string" && Object.hasOwn(BEATS, x);
}

export function outcome(a, b) {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)));
}

export function makeSalt() {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export function makeRoomCode(len = 5) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  // 256 % 31 bias is negligible for room codes.
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

const isRingId = (id) => typeof id === "string" && Object.hasOwn(RING_BY_ID, id);
const sortedIds = (ids) => [...ids].sort();
const without = (list, remove) => list.filter((id) => !remove.includes(id));

export function commitHash(hand, move, rings, salt) {
  return sha256Hex(`${hand}:${move}:${rings.join(",")}:${salt}`);
}

export async function verifyReveal(hash, hand, move, rings, salt) {
  if (!isMove(move) || !Array.isArray(rings) || typeof salt !== "string" || typeof hash !== "string") return false;
  return (await commitHash(hand, move, rings, salt)) === hash;
}

export function deckHash(deck, salt) {
  return sha256Hex(`deck:${sortedIds(deck).join(",")}:${salt}`);
}

export function tableHash(round, table, salt) {
  return sha256Hex(`table:${round}:${sortedIds(table).join(",")}:${salt}`);
}

export function seedHash(round, seed) {
  return sha256Hex(`seed:${round}:${seed}`);
}

// Shared d10: neither seed alone decides it. 2^32 % 10 = 6, so the bias is ~1e-9.
export async function rollD10(round, seedHost, seedGuest) {
  const hex = await sha256Hex(`${round}:${seedHost}:${seedGuest}`);
  return 1 + (parseInt(hex.slice(0, 8), 16) % 10);
}

export function isValidDeck(ids) {
  return Array.isArray(ids) && ids.length === DECK_SIZE && new Set(ids).size === ids.length && ids.every(isRingId);
}

export function isValidTable(ids, size, deck) {
  return Array.isArray(ids) && Array.isArray(deck) && ids.length === size && new Set(ids).size === ids.length
    && ids.every((id) => isRingId(id) && deck.includes(id));
}

// Match winner from round points: at least ROUNDS_TO_WIN and strictly ahead; ties keep playing.
export function matchWinner(points) {
  const { me, opp } = points;
  if (me >= ROUNDS_TO_WIN && me > opp) return "me";
  if (opp >= ROUNDS_TO_WIN && opp > me) return "opp";
  return null;
}

// Incoming message shape checks (content is checked later, against the commits).
const MAX_LIST = 32;
const isHex = (x, len) => typeof x === "string" && x.length === len && /^[0-9a-f]+$/.test(x);
const isPosInt = (x) => Number.isInteger(x) && x > 0;
const isStrList = (x) => Array.isArray(x) && x.length <= MAX_LIST && x.every((s) => typeof s === "string" && s.length <= 64);
const isRole = (x) => x === "host" || x === "guest";

export class Match {
  #send;
  #q = Promise.resolve();
  #my; // my secrets: {deck, seeds: Map(round -> {seed, hash, revealed}), table, hand}
  #in; // opponent messages, keyed by round / hand
  #oppSeed; // Map(round -> verified opponent seed)
  #oppHand; // verified opponent reveal for the current hand
  #orderSent; // host: order message sent for the current hand
  #rematch; // {me: {changeDeck, seed, hash}, opp: {changeDeck, hash}}

  constructor({ role = "host", send } = {}) {
    if (!isRole(role)) throw new Error("Match: ruolo non valido");
    this.role = role;
    this.outbox = [];
    this.#send = typeof send === "function" ? send : (msg) => this.outbox.push(msg);
    this.prevDeck = null; // my deck of the previous match (to preselect it in the UI)
    this.deck = { me: null, opp: null };
    this.#reset(false);
  }

  #reset(keepDecks) {
    if (this.deck.me) this.prevDeck = [...this.deck.me];
    this.phase = keepDecks ? "roll" : "deck";
    if (!keepDecks) this.deck = { me: null, opp: null };
    this.d10 = null;
    this.table = { me: null, opp: null };
    this.active = { me: null, opp: null };
    this.hand = 1; // protocol hand sequence number, monotonic across the whole match
    this.roundNo = 1;
    this.handInRound = 1;
    this.points = { me: 0, opp: 0 };
    this.hp = { me: MAX_HP, opp: MAX_HP };
    this.winner = null;
    this.cheated = false;
    this.lastResult = null;
    this.history = [];
    this.rounds = [];
    this.iWantRematch = false;
    this.oppWantsRematch = false;
    this.rematchChangeDeck = { me: null, opp: null };
    this.#rematch = { me: null, opp: null };
    this.#my = { deck: null, seeds: new Map(), table: null, hand: null };
    this.#in = {
      deckHash: null, deckReveal: null,
      seedHash: new Map(), seedReveal: new Map(),
      tableHash: new Map(), tableReveal: new Map(),
      handHash: new Map(), handReveal: new Map(), order: new Map(),
    };
    this.#oppSeed = new Map();
    this.#clearHand();
  }

  #clearHand() {
    this.myMove = null;
    this.myRings = null;
    this.#my.hand = null;
    this.#oppHand = null;
    this.#orderSent = false;
  }

  // Have I made my choice in the current phase? Has the opponent (committed)?
  get submitted() {
    if (this.phase === "deck") return !!this.#my.deck;
    if (this.phase === "table") return this.#my.table?.round === this.roundNo;
    if (this.phase === "hand") return this.#my.hand?.hand === this.hand;
    return false;
  }

  get oppSubmitted() {
    if (this.phase === "deck") return !!this.#in.deckHash;
    if (this.phase === "table") return this.#in.tableHash.has(this.roundNo);
    if (this.phase === "hand") return this.#in.handHash.has(this.hand);
    return false;
  }

  #run(fn) {
    const p = this.#q.then(fn);
    this.#q = p.catch(() => {});
    return p;
  }

  idle() {
    return this.#q;
  }

  // ---------- actions ----------

  chooseDeck(ids) {
    return this.#run(async () => {
      if (this.phase !== "deck" || this.#my.deck || !isValidDeck(ids)) return false;
      const deck = sortedIds(ids);
      const salt = makeSalt();
      const hash = await deckHash(deck, salt);
      this.#my.deck = { ids: deck, salt, hash, revealed: false };
      this.deck.me = deck;
      this.#send({ t: "deck-commit", hash });
      await this.#commitSeed(1); // no-op after a rematch (already committed in "rematch")
      await this.#advance();
      return true;
    });
  }

  chooseTable(ids) {
    return this.#run(async () => {
      const round = this.roundNo;
      if (this.phase !== "table" || this.#my.table?.round === round || !isValidTable(ids, this.d10, this.deck.me)) {
        return false;
      }
      const table = sortedIds(ids);
      const salt = makeSalt();
      const hash = await tableHash(round, table, salt);
      this.#my.table = { round, ids: table, salt, hash, revealed: false };
      this.table.me = table;
      this.#send({ t: "table-commit", round, hash });
      await this.#commitSeed(round + 1); // seed for the next round's d10, revealed when this round ends
      await this.#advance();
      return true;
    });
  }

  pick(move, rings = []) {
    return this.#run(async () => {
      const hand = this.hand;
      if (this.phase !== "hand" || this.#my.hand) return false;
      if (!Array.isArray(rings) || !validatePlacement(move, rings, this.active.me)) return false;
      rings = [...rings];
      const salt = makeSalt();
      const hash = await commitHash(hand, move, rings, salt);
      // Host = arbiter of speed: whoever committed first (as seen by the host right now) goes first.
      const firstRole = this.role === "host" ? (this.#in.handHash.has(hand) ? "guest" : "host") : null;
      this.#my.hand = { hand, move, rings, salt, hash, revealed: false, firstRole };
      this.myMove = move;
      this.myRings = rings;
      this.#send({ t: "commit", hand, hash });
      await this.#advance();
      return true;
    });
  }

  requestRematch({ changeDeck = false } = {}) {
    return this.#run(async () => {
      if (this.phase !== "over" || this.iWantRematch) return false;
      // Without both decks (cheat detected during the deck phase) there is nothing to keep.
      const change = !!changeDeck || !this.deck.me || !this.deck.opp;
      const seed = makeSalt();
      const hash = await seedHash(1, seed);
      this.#rematch.me = { changeDeck: change, seed, hash };
      this.iWantRematch = true;
      this.rematchChangeDeck.me = change;
      this.#send({ t: "rematch", changeDeck: change, seed: hash });
      await this.#maybeRestart();
      return true;
    });
  }

  receive(msg) {
    return this.#run(async () => {
      if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return false;
      if (msg.t === "rematch") return this.#receiveRematch(msg);
      if (!this.#store(msg)) return false;
      await this.#advance();
      return true;
    });
  }

  // ---------- incoming ----------

  #store(msg) {
    if (this.phase === "over") return false;
    const inp = this.#in;
    const R = this.roundNo;
    const H = this.hand;
    const put = (map, key, value) => {
      if (map.has(key)) return false; // first message wins
      map.set(key, value);
      return true;
    };
    const roundOk = isPosInt(msg.round) && (msg.round === R || msg.round === R + 1);
    const handOk = isPosInt(msg.hand) && (msg.hand === H || msg.hand === H + 1);
    switch (msg.t) {
      case "deck-commit":
        if (this.phase !== "deck" || inp.deckHash || !isHex(msg.hash, 64)) return false;
        inp.deckHash = msg.hash;
        return true;
      case "deck-reveal":
        if (this.phase !== "deck" || inp.deckReveal || !isStrList(msg.deck) || !isHex(msg.salt, 32)) return false;
        inp.deckReveal = { deck: [...msg.deck], salt: msg.salt };
        return true;
      case "seed-commit":
        return roundOk && isHex(msg.hash, 64) && put(inp.seedHash, msg.round, msg.hash);
      case "seed-reveal":
        return roundOk && isHex(msg.seed, 32) && put(inp.seedReveal, msg.round, msg.seed);
      case "table-commit":
        return roundOk && isHex(msg.hash, 64) && put(inp.tableHash, msg.round, msg.hash);
      case "table-reveal":
        return roundOk && isStrList(msg.table) && isHex(msg.salt, 32)
          && put(inp.tableReveal, msg.round, { table: [...msg.table], salt: msg.salt });
      case "commit":
        return handOk && isHex(msg.hash, 64) && put(inp.handHash, msg.hand, msg.hash);
      case "order":
        return this.role === "guest" && handOk && isRole(msg.first) && put(inp.order, msg.hand, msg.first);
      case "reveal":
        return handOk && typeof msg.move === "string" && msg.move.length <= 16 && isStrList(msg.rings)
          && isHex(msg.salt, 32) && put(inp.handReveal, msg.hand, { move: msg.move, rings: [...msg.rings], salt: msg.salt });
      default:
        return false; // unknown type
    }
  }

  async #receiveRematch(msg) {
    if (this.phase !== "over" || this.#rematch.opp) return false;
    if (typeof msg.changeDeck !== "boolean" || !isHex(msg.seed, 64)) return false;
    this.#rematch.opp = { changeDeck: msg.changeDeck, hash: msg.seed };
    this.oppWantsRematch = true;
    this.rematchChangeDeck.opp = msg.changeDeck;
    await this.#maybeRestart();
    return true;
  }

  async #maybeRestart() {
    const { me, opp } = this.#rematch;
    if (!me || !opp) return false;
    this.#reset(!me.changeDeck && !opp.changeDeck);
    this.#my.seeds.set(1, { seed: me.seed, hash: me.hash, revealed: false });
    this.#in.seedHash.set(1, opp.hash);
    await this.#advance();
    return true;
  }

  // ---------- state machine ----------

  async #commitSeed(round) {
    if (this.#my.seeds.has(round)) return;
    const seed = makeSalt();
    const hash = await seedHash(round, seed);
    this.#my.seeds.set(round, { seed, hash, revealed: false });
    this.#send({ t: "seed-commit", round, hash });
  }

  #cheat() {
    this.cheated = true;
    this.winner = "me";
    this.phase = "over";
    return false;
  }

  async #advance() {
    while (this.phase !== "over" && (await this.#step()));
  }

  // Does one thing (send a reveal, verify an opponent reveal, change phase); returns true if it did.
  async #step() {
    switch (this.phase) {
      case "deck": return this.#stepDeck();
      case "roll": return this.#stepRoll();
      case "table": return this.#stepTable();
      case "hand": return this.#stepHand();
      default: return false;
    }
  }

  async #stepDeck() {
    const my = this.#my.deck;
    const inp = this.#in;
    if (!my || !inp.deckHash) return false;
    if (!my.revealed) {
      my.revealed = true;
      this.#send({ t: "deck-reveal", deck: my.ids, salt: my.salt });
      return true;
    }
    if (!this.deck.opp) {
      const rv = inp.deckReveal;
      if (!rv) return this.#stepSeed();
      const ok = isValidDeck(rv.deck) && (await deckHash(rv.deck, rv.salt)) === inp.deckHash;
      if (!ok) return this.#cheat();
      this.deck.opp = sortedIds(rv.deck);
      return true;
    }
    if (await this.#stepSeed()) return true;
    this.phase = "roll";
    return true;
  }

  // Seed exchange for the current round's d10 (also runs in the deck phase, after my deck reveal).
  async #stepSeed() {
    const R = this.roundNo;
    const mine = this.#my.seeds.get(R);
    const oppHash = this.#in.seedHash.get(R);
    if (!mine || !oppHash) return false;
    if (!mine.revealed) {
      mine.revealed = true;
      this.#send({ t: "seed-reveal", round: R, seed: mine.seed });
      return true;
    }
    if (this.#oppSeed.has(R)) return false;
    const seed = this.#in.seedReveal.get(R);
    if (!seed) return false;
    if ((await seedHash(R, seed)) !== oppHash) return this.#cheat();
    this.#oppSeed.set(R, seed);
    return true;
  }

  async #stepRoll() {
    const R = this.roundNo;
    if (!this.#my.seeds.has(R)) {
      await this.#commitSeed(R); // normally already sent earlier (deck-commit, table-commit, rematch)
      return true;
    }
    if (await this.#stepSeed()) return true;
    if (!this.#my.seeds.get(R).revealed || !this.#oppSeed.has(R)) return false;
    const mine = this.#my.seeds.get(R).seed;
    const theirs = this.#oppSeed.get(R);
    this.d10 = this.role === "host" ? await rollD10(R, mine, theirs) : await rollD10(R, theirs, mine);
    this.phase = "table";
    return true;
  }

  async #stepTable() {
    const R = this.roundNo;
    const my = this.#my.table;
    const oppHash = this.#in.tableHash.get(R);
    if (my?.round !== R || !oppHash) return false;
    if (!my.revealed) {
      my.revealed = true;
      this.#send({ t: "table-reveal", round: R, table: my.ids, salt: my.salt });
      return true;
    }
    if (!this.table.opp) {
      const rv = this.#in.tableReveal.get(R);
      if (!rv) return false;
      const ok = isValidTable(rv.table, this.d10, this.deck.opp) && (await tableHash(R, rv.table, rv.salt)) === oppHash;
      if (!ok) return this.#cheat();
      this.table.opp = sortedIds(rv.table);
      return true;
    }
    this.active = { me: [...this.table.me], opp: [...this.table.opp] };
    this.phase = "hand";
    return true;
  }

  async #stepHand() {
    const H = this.hand;
    const my = this.#my.hand;
    const oppHash = this.#in.handHash.get(H);
    if (!my || !oppHash) return false;
    if (this.role === "host" && !this.#orderSent) {
      this.#orderSent = true;
      this.#send({ t: "order", hand: H, first: my.firstRole });
      return true;
    }
    const firstRole = this.role === "host" ? my.firstRole : this.#in.order.get(H);
    if (!firstRole) return false; // guest: never reveal before the host's order
    if (!my.revealed) {
      my.revealed = true;
      this.#send({ t: "reveal", hand: H, move: my.move, rings: my.rings, salt: my.salt });
      return true;
    }
    if (!this.#oppHand) {
      const rv = this.#in.handReveal.get(H);
      if (!rv) return false;
      const ok = (await verifyReveal(oppHash, H, rv.move, rv.rings, rv.salt))
        && validatePlacement(rv.move, rv.rings, this.active.opp);
      if (!ok) return this.#cheat();
      this.#oppHand = rv;
      return true;
    }
    await this.#resolve(my, this.#oppHand, firstRole === this.role ? "me" : "opp");
    return true;
  }

  async #resolve(my, opp, first) {
    const H = this.hand;
    const [saltHost, saltGuest] = this.role === "host" ? [my.salt, opp.salt] : [opp.salt, my.salt];
    const rng = makeRng(await sha256Hex(`${H}:${saltHost}:${saltGuest}`));
    const hpBefore = { ...this.hp };
    const tables = { me: without(this.active.me, my.rings), opp: without(this.active.opp, opp.rings) };
    const r = resolveHand({
      moves: { me: my.move, opp: opp.move },
      rings: { me: my.rings, opp: opp.rings },
      first, hp: hpBefore, myActiveTable: tables.me, oppActiveTable: tables.opp, rng,
    });
    this.active = { me: without(tables.me, r.stolen.me), opp: without(tables.opp, r.stolen.opp) };
    this.hp = { ...r.hpAfter };

    const res = r.outcome;
    const koMe = this.hp.me === 0;
    const koOpp = this.hp.opp === 0;
    const roundEnded = koMe || koOpp;
    const roundWinner = !roundEnded ? null : koMe && koOpp ? "both" : koOpp ? "me" : "opp";
    if (roundEnded) {
      if (roundWinner !== "opp") this.points.me++;
      if (roundWinner !== "me") this.points.opp++;
      this.rounds.push({ roundNo: this.roundNo, winner: roundWinner, hpMe: this.hp.me, hpOpp: this.hp.opp });
      this.winner = matchWinner(this.points);
    }
    this.lastResult = {
      hand: H, roundNo: this.roundNo, handInRound: this.handInRound,
      me: my.move, opp: opp.move, outcome: res, first,
      ringsMe: [...my.rings], ringsOpp: [...opp.rings], log: r.log,
      baseDmgMe: res === 0 ? DRAW_DAMAGE : res === -1 ? DAMAGE[opp.move] : 0,
      baseDmgOpp: res === 0 ? DRAW_DAMAGE : res === 1 ? DAMAGE[my.move] : 0,
      dmgMe: r.dmg.me, dmgOpp: r.dmg.opp, healMe: r.heal.me, healOpp: r.heal.opp,
      hpBeforeMe: hpBefore.me, hpBeforeOpp: hpBefore.opp, hpMe: this.hp.me, hpOpp: this.hp.opp,
      stolenMe: [...r.stolen.me], stolenOpp: [...r.stolen.opp],
      roundEnded, roundWinner, pointsMe: this.points.me, pointsOpp: this.points.opp,
      matchOver: !!this.winner,
    };
    this.history.push(this.lastResult);
    for (const map of [this.#in.handHash, this.#in.handReveal, this.#in.order]) map.delete(H);
    this.hand++;
    this.#clearHand();
    if (this.winner) {
      this.phase = "over";
    } else if (roundEnded) {
      this.roundNo++;
      this.handInRound = 1;
      this.hp = { me: MAX_HP, opp: MAX_HP };
      this.d10 = null;
      this.table = { me: null, opp: null };
      this.active = { me: null, opp: null };
      this.#my.table = null;
      this.phase = "roll";
    } else {
      this.handInRound++;
    }
  }
}
