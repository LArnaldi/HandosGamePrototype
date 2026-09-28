// app.js: UI rendering and glue between game logic (game.js) and networking (net.js).
// Screens: home, lobby (host waiting), joining (guest), game (phases deck / roll / table / hand /
// over, see Match in game.js), disconnected. All DOM is built with textContent; opponent data is never parsed as HTML.

import { Match, MOVES, EMOJI, LABEL, MAX_HP, DAMAGE, DRAW_DAMAGE, ROUNDS_TO_WIN } from "./game.js";
import { RINGS, RING_BY_ID, SLOTS, DECK_SIZE } from "./rings.js";
import { hostRoom, joinRoom, buildInviteLink, readRoomFromUrl, normalizeCode } from "./net.js";

const NAME_KEY = "handos-name";
const NAME_MAX = 20;
const DEFAULT_NAME = "Giocatore";
const DEFAULT_OPP = "Avversario";

const root = document.getElementById("app");

const state = {
  screen: "home", // home | lobby | joining | game | disconnected
  name: loadName(),
  codeInput: "",
  error: "",
  code: null, // room code (host: once registered; guest: the one being joined)
  oppName: DEFAULT_OPP,
  match: null,
  copied: false,
  // Local, not yet confirmed choices of the current phase; reset when `key` changes.
  sel: { key: "", deck: new Set(), table: new Set(), move: null, rings: [] },
};

let net = null; // current net handle
let session = 0; // bumps on every new/closed session so stale callbacks are ignored
let queue = Promise.resolve();
let animatedResult = null; // lastResult object whose reveal animation already played
let animatedEnd = null; // match end (keyed by final result) whose animation already played
let hpAnim = null; // {result, start}: damage animation of the last resolved round (plays once)

// Damage feedback timings (ms). Re-renders during the window resume the animations at the
// elapsed time instead of restarting them; after it, bars render statically.
const HP_FILL_MS = 600;
const HP_SHAKE_MS = 420;
const HP_FLOAT_MS = 1100;

// ---------- helpers ----------

function cleanName(x, fallback) {
  const s = typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
  return s || fallback;
}

