import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOVES, EMOJI, LABEL, MAX_HP, DAMAGE, DRAW_DAMAGE, ROUNDS_TO_WIN, ROOM_ALPHABET, isMove, outcome,
  matchWinner,
  makeSalt, makeRoomCode, commitHash, verifyReveal, Match,
} from "../js/game.js";

test("constants and isMove", () => {
  assert.deepEqual(MOVES, ["sasso", "carta", "forbice"]);
  for (const m of MOVES) {
    assert.ok(isMove(m));
    assert.ok(EMOJI[m]);
    assert.ok(LABEL[m]);
  }
  for (const x of ["pietra", "", null, undefined, 1, "toString", {}]) assert.equal(isMove(x), false);
  assert.equal(MAX_HP, 20);
  assert.deepEqual(DAMAGE, { sasso: 5, carta: 3, forbice: 1 });
  assert.equal(DRAW_DAMAGE, 1);
  assert.equal(ROUNDS_TO_WIN, 2);
});

test("outcome for all 9 pairs", () => {
  const expected = {
    "sasso,sasso": 0, "sasso,carta": -1, "sasso,forbice": 1,
    "carta,sasso": 1, "carta,carta": 0, "carta,forbice": -1,
    "forbice,sasso": -1, "forbice,carta": 1, "forbice,forbice": 0,
  };
  for (const a of MOVES) for (const b of MOVES) assert.equal(outcome(a, b), expected[`${a},${b}`], `${a} vs ${b}`);
});

test("salt and room code format", () => {
  const s = makeSalt();
  assert.match(s, /^[0-9a-f]{32}$/);
  assert.notEqual(s, makeSalt());
  const code = makeRoomCode();
  assert.equal(code.length, 5);
  for (const c of code) assert.ok(ROOM_ALPHABET.includes(c));
});

test("commit/verify roundtrip and tamper detection", async () => {
  const salt = makeSalt();
  const hash = await commitHash(2, "carta", salt);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await verifyReveal(hash, 2, "carta", salt), true);
  assert.equal(await verifyReveal(hash, 2, "sasso", salt), false);
  assert.equal(await verifyReveal(hash, 3, "carta", salt), false);
  assert.equal(await verifyReveal(hash, 2, "carta", makeSalt()), false);
  const bogus = await commitHash(2, "lizard", salt);
  assert.equal(await verifyReveal(bogus, 2, "lizard", salt), false);
});

// Plays one hand between a and b. `order` decides who delivers their reveal first.
async function playHand(a, b, moveA, moveB, order = "ab") {
  const ca = await a.pick(moveA);
  const cb = await b.pick(moveB);
  assert.ok(ca && cb);
  assert.equal(ca.hand, a.hand);
  assert.equal(a.revealReady(), false, "no reveal before opponent commit");
  assert.equal(a.takeReveal(), null);
  b.receiveCommit(ca);
  a.receiveCommit(cb);
  assert.ok(a.revealReady() && b.revealReady());
  const ra = a.takeReveal();
  const rb = b.takeReveal();
  if (order === "ab") {
    await b.receiveReveal(ra);
    await a.receiveReveal(rb);
  } else {
    await a.receiveReveal(rb);
    await b.receiveReveal(ra);
  }
}

// Sets both sides' HP for the current round (mirrored).
function setHp(a, b, hpA, hpB) {
  a.hp = { me: hpA, opp: hpB };
  b.hp = { me: hpB, opp: hpA };
}

// Ends the current round quickly: who = "a" | "b" | "both".
async function finishRound(a, b, who, order = "ab") {
  if (who === "both") {
    setHp(a, b, 1, 1);
    await playHand(a, b, "carta", "carta", order);
  } else if (who === "a") {
    setHp(a, b, 20, 1);
    await playHand(a, b, "sasso", "forbice", order);
  } else {
    setHp(a, b, 1, 20);
    await playHand(a, b, "sasso", "carta", order);
  }
}

function assertMirrored(a, b) {
  assert.equal(a.hand, b.hand);
  assert.equal(a.roundNo, b.roundNo);
  assert.equal(a.handInRound, b.handInRound);
  assert.deepEqual(a.points, { me: b.points.opp, opp: b.points.me });
  assert.deepEqual(a.hp, { me: b.hp.opp, opp: b.hp.me });
  const flip = { me: "opp", opp: "me", null: null };
  assert.equal(a.winner, flip[b.winner]);
}

