import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_HP, MOVES } from "../js/game.js";
import {
  SLOTS, DECK_SIZE, RINGS, RING_BY_ID, validatePlacement, resolveHand, makeRng,
} from "../js/rings.js";

// Helper: me vs opp with given rings; me is faster by default.
function hand(meMove, oppMove, meRings = [], oppRings = [], extra = {}) {
  return resolveHand({
    moves: { me: meMove, opp: oppMove },
    rings: { me: meRings, opp: oppRings },
    first: "me",
    hp: { me: MAX_HP, opp: MAX_HP },
    myActiveTable: [],
    oppActiveTable: [],
    rng: () => 0,
    ...extra,
  });
}

const constRng = (v) => () => v;

test("database shape", () => {
  assert.deepEqual(SLOTS, { sasso: 0, carta: 5, forbice: 2 });
  assert.equal(DECK_SIZE, 10);
  assert.equal(RINGS.length, 20);
  const ids = new Set();
  for (const r of RINGS) {
    assert.match(r.id, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(!ids.has(r.id));
    ids.add(r.id);
    for (const k of ["name", "gem", "icon", "text"]) assert.ok(typeof r[k] === "string" && r[k].length);
    assert.equal(RING_BY_ID[r.id], r);
  }
});

test("validatePlacement", () => {
  const table = ["ferro", "lama", "scriba", "ombra", "fenice", "pace"];
  assert.equal(validatePlacement("sasso", [], table), true);
  assert.equal(validatePlacement("sasso", ["ferro"], table), false);
  assert.equal(validatePlacement("forbice", ["ferro", "lama"], table), true);
  assert.equal(validatePlacement("forbice", ["ferro", "lama", "pace"], table), false);
  assert.equal(validatePlacement("carta", ["ferro", "lama", "scriba", "ombra", "fenice"], table), true);
  assert.equal(validatePlacement("carta", table, table), false);
  assert.equal(validatePlacement("carta", ["ferro", "ferro"], table), false);
  assert.equal(validatePlacement("carta", ["vampiro"], table), false);
  assert.equal(validatePlacement("pietra", [], table), false);
  assert.equal(validatePlacement("carta", "ferro", table), false);
});

test("no rings: base damage", () => {
  let r = hand("sasso", "forbice");
  assert.deepEqual(r.dmg, { me: 0, opp: 5 });
  assert.deepEqual(r.hpAfter, { me: 20, opp: 15 });
  assert.equal(r.outcome, 1);
  r = hand("carta", "carta");
  assert.deepEqual(r.dmg, { me: 1, opp: 1 });
  assert.equal(r.outcome, 0);
  r = hand("forbice", "sasso");
  assert.deepEqual(r.dmg, { me: 5, opp: 0 });
  assert.equal(r.outcome, -1);
});

test("gigante counts other uncancelled rings", () => {
  assert.equal(hand("carta", "sasso", ["gigante", "pace", "caos"]).dmg.opp, 3 + 2);
  assert.equal(hand("carta", "sasso", ["gigante"]).dmg.opp, 3);
  assert.equal(hand("sasso", "carta", [], ["gigante", "pace"]).dmg.me, 3 + 1);
  assert.equal(hand("carta", "forbice", ["gigante", "pace"]).dmg.me, 1); // lose: nothing
});

test("scriba and lama", () => {
  assert.equal(hand("carta", "sasso", ["scriba"]).dmg.opp, 5);
  assert.equal(hand("forbice", "carta", ["scriba"]).dmg.opp, 1);
  assert.equal(hand("forbice", "carta", ["lama"]).dmg.opp, 3);
  assert.equal(hand("carta", "sasso", ["lama"]).dmg.opp, 3);
  assert.equal(hand("carta", "forbice", ["scriba"]).dmg.opp, 0);
});

test("ferro", () => {
  assert.equal(hand("forbice", "sasso", ["ferro"]).dmg.me, 3);
  assert.equal(hand("carta", "forbice", ["ferro"]).dmg.me, 0); // 1 - 2 floors at 0
  assert.equal(hand("carta", "carta", ["ferro"]).dmg.me, 0);
});

test("nebbia", () => {
  assert.equal(hand("forbice", "sasso", ["nebbia"]).dmg.me, 1);
  assert.equal(hand("carta", "carta", ["nebbia"]).dmg.me, 1);
  assert.equal(hand("forbice", "carta", ["nebbia"]).dmg.me, 0);
});

test("specchio", () => {
  const r = hand("forbice", "sasso", ["specchio"]);
  assert.deepEqual(r.dmg, { me: 5, opp: 2 });
  assert.equal(hand("carta", "carta", ["specchio"]).dmg.opp, 1);
});

test("vampiro, guaritore and HP clamp", () => {
  let r = hand("carta", "sasso", ["vampiro"], [], { hp: { me: 10, opp: 20 } });
  assert.deepEqual(r.heal, { me: 2, opp: 0 });
  assert.equal(r.hpAfter.me, 12);
  assert.equal(hand("sasso", "carta", ["vampiro"]).heal.me, 0);
  r = hand("sasso", "carta", ["guaritore"], [], { hp: { me: 10, opp: 20 } });
  assert.equal(r.hpAfter.me, 10 - 3 + 3);
  r = hand("carta", "sasso", ["guaritore"]); // at full HP: clamped to MAX_HP
  assert.equal(r.hpAfter.me, MAX_HP);
  r = hand("sasso", "carta", [], [], { hp: { me: 2, opp: 20 } }); // clamped to 0
  assert.equal(r.hpAfter.me, 0);
  assert.equal(r.dmg.me, 3);
});

test("fenice end check", () => {
  let r = hand("forbice", "sasso", ["fenice"], [], { hp: { me: 3, opp: 20 } });
  assert.equal(r.hpAfter.me, 1);
  assert.equal(r.log[0].note, "resti a 1 HP");
  r = hand("forbice", "sasso", ["fenice"], [], { hp: { me: 10, opp: 20 } });
  assert.equal(r.hpAfter.me, 5);
  // Fenice first on the fingers, damage added later by the opponent: still saves at the end.
  r = hand("forbice", "carta", ["fenice", "lama"], ["specchio"], { hp: { me: 1, opp: 20 }, first: "me" });
  assert.equal(r.dmg.me, 1); // specchio reflects floor(3 / 2)
  assert.equal(r.hpAfter.me, 1);
  r = hand("carta", "forbice", ["fenice"], ["lama", "tuono"], { hp: { me: 3, opp: 20 } });
  assert.equal(r.dmg.me, 6);
  assert.equal(r.hpAfter.me, 1);
  // Cancelled Fenice does nothing.
  r = hand("carta", "forbice", ["fenice"], ["ombra"], { hp: { me: 1, opp: 20 } });
  assert.equal(r.hpAfter.me, 0);
});

test("pace and caos", () => {
  assert.deepEqual(hand("sasso", "sasso", ["pace"]).dmg, { me: 0, opp: 1 });
  assert.equal(hand("forbice", "sasso", ["pace"]).dmg.me, 5);
  assert.deepEqual(hand("carta", "carta", ["caos"]).dmg, { me: 1, opp: 3 });
  assert.equal(hand("carta", "sasso", ["caos"]).dmg.opp, 3);
});

test("tuono", () => {
  assert.equal(hand("carta", "sasso", ["tuono"]).dmg.opp, 6);
  assert.equal(hand("carta", "forbice", ["tuono"]).dmg.me, 2);
  assert.deepEqual(hand("carta", "carta", ["tuono"]).dmg, { me: 1, opp: 1 });
});

test("doppio-taglio", () => {
  assert.equal(hand("carta", "sasso", ["doppio-taglio"]).dmg.opp, 6);
  assert.equal(hand("forbice", "sasso", ["doppio-taglio"]).dmg.me, 10);
  assert.deepEqual(hand("carta", "carta", ["doppio-taglio"]).dmg, { me: 1, opp: 1 });
});

test("rabbia and tramonto use HP at start of hand", () => {
  const hp = (me) => ({ hp: { me, opp: 20 } });
  assert.equal(hand("carta", "sasso", ["rabbia"], [], hp(20)).dmg.opp, 3);
  assert.equal(hand("carta", "sasso", ["rabbia"], [], hp(11)).dmg.opp, 3 + 1);
  assert.equal(hand("carta", "sasso", ["rabbia"], [], hp(5)).dmg.opp, 3 + 3);
  assert.equal(hand("sasso", "carta", ["rabbia"], [], hp(5)).dmg.opp, 0);
  assert.equal(hand("carta", "sasso", ["tramonto"], [], hp(10)).dmg.opp, 7);
  assert.equal(hand("carta", "sasso", ["tramonto"], [], hp(11)).dmg.opp, 3);
  assert.equal(hand("sasso", "carta", ["tramonto"], [], hp(5)).dmg.opp, 0);
});

test("sacrificio", () => {
  assert.deepEqual(hand("carta", "sasso", ["sacrificio"]).dmg, { me: 2, opp: 7 });
  assert.deepEqual(hand("sasso", "carta", ["sacrificio"]).dmg, { me: 5, opp: 0 });
  assert.deepEqual(hand("sasso", "sasso", ["sacrificio"]).dmg, { me: 3, opp: 1 });
});

test("sorte rolls 1d6 from rng", () => {
  assert.equal(hand("carta", "sasso", ["sorte"], [], { rng: constRng(0) }).dmg.opp, 4);
  assert.equal(hand("carta", "sasso", ["sorte"], [], { rng: constRng(0.999) }).dmg.opp, 9);
  let calls = 0;
  hand("sasso", "carta", ["sorte"], [], { rng: () => (calls++, 0) });
  assert.equal(calls, 0); // no roll when losing
});

test("montagna", () => {
  assert.equal(hand("forbice", "sasso", ["montagna"]).dmg.me, 0);
  assert.equal(hand("carta", "forbice", ["montagna"]).dmg.me, 1);
  assert.equal(hand("sasso", "sasso", ["montagna"]).dmg.me, 1);
});

test("ladro disables a random active opponent ring, deterministically", () => {
  const oppActiveTable = ["vampiro", "caos", "ferro"]; // sorted: caos, ferro, vampiro
  let r = hand("carta", "sasso", ["ladro"], [], { oppActiveTable, rng: constRng(0) });
  assert.deepEqual(r.stolen, { me: [], opp: ["caos"] });
  r = hand("carta", "sasso", ["ladro"], [], { oppActiveTable, rng: constRng(0.5) });
  assert.deepEqual(r.stolen.opp, ["ferro"]);
  r = hand("carta", "sasso", ["ladro"], [], { oppActiveTable, rng: constRng(0.99) });
  assert.deepEqual(r.stolen.opp, ["vampiro"]);
  // Opponent's ladro hits my table.
  r = hand("sasso", "carta", [], ["ladro"], { myActiveTable: ["pace", "lama"], rng: constRng(0) });
  assert.deepEqual(r.stolen, { me: ["lama"], opp: [] });
  // Empty table or not winning: nothing, no rng consumed.
  let calls = 0;
  const rng = () => (calls++, 0);
  assert.deepEqual(hand("carta", "sasso", ["ladro"], [], { rng }).stolen.opp, []);
  assert.deepEqual(hand("sasso", "carta", ["ladro"], [], { oppActiveTable, rng }).stolen.opp, []);
  assert.equal(calls, 0);
  // Same rng sequence -> same result.
  const a = hand("carta", "sasso", ["sorte", "ladro"], [], { oppActiveTable, rng: makeRng("abcd1234") });
  const b = hand("carta", "sasso", ["sorte", "ladro"], [], { oppActiveTable, rng: makeRng("abcd1234") });
  assert.deepEqual(a, b);
});

test("order: ferro before vs after doppio-taglio", () => {
  // forbice loses to sasso: base 5 to me.
  assert.equal(hand("forbice", "sasso", ["ferro", "doppio-taglio"]).dmg.me, (5 - 2) * 2);
  assert.equal(hand("forbice", "sasso", ["doppio-taglio", "ferro"]).dmg.me, 5 * 2 - 2);
});

test("order: faster player's rings apply first", () => {
  // opp wins with sasso (5 to me). My ferro, opp's doppio-taglio.
  const base = { moves: { me: "forbice", opp: "sasso" }, rings: { me: ["ferro"], opp: ["doppio-taglio"] },
    hp: { me: 20, opp: 20 }, rng: () => 0 };
  const meFirst = resolveHand({ ...base, first: "me" });
  const oppFirst = resolveHand({ ...base, first: "opp" });
  assert.equal(meFirst.dmg.me, (5 - 2) * 2);
  assert.equal(oppFirst.dmg.me, 5 * 2 - 2);
  assert.deepEqual(meFirst.log.map((e) => e.owner), ["me", "opp"]);
  assert.deepEqual(oppFirst.log.map((e) => e.owner), ["opp", "me"]);
});

test("ombra pre-pass", () => {
  // Faster player's Ombra cancels all of the slower player's rings.
  let r = hand("carta", "sasso", ["ombra", "scriba"], ["ferro", "specchio"], { first: "me" });
  assert.equal(r.dmg.opp, 5);
  assert.deepEqual(r.log.map((e) => [e.owner, e.id, e.cancelled]), [
    ["me", "ombra", false], ["me", "scriba", false], ["opp", "ferro", true], ["opp", "specchio", true],
  ]);
  // Only the slower player has Ombra: the faster player's rings are cancelled.
  r = hand("carta", "sasso", ["scriba", "tuono"], ["ferro", "ombra"], { first: "me" });
  assert.equal(r.dmg.opp, 1); // 3 - 2 from ferro
  assert.ok(r.log.filter((e) => e.owner === "me").every((e) => e.cancelled));
  assert.ok(r.log.filter((e) => e.owner === "opp").every((e) => !e.cancelled));
  // Both have Ombra: faster wins, slower's Ombra is cancelled too.
  r = hand("carta", "sasso", ["ombra", "scriba"], ["ombra", "ferro"], { first: "opp" });
  assert.ok(r.log.filter((e) => e.owner === "me").every((e) => e.cancelled));
  assert.equal(r.dmg.opp, 1);
  r = hand("carta", "sasso", ["ombra", "scriba"], ["ombra", "ferro"], { first: "me" });
  assert.ok(r.log.filter((e) => e.owner === "opp").every((e) => e.cancelled));
  assert.equal(r.dmg.opp, 5);
  // Cancelled rings do not count for Gigante.
  r = hand("carta", "sasso", ["gigante", "pace"], ["ombra"], { first: "me" });
  assert.equal(r.dmg.opp, 3);
});

test("damage pools never go negative", () => {
  const r = hand("carta", "forbice", ["ferro", "nebbia"], []);
  assert.equal(r.dmg.me, 0);
  assert.ok(r.dmg.opp >= 0);
});

test("makeRng is deterministic and in [0,1)", () => {
  const a = makeRng("deadbeef00112233");
  const b = makeRng("deadbeef00112233");
  const c = makeRng("deadbeef00112234");
  const sa = Array.from({ length: 50 }, a);
  assert.deepEqual(sa, Array.from({ length: 50 }, b));
  assert.notDeepEqual(sa, Array.from({ length: 50 }, c));
  assert.ok(sa.every((x) => x >= 0 && x < 1));
  const bytes = makeRng(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 0x11, 0x22, 0x33]));
  assert.deepEqual(Array.from({ length: 50 }, bytes), sa);
});

