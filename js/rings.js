// rings.js: ring database and per-hand ring effect engine; pure, no DOM, no network, Node-testable.
//
// Design (see PLAN.md, "Rings"):
//   - 20 rings exist; before the match each player picks DECK_SIZE (10) of them as their deck.
//   - At the start of each round a shared d10 is rolled; each player secretly puts exactly that many
//     rings from their deck on their table; the tables are revealed simultaneously.
//   - Each hand, besides the move, a player places rings from their own table on the extended fingers
//     of the move (SLOTS: sasso 0, carta 5, forbice 2), ordered left to right. Used rings are disabled
//     until the next round.
//   - Application order: the rings of the player who confirmed first ("faster") apply first, left to
//     right, then the slower player's rings, left to right. Exceptions:
//       Ombra (pre-pass): if the faster player has Ombra, ALL the slower player's rings are cancelled
//       (their Ombra included); if only the slower player has Ombra, all the faster player's rings
//       are cancelled. Cancelled rings still count as used.
//       Fenice (end check): if its owner would end the hand at 0 HP, they stay at 1.
//
// API
//   SLOTS, DECK_SIZE, RINGS [{id, name, gem, icon, text}], RING_BY_ID
//   validatePlacement(move, ringIds, activeTable) -> bool
//   resolveHand({moves, rings, first, hp, myActiveTable, oppActiveTable, rng})
//     -> {dmg, heal, hpAfter, outcome, log:[{owner, id, cancelled, note}], stolen:{me, opp}}
//   makeRng(seedHexOrBytes) -> () => float in [0,1)  (deterministic, mulberry32)

import { DAMAGE, DRAW_DAMAGE, MAX_HP, outcome as rpsOutcome, isMove } from "./game.js";

export const SLOTS = { sasso: 0, carta: 5, forbice: 2 };
export const DECK_SIZE = 10;

export const RINGS = [
  { id: "gigante", name: "Anello del Gigante", gem: "#b5651d", icon: "🗿",
    text: "Se vinci: +1 danno per ogni altro anello attivo sulle tue dita." },
  { id: "scriba", name: "Anello dello Scriba", gem: "#e8d8a8", icon: "📜",
    text: "+2 danni se vinci con Carta." },
  { id: "lama", name: "Anello della Lama", gem: "#c0c8d0", icon: "🗡️",
    text: "+2 danni se vinci con Forbice." },
  { id: "ferro", name: "Anello di Ferro", gem: "#6b6f75", icon: "🛡️",
    text: "Subisci 2 danni in meno." },
  { id: "nebbia", name: "Anello della Nebbia", gem: "#a9b8c4", icon: "🌫️",
    text: "Se perdi, subisci al massimo 1 danno." },
  { id: "specchio", name: "Anello dello Specchio", gem: "#9fe3f0", icon: "🪞",
    text: "Se perdi, l'avversario subisce metà (per difetto) dei tuoi danni." },
  { id: "vampiro", name: "Anello del Vampiro", gem: "#8b0000", icon: "🧛",
    text: "Se vinci, recuperi 2 PV." },
  { id: "guaritore", name: "Anello del Guaritore", gem: "#3cb371", icon: "🌿",
    text: "Recuperi 3 PV, qualunque sia l'esito." },
  { id: "fenice", name: "Anello della Fenice", gem: "#ff7f11", icon: "🔥",
    text: "Se questa mano ti porterebbe a 0 PV, resti a 1." },
  { id: "pace", name: "Anello della Pace", gem: "#f5f5f0", icon: "🕊️",
    text: "In caso di pareggio non subisci danni." },
  { id: "caos", name: "Anello del Caos", gem: "#9b30ff", icon: "🌀",
    text: "In caso di pareggio l'avversario subisce 2 danni in più." },
  { id: "tuono", name: "Anello del Tuono", gem: "#ffd700", icon: "⚡",
    text: "Se vinci: +3 danni. Se perdi: subisci 1 danno in più." },
  { id: "doppio-taglio", name: "Anello del Doppio Taglio", gem: "#dc143c", icon: "⚔️",
    text: "Se vinci, i danni all'avversario raddoppiano. Se perdi, i tuoi raddoppiano." },
  { id: "rabbia", name: "Anello della Rabbia", gem: "#ff4500", icon: "😡",
    text: "Se vinci: +1 danno ogni 5 PV che ti mancano." },
  { id: "tramonto", name: "Anello del Tramonto", gem: "#e9967a", icon: "🌅",
    text: "Se vinci con 10 PV o meno: +4 danni." },
  { id: "sacrificio", name: "Anello del Sacrificio", gem: "#4b0000", icon: "🩸",
    text: "Subisci sempre 2 danni in più. Se vinci: +4 danni." },
  { id: "sorte", name: "Anello della Sorte", gem: "#50c878", icon: "🎲",
    text: "Se vinci: +1d6 danni." },
  { id: "ombra", name: "Anello dell'Ombra", gem: "#2f2f4f", icon: "🌑",
    text: "Annulla tutti gli anelli dell'avversario in questa mano." },
  { id: "ladro", name: "Anello del Ladro", gem: "#556b2f", icon: "🦝",
    text: "Se vinci: disattiva un anello a caso sul tavolo dell'avversario." },
  { id: "montagna", name: "Anello della Montagna", gem: "#8b7d6b", icon: "⛰️",
    text: "Se l'avversario vince con Sasso, non subisci danni." },
];