test("matchWinner: needs >= 2 points and a lead, never a draw", () => {
  const cases = [
    [0, 0, null], [1, 0, null], [1, 1, null], [2, 0, "me"], [2, 1, "me"], [0, 2, "opp"],
    [1, 2, "opp"], [2, 2, null], [3, 2, "me"], [3, 3, null], [3, 4, "opp"], [5, 5, null],
  ];
  for (const [me, opp, w] of cases) assert.equal(matchWinner({ me, opp }), w, `${me}-${opp}`);
});

test("hand damage for all 9 pairs, mirrored on both sides", async () => {
  // [dmg to a, dmg to b]
  const expected = {
    "sasso,sasso": [1, 1], "sasso,carta": [3, 0], "sasso,forbice": [0, 5],
    "carta,sasso": [0, 3], "carta,carta": [1, 1], "carta,forbice": [1, 0],
    "forbice,sasso": [5, 0], "forbice,carta": [0, 1], "forbice,forbice": [1, 1],
  };
  const common = { hand: 1, roundNo: 1, handInRound: 1, roundEnded: false, roundWinner: null,
    pointsMe: 0, pointsOpp: 0, matchOver: false };
  for (const ma of MOVES) for (const mb of MOVES) {
    const a = new Match();
    const b = new Match();
    await playHand(a, b, ma, mb);
    const [dA, dB] = expected[`${ma},${mb}`];
    const label = `${ma} vs ${mb}`;
    assert.deepEqual(a.hp, { me: MAX_HP - dA, opp: MAX_HP - dB }, label);
    assert.deepEqual(b.hp, { me: MAX_HP - dB, opp: MAX_HP - dA }, label);
    assert.deepEqual(a.lastResult, {
      ...common, me: ma, opp: mb, outcome: outcome(ma, mb),
      dmgMe: dA, dmgOpp: dB, hpMe: MAX_HP - dA, hpOpp: MAX_HP - dB,
    }, label);
    assert.deepEqual(b.lastResult, {
      ...common, me: mb, opp: ma, outcome: outcome(mb, ma),
      dmgMe: dB, dmgOpp: dA, hpMe: MAX_HP - dB, hpOpp: MAX_HP - dA,
    }, label);
    assert.equal(a.winner, null);
    assert.equal(a.hand, 2);
    assert.equal(a.handInRound, 2);
    assert.equal(a.roundNo, 1);
  }
});

test("round ends when one side hits 0: point awarded, HP resets, lastResult keeps the KO", async () => {
  const a = new Match();
  const b = new Match();
  await playHand(a, b, "carta", "carta"); // 19/19
  setHp(a, b, 20, 2);
  await playHand(a, b, "sasso", "forbice"); // 5 damage on 2 HP
  assert.equal(a.lastResult.dmgOpp, 5);
  assert.equal(a.lastResult.hpOpp, 0, "pre-reset HP kept in lastResult");
  assert.equal(a.lastResult.hpMe, 20);
  assert.equal(a.lastResult.roundEnded, true);
  assert.equal(a.lastResult.roundWinner, "me");
  assert.equal(b.lastResult.roundWinner, "opp");
  assert.equal(a.lastResult.roundNo, 1);
  assert.equal(a.lastResult.handInRound, 2);
  assert.deepEqual([a.lastResult.pointsMe, a.lastResult.pointsOpp], [1, 0]);
  assert.equal(a.lastResult.matchOver, false);
  assert.deepEqual(a.points, { me: 1, opp: 0 });
  assert.deepEqual(a.hp, { me: MAX_HP, opp: MAX_HP }, "HP reset for next round");
  assert.equal(a.roundNo, 2);
  assert.equal(a.handInRound, 1);
  assert.equal(a.hand, 3, "protocol hand seq keeps increasing");
  assert.deepEqual(a.rounds, [{ roundNo: 1, winner: "me", hpMe: 20, hpOpp: 0 }]);
  assert.deepEqual(b.rounds, [{ roundNo: 1, winner: "opp", hpMe: 0, hpOpp: 20 }]);
  assert.equal(a.winner, null);
  assertMirrored(a, b);
  await playHand(a, b, "forbice", "sasso"); // round 2 continues normally
  assert.deepEqual(a.hp, { me: 15, opp: 20 });
  assert.equal(a.lastResult.roundNo, 2);
  assert.equal(a.handInRound, 2);
});

