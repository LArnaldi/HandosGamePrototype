// game.js: pure game logic (moves, match/round/hand rules, room codes, commit-reveal hashing); no DOM, Node-testable.
//
// Structure: PARTITA (match) -> ROUND -> MANO (hand).
//   MANO:    one RPS exchange (one commit-reveal). The hand loser loses DAMAGE[winning move] HP;
//            on a draw both lose DRAW_DAMAGE. HP floors at 0.
//   ROUND:   both start at MAX_HP; hands are played until at least one player is at 0 HP. Exactly
//            one at 0 -> the other gets +1 round point. Both at 0 in the same hand -> BOTH get +1.
//            HP then resets to MAX_HP for the next round.
//   PARTITA: "al meglio di 3", extendable. Won by the player with >= ROUNDS_TO_WIN (2) round points
//            AND strictly more than the opponent. Tied points (2-2, 3-3, ...) -> keep playing rounds.
//            There is no match draw. A detected cheater loses at once (winner "me").
//
// API
//   MOVES, EMOJI, LABEL, ROOM_ALPHABET
//   MAX_HP (20), DAMAGE {sasso:5, carta:3, forbice:1} (keyed by the WINNING move), DRAW_DAMAGE (1), ROUNDS_TO_WIN (2)
//   isMove(x) -> bool;  outcome(a, b) -> 1 | -1 | 0  (a's point of view)
//   matchWinner({me, opp}) -> "me" | "opp" | null  (from round points)
//   makeSalt() -> 32-char hex;  makeRoomCode() -> 5 chars from ROOM_ALPHABET
//   async commitHash(hand, move, salt) -> hex SHA-256 of `${hand}:${move}:${salt}`
//   async verifyReveal(hash, hand, move, salt) -> bool
//
//   class Match (one match, local player's view, network-agnostic):
//     state: hand        protocol hand sequence number (1-based, monotonic across the whole match)
//            roundNo     current round (1-based);  handInRound  current hand within it (1-based)
//            points {me, opp} round points;  hp {me, opp} HP in the current round
//            winner (null|"me"|"opp"), cheated, iWantRematch, oppWantsRematch
//            lastResult (last resolved hand, or null):
//              {hand, roundNo, handInRound, me, opp, outcome, dmgMe, dmgOpp, hpMe, hpOpp,
//               roundEnded, roundWinner (null|"me"|"opp"|"both"), pointsMe, pointsOpp, matchOver}
//              dmg* = damage dealt this hand, before the 0 floor; hp* = HP right after the hand
//              (before any round reset, so a KO shows as 0); points* = round points after the hand.
//            history [lastResult...] (every hand of the match)
//            rounds [{roundNo, winner ("me"|"opp"|"both"), hpMe, hpOpp}] (finished rounds, final HP)
//     When a hand ends a round and the match goes on, hp resets to MAX_HP, roundNo++ and
//     handInRound = 1 immediately. When the match is over, roundNo/hp stay as they ended.
//     async pick(move)       -> {t:"commit", hand, hash} | null (invalid / already picked / match over)
//     receiveCommit(msg)     -> stores opponent hash (current hand; hand+1 is buffered)
//     revealReady()          -> true when both commits known and our reveal not yet sent
//     takeReveal()           -> {t:"reveal", hand, move, salt} | null; may resolve the hand if the
//                               opponent's reveal already arrived (check lastResult afterwards)
//     async receiveReveal(msg) -> {resolved, cheated}
//     requestRematch()       -> {t:"rematch"} | null (only when match over); resets if both want it
//     receiveRematch()       -> true if this caused a reset
//     reset()                -> fresh match (0-0 points, round 1, hand 1, full HP)
//   Typical loop: after pick()/receiveCommit(), if revealReady() send takeReveal().

export const MOVES = ["sasso", "carta", "forbice"];
export const EMOJI = { sasso: "✊", carta: "✋", forbice: "✌️" };
export const LABEL = { sasso: "Sasso", carta: "Carta", forbice: "Forbice" };
export const MAX_HP = 20;
export const DAMAGE = { sasso: 5, carta: 3, forbice: 1 };
export const DRAW_DAMAGE = 1;
export const ROUNDS_TO_WIN = 2;
export const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const BEATS = { sasso: "forbice", forbice: "carta", carta: "sasso" };

export function isMove(x) {
  return typeof x === "string" && Object.hasOwn(BEATS, x);
}

export function outcome(a, b) {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function makeSalt() {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

export function makeRoomCode(len = 5) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(len));
  // 256 % 31 bias is negligible for room codes.
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

export async function commitHash(hand, move, salt) {
  const data = new TextEncoder().encode(`${hand}:${move}:${salt}`);
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)));
}

