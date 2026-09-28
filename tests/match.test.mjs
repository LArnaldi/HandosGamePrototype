import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Match, MOVES, MAX_HP, matchWinner, makeSalt, rollD10, deckHash, seedHash, isValidDeck, isValidTable,
} from "../js/game.js";
import { RINGS, DECK_SIZE, SLOTS, makeRng } from "../js/rings.js";

const IDS = RINGS.map((r) => r.id);
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two Match instances (host + guest) wired through an in-memory bus. Every direction is FIFO, like a
// reliable PeerJS DataConnection. Modes:
//   "sync":   each message is handed to the receiver as soon as it is sent
//   "random": each message is delivered after a random 0-3 ms delay (FIFO per direction), so the two
//             directions interleave arbitrarily and deliveries overlap with local actions
//   "manual": messages wait in `pending[from]` until deliver()/flush()
// taps: [(from, msg) => msg | null] can rewrite or drop a message before delivery.
function makeBus(mode = "sync", seed = 1) {
  const rnd = makeRng([seed, 7, 7]);
  const pending = { host: [], guest: [] };
  const chains = { host: Promise.resolve(), guest: Promise.resolve() };
  const bus = { mode, log: [], pending, taps: [], sent: 0 };
  const onSend = (from, msg) => {
    msg = clone(msg);
    bus.sent++;
    bus.log.push({ from, msg: clone(msg) });
    for (const tap of bus.taps) {
      msg = tap(from, msg);
      if (!msg) return;
    }
    const to = from === "host" ? bus.guest : bus.host;
    if (mode === "manual") pending[from].push(msg);
    else if (mode === "sync") to.receive(msg);
    else chains[from] = chains[from].then(() => sleep(rnd() * 3)).then(() => { to.receive(msg); });
  };
  bus.host = new Match({ role: "host", send: (m) => onSend("host", m) });
  bus.guest = new Match({ role: "guest", send: (m) => onSend("guest", m) });
  bus.other = (from) => (from === "host" ? bus.guest : bus.host);
  // manual mode: deliver up to n pending messages sent by `from`
  bus.deliver = async (from, n = Infinity) => {
    while (n-- > 0 && pending[from].length) await bus.other(from).receive(pending[from].shift());
    await Promise.all([bus.host.idle(), bus.guest.idle()]);
  };
  // wait until nothing is in flight (manual mode: deliver everything, in both directions)
  bus.flush = async () => {
    for (let i = 0; i < 10000; i++) {
      const n = bus.sent;
      await Promise.all([chains.host, chains.guest]);
      await Promise.all([bus.host.idle(), bus.guest.idle()]);
      if (mode === "manual" && (pending.host.length || pending.guest.length)) {
        await bus.deliver(rnd() < 0.5 ? "host" : "guest", 1 + Math.floor(rnd() * 3));
        continue;
      }
      if (n === bus.sent) return;
    }
    throw new Error("bus did not settle");
  };
  bus.sentBy = (from, t, key) => bus.log.filter((e) => e.from === from && e.msg.t === t && (key == null || e.msg.hand === key));
  return bus;
}

const FLIP = { me: "opp", opp: "me", both: "both", null: null, undefined };

function flipResult(r) {
  if (!r) return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "me") out.opp = v;
    else if (k === "opp") out.me = v;
    else if (k.endsWith("Me")) out[k.slice(0, -2) + "Opp"] = v;
    else if (k.endsWith("Opp")) out[k.slice(0, -3) + "Me"] = v;
    else if (k === "outcome") out[k] = -v || 0;
    else if (k === "first" || k === "roundWinner") out[k] = FLIP[v];
    else if (k === "log") out[k] = v.map((e) => ({ ...e, owner: FLIP[e.owner] }));
    else out[k] = v;
  }
  return out;
}

const mirror = (x) => ({ me: x.opp, opp: x.me });

function assertMirrored(h, g) {
  assert.equal(h.phase, g.phase);
  assert.equal(h.hand, g.hand);
  assert.equal(h.roundNo, g.roundNo);
  assert.equal(h.handInRound, g.handInRound);
  assert.equal(h.d10, g.d10);
  assert.deepEqual(h.points, mirror(g.points));
  assert.deepEqual(h.hp, mirror(g.hp));
  assert.deepEqual(h.deck, mirror(g.deck));
  assert.deepEqual(h.table, mirror(g.table));
  assert.deepEqual(h.active, mirror(g.active));
  assert.equal(h.winner, FLIP[g.winner]);
  assert.deepEqual(h.lastResult, flipResult(g.lastResult));
  assert.equal(h.history.length, g.history.length);
  assert.equal(h.cheated || g.cheated, false);
}