test("mirror consistency: both players' views agree", () => {
  const gen = makeRng("0123456789abcdef");
  const pick = (arr) => arr[Math.floor(gen() * arr.length)];
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(gen() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const allIds = RINGS.map((r) => r.id);
  const flip = { me: "opp", opp: "me" };
  for (let i = 0; i < 2000; i++) {
    const tableA = shuffle(allIds).slice(0, 1 + Math.floor(gen() * 10));
    const tableB = shuffle(allIds).slice(0, 1 + Math.floor(gen() * 10));
    const mA = pick(MOVES), mB = pick(MOVES);
    const rA = shuffle(tableA).slice(0, Math.floor(gen() * (SLOTS[mA] + 1)));
    const rB = shuffle(tableB).slice(0, Math.floor(gen() * (SLOTS[mB] + 1)));
    assert.ok(validatePlacement(mA, rA, tableA));
    assert.ok(validatePlacement(mB, rB, tableB));
    const activeA = tableA.filter((x) => !rA.includes(x));
    const activeB = tableB.filter((x) => !rB.includes(x));
    const hpA = 1 + Math.floor(gen() * 20), hpB = 1 + Math.floor(gen() * 20);
    const first = gen() < 0.5 ? "me" : "opp";
    const seed = Math.floor(gen() * 2 ** 32).toString(16).padStart(8, "0");

    const va = resolveHand({ moves: { me: mA, opp: mB }, rings: { me: rA, opp: rB }, first,
      hp: { me: hpA, opp: hpB }, myActiveTable: activeA, oppActiveTable: activeB, rng: makeRng(seed) });
    const vb = resolveHand({ moves: { me: mB, opp: mA }, rings: { me: rB, opp: rA }, first: flip[first],
      hp: { me: hpB, opp: hpA }, myActiveTable: activeB, oppActiveTable: activeA, rng: makeRng(seed) });

    const ctx = JSON.stringify({ mA, mB, rA, rB, first, hpA, hpB });
    assert.deepEqual(vb.dmg, { me: va.dmg.opp, opp: va.dmg.me }, ctx);
    assert.deepEqual(vb.heal, { me: va.heal.opp, opp: va.heal.me }, ctx);
    assert.deepEqual(vb.hpAfter, { me: va.hpAfter.opp, opp: va.hpAfter.me }, ctx);
    assert.deepEqual(vb.stolen, { me: va.stolen.opp, opp: va.stolen.me }, ctx);
    assert.equal(vb.outcome, -va.outcome || 0, ctx);
    assert.deepEqual(vb.log, va.log.map((e) => ({ ...e, owner: flip[e.owner] })), ctx);
    for (const s of ["me", "opp"]) {
      assert.ok(va.dmg[s] >= 0 && va.heal[s] >= 0, ctx);
      assert.ok(va.hpAfter[s] >= 0 && va.hpAfter[s] <= MAX_HP, ctx);
    }
  }
});