test("draw hand with only one side at 1 HP: the other wins the round", async () => {
  const a = new Match();
  const b = new Match();
  setHp(a, b, 1, 4);
  await playHand(a, b, "sasso", "sasso");
  assert.equal(a.lastResult.roundWinner, "opp");
  assert.deepEqual([a.lastResult.hpMe, a.lastResult.hpOpp], [0, 3]);
  assert.deepEqual(a.points, { me: 0, opp: 1 });
});

test("double KO gives both a round point", async () => {
  const a = new Match();
  const b = new Match();
  await finishRound(a, b, "both");
  assert.equal(a.lastResult.roundWinner, "both");
  assert.equal(b.lastResult.roundWinner, "both");
  assert.deepEqual([a.lastResult.hpMe, a.lastResult.hpOpp], [0, 0]);
  assert.deepEqual(a.points, { me: 1, opp: 1 });
  assert.deepEqual(a.hp, { me: MAX_HP, opp: MAX_HP });
  assert.equal(a.roundNo, 2);
  assert.equal(a.winner, null);
  assert.deepEqual(a.rounds, [{ roundNo: 1, winner: "both", hpMe: 0, hpOpp: 0 }]);
});

test("match won 2-0", async () => {
  const a = new Match();
  const b = new Match();
  await finishRound(a, b, "a");
  assert.equal(a.winner, null);
  await finishRound(a, b, "a", "ba");
  assert.deepEqual(a.points, { me: 2, opp: 0 });
  assert.equal(a.winner, "me");
  assert.equal(b.winner, "opp");
  assert.equal(a.lastResult.matchOver, true);
  assert.equal(a.roundNo, 2, "roundNo stays on the final round");
  assert.deepEqual(a.hp, { me: 20, opp: 0 }, "no HP reset once the match is over");
  assert.equal(await a.pick("sasso"), null, "no picks after match over");
  assertMirrored(a, b);
});

test("match won 2-1", async () => {
  const a = new Match();
  const b = new Match();
  await finishRound(a, b, "b");
  await finishRound(a, b, "a");
  assert.equal(a.winner, null);
  await finishRound(a, b, "b", "ba");
  assert.deepEqual(a.points, { me: 1, opp: 2 });
  assert.equal(a.winner, "opp");
  assert.equal(b.winner, "me");
  assert.equal(a.rounds.length, 3);
  assertMirrored(a, b);
});

test("1-0 then double KO -> 2-1, match over", async () => {
  const a = new Match();
  const b = new Match();
  await finishRound(a, b, "a");
  await finishRound(a, b, "both");
  assert.deepEqual(a.points, { me: 2, opp: 1 });
  assert.equal(a.winner, "me");
  assert.equal(b.winner, "opp");
  assert.equal(a.lastResult.roundWinner, "both");
  assert.equal(a.lastResult.matchOver, true);
});

test("1-1 then double KO -> 2-2 continues, then 3-2 ends", async () => {
  const a = new Match();
  const b = new Match();
  await finishRound(a, b, "a");
  await finishRound(a, b, "b");
  await finishRound(a, b, "both");
  assert.deepEqual(a.points, { me: 2, opp: 2 });
  assert.equal(a.winner, null, "tied at 2-2: keep playing");
  assert.equal(a.lastResult.matchOver, false);
  assert.equal(a.roundNo, 4);
  assert.deepEqual(a.hp, { me: MAX_HP, opp: MAX_HP });
  await finishRound(a, b, "both"); // 3-3
  assert.equal(a.winner, null);
  await finishRound(a, b, "b", "ba"); // 3-4
  assert.deepEqual(a.points, { me: 3, opp: 4 });
  assert.equal(a.winner, "opp");
  assert.equal(b.winner, "me");
  assert.deepEqual(a.rounds.map((r) => r.winner), ["me", "opp", "both", "both", "opp"]);
  assertMirrored(a, b);
});