// Deck with the preferred rings first, filled up to DECK_SIZE.
const deckOf = (...pref) => [...new Set([...pref, ...IDS])].slice(0, DECK_SIZE);

async function startMatch(bus, deckH = deckOf(), deckG = deckOf()) {
  assert.equal(await bus.host.chooseDeck(deckH), true);
  assert.equal(await bus.guest.chooseDeck(deckG), true);
  await bus.flush();
}

// Tables: preferred rings first, then the rest of the deck. forceD10 overrides the (random) roll on
// both sides, identically, so a scenario can rely on a table size.
async function chooseTables(bus, prefH = [], prefG = [], forceD10 = null) {
  const { host, guest } = bus;
  assert.equal(host.phase, "table");
  if (forceD10) host.d10 = guest.d10 = forceD10;
  const pick = (m, pref) => [...new Set([...pref, ...m.deck.me])].slice(0, m.d10);
  assert.equal(await host.chooseTable(pick(host, prefH)), true);
  assert.equal(await guest.chooseTable(pick(guest, prefG)), true);
  await bus.flush();
  assert.equal(host.phase, "hand");
}

// Plays one hand; first = "host" | "guest" decides who commits first (as seen by the host).
async function playHand(bus, [mh, rh = []], [mg, rg = []], first = "host") {
  const { host, guest } = bus;
  if (first === "guest") {
    assert.equal(await guest.pick(mg, rg), true);
    if (bus.mode === "manual") await bus.deliver("guest");
    else await bus.flush();
    assert.equal(await host.pick(mh, rh), true);
  } else {
    assert.equal(await host.pick(mh, rh), true);
    assert.equal(await guest.pick(mg, rg), true);
  }
  await bus.flush();
}

function setHp(bus, hpH, hpG) {
  bus.host.hp = { me: hpH, opp: hpG };
  bus.guest.hp = { me: hpG, opp: hpH };
}

async function toHands(bus, prefH = [], prefG = [], d10 = null) {
  await startMatch(bus, deckOf(...prefH), deckOf(...prefG));
  await chooseTables(bus, prefH, prefG, d10 ?? Math.max(prefH.length, prefG.length, 1));
}

// ---------- pure helpers ----------

test("rollD10: deterministic, in 1..10, roughly uniform", async () => {
  const a = makeSalt();
  const b = makeSalt();
  assert.equal(await rollD10(1, a, b), await rollD10(1, a, b));
  const counts = new Array(11).fill(0);
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const v = await rollD10(1 + (i % 7), makeSalt(), makeSalt());
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 10);
    counts[v]++;
  }
  for (let v = 1; v <= 10; v++) assert.ok(Math.abs(counts[v] - N / 10) < 110, `bucket ${v}: ${counts[v]}`);
});

test("isValidDeck / isValidTable", () => {
  assert.equal(isValidDeck(IDS.slice(0, 10)), true);
  assert.equal(isValidDeck(IDS.slice(0, 9)), false);
  assert.equal(isValidDeck([...IDS.slice(0, 9), IDS[0]]), false);
  assert.equal(isValidDeck([...IDS.slice(0, 9), "drago"]), false);
  assert.equal(isValidDeck("gigante"), false);
  const deck = IDS.slice(0, 10);
  assert.equal(isValidTable(deck.slice(0, 3), 3, deck), true);
  assert.equal(isValidTable(deck.slice(0, 3), 4, deck), false);
  assert.equal(isValidTable([deck[0], deck[0]], 2, deck), false);
  assert.equal(isValidTable([IDS[15]], 1, deck), false);
});

// ---------- deck / roll / table ----------