function loadName() {
  try {
    return cleanName(localStorage.getItem(NAME_KEY), DEFAULT_NAME);
  } catch {
    return DEFAULT_NAME;
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {}
}

function clearUrl() {
  if (location.search) history.replaceState(null, "", location.pathname + location.hash);
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function enqueue(fn) {
  const s = session;
  queue = queue
    .then(() => (s === session ? fn() : undefined))
    .catch((e) => console.error(e))
    .then(() => { if (s === session) render(); });
}

function send(msg) {
  if (msg) net?.send(msg);
}

// ---------- session lifecycle ----------

function endSession() {
  session++;
  try { net?.close(); } catch {}
  net = null;
  state.match = null;
  state.code = null;
  state.oppName = DEFAULT_OPP;
  state.copied = false;
}

function goHome(error = "") {
  endSession();
  clearUrl();
  state.screen = "home";
  state.error = error;
  render();
}

function commitName() {
  state.name = cleanName(state.name, DEFAULT_NAME);
  saveName(state.name);
}

function startGame(role) {
  const s = session;
  // Match sends its protocol messages itself, in order; drop them if this session is gone.
  state.match = new Match({ role, send: (msg) => { if (s === session) net?.send(msg); } });
  state.oppName = DEFAULT_OPP;
  animatedResult = null;
  hpAnim = null;
  state.screen = "game";
  send({ t: "hello", name: state.name });
  render();
}

function makeCallbacks(s) {
  const live = () => s === session;
  return {
    onMessage: (msg) => { if (live()) handleMessage(msg); },
    onClose: () => {
      if (!live()) return;
      net = null;
      state.screen = "disconnected";
      render();
    },
    onError: (text) => { if (live()) goHome(text); },
  };
}

function createRoom() {
  commitName();
  endSession();
  clearUrl();
  const s = session;
  state.error = "";
  state.screen = "lobby";
  net = hostRoom({
    ...makeCallbacks(s),
    onCode: (code) => {
      if (s !== session) return;
      state.code = code;
      render();
    },
    onOpponent: () => { if (s === session) startGame("host"); },
  });
  render();
}

function join(code) {
  commitName();
  endSession();
  const s = session;
  state.error = "";
  state.code = normalizeCode(code);
  state.screen = "joining";
  net = joinRoom(state.code, {
    ...makeCallbacks(s),
    onOpen: () => { if (s === session) startGame("guest"); },
  });
  render();
}

// ---------- protocol ----------

function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
  enqueue(async () => {
    const m = state.match;
    if (!m) return;
    if (msg.t === "hello") state.oppName = cleanName(msg.name, DEFAULT_OPP);
    else await m.receive(msg); // Match validates every game message and ignores the rest
  });
}

// Runs a Match action in the queue, then re-renders.
function act(fn) {
  const m = state.match;
  if (m) enqueue(() => (state.match === m ? fn(m) : undefined));
}

function confirmDeck() {
  const ids = [...state.sel.deck];
  if (ids.length === DECK_SIZE) act((m) => m.chooseDeck(ids));
}

function confirmTable() {
  const ids = [...state.sel.table];
  act((m) => (ids.length === m.d10 ? m.chooseTable(ids) : undefined));
}

function confirmHand() {
  const { move, rings } = state.sel;
  if (move) act((m) => m.pick(move, [...rings]));
}

function rematch(changeDeck) {
  act((m) => m.requestRematch({ changeDeck }));
}

// Local selection state is keyed by phase/round/hand; a new key starts a fresh selection.
function syncSelection(m) {
  const key = `${m.phase}:${m.roundNo}:${m.hand}`;
  if (state.sel.key === key) return state.sel;
  state.sel = {
    key,
    deck: new Set(m.phase === "deck" ? m.prevDeck ?? [] : []),
    table: new Set(),
    move: null,
    rings: [],
  };
  return state.sel;
}

// ---------- rendering ----------

function render() {
  const view = {
    home: renderHome,
    lobby: renderLobby,
    joining: renderJoining,
    game: () => (state.match?.phase === "over" ? renderEnd() : renderGame()),
    disconnected: renderDisconnected,
  }[state.screen];
  root.replaceChildren(...[].concat(view()).filter(Boolean));
}

function title() {
  return h("header", { class: "title" },
    h("h1", { text: "Carta · Forbice · Sasso" }),
    h("p", { class: "subtitle", text: "1v1 online" }));
}

function renderHome() {
  const nameInput = h("input", {
    id: "name",
    type: "text",
    maxLength: NAME_MAX,
    autocomplete: "nickname",
    value: state.name,
    oninput: (e) => { state.name = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter") createRoom(); },
  });
  const codeInput = h("input", {
    id: "code",
    class: "code-input",
    type: "text",
    maxLength: 5,
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    placeholder: "CODICE",
    "aria-label": "Codice stanza",
    value: state.codeInput,
    oninput: (e) => {
      const el = e.target;
      const pos = el.selectionStart;
      el.value = el.value.toUpperCase().replace(/\s/g, "").slice(0, 5);
      try { el.setSelectionRange(pos, pos); } catch {}
      state.codeInput = el.value;
    },
    onkeydown: (e) => { if (e.key === "Enter") join(state.codeInput); },
  });
  return [
    title(),
    h("section", { class: "card stack" },
      h("label", { class: "field-label", for: "name", text: "Il tuo nome" }),
      nameInput,
      h("button", { class: "btn", type: "button", text: "Crea partita", onclick: createRoom })),
    h("section", { class: "card stack" },
      h("label", { class: "field-label", for: "code", text: "Hai un codice?" }),
      h("div", { class: "row" },
        codeInput,
        h("button", { class: "btn btn-small", type: "button", text: "Entra", onclick: () => join(state.codeInput) }))),
    state.error ? h("p", { class: "error", role: "alert", text: state.error }) : null,
  ];
}

function copyLink(input) {
  const done = () => {
    state.copied = true;
    render();
  };
  const fallback = () => {
    input.focus();
    input.select();
    try { if (document.execCommand("copy")) return done(); } catch {}
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(input.value).then(done, fallback);
  else fallback();
}

function renderLobby() {
  if (!state.code) {
    return [title(), h("p", { class: "status", text: "Creazione stanza…" }), cancelBtn()];
  }
  const link = h("input", {
    class: "link-input",
    type: "text",
    readOnly: true,
    value: buildInviteLink(state.code),
    "aria-label": "Link di invito",
    onfocus: (e) => e.target.select(),
  });
  return [
    title(),
    h("section", { class: "card stack" },
      h("p", { class: "field-label", text: "Codice stanza" }),
      h("p", { class: "room-code", text: state.code }),
      h("p", { class: "muted", text: "Invia il link o il codice al tuo avversario." }),
      link,
      h("button", {
        class: "btn",
        type: "button",
        text: state.copied ? "Link copiato!" : "Copia link",
        onclick: () => copyLink(link),
      })),
    h("p", { class: "status waiting", text: "In attesa dell'avversario…" }),
    cancelBtn(),
  ];
}

function renderJoining() {
  return [
    title(),
    h("p", { class: "status waiting", text: `Connessione alla stanza ${state.code}…` }),
    cancelBtn(),
  ];
}

function cancelBtn() {
  return h("button", { class: "btn btn-secondary", type: "button", text: "Annulla", onclick: () => goHome() });
}

function reducedMotion() {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

// Start a Web Animation already `elapsed` ms in, so a re-render continues it rather than replaying.
function playFrom(el, keyframes, duration, elapsed, easing = "ease-out") {
  if (!(elapsed < duration) || typeof el.animate !== "function") return;
  const a = el.animate(keyframes, { duration, easing, fill: "forwards" });
  a.currentTime = Math.max(0, elapsed);
}

const SHAKE = [
  { transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" },
  { transform: "translateX(-4px)" }, { transform: "translateX(2px)" }, { transform: "translateX(0)" },
];

function hpBar(side, label, nameParts, hp, prevHp, elapsed) {
  const pct = (hp / MAX_HP) * 100;
  const level = pct > 50 ? "high" : pct > 25 ? "mid" : "low";
  const fill = h("div", { class: `hp-fill ${level}` });
  fill.style.width = `${pct}%`;
  const num = h("span", { class: "hp-num", text: `HP ${hp}/${MAX_HP}` });
  const track = h("div", {
    class: "hp-track",
    role: "meter",
    "aria-valuemin": "0",
    "aria-valuemax": String(MAX_HP),
    "aria-valuenow": String(hp),
    "aria-label": label,
  }, fill);
  const bar = h("div", { class: `hp hp-${side}` },
    h("div", { class: "hp-head" }, h("span", { class: "hp-name" }, ...nameParts), num),
    track);
  const delta = hp - prevHp; // net change this hand (damage and heal)
  if (delta !== 0 && elapsed < HP_FLOAT_MS) {
    const from = (prevHp / MAX_HP) * 100;
    playFrom(fill, [{ width: `${from}%` }, { width: `${pct}%` }], HP_FILL_MS, elapsed);
    if (delta < 0) playFrom(bar, SHAKE, HP_SHAKE_MS, elapsed, "linear");
    const float = h("span", { class: "hp-float", text: delta < 0 ? `−${-delta}` : `+${delta}`, "aria-hidden": "true" });
    num.append(float);
    playFrom(float, [
      { opacity: 0, transform: "translateY(0.4rem) scale(0.8)" },
      { opacity: 1, transform: "translateY(-0.2rem) scale(1.15)", offset: 0.2 },
      { opacity: 1, transform: "translateY(-0.5rem) scale(1)", offset: 0.65 },
      { opacity: 0, transform: "translateY(-1.2rem) scale(1)" },
    ], HP_FLOAT_MS, elapsed);
  }
  return bar;
}

function hpPanel(m) {
  const r = m.lastResult;
  if (r && hpAnim?.result !== r) {
    hpAnim = { result: r, start: reducedMotion() ? -Infinity : performance.now() };
  }
  const elapsed = r ? performance.now() - hpAnim.start : Infinity;
  // Right after a KO, keep showing the pre-reset HP until the next round's hands start.
  const showKo = !!r?.roundEnded && m.phase !== "hand";
  const fresh = !!r && (showKo || (r.roundNo === m.roundNo && m.phase === "hand"));
  const hpMe = showKo ? r.hpMe : m.hp.me;
  const hpOpp = showKo ? r.hpOpp : m.hp.opp;
  return h("div", { class: "hp-panel" },
    hpBar("me", "I tuoi HP", [h("span", { class: "hp-tag", text: "Tu" }), state.name],
      hpMe, fresh ? r.hpBeforeMe : hpMe, elapsed),
    hpBar("opp", `HP di ${state.oppName}`, [state.oppName],
      hpOpp, fresh ? r.hpBeforeOpp : hpOpp, elapsed));
}

// Pop-in animation only the first time a given hand result is shown.
function freshResult(r) {
  const fresh = r !== animatedResult;
  animatedResult = r;
  return fresh;
}

const winnerDesc = (w) => (w === "me" ? "vinto da te" : w === "opp" ? `vinto da ${state.oppName}` : "doppio KO, un punto a testa");
const winnerShort = (w) => (w === "me" ? "Tu" : w === "opp" ? state.oppName : "Doppio KO");

// Round marker: colored for me / opp / both (double KO), or hollow for the round being played.
function pip(roundNo, kind) {
  const desc = `Round ${roundNo}: ${kind === "current" ? "in corso" : winnerDesc(kind)}`;
  return h("li", { class: `pip ${kind}`, title: desc },
    h("span", { "aria-hidden": "true", text: String(roundNo) }),
    h("span", { class: "sr-only", text: desc }));
}

function pips(m) {
  const items = m.rounds.map((rd) => pip(rd.roundNo, rd.winner));
  if (!m.winner) items.push(pip(m.roundNo, "current"));
  return h("ol", { class: "pips", "aria-label": "Round della partita" }, items);
}

const isTied = (m) => !m.winner && m.points.me === m.points.opp && m.points.me >= ROUNDS_TO_WIN;

function scoreLine(m, cls = "") {
  return h("p", { class: `score ${cls}`, "aria-label": `Round vinti: tu ${m.points.me}, ${state.oppName} ${m.points.opp}` },
    h("span", { class: "score-name me", text: "Tu" }),
    h("span", { class: "score-num me", text: String(m.points.me) }),
    h("span", { class: "score-sep", text: "–", "aria-hidden": "true" }),
    h("span", { class: "score-num opp", text: String(m.points.opp) }),
    h("span", { class: "score-name opp", text: state.oppName }));
}

const PHASE_TEXT = { deck: "Scelta degli anelli", roll: "Tiro del d10", table: "Anelli sul tavolo" };

function scoreboard(m) {
  const info = m.phase === "hand" ? `Round ${m.roundNo} · Mano ${m.handInRound}`
    : m.phase === "over" ? `Round ${m.roundNo}` : `Round ${m.roundNo} · ${PHASE_TEXT[m.phase]}`;
  return h("section", { class: "scoreboard", "aria-label": "Punteggio della partita" },
    h("p", { class: "bo3", text: "Al meglio di 3" }),
    scoreLine(m),
    pips(m),
    isTied(m) ? h("p", { class: "tie-hint", text: "Parità: si continua!" }) : null,
    h("p", { class: "round-info" }, h("strong", { text: info })));
}

const hpDelta = (before, after) => (after < before ? `−${before - after} HP` : after > before ? `+${after - before} HP` : "±0 HP");

function handText(r) {
  const cls = r.outcome === 1 ? "win" : r.outcome === -1 ? "lose" : "draw";
  const head = r.outcome === 1 ? "Hai vinto la mano!" : r.outcome === -1 ? "Hai perso la mano." : "Pareggio.";
  return [`${head} Tu ${hpDelta(r.hpBeforeMe, r.hpMe)} · ${state.oppName} ${hpDelta(r.hpBeforeOpp, r.hpOpp)}`, cls];
}

const ringLabel = (id) => `${RING_BY_ID[id]?.icon ?? "💍"} ${RING_BY_ID[id]?.name ?? id}`;

function revealRow(r) {
  const side = (who, move, rings) => h("div", { class: "reveal-side" },
    h("span", { class: "reveal-emoji", text: EMOJI[move], "aria-label": LABEL[move] }),
    h("span", { class: "reveal-who", text: who }),
    h("span", { class: "muted", text: rings.length ? rings.map((id) => RING_BY_ID[id]?.icon ?? "💍").join(" ") : "nessun anello" }));
  return h("div", { class: "reveal-row" },
    side("Tu", r.me, r.ringsMe),
    h("span", { class: "reveal-vs", text: "vs" }),
    side(state.oppName, r.opp, r.ringsOpp));
}

function ringLog(r) {
  const who = (o) => (o === "me" ? "Tu" : state.oppName);
  const items = [
    h("li", { text: `Più veloce: ${who(r.first)} (i suoi anelli si applicano per primi)` }),
    h("li", { text: `Danni base: Tu ${r.baseDmgMe} · ${state.oppName} ${r.baseDmgOpp}` }),
    ...r.log.map((e) => h("li", { class: e.cancelled ? "ring-log-cancelled" : "" }, `${who(e.owner)}: ${ringLabel(e.id)} — ${e.note}`)),
    h("li", { text: `Totale: Tu ${r.dmgMe} danni, +${r.healMe} HP · ${state.oppName} ${r.dmgOpp} danni, +${r.healOpp} HP` }),
  ];
  for (const id of r.stolenMe) items.push(h("li", { text: `${state.oppName} ti disattiva ${ringLabel(id)}` }));
  for (const id of r.stolenOpp) items.push(h("li", { text: `Disattivi ${ringLabel(id)} a ${state.oppName}` }));
  return h("ul", { class: "ring-log" }, items);
}

function revealCard(r) {
  const fresh = freshResult(r);
  const [text, cls] = handText(r);
  let kicker = null;
  if (r.roundEnded) {
    kicker = r.roundWinner === "me" ? `KO! Round ${r.roundNo} vinto` : r.roundWinner === "opp" ? `KO… Round ${r.roundNo} perso`
      : `Doppio KO! Round ${r.roundNo}: un punto a testa`;
  }
  return h("section", { class: `card reveal ${cls}${fresh ? " pop" : ""}`, "aria-live": "polite" },
    kicker ? h("h2", { class: "round-end-title", text: kicker }) : null,
    revealRow(r),
    h("p", { class: "reveal-outcome", text }),
    ringLog(r));
}

// One ring as a chip (a button when clickable). opts: {used, selected, onclick, disabled, prefix}
function ringChip(id, opts = {}) {
  const ring = RING_BY_ID[id];
  const cls = `ring-chip${opts.used ? " used" : ""}${opts.selected ? " selected" : ""}`;
  const content = [opts.prefix ?? null, `${ring.icon} ${ring.name}`];
  if (!opts.onclick) return h("span", { class: cls, title: ring.text }, ...content);
  return h("button", { class: cls, type: "button", title: ring.text, disabled: !!opts.disabled, onclick: opts.onclick }, ...content);
}

function ringRow(label, ids, active) {
  if (!ids) return null;
  return h("div", { class: "ring-block" },
    h("p", { class: "field-label", text: label }),
    h("div", { class: "ring-row" }, ids.map((id) => ringChip(id, { used: active && !active.includes(id) }))));
}

// Checkbox list of rings; `sel` is a Set that is updated in place.
function ringChecklist(ids, sel, max, disabled) {
  return h("div", { class: "ring-list" }, ids.map((id) => {
    const ring = RING_BY_ID[id];
    const box = h("input", {
      type: "checkbox",
      checked: sel.has(id),
      disabled: disabled || (!sel.has(id) && sel.size >= max),
      onchange: (e) => {
        if (e.target.checked) sel.add(id);
        else sel.delete(id);
        render();
      },
    });
    return h("label", { class: `ring-opt${sel.has(id) ? " selected" : ""}` },
      box,
      h("span", { class: "ring-opt-name", text: `${ring.icon} ${ring.name}` }),
      h("span", { class: "ring-opt-text", text: ring.text }));
  }));
}

function waitText(m) {
  return m.oppSubmitted ? `${state.oppName} ha già scelto` : `In attesa di ${state.oppName}…`;
}

function renderDeckPhase(m, sel) {
  const done = m.submitted;
  return h("section", { class: "card stack" },
    h("h2", { text: `Scegli ${DECK_SIZE} anelli` }),
    h("p", { class: "muted", text: `Il tuo mazzo per questa partita (${sel.deck.size}/${DECK_SIZE})` }),
    ringChecklist(RINGS.map((r) => r.id), sel.deck, DECK_SIZE, done),
    h("button", { class: "btn", type: "button", text: "Conferma", disabled: done || sel.deck.size !== DECK_SIZE, onclick: confirmDeck }),
    h("p", { class: `status${done ? " waiting" : ""}`, text: done ? waitText(m) : m.oppSubmitted ? `${state.oppName} ha scelto` : "" }));
}

function renderTablePhase(m, sel) {
  const done = m.submitted;
  return [
    h("section", { class: "card stack" },
      h("p", { class: "d10", text: `🎲 d10: ${m.d10}` }),
      h("h2", { text: `Metti ${m.d10} ${m.d10 === 1 ? "anello" : "anelli"} sul tavolo` }),
      h("p", { class: "muted", text: `Scelti ${sel.table.size}/${m.d10}` }),
      ringChecklist(m.deck.me, sel.table, m.d10, done),
      h("button", { class: "btn", type: "button", text: "Conferma", disabled: done || sel.table.size !== m.d10, onclick: confirmTable }),
      h("p", { class: `status${done ? " waiting" : ""}`, text: done ? waitText(m) : m.oppSubmitted ? `${state.oppName} ha scelto` : "" })),
    ringRow(`Mazzo di ${state.oppName}`, m.deck.opp),
  ];
}

function renderHandPhase(m, sel) {
  const done = m.submitted;
  const move = done ? m.myMove : sel.move;
  const placed = done ? m.myRings : sel.rings;
  const slots = move ? SLOTS[move] : 0;
  const moves = h("div", { class: "hands" },
    MOVES.map((mv) => h("button", {
      class: `hand-btn${move === mv ? " chosen" : ""}`,
      type: "button",
      disabled: done,
      "aria-pressed": move === mv ? "true" : "false",
      onclick: () => {
        sel.move = mv;
        sel.rings = sel.rings.slice(0, SLOTS[mv]);
        render();
      },
    }, h("span", { class: "hand-emoji", text: EMOJI[mv], "aria-hidden": "true" }),
       h("span", { class: "hand-label", text: LABEL[mv] }),
       h("span", { class: "hand-dmg", text: `${DAMAGE[mv]} ${DAMAGE[mv] === 1 ? "danno" : "danni"} · ${SLOTS[mv]} dita` }))));

  const fingers = [];
  for (let i = 0; i < slots; i++) {
    const id = placed[i];
    fingers.push(id
      ? ringChip(id, { prefix: `${i + 1}. `, onclick: done ? null : () => { sel.rings.splice(i, 1); render(); } })
      : h("span", { class: "ring-chip empty", text: `${i + 1}. —` }));
  }
  const mine = h("div", { class: "ring-block" },
    h("p", { class: "field-label", text: "Il tuo tavolo (tocca per mettere un anello sul prossimo dito)" }),
    h("div", { class: "ring-row" }, m.table.me.map((id) => {
      const used = !m.active.me.includes(id);
      const on = placed.includes(id);
      return ringChip(id, {
        used, selected: on,
        disabled: done || used || on || !move || placed.length >= slots,
        onclick: () => { sel.rings.push(id); render(); },
      });
    })));
  return [
    ringRow(`Tavolo di ${state.oppName}`, m.table.opp, m.active.opp),
    moves,
    move ? h("div", { class: "ring-block" },
      h("p", { class: "field-label", text: slots ? `Dita (${placed.length}/${slots}, da sinistra a destra)` : "Sasso: nessun dito libero" }),
      h("div", { class: "ring-row" }, fingers)) : null,
    mine,
    h("button", { class: "btn", type: "button", text: "Conferma", disabled: done || !move, onclick: confirmHand }),
    h("p", { class: "rules", text: `Pareggio: −${DRAW_DAMAGE} HP a testa` }),
    h("p", { class: `status${done ? " waiting" : ""}`, "aria-live": "polite",
      text: done ? (m.oppSubmitted ? `${state.oppName} ha scelto…` : `In attesa di ${state.oppName}…`)
        : m.oppSubmitted ? `${state.oppName} ha scelto` : "Scegli la mossa e gli anelli" }),
  ];
}

function renderGame() {
  const m = state.match;
  animatedEnd = null; // a match is in progress, so the next end screen is a new one (even after a rematch)
  const sel = syncSelection(m);
  const r = m.lastResult;
  let body;
  if (m.phase === "deck") body = renderDeckPhase(m, sel);
  else if (m.phase === "roll") body = h("p", { class: "status waiting", text: "Tiro del d10 a due mani…" });
  else if (m.phase === "table") body = renderTablePhase(m, sel);
  else body = renderHandPhase(m, sel);
  return [
    scoreboard(m),
    m.phase === "deck" ? null : hpPanel(m),
    r && m.phase !== "deck" ? revealCard(r) : null,
    ...[].concat(body),
    h("button", { class: "btn btn-secondary btn-quiet", type: "button", text: "Esci", onclick: () => goHome() }),
  ];
}

function roundsList(m) {
  if (!m.rounds.length) return null;
  return h("ol", { class: "round-list", "aria-label": "Round giocati" },
    m.rounds.map((rd) => h("li", { class: "round-item" },
      h("span", { class: `pip ${rd.winner}`, "aria-hidden": "true", text: String(rd.roundNo) }),
      h("span", { class: "round-item-no", text: `Round ${rd.roundNo}` }),
      h("span", { class: "round-item-who", text: winnerShort(rd.winner) }),
      h("span", { class: "round-item-hp", text: `${rd.hpMe}–${rd.hpOpp} HP` }))));
}

function renderEnd() {
  const m = state.match;
  const won = m.winner === "me";
  const endKey = m.lastResult ?? m;
  const freshEnd = endKey !== animatedEnd;
  animatedEnd = endKey;
  const headline = m.cheated ? "L'avversario ha barato — vinci a tavolino" : won ? "Hai vinto la partita!" : "Hai perso la partita";
  const how = (change) => (change ? "cambiando anelli" : "con gli stessi anelli");
  let rematchInfo = null;
  if (m.iWantRematch) rematchInfo = `Hai chiesto la rivincita ${how(m.rematchChangeDeck.me)}. In attesa di ${state.oppName}…`;
  else if (m.oppWantsRematch) rematchInfo = `${state.oppName} vuole la rivincita ${how(m.rematchChangeDeck.opp)}!`;
  return [
    h("section", { class: `card end ${won ? "win" : "lose"}${freshEnd ? " pop" : ""}` },
      h("p", { class: "end-emoji", text: m.cheated ? "🚩" : won ? "🏆" : "😔", "aria-hidden": "true" }),
      h("h2", { class: "end-title", text: headline }),
      h("p", { class: "bo3", text: "Round vinti" }),
      scoreLine(m),
      roundsList(m)),
    m.lastResult ? hpPanel(m) : null,
    m.lastResult && !m.cheated ? revealCard(m.lastResult) : null,
    rematchInfo ? h("p", { class: "status", "aria-live": "polite", text: rematchInfo }) : null,
    h("button", { class: "btn", type: "button", disabled: m.iWantRematch, text: "Rivincita con gli stessi anelli", onclick: () => rematch(false) }),
    h("button", { class: "btn", type: "button", disabled: m.iWantRematch, text: "Rivincita cambiando anelli", onclick: () => rematch(true) }),
    h("button", { class: "btn btn-secondary", type: "button", text: "Esci", onclick: () => goHome() }),
  ];
}

function renderDisconnected() {
  return [
    h("section", { class: "card stack" },
      h("p", { class: "end-emoji", text: "🔌", "aria-hidden": "true" }),
      h("h2", { text: "Avversario disconnesso" }),
      h("button", { class: "btn", type: "button", text: "Torna alla home", onclick: () => goHome() })),
  ];
}

// ---------- boot ----------

const urlCode = readRoomFromUrl();
if (urlCode) join(urlCode);
else render();