test("no match draw: double KOs from 0-0 never end the match in a draw", async () => {
  const a = new Match();
  const b = new Match();
  for (let i = 0; i < 6; i++) {
    await finishRound(a, b, "both", i % 2 ? "ab" : "ba");
    assert.equal(a.winner, null);
    assert.equal(b.winner, null);
  }
  assert.deepEqual(a.points, { me: 6, opp: 6 });
  await finishRound(a, b, "a");
  assert.equal(a.winner, "me");
});

test("full multi-round match with natural hands, both reveal orderings, mirrored state", async () => {
  const a = new Match();
  const b = new Match();
  const orders = ["ab", "ba"];
  let n = 0;
  // Round 1: a wins with sasso x4 (20 -> 0 for b)
  for (let i = 0; i < 4; i++) {
    await playHand(a, b, "sasso", "forbice", orders[n++ % 2]);
    assertMirrored(a, b);
  }
  assert.deepEqual(a.points, { me: 1, opp: 0 });
  assert.equal(a.roundNo, 2);
  assert.equal(a.hand, 5);
  // Round 2: b wins with carta x7 (3*7 = 21 >= 20), with a draw in between
  await playHand(a, b, "forbice", "forbice", orders[n++ % 2]); // 19/19
  for (let i = 0; i < 7; i++) {
    await playHand(a, b, "sasso", "carta", orders[n++ % 2]);
    assertMirrored(a, b);
  }
  assert.equal(a.lastResult.hpMe, 0);
  assert.equal(a.lastResult.hpOpp, 19);
  assert.equal(a.lastResult.handInRound, 8);
  assert.deepEqual(a.points, { me: 1, opp: 1 });
  // Round 3: a wins
  for (let i = 0; i < 20; i++) await playHand(a, b, "forbice", "carta", orders[n++ % 2]);
  assert.deepEqual(a.points, { me: 2, opp: 1 });
  assert.equal(a.winner, "me");
  assert.equal(b.winner, "opp");
  assertMirrored(a, b);
  assert.equal(a.history.length, 32);
  for (let i = 0; i < a.history.length; i++) {
    const x = a.history[i];
    const y = b.history[i];
    assert.equal(x.hand, i + 1);
    assert.deepEqual(
      [x.hand, x.roundNo, x.handInRound, x.me, x.opp, x.outcome, x.dmgMe, x.dmgOpp, x.hpMe, x.hpOpp,
        x.roundEnded, x.pointsMe, x.pointsOpp, x.matchOver],
      [y.hand, y.roundNo, y.handInRound, y.opp, y.me, -y.outcome || 0, y.dmgOpp, y.dmgMe, y.hpOpp, y.hpMe,
        y.roundEnded, y.pointsOpp, y.pointsMe, y.matchOver]);
  }
  assert.deepEqual(a.rounds, [
    { roundNo: 1, winner: "me", hpMe: 20, hpOpp: 0 },
    { roundNo: 2, winner: "opp", hpMe: 0, hpOpp: 19 },
    { roundNo: 3, winner: "me", hpMe: 20, hpOpp: 0 },
  ]);
  assert.equal(a.cheated || b.cheated, false);
});

test("early commit for the next hand is held across a round boundary", async () => {
  const a = new Match();
  const b = new Match();
  setHp(a, b, 20, 1);
  const ca = await a.pick("sasso");
  const cb = await b.pick("forbice");
  a.receiveCommit(cb);
  b.receiveCommit(ca);
  const ra = a.takeReveal();
  const rb = b.takeReveal();
  await b.receiveReveal(ra); // b resolves first: round over for b
  assert.equal(b.roundNo, 2);
  const cb2 = await b.pick("carta"); // b commits hand 2 before a resolved hand 1
  assert.equal(cb2.hand, 2);
  a.receiveCommit(cb2); // buffered
  await a.receiveReveal(rb);
  assert.equal(a.roundNo, 2);
  assert.equal(a.oppHash, cb2.hash, "buffered commit promoted");
  const ca2 = await a.pick("sasso");
  b.receiveCommit(ca2);
  assert.ok(a.revealReady());
  const ra2 = a.takeReveal();
  const rb2 = b.takeReveal();
  await a.receiveReveal(rb2);
  await b.receiveReveal(ra2);
  assert.deepEqual(a.hp, { me: 17, opp: 20 });
  assertMirrored(a, b);
});