test("deck exchange, shared d10 and table exchange", async () => {
  const bus = makeBus("manual");
  const { host, guest } = bus;
  assert.equal(host.phase, "deck");
  assert.equal(await host.chooseDeck(IDS.slice(0, 9)), false, "9 rings refused");
  assert.equal(await host.chooseDeck([...IDS.slice(0, 9), IDS[0]]), false, "duplicates refused");
  const dh = IDS.slice(0, 10).reverse();
  const dg = IDS.slice(5, 15);
  assert.equal(await host.chooseDeck(dh), true);
  assert.equal(await host.chooseDeck(IDS.slice(10, 20)), false, "second deck refused");
  assert.equal(host.submitted, true);
  assert.deepEqual(host.deck.me, [...dh].sort());
  await bus.deliver("host");
  assert.equal(guest.oppSubmitted, true);
  assert.equal(guest.deck.opp, null, "decks stay secret until both committed");
  assert.equal(bus.sentBy("host", "deck-reveal").length, 0, "no reveal before the opponent commits");
  assert.equal(await guest.chooseDeck(dg), true);
  await bus.flush();
  for (const m of [host, guest]) assert.equal(m.phase, "table");
  assert.deepEqual(host.deck.opp, [...dg].sort());
  assert.deepEqual(guest.deck.opp, [...dh].sort());
  assert.ok(host.d10 >= 1 && host.d10 <= 10);
  assert.equal(host.d10, guest.d10, "same d10 on both clients");

  const n = host.d10;
  assert.equal(await host.chooseTable(host.deck.me.slice(0, n === 10 ? 9 : n + 1)), false, "wrong size");
  assert.equal(await host.chooseTable([...IDS.slice(15, 15 + n)]), false, "rings not in the deck");
  assert.equal(await host.chooseTable(host.deck.me.slice(0, n)), true);
  assert.equal(await guest.chooseTable(guest.deck.me.slice(-n)), true);
  await bus.flush();
  for (const m of [host, guest]) assert.equal(m.phase, "hand");
  assert.deepEqual(host.table.opp, guest.deck.me.slice(-n));
  assert.deepEqual(guest.table.opp, host.deck.me.slice(0, n));
  assert.deepEqual(host.active, host.table);
  assertMirrored(host, guest);
});

test("d10 is identical and in range across many rounds and seeds", async () => {
  for (let i = 0; i < 20; i++) {
    const bus = makeBus(i % 2 ? "sync" : "random", i);
    await startMatch(bus);
    const { host, guest } = bus;
    for (let round = 1; round <= 3; round++) {
      assert.equal(host.phase, "table");
      assert.equal(host.roundNo, round);
      assert.ok(host.d10 >= 1 && host.d10 <= 10);
      assert.equal(host.d10, guest.d10);
      await chooseTables(bus);
      if (round === 3) break;
      setHp(bus, 20, 1);
      await playHand(bus, ["sasso"], ["forbice"]);
      if (round === 2) break; // 2-0: match over
    }
  }
});

// ---------- hands ----------

test("hand with rings: damage, mirrored state, used rings disabled", async () => {
  const bus = makeBus("sync");
  const { host, guest } = bus;
  await toHands(bus, ["scriba", "ferro"], ["ferro", "tuono"], 3);
  assert.equal(await host.pick("sasso", ["ferro"]), false, "sasso has no fingers");
  assert.equal(await host.pick("carta", ["lama", "scriba"]), false, "ring not on the table");
  assert.equal(await host.pick("carta", ["scriba", "scriba"]), false, "duplicate ring");
  await playHand(bus, ["carta", ["scriba"]], ["sasso"]);
  const r = host.lastResult;
  assert.equal(r.outcome, 1);
  assert.equal(r.baseDmgOpp, 3);
  assert.equal(r.dmgOpp, 5);
  assert.deepEqual(host.hp, { me: 20, opp: 15 });
  assert.deepEqual(r.ringsMe, ["scriba"]);
  assert.equal(r.log[0].id, "scriba");
  assert.ok(!host.active.me.includes("scriba"), "used ring disabled");
  assert.ok(host.table.me.includes("scriba"), "still on the table");
  assert.equal(await host.pick("carta", ["scriba"]), false, "used ring refused");
  assertMirrored(host, guest);

  await playHand(bus, ["forbice", ["ferro"]], ["sasso", []], "guest");
  assert.equal(host.lastResult.dmgMe, 3, "5 - 2 (ferro)");
  assert.deepEqual([...host.active.me].sort(), host.table.me.filter((x) => x !== "scriba" && x !== "ferro").sort());
  assertMirrored(host, guest);
});

