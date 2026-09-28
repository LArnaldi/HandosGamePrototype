import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOVES, EMOJI, LABEL, WIN_SCORE, ROOM_ALPHABET, isMove, outcome,
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
  assert.equal(WIN_SCORE, 3);
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

// Plays one round between a and b. `order` decides who delivers their reveal first.
async function playRound(a, b, moveA, moveB, order = "ab") {
  const ca = await a.pick(moveA);
  const cb = await b.pick(moveB);
  assert.ok(ca && cb);
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

test("full match, first to 3, both reveal orderings", async () => {
  const a = new Match();
  const b = new Match();
  await playRound(a, b, "sasso", "forbice", "ab"); // a wins
  assert.deepEqual(a.scores, { me: 1, opp: 0 });
  assert.deepEqual(b.scores, { me: 0, opp: 1 });
  assert.deepEqual(a.lastResult, { round: 1, me: "sasso", opp: "forbice", outcome: 1 });
  assert.deepEqual(b.lastResult, { round: 1, me: "forbice", opp: "sasso", outcome: -1 });
  await playRound(a, b, "carta", "carta", "ba"); // draw
  assert.equal(a.round, 3);
  assert.deepEqual(a.scores, { me: 1, opp: 0 });
  await playRound(a, b, "carta", "forbice", "ba"); // b wins
  await playRound(a, b, "carta", "sasso", "ab");
  assert.equal(a.winner, null);
  await playRound(a, b, "forbice", "carta", "ba");
  assert.deepEqual(a.scores, { me: 3, opp: 1 });
  assert.equal(a.winner, "me");
  assert.equal(b.winner, "opp");
  assert.equal(a.history.length, 5);
  assert.equal(a.cheated || b.cheated, false);
  assert.equal(await a.pick("sasso"), null, "no picks after match over");
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
  assert.equal(a.round, 1);
  const ra = a.takeReveal(); // resolves locally
  assert.equal(a.round, 2);
  assert.deepEqual(a.scores, { me: 0, opp: 1 });
  assert.deepEqual(await b.receiveReveal(ra), { resolved: true, cheated: false });
  assert.deepEqual(b.scores, { me: 1, opp: 0 });
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

test("pick refused twice in a round and invalid moves refused", async () => {
  const a = new Match();
  assert.equal(await a.pick("lizard"), null);
  const [first, second] = await Promise.all([a.pick("sasso"), a.pick("carta")]);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(await a.pick("carta"), null);
});

test("commits for wrong rounds are ignored", async () => {
  const a = new Match();
  a.receiveCommit({ t: "commit", round: 5, hash: "x" });
  assert.equal(a.oppHash, null);
  a.receiveCommit({ t: "commit", round: 1, hash: "h1" });
  a.receiveCommit({ t: "commit", round: 1, hash: "h2" });
  assert.equal(a.oppHash, "h1");
});

test("rematch resets when both request it", async () => {
  const a = new Match();
  const b = new Match();
  assert.equal(a.requestRematch(), null, "no rematch mid-match");
  for (let i = 0; i < 3; i++) await playRound(a, b, "carta", "sasso");
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
    assert.equal(m.round, 1);
    assert.deepEqual(m.scores, { me: 0, opp: 0 });
    assert.equal(m.history.length, 0);
    assert.equal(m.iWantRematch || m.oppWantsRematch, false);
  }
  await playRound(a, b, "sasso", "sasso");
  assert.equal(a.round, 2);
});