test("opponent reveal arriving before our own reveal is sent", async () => {
  const a = new Match();
  const b = new Match();
  const ca = await a.pick("sasso");
  const cb = await b.pick("carta");
  b.receiveCommit(ca);
  const rb = b.takeReveal();
  a.receiveCommit(cb);
  const r = await a.receiveReveal(rb); // a hasn't sent its reveal yet
  assert.deepEqual(r, { resolved: false, cheated: false });
  assert.equal(a.hand, 1);
  const ra = a.takeReveal(); // resolves locally
  assert.equal(a.hand, 2);
  assert.equal(a.handInRound, 2);
  assert.deepEqual(a.hp, { me: 17, opp: 20 });
  assert.deepEqual(await b.receiveReveal(ra), { resolved: true, cheated: false });
  assert.deepEqual(b.hp, { me: 20, opp: 17 });
});

test("cheating opponent is detected", async () => {
  const a = new Match();
  const b = new Match();
  const ca = await a.pick("sasso");
  const cb = await b.pick("forbice");
  a.receiveCommit(cb);
  b.receiveCommit(ca);
  a.takeReveal();
  const rb = b.takeReveal();
  const r = await a.receiveReveal({ ...rb, move: "carta" }); // b switches move after seeing sasso
  assert.deepEqual(r, { resolved: false, cheated: true });
  assert.equal(a.cheated, true);
  assert.equal(a.winner, "me");
});

test("pick refused twice in a hand and invalid moves refused", async () => {
  const a = new Match();
  assert.equal(await a.pick("lizard"), null);
  const [first, second] = await Promise.all([a.pick("sasso"), a.pick("carta")]);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(await a.pick("carta"), null);
});

test("commits for wrong hands are ignored", async () => {
  const a = new Match();
  a.receiveCommit({ t: "commit", hand: 5, hash: "x" });
  assert.equal(a.oppHash, null);
  a.receiveCommit({ t: "commit", hand: 1, hash: "h1" });
  a.receiveCommit({ t: "commit", hand: 1, hash: "h2" });
  assert.equal(a.oppHash, "h1");
});

test("rematch fully resets the match when both request it", async () => {
  const a = new Match();
  const b = new Match();
  assert.equal(a.requestRematch(), null, "no rematch mid-match");
  await finishRound(a, b, "a");
  assert.equal(a.requestRematch(), null, "no rematch between rounds");
  await finishRound(a, b, "both");
  assert.equal(a.winner, "me");
  const msg = a.requestRematch();
  assert.deepEqual(msg, { t: "rematch" });
  assert.equal(a.requestRematch(), null);
  assert.equal(a.winner, "me", "waits for opponent");
  assert.equal(b.receiveRematch(), false);
  b.requestRematch(); // b now has both -> resets
  assert.equal(b.winner, null);
  assert.equal(a.receiveRematch(), true);
  for (const m of [a, b]) {
    assert.equal(m.hand, 1);
    assert.equal(m.roundNo, 1);
    assert.equal(m.handInRound, 1);
    assert.deepEqual(m.points, { me: 0, opp: 0 });
    assert.deepEqual(m.hp, { me: MAX_HP, opp: MAX_HP });
    assert.equal(m.lastResult, null);
    assert.equal(m.history.length, 0);
    assert.equal(m.rounds.length, 0);
    assert.equal(m.iWantRematch || m.oppWantsRematch, false);
  }
  await playHand(a, b, "sasso", "sasso");
  assert.equal(a.hand, 2);
});

test("rematch allowed after cheating", async () => {
  const a = new Match();
  a.cheated = true;
  a.winner = "me";
  assert.deepEqual(a.requestRematch(), { t: "rematch" });
});

test("pick started before a reset cannot clobber a new pick of the same move", async () => {
  const a = new Match();
  const stale = a.pick("sasso");
  a.reset();
  const fresh = a.pick("sasso");
  assert.equal(await stale, null);
  const c = await fresh;
  assert.ok(c);
  assert.equal(a.myHash, c.hash);
  assert.equal(await verifyReveal(a.myHash, 1, "sasso", a.mySalt), true);
});