test("order: host is the arbiter; guest-first and host-first", async () => {
  const bus = makeBus("manual");
  const { host, guest } = bus;
  await toHands(bus, ["ombra", "vampiro"], ["ombra", "guaritore"], 2);

  // Guest commits first and the host receives it before committing: guest goes first.
  assert.equal(await guest.pick("carta", ["ombra", "guaritore"]), true);
  await bus.deliver("guest");
  assert.equal(host.oppSubmitted, true);
  assert.equal(await host.pick("carta", ["ombra", "vampiro"]), true);
  const hostMsgs = bus.pending.host.map((m) => m.t);
  assert.deepEqual(hostMsgs, ["commit", "order", "reveal"], "order before the host's reveal");
  assert.equal(bus.pending.host[1].first, "guest");
  await bus.flush();
  assert.equal(guest.lastResult.first, "me");
  assert.equal(host.lastResult.first, "opp");
  // Guest's Ombra was faster: the host's rings are all cancelled (Ombra included).
  assert.deepEqual(host.lastResult.log.filter((e) => e.owner === "me").map((e) => e.cancelled), [true, true]);
  assert.deepEqual(host.hp, { me: 19, opp: 20 }, "draw 1 each, guest heals 3 (clamped)");
  assertMirrored(host, guest);

  // New round so both have their rings again; this time the host commits first.
  setHp(bus, 20, 1);
  await playHand(bus, ["sasso"], ["forbice"]);
  await chooseTables(bus, ["ombra", "vampiro"], ["ombra", "guaritore"], 2);
  assert.equal(await host.pick("carta", ["ombra", "vampiro"]), true);
  assert.equal(await guest.pick("carta", ["ombra", "guaritore"]), true);
  await bus.flush();
  assert.equal(host.lastResult.first, "me");
  assert.equal(guest.lastResult.first, "opp");
  assert.deepEqual(guest.lastResult.log.filter((e) => e.owner === "me").map((e) => e.cancelled), [true, true]);
  assert.deepEqual(host.hp, { me: 19, opp: 19 });
  assertMirrored(host, guest);
});

test("guest never reveals before the host's order arrives", async () => {
  const bus = makeBus("sync");
  const { host, guest } = bus;
  await toHands(bus);
  const held = [];
  bus.taps.push((from, msg) => (msg.t === "order" ? (held.push(msg), null) : msg));
  await playHand(bus, ["sasso"], ["carta"]);
  assert.equal(bus.sentBy("host", "reveal", 1).length, 1, "host revealed after sending its order");
  assert.equal(bus.sentBy("guest", "reveal", 1).length, 0, "guest waits for the order");
  assert.equal(host.lastResult, null);
  assert.equal(guest.lastResult, null);
  assert.equal(held.length, 1);
  bus.taps.length = 0;
  await guest.receive(held[0]);
  await bus.flush();
  assert.equal(bus.sentBy("guest", "reveal", 1).length, 1);
  assert.equal(host.lastResult.outcome, -1);
  assertMirrored(host, guest);
});

test("order messages to the host and orders for other hands are ignored", async () => {
  const bus = makeBus("manual");
  const { host, guest } = bus;
  await toHands(bus);
  assert.equal(await host.receive({ t: "order", hand: 1, first: "guest" }), false);
  assert.equal(await guest.receive({ t: "order", hand: 7, first: "guest" }), false);
  assert.equal(await guest.receive({ t: "order", hand: 1, first: "me" }), false);
});

test("Ladro: the stolen ring is disabled on both clients", async () => {
  const bus = makeBus("random", 3);
  const { host, guest } = bus;
  await toHands(bus, ["ladro"], ["ferro", "tuono", "pace", "caos"], 5);
  await playHand(bus, ["forbice", ["ladro"]], ["carta", ["ferro"]]);
  const r = host.lastResult;
  assert.equal(r.outcome, 1);
  assert.equal(r.stolenOpp.length, 1);
  const stolen = r.stolenOpp[0];
  assert.ok(guest.table.me.includes(stolen) && stolen !== "ferro");
  assert.ok(!guest.active.me.includes(stolen));
  assert.deepEqual(guest.lastResult.stolenMe, [stolen]);
  assert.equal(guest.active.me.length, 3, "5 - ferro (used) - stolen");
  assertMirrored(host, guest);
});

