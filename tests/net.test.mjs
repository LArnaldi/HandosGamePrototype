// Smoke tests for js/net.js with a fake in-memory `Peer` (no WebRTC in Node).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { hostRoom, joinRoom, buildInviteLink, readRoomFromUrl, ID_PREFIX } from "../js/net.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class Emitter {
  #h = {};
  on(ev, fn) { (this.#h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.#h[ev] || []) fn(...a); }
}

let registry; // id -> FakePeer
let takenIds; // ids that fail with 'unavailable-id'

class FakeConn extends Emitter {
  constructor(peer) { super(); this.peer = peer; this.open = false; this.other = null; this.sent = []; }
  send(msg) { this.sent.push(msg); const o = this.other; queueMicrotask(() => o.emit("data", structuredClone(msg))); }
  close() {
    if (!this.open && !this.other) return;
    const o = this.other;
    this.open = false; this.other = null;
    this.emit("close");
    if (o) o.close();
  }
}

class FakePeer extends Emitter {
  constructor(id) {
    super();
    this.id = id ?? "rnd-" + Math.random().toString(36).slice(2);
    this.destroyed = false;
    queueMicrotask(() => {
      if (takenIds.has(this.id) || registry.has(this.id)) return this.emit("error", { type: "unavailable-id" });
      registry.set(this.id, this);
      this.emit("open", this.id);
    });
  }
  connect(id) {
    const mine = new FakeConn(this);
    queueMicrotask(() => {
      const host = registry.get(id);
      if (!host) return this.emit("error", { type: "peer-unavailable" });
      const theirs = new FakeConn(host);
      mine.other = theirs; theirs.other = mine;
      host.emit("connection", theirs);
      queueMicrotask(() => { mine.open = theirs.open = true; theirs.emit("open"); mine.emit("open"); });
    });
    return mine;
  }
  reconnect() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (registry.get(this.id) === this) registry.delete(this.id);
    this.emit("close");
  }
}

beforeEach(() => {
  registry = new Map();
  takenIds = new Set();
  globalThis.Peer = FakePeer;
});

test("host and guest exchange messages, close fires onClose once", async () => {
  const log = [];
  let code;
  const host = hostRoom({
    onCode: (c) => (code = c),
    onOpponent: () => log.push("host:opp"),
    onMessage: (m) => log.push(["host:msg", m]),
    onClose: () => log.push("host:close"),
    onError: (t) => log.push(["host:err", t]),
  });
  await tick();
  assert.match(code, /^[A-Z2-9]{5}$/);
  const guest = joinRoom(" " + code.toLowerCase() + " ", {
    onOpen: () => log.push("guest:open"),
    onMessage: (m) => log.push(["guest:msg", m]),
    onClose: () => log.push("guest:close"),
    onError: (t) => log.push(["guest:err", t]),
  });
  await tick(5);
  assert.ok(log.includes("host:opp") && log.includes("guest:open"));
  assert.equal(guest.send({ t: "hello", name: "B" }), true);
  assert.equal(host.send({ t: "hello", name: "A" }), true);
  await tick(5);
  assert.deepEqual(log.filter((e) => Array.isArray(e)).sort(), [
    ["guest:msg", { t: "hello", name: "A" }],
    ["host:msg", { t: "hello", name: "B" }],
  ].sort());
  guest.close();
  await tick(5);
  assert.equal(log.filter((e) => e === "host:close").length, 1);
  assert.ok(!log.includes("guest:close"), "explicit close fires no callbacks");
  assert.equal(host.send({ t: "x" }), false);
});

test("third player gets 'Stanza piena'", async () => {
  let code;
  const hostLog = [];
  hostRoom({ onCode: (c) => (code = c), onClose: () => hostLog.push("close"), onError: () => hostLog.push("err") });
  await tick();
  joinRoom(code, {});
  await tick(5);
  const errs = [];
  joinRoom(code, { onError: (text, type) => errs.push([text, type]), onClose: () => errs.push("close") });
  await tick(20);
  assert.deepEqual(errs, [["Stanza piena.", "full"]]);
  assert.deepEqual(hostLog, []);
});

test("unavailable-id retries with a new code, then gives up", async () => {
  // Make the first two attempted ids taken by intercepting Peer construction.
  let attempts = 0;
  globalThis.Peer = class extends FakePeer {
    constructor(id) { if (++attempts <= 2) takenIds.add(id); super(id); }
  };
  const codes = [];
  hostRoom({ onCode: (c) => codes.push(c) });
  await tick(5);
  assert.equal(attempts, 3);
  assert.equal(codes.length, 1);
  assert.ok(registry.has(ID_PREFIX + codes[0]));

  attempts = -100; // every id taken
  const errs = [];
  hostRoom({ onCode: () => errs.push("code"), onError: (t, type) => errs.push(type) });
  await tick(10);
  assert.deepEqual(errs, ["unavailable-id"]);
  assert.equal(attempts, -95); // 5 tries
});

test("joining a missing room reports 'Stanza non trovata'; bad code rejected", async () => {
  const errs = [];
  joinRoom("ABCDE", { onError: (text, type) => errs.push([text, type]) });
  joinRoom("abc", { onError: (text, type) => errs.push([text, type]) });
  await tick(5);
  assert.equal(errs.length, 2);
  assert.ok(errs.some(([t, type]) => type === "peer-unavailable" && t.startsWith("Stanza non trovata")));
  assert.ok(errs.some(([, type]) => type === "invalid-code"));
});

test("invite link helpers", () => {
  globalThis.location = { origin: "https://x.github.io", pathname: "/game/", search: "?r=ab2cd" };
  assert.equal(buildInviteLink("AB2CD"), "https://x.github.io/game/?r=AB2CD");
  assert.equal(readRoomFromUrl(), "AB2CD");
  for (const search of ["", "?r=ABC", "?r=ABCD1", "?r=ABCDEF", "?x=ABCDE"]) {
    globalThis.location.search = search;
    assert.equal(readRoomFromUrl(), null, search);
  }
  delete globalThis.location;
});