export const RING_BY_ID = Object.freeze(Object.fromEntries(RINGS.map((r) => [r.id, r])));

export function validatePlacement(move, ringIds, activeTable) {
  if (!isMove(move) || !Array.isArray(ringIds) || !Array.isArray(activeTable)) return false;
  if (ringIds.length > SLOTS[move]) return false;
  if (new Set(ringIds).size !== ringIds.length) return false;
  return ringIds.every((id) => activeTable.includes(id) && Object.hasOwn(RING_BY_ID, id));
}

const OTHER = { me: "opp", opp: "me" };

// Each effect mutates the context and returns a short Italian note ("" -> "nessun effetto").
// c = {self, other, res (owner's outcome), moves, hp, dmg, heal, rng, tables, stolen, uncancelled}
const EFFECTS = {
  gigante(c) {
    if (c.res !== 1) return "";
    const n = c.uncancelled[c.self] - 1;
    c.dmg[c.other] += n;
    return n > 0 ? `+${n} danni` : "";
  },
  scriba(c) {
    if (c.res !== 1 || c.moves[c.self] !== "carta") return "";
    c.dmg[c.other] += 2;
    return "+2 danni";
  },
  lama(c) {
    if (c.res !== 1 || c.moves[c.self] !== "forbice") return "";
    c.dmg[c.other] += 2;
    return "+2 danni";
  },
  ferro(c) {
    const before = c.dmg[c.self];
    c.dmg[c.self] = Math.max(0, before - 2);
    const saved = before - c.dmg[c.self];
    return saved > 0 ? `-${saved} danni subiti` : "";
  },
  nebbia(c) {
    if (c.res !== -1) return "";
    const before = c.dmg[c.self];
    c.dmg[c.self] = Math.min(before, 1);
    return before > 1 ? `danni subiti ridotti a ${c.dmg[c.self]}` : "";
  },
  specchio(c) {
    if (c.res !== -1) return "";
    const n = Math.floor(c.dmg[c.self] / 2);
    c.dmg[c.other] += n;
    return n > 0 ? `riflette ${n} danni` : "";
  },
  vampiro(c) {
    if (c.res !== 1) return "";
    c.heal[c.self] += 2;
    return "+2 PV";
  },
  guaritore(c) {
    c.heal[c.self] += 3;
    return "+3 PV";
  },
  fenice() {
    return ""; // end check, see resolveHand
  },
  pace(c) {
    if (c.res !== 0) return "";
    c.dmg[c.self] = 0;
    return "nessun danno subito";
  },
  caos(c) {
    if (c.res !== 0) return "";
    c.dmg[c.other] += 2;
    return "+2 danni";
  },
  tuono(c) {
    if (c.res === 1) {
      c.dmg[c.other] += 3;
      return "+3 danni";
    }
    if (c.res === -1) {
      c.dmg[c.self] += 1;
      return "+1 danno subito";
    }
    return "";
  },
  "doppio-taglio"(c) {
    if (c.res === 1) {
      c.dmg[c.other] *= 2;
      return `danni raddoppiati (${c.dmg[c.other]})`;
    }
    if (c.res === -1) {
      c.dmg[c.self] *= 2;
      return `danni subiti raddoppiati (${c.dmg[c.self]})`;
    }
    return "";
  },
  rabbia(c) {
    if (c.res !== 1) return "";
    const n = Math.floor(Math.max(0, MAX_HP - c.hp[c.self]) / 5);
    c.dmg[c.other] += n;
    return n > 0 ? `+${n} danni` : "";
  },
  tramonto(c) {
    if (c.res !== 1 || c.hp[c.self] > 10) return "";
    c.dmg[c.other] += 4;
    return "+4 danni";
  },
  sacrificio(c) {
    c.dmg[c.self] += 2;
    if (c.res !== 1) return "+2 danni subiti";
    c.dmg[c.other] += 4;
    return "+2 danni subiti, +4 danni";
  },
  sorte(c) {
    if (c.res !== 1) return "";
    const n = 1 + Math.floor(c.rng() * 6);
    c.dmg[c.other] += n;
    return `dado: ${n}, +${n} danni`;
  },
  ombra() {
    return "annulla gli anelli avversari"; // pre-pass, see resolveHand
  },
  ladro(c) {
    if (c.res !== 1) return "";
    const pool = [...c.tables[c.other]].sort();
    if (!pool.length) return "";
    const id = pool[Math.floor(c.rng() * pool.length)];
    c.tables[c.other] = c.tables[c.other].filter((x) => x !== id);
    c.stolen[c.other].push(id);
    return `disattiva ${RING_BY_ID[id]?.name ?? id}`;
  },
  montagna(c) {
    if (c.res !== -1 || c.moves[c.other] !== "sasso") return "";
    c.dmg[c.self] = 0;
    return "nessun danno subito";
  },
};