test("used rings come back in the next round (new d10, new table)", async () => {
  const bus = makeBus("sync");
  const { host, guest } = bus;
  await toHands(bus, ["gigante", "scriba"], ["ferro"], 2);
  setHp(bus, 20, 3);
  await playHand(bus, ["carta", ["gigante", "scriba"]], ["sasso", []]);
  assert.equal(host.lastResult.dmgOpp, 6, "3 + 1 (gigante) + 2 (scriba)");
  assert.equal(host.lastResult.roundEnded, true);
  assert.equal(host.phase, "table");
  assert.equal(host.roundNo, 2);
  assert.equal(host.table.me, null);
  assertMirrored(host, guest);
  await chooseTables(bus, ["gigante", "scriba"], ["ferro"], 2);
  assert.deepEqual(host.active.me, ["gigante", "scriba"]);
  assert.equal(await host.pick("carta", ["scriba", "gigante"]), true, "re-enabled");
});

// ---------- cheating ----------

test("invalid placement (ring not on the table) is detected as cheating", async () => {
  const bus = makeBus("sync");
  const { host, guest } = bus;
  await toHands(bus, [], ["ferro"], 1);
  const offTable = guest.deck.me.find((id) => !guest.table.me.includes(id));
  guest.active.me.push(offTable); // the cheater's client accepts it locally
  await playHand(bus, ["sasso"], ["carta", [offTable]]);
  assert.equal(host.cheated, true);
  assert.equal(host.winner, "me");
  assert.equal(host.phase, "over");
  assert.equal(guest.cheated, false);
});

test("tampered reveals are detected (hand, table, deck, seed)", async () => {
  const change = (t, fn) => (from, msg) => (from === "guest" && msg.t === t ? fn(msg) : msg);
  const cases = [
    ["reveal", (m) => ({ ...m, move: m.move === "carta" ? "forbice" : "carta" })],
    ["reveal", (m) => ({ ...m, rings: [] })],
    ["table-reveal", (m) => ({ ...m, salt: makeSalt() })],
    ["deck-reveal", (m) => ({ ...m, deck: IDS.slice(10, 20) })],
    ["seed-reveal", (m) => ({ ...m, seed: makeSalt() })],
  ];
  for (const [t, fn] of cases) {
    const bus = makeBus("sync");
    bus.taps.push(change(t, fn));
    await startMatch(bus);
    if (bus.host.phase === "table") {
      await chooseTables(bus, [], ["ferro"], 1).catch(() => {});
      if (bus.host.phase === "hand") await playHand(bus, ["sasso"], ["carta", ["ferro"]]);
    }
    assert.equal(bus.host.cheated, true, t);
    assert.equal(bus.host.winner, "me", t);
    assert.equal(bus.host.phase, "over", t);
  }
});

test("a deck that matches its hash but breaks the rules is cheating", async () => {
  const host = new Match({ role: "host" });
  await host.chooseDeck(IDS.slice(0, 10));
  const bad = IDS.slice(0, 9);
  const salt = makeSalt();
  await host.receive({ t: "deck-commit", hash: await deckHash(bad, salt) });
  assert.equal(host.cheated, false);
  await host.receive({ t: "deck-reveal", deck: bad, salt });
  assert.equal(host.cheated, true);
  assert.equal(host.winner, "me");
});

test("malformed and out-of-phase messages are ignored", async () => {
  const m = new Match({ role: "guest" });
  const h64 = "a".repeat(64);
  for (const msg of [
    null, 5, "x", {}, { t: 3 }, { t: "boh" }, { t: "deck-commit", hash: "xyz" },
    { t: "deck-commit", hash: "A".repeat(64) }, { t: "deck-reveal", deck: "gigante", salt: "0".repeat(32) },
    { t: "seed-commit", round: 0, hash: h64 }, { t: "seed-commit", round: 3, hash: h64 },
    { t: "seed-reveal", round: 1, seed: "zz" }, { t: "table-commit", round: "1", hash: h64 },
    { t: "commit", hand: 9, hash: h64 }, { t: "commit", hand: 1, hash: 1 },
    { t: "reveal", hand: 1, move: "sasso", rings: "ferro", salt: "0".repeat(32) },
    { t: "reveal", hand: 1, move: "sasso", rings: [1], salt: "0".repeat(32) },
    { t: "order", hand: 1, first: "opp" }, { t: "rematch", changeDeck: true, seed: h64 },
  ]) {
    assert.equal(await m.receive(msg), false, JSON.stringify(msg));
  }
  assert.equal(m.phase, "deck");
  assert.equal(m.oppSubmitted, false);
  assert.equal(await m.receive({ t: "deck-commit", hash: h64 }), true);
  assert.equal(await m.receive({ t: "deck-commit", hash: "b".repeat(64) }), false, "first commit wins");
  assert.equal(m.cheated, false);
  assert.equal(await m.receive({ t: "seed-commit", round: 1, hash: await seedHash(1, makeSalt()) }), true);
});