export async function verifyReveal(hash, hand, move, salt) {
  if (!isMove(move) || typeof salt !== "string" || typeof hash !== "string") return false;
  return (await commitHash(hand, move, salt)) === hash;
}

// Match winner from round points: at least ROUNDS_TO_WIN and strictly ahead; ties keep playing.
export function matchWinner(points) {
  const { me, opp } = points;
  if (me >= ROUNDS_TO_WIN && me > opp) return "me";
  if (opp >= ROUNDS_TO_WIN && opp > me) return "opp";
  return null;
}

export class Match {
  constructor() {
    this.reset();
  }

  reset() {
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
    this.nextOppHash = null; // opponent commit for hand+1 that arrived early
    this.#clearHand();
  }

  #clearHand() {
    this.myMove = this.mySalt = this.myHash = null;
    this.oppHash = this.oppMove = null;
    this.revealSent = false;
  }

  async pick(move) {
    if (this.winner || !isMove(move) || this.myMove) return null;
    const hand = this.hand;
    this.myMove = move; // claim synchronously so concurrent picks are refused
    const salt = (this.mySalt = makeSalt());
    const hash = await commitHash(hand, move, salt);
    if (this.hand !== hand || this.mySalt !== salt) return null; // reset (and maybe re-picked) meanwhile
    this.myHash = hash;
    return { t: "commit", hand, hash };
  }

  receiveCommit(msg) {
    if (this.winner || typeof msg?.hash !== "string") return;
    if (msg.hand === this.hand && !this.oppHash) this.oppHash = msg.hash;
    else if (msg.hand === this.hand + 1 && !this.nextOppHash) this.nextOppHash = msg.hash;
  }

  revealReady() {
    return !this.winner && !!this.myHash && !!this.oppHash && !this.revealSent;
  }

  takeReveal() {
    if (!this.revealReady()) return null; // never reveal before holding the opponent's commit
    this.revealSent = true;
    const msg = { t: "reveal", hand: this.hand, move: this.myMove, salt: this.mySalt };
    if (this.oppMove) this.#resolve();
    return msg;
  }

  async receiveReveal(msg) {
    const hand = this.hand;
    const hash = this.oppHash;
    if (this.winner || msg?.hand !== hand || !hash || this.oppMove) {
      return { resolved: false, cheated: this.cheated };
    }
    const ok = await verifyReveal(hash, hand, msg.move, msg.salt);
    if (this.hand !== hand || this.oppHash !== hash || this.winner || this.oppMove) {
      return { resolved: false, cheated: this.cheated }; // state moved on while hashing
    }
    if (!ok) {
      this.cheated = true;
      this.winner = "me";
      return { resolved: false, cheated: true };
    }
    this.oppMove = msg.move;
    if (!this.revealSent) return { resolved: false, cheated: false }; // resolve in takeReveal()
    this.#resolve();
    return { resolved: true, cheated: false };
  }

  #resolve() {
    const res = outcome(this.myMove, this.oppMove);
    const dmgMe = res === 0 ? DRAW_DAMAGE : res === -1 ? DAMAGE[this.oppMove] : 0;
    const dmgOpp = res === 0 ? DRAW_DAMAGE : res === 1 ? DAMAGE[this.myMove] : 0;
    this.hp.me = Math.max(0, this.hp.me - dmgMe);
    this.hp.opp = Math.max(0, this.hp.opp - dmgOpp);
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
      hand: this.hand, roundNo: this.roundNo, handInRound: this.handInRound,
      me: this.myMove, opp: this.oppMove, outcome: res,
      dmgMe, dmgOpp, hpMe: this.hp.me, hpOpp: this.hp.opp,
      roundEnded, roundWinner, pointsMe: this.points.me, pointsOpp: this.points.opp,
      matchOver: !!this.winner,
    };
    this.history.push(this.lastResult);
    this.hand++;
    if (roundEnded && !this.winner) {
      this.roundNo++;
      this.handInRound = 1;
      this.hp = { me: MAX_HP, opp: MAX_HP };
    } else if (!roundEnded) {
      this.handInRound++;
    }
    this.#clearHand();
    this.oppHash = this.nextOppHash;
    this.nextOppHash = null;
  }

  requestRematch() {
    if (!this.winner || this.iWantRematch) return null;
    this.iWantRematch = true;
    this.#maybeRestart();
    return { t: "rematch" };
  }

  receiveRematch() {
    if (!this.winner) return false;
    this.oppWantsRematch = true;
    return this.#maybeRestart();
  }

  #maybeRestart() {
    if (!(this.iWantRematch && this.oppWantsRematch)) return false;
    this.reset();
    return true;
  }
}
