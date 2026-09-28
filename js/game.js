// game.js: pure game logic (moves, round/match rules, room codes, commit-reveal hashing); no DOM, Node-testable.
//
// API
//   MOVES, EMOJI, LABEL, ROOM_ALPHABET
//   MAX_HP (20), DAMAGE {sasso:5, carta:3, forbice:1} (keyed by the WINNING move), DRAW_DAMAGE (1)
//   isMove(x) -> bool;  outcome(a, b) -> 1 | -1 | 0  (a's point of view)
//   makeSalt() -> 32-char hex;  makeRoomCode() -> 5 chars from ROOM_ALPHABET
//   async commitHash(round, move, salt) -> hex SHA-256 of `${round}:${move}:${salt}`
//   async verifyReveal(hash, round, move, salt) -> bool
//
//   class Match (one match, local player's view, network-agnostic):
//     rules: both start at MAX_HP. The round loser loses DAMAGE[winning move] HP; on a draw both
//            lose DRAW_DAMAGE. HP floors at 0; a player at 0 loses. Both at 0 together -> "draw".
//     state: round, hp {me, opp}, winner (null|"me"|"opp"|"draw"), cheated, lastResult
//            ({round, me, opp, outcome, dmgMe, dmgOpp, hpMe, hpOpp}; dmg* = HP lost this round,
//            hp* = HP after it), history [lastResult...], iWantRematch, oppWantsRematch
//     async pick(move)       -> {t:"commit", round, hash} | null (invalid / already picked / match over)
//     receiveCommit(msg)     -> stores opponent hash (current round; next round is buffered)
//     revealReady()          -> true when both commits known and our reveal not yet sent
//     takeReveal()           -> {t:"reveal", round, move, salt} | null; may resolve the round if the
//                               opponent's reveal already arrived (check lastResult/round afterwards)
//     async receiveReveal(msg) -> {resolved, cheated}
//     requestRematch()       -> {t:"rematch"} | null (only when match over); resets if both want it
//     receiveRematch()       -> true if this caused a reset
//     reset()                -> fresh match
//   Typical loop: after pick()/receiveCommit(), if revealReady() send takeReveal().

export const MOVES = ["sasso", "carta", "forbice"];
export const EMOJI = { sasso: "✊", carta: "✋", forbice: "✌️" };
export const LABEL = { sasso: "Sasso", carta: "Carta", forbice: "Forbice" };
export const MAX_HP = 20;
export const DAMAGE = { sasso: 5, carta: 3, forbice: 1 };
export const DRAW_DAMAGE = 1;
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

export async function commitHash(round, move, salt) {
  const data = new TextEncoder().encode(`${round}:${move}:${salt}`);
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data)));
}

export async function verifyReveal(hash, round, move, salt) {
  if (!isMove(move) || typeof salt !== "string" || typeof hash !== "string") return false;
  return (await commitHash(round, move, salt)) === hash;
}

export class Match {
  constructor() {
    this.reset();
  }

  reset() {
    this.round = 1;
    this.hp = { me: MAX_HP, opp: MAX_HP };
    this.winner = null;
    this.cheated = false;
    this.lastResult = null;
    this.history = [];
    this.iWantRematch = false;
    this.oppWantsRematch = false;
    this.nextOppHash = null; // opponent commit for round+1 that arrived early
    this.#clearRound();
  }

  #clearRound() {
    this.myMove = this.mySalt = this.myHash = null;
    this.oppHash = this.oppMove = null;
    this.revealSent = false;
  }

  async pick(move) {
    if (this.winner || !isMove(move) || this.myMove) return null;
    const round = this.round;
    this.myMove = move; // claim synchronously so concurrent picks are refused
    const salt = (this.mySalt = makeSalt());
    const hash = await commitHash(round, move, salt);
    if (this.round !== round || this.mySalt !== salt) return null; // reset (and maybe re-picked) meanwhile
    this.myHash = hash;
    return { t: "commit", round, hash };
  }

  receiveCommit(msg) {
    if (this.winner || typeof msg?.hash !== "string") return;
    if (msg.round === this.round && !this.oppHash) this.oppHash = msg.hash;
    else if (msg.round === this.round + 1 && !this.nextOppHash) this.nextOppHash = msg.hash;
  }

  revealReady() {
    return !this.winner && !!this.myHash && !!this.oppHash && !this.revealSent;
  }

  takeReveal() {
    if (!this.revealReady()) return null; // never reveal before holding the opponent's commit
    this.revealSent = true;
    const msg = { t: "reveal", round: this.round, move: this.myMove, salt: this.mySalt };
    if (this.oppMove) this.#resolve();
    return msg;
  }

  async receiveReveal(msg) {
    const round = this.round;
    const hash = this.oppHash;
    if (this.winner || msg?.round !== round || !hash || this.oppMove) {
      return { resolved: false, cheated: this.cheated };
    }
    const ok = await verifyReveal(hash, round, msg.move, msg.salt);
    if (this.round !== round || this.oppHash !== hash || this.winner || this.oppMove) {
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
    this.lastResult = {
      round: this.round, me: this.myMove, opp: this.oppMove, outcome: res,
      dmgMe, dmgOpp, hpMe: this.hp.me, hpOpp: this.hp.opp,
    };
    this.history.push(this.lastResult);
    if (this.hp.me === 0 && this.hp.opp === 0) this.winner = "draw";
    else if (this.hp.opp === 0) this.winner = "me";
    else if (this.hp.me === 0) this.winner = "opp";
    this.round++;
    this.#clearRound();
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