test("a commit for the next hand arriving before this hand's reveal is held", async () => {
  const bus = makeBus("manual");
  const { host, guest } = bus;
  await toHands(bus);
  assert.equal(await host.pick("sasso"), true);
  assert.equal(await guest.pick("sasso"), true);
  await bus.deliver("host", 1); // host commit
  await bus.deliver("guest"); // guest commit -> host sends order + reveal
  // Host resolves as soon as it gets the guest's reveal; deliver guest -> host first.
  await bus.deliver("host", 1); // order -> guest reveals
  await bus.deliver("guest");
  assert.equal(host.hand, 2);
  assert.equal(await host.pick("carta"), true);
  // Swap the host's pending [reveal(1), commit(2)] to deliver the next-hand commit first.
  assert.deepEqual(bus.pending.host.map((m) => m.t), ["reveal", "commit"]);
  bus.pending.host.reverse();
  await bus.deliver("host");
  assert.equal(guest.hand, 2);
  assert.equal(guest.oppSubmitted, true, "held commit promoted");
  assert.equal(await guest.pick("forbice"), true);
  await bus.flush();
  assert.equal(host.hand, 3);
  assert.deepEqual(host.hp, { me: 18, opp: 19 });
  assertMirrored(host, guest);
});

// ---------- full match ----------

function randomChoice(rnd, list, n) {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}

async function autoMatch(bus, rnd, { decks = true } = {}) {
  const { host, guest } = bus;
  const sides = [host, guest];
  let lastRound = 0;
  for (let steps = 0; steps < 2000; steps++) {
    await bus.flush();
    assert.equal(host.phase, guest.phase);
    const phase = host.phase;
    if (phase === "over") break;
    if (phase === "deck") {
      assert.ok(decks, "unexpected deck phase");
      await Promise.all(sides.map((m) => m.chooseDeck(m.prevDeck && rnd() < 0.5 ? m.prevDeck : randomChoice(rnd, IDS, DECK_SIZE))));
    } else if (phase === "table") {
      assert.equal(host.d10, guest.d10);
      assert.ok(host.d10 >= 1 && host.d10 <= 10);
      assert.ok(host.roundNo > lastRound);
      lastRound = host.roundNo;
      assertMirrored(host, guest);
      const order = rnd() < 0.5 ? sides : [...sides].reverse();
      await Promise.all(order.map((m) => m.chooseTable(randomChoice(rnd, m.deck.me, m.d10))));
    } else if (phase === "hand") {
      const before = host.hand;
      const order = rnd() < 0.5 ? sides : [...sides].reverse();
      await Promise.all(order.map(async (m, i) => {
        if (i && rnd() < 0.5) await sleep(rnd() * 4);
        const move = MOVES[Math.floor(rnd() * 3)];
        assert.equal(await m.pick(move, randomChoice(rnd, m.active.me, Math.floor(rnd() * (SLOTS[move] + 1)))), true);
      }));
      await bus.flush();
      assert.equal(host.hand, before + 1);
      assertMirrored(host, guest);
      const r = host.lastResult;
      for (const id of [...r.ringsMe, ...r.stolenMe]) assert.ok(!(host.active.me ?? []).includes(id) || r.roundEnded);
      // host sends the order before its own reveal, and the guest reveals only after it
      const idx = (from, t) => bus.log.findIndex((e) => e.from === from && e.msg.t === t && e.msg.hand === before);
      assert.ok(idx("host", "order") >= 0);
      assert.ok(idx("host", "order") < idx("host", "reveal"));
      assert.ok(idx("host", "order") < idx("guest", "reveal"));
      const orderMsg = bus.log[idx("host", "order")].msg;
      assert.equal(r.first, orderMsg.first === "host" ? "me" : "opp");
    } else {
      assert.fail(`stuck in phase ${phase}`);
    }
  }
  assert.equal(host.phase, "over");
  assert.ok(host.winner);
  assert.equal(host.winner, matchWinner(host.points));
  assertMirrored(host, guest);
}