export function resolveHand({ moves, rings, first, hp, myActiveTable = [], oppActiveTable = [], rng = Math.random }) {
  if (!isMove(moves?.me) || !isMove(moves?.opp)) throw new Error("resolveHand: mosse non valide");
  if (first !== "me" && first !== "opp") throw new Error("resolveHand: first non valido");
  const placed = { me: [...(rings?.me ?? [])], opp: [...(rings?.opp ?? [])] };
  for (const side of ["me", "opp"]) {
    for (const id of placed[side]) {
      if (!Object.hasOwn(RING_BY_ID, id)) throw new Error(`resolveHand: anello sconosciuto ${id}`);
    }
  }

  const res = rpsOutcome(moves.me, moves.opp);
  const dmg = {
    me: res === 0 ? DRAW_DAMAGE : res === -1 ? DAMAGE[moves.opp] : 0,
    opp: res === 0 ? DRAW_DAMAGE : res === 1 ? DAMAGE[moves.me] : 0,
  };
  const heal = { me: 0, opp: 0 };

  // Ombra pre-pass: the faster player's Ombra wins; otherwise the slower player's Ombra applies.
  const second = OTHER[first];
  const cancelled = { me: false, opp: false };
  if (placed[first].includes("ombra")) cancelled[second] = true;
  else if (placed[second].includes("ombra")) cancelled[first] = true;

  const uncancelled = {
    me: cancelled.me ? 0 : placed.me.length,
    opp: cancelled.opp ? 0 : placed.opp.length,
  };
  const ctx = {
    moves, hp, dmg, heal, rng, uncancelled,
    tables: { me: [...myActiveTable], opp: [...oppActiveTable] },
    stolen: { me: [], opp: [] },
  };

  const log = [];
  for (const owner of [first, second]) {
    for (const id of placed[owner]) {
      if (cancelled[owner]) {
        log.push({ owner, id, cancelled: true, note: "annullato dall'Ombra" });
        continue;
      }
      const c = { ...ctx, self: owner, other: OTHER[owner], res: owner === "me" ? res : -res };
      const note = EFFECTS[id](c);
      ctx.tables = c.tables; // ladro may reassign
      log.push({ owner, id, cancelled: false, note: note || "nessun effetto" });
    }
  }

  const hpAfter = {};
  for (const side of ["me", "opp"]) {
    let v = Math.min(MAX_HP, Math.max(0, hp[side] - dmg[side] + heal[side]));
    if (v === 0 && !cancelled[side] && placed[side].includes("fenice")) {
      v = 1;
      const entry = log.find((e) => e.owner === side && e.id === "fenice");
      entry.note = "resti a 1 PV";
    }
    hpAfter[side] = v;
  }

  return { dmg, heal, hpAfter, outcome: res, log, stolen: ctx.stolen };
}

// Deterministic PRNG (mulberry32) seeded by FNV-1a over the seed bytes (hex string or byte array).
export function makeRng(seed) {
  let bytes;
  if (typeof seed === "string") {
    const hex = seed.replace(/[^0-9a-f]/gi, "");
    bytes = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  } else {
    bytes = Array.from(seed ?? []);
  }
  let h = 0x811c9dc5;
  for (const b of bytes.slice(0, 32)) h = Math.imul(h ^ (b & 0xff), 0x01000193) >>> 0;
  let a = h;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
