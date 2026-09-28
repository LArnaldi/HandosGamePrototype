import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOVES, EMOJI, LABEL, MAX_HP, DAMAGE, DRAW_DAMAGE, ROUNDS_TO_WIN, ROOM_ALPHABET, isMove, outcome,
  matchWinner,
  makeSalt, makeRoomCode, commitHash, verifyReveal,
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
  const hash = await commitHash(2, "carta", ["ferro", "ombra"], salt);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await verifyReveal(hash, 2, "carta", ["ferro", "ombra"], salt), true);
  assert.equal(await verifyReveal(hash, 2, "sasso", ["ferro", "ombra"], salt), false);
  assert.equal(await verifyReveal(hash, 3, "carta", ["ferro", "ombra"], salt), false);
  assert.equal(await verifyReveal(hash, 2, "carta", ["ombra", "ferro"], salt), false, "finger order is committed");
  assert.equal(await verifyReveal(hash, 2, "carta", ["ferro"], salt), false);
  assert.equal(await verifyReveal(hash, 2, "carta", ["ferro", "ombra"], makeSalt()), false);
  assert.equal(await verifyReveal(hash, 2, "carta", "ferro,ombra", salt), false);
  const bogus = await commitHash(2, "lizard", [], salt);
  assert.equal(await verifyReveal(bogus, 2, "lizard", [], salt), false);
});

test("matchWinner: needs >= 2 points and a lead, never a draw", () => {
  const cases = [
    [0, 0, null], [1, 0, null], [1, 1, null], [2, 0, "me"], [2, 1, "me"], [0, 2, "opp"],
    [1, 2, "opp"], [2, 2, null], [3, 2, "me"], [3, 3, null], [3, 4, "opp"], [5, 5, null],
  ];
  for (const [me, opp, w] of cases) assert.equal(matchWinner({ me, opp }), w, `${me}-${opp}`);
});