for (const mode of ["sync", "random", "manual"]) {
  test(`full match to completion with random rings (${mode} bus)`, async () => {
    for (let i = 0; i < (mode === "random" ? 3 : 6); i++) {
      const bus = makeBus(mode, 100 + i);
      await autoMatch(bus, makeRng([i, 42, mode.length]));
      const firsts = bus.host.history.map((r) => r.first);
      assert.ok(firsts.every((f) => f === "me" || f === "opp"));
    }
  });
}

// ---------- rematch ----------

test("rematch with the same rings: decks kept, straight to the round-1 roll", async () => {
  const bus = makeBus("random", 9);
  const { host, guest } = bus;
  await startMatch(bus, deckOf("ombra"), deckOf("ferro", "pace"));
  await chooseTables(bus);
  setHp(bus, 1, 20);
  await playHand(bus, ["sasso"], ["carta"]);
  await chooseTables(bus);
  setHp(bus, 1, 20);
  await playHand(bus, ["sasso"], ["carta"]);
  assert.equal(host.winner, "opp");
  const decks = clone(host.deck);
  assert.equal(await guest.requestRematch({ changeDeck: false }), true);
  assert.equal(await guest.requestRematch({ changeDeck: true }), false, "only once");
  await bus.flush();
  assert.equal(host.oppWantsRematch, true);
  assert.equal(host.rematchChangeDeck.opp, false);
  assert.equal(host.phase, "over");
  assert.equal(await host.requestRematch(), true);
  await bus.flush();
  for (const m of [host, guest]) {
    assert.equal(m.phase, "table");
    assert.equal(m.hand, 1);
    assert.equal(m.roundNo, 1);
    assert.deepEqual(m.points, { me: 0, opp: 0 });
    assert.deepEqual(m.hp, { me: MAX_HP, opp: MAX_HP });
    assert.equal(m.lastResult, null);
    assert.equal(m.iWantRematch || m.oppWantsRematch, false);
  }
  assert.deepEqual(host.deck, decks);
  assert.deepEqual(host.prevDeck, decks.me);
  assert.equal(host.d10, guest.d10);
  await autoMatch(bus, makeRng([5]), { decks: false });
});

test("rematch where one player changes rings: deck phase for both, previous deck kept for preselect", async () => {
  const bus = makeBus("manual", 4);
  const { host, guest } = bus;
  await startMatch(bus, deckOf("ombra"), deckOf("ferro"));
  await chooseTables(bus);
  setHp(bus, 20, 1);
  await playHand(bus, ["sasso"], ["forbice"]);
  await chooseTables(bus);
  setHp(bus, 20, 1);
  await playHand(bus, ["sasso"], ["forbice"]);
  assert.equal(host.winner, "me");
  const oldHost = [...host.deck.me];
  const oldGuest = [...guest.deck.me];
  await host.requestRematch({ changeDeck: true });
  await guest.requestRematch({ changeDeck: false });
  await bus.flush();
  for (const m of [host, guest]) {
    assert.equal(m.phase, "deck");
    assert.deepEqual(m.deck, { me: null, opp: null });
  }
  assert.deepEqual(host.prevDeck, oldHost);
  assert.deepEqual(guest.prevDeck, oldGuest);
  await startMatch(bus, IDS.slice(10, 20), guest.prevDeck);
  assert.equal(host.phase, "table");
  assert.deepEqual(guest.deck.opp, IDS.slice(10, 20).sort());
  assert.equal(host.d10, guest.d10);
  await autoMatch(bus, makeRng([6]));
});

test("rematch after a cheat detected in the deck phase forces a new deck phase", async () => {
  const bus = makeBus("sync");
  bus.taps.push((from, msg) => (from === "guest" && msg.t === "deck-reveal" ? { ...msg, deck: IDS.slice(10, 20) } : msg));
  await startMatch(bus);
  assert.equal(bus.host.cheated, true);
  bus.taps.length = 0;
  assert.equal(await bus.host.requestRematch({ changeDeck: false }), true);
  assert.equal(bus.host.rematchChangeDeck.me, true);
});
