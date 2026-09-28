// app.js: UI rendering and glue between game logic (game.js) and networking (net.js).
// Screens: home, lobby (host waiting), joining (guest), game, disconnected. The game screen follows
// the Match phases (see game.js): deck builder -> d10 roll -> table pick -> hands (move + rings on
// fingers) -> round-end panel -> ... -> match end with rematch. A rules drawer ("?") lives outside
// #app and is available on every screen.
// All DOM is built with textContent; names and other network data are never parsed as HTML.

import { Match, MOVES, EMOJI, LABEL, MAX_HP, DAMAGE, DRAW_DAMAGE, ROUNDS_TO_WIN } from "./game.js";
import { RINGS, RING_BY_ID, SLOTS, DECK_SIZE } from "./rings.js";
import { hostRoom, joinRoom, buildInviteLink, readRoomFromUrl, normalizeCode } from "./net.js";

const NAME_KEY = "handos-name";
const RULES_KEY = "handos-rules-open";
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
  // View-only toggles that must survive re-renders.
  ui: { logOpen: true, oppDeckOpen: false, myDeckOpen: false },
  roundAck: null, // key of the round-ending hand whose panel the player dismissed
};

let net = null; // current net handle
let session = 0; // bumps on every new/closed session so stale callbacks are ignored
let queue = Promise.resolve();
let gen = 0; // bumps for every new match (including rematches), to key one-shot animations
let lastPhase = null;
let animatedResult = null; // lastResult object whose pop-in animation already played
let animatedEnd = null; // match end (keyed by final result) whose animation already played
let hpAnim = null; // {result, start}: damage animation of the last resolved hand (plays once)
let rollAnim = null; // {key, start}: d10 roll animation of the current round (plays once)
let rollTimer = null; // re-render when the d10 roll settles
let dieTicker = null; // random faces while the die rolls

// Damage feedback timings (ms). Re-renders during the window resume the animations at the
// elapsed time instead of restarting them; after it, bars render statically.
const HP_FILL_MS = 600;
const HP_SHAKE_MS = 420;
const HP_FLOAT_MS = 1100;
const ROLL_MS = 1300; // d10 roll animation
const DIE_TICK_MS = 85;

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

// Element builder. props: class, text, on<event>, vars ({"--x": value} CSS custom properties),
// DOM properties (non-string values) or attributes (strings; `true` -> empty attribute).
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "vars") for (const [name, val] of Object.entries(v)) el.style.setProperty(name, val);
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

function reducedMotion() {
  try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dmgText = (n) => plural(n, "danno", "danni");
// "Anello della Lama" -> "Lama" (compact contexts: chips, fingers, log).
const shortName = (id) => (RING_BY_ID[id]?.name ?? id).replace(/^Anello (?:della |dello |dell'|del |di )/, "");
const who = (side) => (side === "me" ? "Tu" : state.oppName);

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
  state.roundAck = null;
  state.ui.oppDeckOpen = false;
  animatedResult = null;
  hpAnim = null;
  gen++;
  lastPhase = null;
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

// Local selection state is keyed by match/phase/round/hand; a new key starts a fresh selection.
function syncSelection(m) {
  const key = `${gen}:${m.phase}:${m.roundNo}:${m.hand}`;
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
  clearTimeout(rollTimer);
  clearInterval(dieTicker);
  rollTimer = dieTicker = null;
  const m = state.match;
  if (state.screen === "game" && m) {
    if (lastPhase === "over" && m.phase !== "over") gen++; // rematch started
    lastPhase = m.phase;
  }
  const view = {
    home: renderHome,
    lobby: renderLobby,
    joining: renderJoining,
    game: () => (m?.phase === "over" ? renderEnd() : renderGame()),
    disconnected: renderDisconnected,
  }[state.screen];
  // Keep keyboard focus on the "same" control across the full re-render.
  const active = document.activeElement;
  const focusKey = active && root.contains(active) ? active.dataset.k : null;
  root.replaceChildren(...[].concat(view()).filter(Boolean));
  if (focusKey) {
    const el = [...root.querySelectorAll("[data-k]")].find((x) => x.dataset.k === focusKey);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
}

function title() {
  return h("header", { class: "title" },
    h("h1", { text: "Handos" }),
    h("p", { class: "subtitle", text: "Carta · Forbice · Sasso — 1v1 nella taverna" }));
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
    h("p", { class: "muted", text: "Nuovo? Tocca ? in alto a destra per le regole." }),
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

// ---------- HP bars ----------

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
    const float = h("span", { class: `hp-float${delta > 0 ? " heal" : ""}`, text: delta < 0 ? `−${-delta}` : `+${delta}`, "aria-hidden": "true" });
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

// showKo: show the HP right after the last hand (before the round reset), e.g. 0 after a KO.
function hpPanel(m, showKo = false) {
  const r = m.lastResult;
  if (r && hpAnim?.result !== r) {
    hpAnim = { result: r, start: reducedMotion() ? -Infinity : performance.now() };
  }
  const elapsed = r ? performance.now() - hpAnim.start : Infinity;
  const fresh = !!r && (showKo || (r.roundNo === m.roundNo && m.phase === "hand"));
  const hpMe = showKo && r ? r.hpMe : m.hp.me;
  const hpOpp = showKo && r ? r.hpOpp : m.hp.opp;
  return h("div", { class: "hp-panel" },
    hpBar("me", "I tuoi HP", [h("span", { class: "hp-tag", text: "Tu" }), state.name],
      hpMe, fresh ? r.hpBeforeMe : hpMe, elapsed),
    hpBar("opp", `HP di ${state.oppName}`, [state.oppName],
      hpOpp, fresh ? r.hpBeforeOpp : hpOpp, elapsed));
}

// ---------- scoreboard ----------

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

const PHASE_TEXT = { deck: "Scelta degli anelli", roll: "Tiro del d10", table: "Anelli sul tavolo", roundEnd: "Fine round" };

function scoreboard(m, phaseKey = m.phase) {
  const info = phaseKey === "hand" ? `Round ${m.roundNo} · Mano ${m.handInRound}`
    : phaseKey === "roundEnd" ? `Round ${m.roundNo - 1} · ${PHASE_TEXT.roundEnd}`
    : `Round ${m.roundNo} · ${PHASE_TEXT[phaseKey]}`;
  return h("section", { class: "scoreboard", "aria-label": "Punteggio della partita" },
    h("p", { class: "bo3", text: "Al meglio di 3" }),
    scoreLine(m),
    pips(m),
    isTied(m) ? h("p", { class: "tie-hint", text: "Parità: si continua!" }) : null,
    h("p", { class: "round-info" }, h("strong", { text: info })));
}

// ---------- ring components ----------

function gemDot(ring) {
  return h("span", { class: "gem", "aria-hidden": "true", vars: { "--gem": ring.gem } });
}

// Deck builder / table picker card: gem, icon, full name, rules text; a toggle button.
function ringCard(id, { selected, disabled, onclick, key }) {
  const ring = RING_BY_ID[id];
  return h("button", {
    class: `ring-card${selected ? " is-selected" : ""}`,
    type: "button",
    "aria-pressed": selected ? "true" : "false",
    disabled: !!disabled,
    "data-k": key,
    vars: { "--gem": ring.gem },
    onclick,
  },
    h("span", { class: "ring-card-head" },
      gemDot(ring),
      h("span", { class: "ring-icon", "aria-hidden": "true", text: ring.icon }),
      h("span", { class: "ring-name", title: ring.name, text: shortName(id) }),
      h("span", { class: "ring-check", "aria-hidden": "true", text: selected ? "✓" : "" })),
    h("span", { class: "ring-text", text: ring.text }));
}

// Table ring: compact chip with short name and text. status: active | placed | used | stolen.
const STATUS_BADGE = { used: "usato", stolen: "rubato" };

function ringMini(id, { status = "active", badge, onclick, disabled, key, label } = {}) {
  const ring = RING_BY_ID[id];
  const tag = onclick ? "button" : "div";
  const badgeText = badge ?? STATUS_BADGE[status];
  return h(tag, {
    class: `ring-mini is-${status}`,
    type: onclick ? "button" : null,
    disabled: onclick ? !!disabled : null,
    "data-k": key,
    "aria-label": label,
    title: ring.text,
    vars: { "--gem": ring.gem },
    onclick,
  },
    gemDot(ring),
    h("span", { class: "ring-icon", "aria-hidden": "true", text: ring.icon }),
    h("span", { class: "ring-body" },
      h("span", { class: "ring-name", text: shortName(id) }),
      h("span", { class: "ring-text", text: ring.text })),
    badgeText ? h("span", { class: `ring-badge badge-${status}`, text: badgeText }) : null);
}

// Rings disabled by a Ladro during the current round: {me: Set, opp: Set}.
function stolenThisRound(m) {
  const hands = m.history.filter((x) => x.roundNo === m.roundNo);
  return {
    me: new Set(hands.flatMap((x) => x.stolenMe)),
    opp: new Set(hands.flatMap((x) => x.stolenOpp)),
  };
}

function tableStatus(m, side, id, stolen) {
  if (stolen[side].has(id)) return "stolen";
  return m.active[side]?.includes(id) ? "active" : "used";
}

// Collapsible list of a whole deck (e.g. the opponent's, once revealed).
function deckView(ids, label, uiKey) {
  if (!ids) return null;
  return h("details", {
    class: "deck-view",
    open: !!state.ui[uiKey],
    ontoggle: (e) => { state.ui[uiKey] = e.target.open; },
  },
    h("summary", {}, `${label} (${ids.length})`),
    h("div", { class: "ring-grid compact" }, ids.map((id) => ringMini(id))));
}

// ---------- deck builder ----------

function renderDeckPhase(m, sel) {
  if (m.submitted) {
    return h("section", { class: "card stack phase-deck" },
      h("h2", { text: "Anelli scelti" }),
      h("div", { class: "ring-grid compact" }, m.deck.me.map((id) => ringMini(id))),
      h("p", { class: "status waiting", "aria-live": "polite",
        text: m.oppSubmitted ? `${state.oppName} ha scelto: apertura delle buste…` : `In attesa che ${state.oppName} scelga i suoi anelli…` }));
  }
  const n = sel.deck.size;
  const full = n >= DECK_SIZE;
  const toggle = (id) => () => {
    if (sel.deck.has(id)) sel.deck.delete(id);
    else if (sel.deck.size < DECK_SIZE) sel.deck.add(id);
    render();
  };
  return h("section", { class: "card stack phase-deck" },
    h("h2", { text: `Scegli i tuoi ${DECK_SIZE} anelli` }),
    h("p", { class: "muted", text: "Tocca un anello per aggiungerlo o toglierlo. Anche l'avversario può scegliere gli stessi." }),
    m.prevDeck ? h("p", { class: "muted", text: "Il mazzo della partita precedente è già selezionato." }) : null,
    m.oppSubmitted ? h("p", { class: "opp-status done", text: `${state.oppName} ha già scelto i suoi anelli` }) : null,
    h("div", { class: "ring-grid" }, RINGS.map((r) => ringCard(r.id, {
      selected: sel.deck.has(r.id),
      disabled: full && !sel.deck.has(r.id),
      onclick: toggle(r.id),
      key: `deck-${r.id}`,
    }))),
    h("div", { class: "sticky-bar" },
      h("p", { class: `counter${n === DECK_SIZE ? " complete" : ""}`, "aria-live": "polite", text: `Scelti ${n}/${DECK_SIZE}` }),
      n ? h("button", { class: "btn btn-secondary btn-small", type: "button", text: "Svuota", "data-k": "deck-clear",
        onclick: () => { sel.deck.clear(); render(); } }) : null,
      h("button", { class: "btn btn-small", type: "button", text: "Conferma", "data-k": "deck-confirm",
        disabled: n !== DECK_SIZE, onclick: confirmDeck })));
}

// ---------- d10 ----------

function die(value, rolling) {
  const face = h("span", { class: "die-face", text: value == null ? "?" : String(value) });
  const el = h("div", { class: `die${rolling ? " rolling" : " settled"}`, "aria-hidden": "true" }, face);
  if (rolling && !reducedMotion()) {
    dieTicker = setInterval(() => { face.textContent = String(1 + Math.floor(Math.random() * 10)); }, DIE_TICK_MS);
  }
  return el;
}

// The d10 of the current round: rolling (phase "roll", or the first ROLL_MS of phase "table"),
// then settled. Returns {el, rolling}.
function rollView(m) {
  if (m.phase === "roll") {
    return { rolling: true, el: h("section", { class: "card roll", "aria-live": "polite" },
      die(null, true),
      h("p", { class: "roll-text", text: "Tiro del d10 a due mani…" })) };
  }
  const key = `${gen}:${m.roundNo}`;
  if (rollAnim?.key !== key) rollAnim = { key, start: reducedMotion() ? -Infinity : performance.now() };
  const left = ROLL_MS - (performance.now() - rollAnim.start);
  if (left > 0) {
    rollTimer = setTimeout(render, left);
    return { rolling: true, el: h("section", { class: "card roll" },
      die(m.d10, true),
      h("p", { class: "roll-text", text: "Tiro del d10…" })) };
  }
  return { rolling: false, el: h("section", { class: "card roll", "aria-live": "polite" },
    die(m.d10, false),
    h("p", { class: "roll-text" },
      h("strong", { text: `Round ${m.roundNo}: ` }),
      `ognuno mette ${plural(m.d10, "anello", "anelli")} sul tavolo`)) };
}

// ---------- table pick ----------

function renderTablePhase(m, sel) {
  const roll = rollView(m);
  if (roll.rolling) return [roll.el];
  const n = sel.table.size;
  let pick;
  if (m.submitted) {
    pick = h("section", { class: "card stack phase-table" },
      h("h2", { text: "Il tuo tavolo" }),
      h("div", { class: "ring-grid compact" }, m.table.me.map((id) => ringMini(id))),
      h("p", { class: "status waiting", "aria-live": "polite",
        text: m.oppSubmitted ? `${state.oppName} ha scelto: apertura delle buste…` : `In attesa che ${state.oppName} scelga il suo tavolo…` }));
  } else {
    const toggle = (id) => () => {
      if (sel.table.has(id)) sel.table.delete(id);
      else if (sel.table.size < m.d10) sel.table.add(id);
      render();
    };
    pick = h("section", { class: "card stack phase-table" },
      h("h2", { text: `Scegli ${plural(m.d10, "anello", "anelli")} dal tuo mazzo` }),
      h("p", { class: "muted", text: "Solo gli anelli sul tavolo potranno andare sulle tue dita in questo round. I tavoli si rivelano insieme." }),
      m.oppSubmitted ? h("p", { class: "opp-status done", text: `${state.oppName} ha già scelto il suo tavolo` }) : null,
      h("div", { class: "ring-grid" }, m.deck.me.map((id) => ringCard(id, {
        selected: sel.table.has(id),
        disabled: !sel.table.has(id) && n >= m.d10,
        onclick: toggle(id),
        key: `table-${id}`,
      }))),
      h("div", { class: "sticky-bar" },
        h("p", { class: `counter${n === m.d10 ? " complete" : ""}`, "aria-live": "polite", text: `Scelti ${n}/${m.d10}` }),
        h("button", { class: "btn btn-small", type: "button", text: "Conferma", "data-k": "table-confirm",
          disabled: n !== m.d10, onclick: confirmTable })));
  }
  return [roll.el, pick, deckView(m.deck.opp, `Anelli di ${state.oppName}`, "oppDeckOpen")];
}

// ---------- hand phase ----------

const FINGER_HEIGHTS = { 5: [58, 84, 100, 88, 66], 2: [96, 100] }; // % of the finger area, left to right

function handVisual(move, placed, editable, sel) {
  const slots = SLOTS[move];
  if (!slots) {
    return h("div", { class: "hand-area fist" },
      h("span", { class: "fist-emoji", "aria-hidden": "true", text: EMOJI.sasso }),
      h("p", { class: "muted", text: "Sasso: nessun dito disteso, niente anelli. Colpisce forte (5 danni)." }));
  }
  const heights = FINGER_HEIGHTS[slots] ?? Array(slots).fill(100);
  const fingers = [];
  for (let i = 0; i < slots; i++) {
    const id = placed[i];
    const label = id ? `Dito ${i + 1}: ${RING_BY_ID[id].name}${editable ? " (tocca per togliere)" : ""}` : `Dito ${i + 1}: libero`;
    const content = id
      ? [h("span", { class: "slot-icon", "aria-hidden": "true", text: RING_BY_ID[id].icon }),
        h("span", { class: "slot-name", "aria-hidden": "true", text: shortName(id) })]
      : [h("span", { class: "slot-num", "aria-hidden": "true", text: String(i + 1) })];
    const slot = editable && id
      ? h("button", { class: "finger-slot filled", type: "button", "aria-label": label, "data-k": `finger-${i}`,
        vars: { "--gem": RING_BY_ID[id].gem },
        onclick: () => { sel.rings.splice(i, 1); render(); } }, ...content)
      : h("span", { class: `finger-slot${id ? " filled" : ""}`, role: "img", "aria-label": label,
        vars: id ? { "--gem": RING_BY_ID[id].gem } : null }, ...content);
    fingers.push(h("li", { class: "finger", vars: { "--h": `${heights[i]}%` } }, slot));
  }
  const detail = placed.length
    ? h("ol", { class: "placed-list" }, placed.map((id, i) => h("li", {},
      h("strong", { text: `${i + 1}. ${RING_BY_ID[id].icon} ${shortName(id)}` }), ` — ${RING_BY_ID[id].text}`)))
    : h("p", { class: "muted", text: editable ? "Tocca un anello del tuo tavolo per metterlo sul prossimo dito libero." : "Nessun anello sulle dita." });
  return h("div", { class: `hand-area slots-${slots}` },
    h("p", { class: "field-label", text: `Dita (sinistra → destra) · ${placed.length}/${slots}` }),
    h("div", { class: "hand-drawing" },
      h("ol", { class: "fingers", "aria-label": "Dita, da sinistra a destra" }, fingers),
      h("div", { class: "palm", "aria-hidden": "true" }, h("span", { text: EMOJI[move] }))),
    detail);
}

function oppTable(m, stolen) {
  return h("section", { class: "table-block opp", "aria-label": `Tavolo di ${state.oppName}` },
    h("div", { class: "table-head" },
      h("h3", { class: "table-title", text: `Tavolo di ${state.oppName}` }),
      h("span", { class: `opp-status${m.oppSubmitted ? " done" : ""}`, "aria-live": "polite",
        text: m.oppSubmitted ? `✓ ${state.oppName} ha confermato` : "sta scegliendo…" })),
    h("div", { class: "ring-grid compact" }, m.table.opp.map((id) => ringMini(id, { status: tableStatus(m, "opp", id, stolen) }))));
}

function myTable(m, stolen, placed, editable, slots, sel) {
  return h("section", { class: "table-block me", "aria-label": "Il tuo tavolo" },
    h("div", { class: "table-head" },
      h("h3", { class: "table-title", text: "Il tuo tavolo" }),
      h("span", { class: "muted", text: `${m.active.me.length}/${m.table.me.length} attivi` })),
    h("div", { class: "ring-grid compact" }, m.table.me.map((id) => {
      let status = tableStatus(m, "me", id, stolen);
      const finger = placed.indexOf(id);
      if (status === "active" && finger >= 0) status = "placed";
      const canTap = editable && (status === "placed" || (status === "active" && placed.length < slots));
      return ringMini(id, {
        status,
        badge: status === "placed" ? `dito ${finger + 1}` : undefined,
        key: `mine-${id}`,
        onclick: editable ? () => {
          if (status === "placed") sel.rings.splice(finger, 1);
          else sel.rings.push(id);
          render();
        } : null,
        disabled: !canTap,
      });
    })));
}

function renderHandPhase(m, sel) {
  const done = m.submitted;
  const move = done ? m.myMove : sel.move;
  const placed = done ? m.myRings : sel.rings;
  const slots = move ? SLOTS[move] : 0;
  const stolen = stolenThisRound(m);
  const r = m.lastResult;
  const out = [];
  if (r && r.roundNo === m.roundNo) out.push(resultPanel(r));
  out.push(oppTable(m, stolen));

  const moves = h("div", { class: "moves", role: "group", "aria-label": "Mossa" },
    MOVES.map((mv) => h("button", {
      class: `move-btn${move === mv ? " chosen" : ""}`,
      type: "button",
      disabled: done,
      "aria-pressed": move === mv ? "true" : "false",
      "data-k": `move-${mv}`,
      onclick: () => {
        sel.move = mv;
        sel.rings = sel.rings.slice(0, SLOTS[mv]); // keep the rings that still fit
        render();
      },
    }, h("span", { class: "move-emoji", text: EMOJI[mv], "aria-hidden": "true" }),
       h("span", { class: "move-label", text: LABEL[mv] }),
       h("span", { class: "move-stats", text: `${dmgText(DAMAGE[mv])} · ${SLOTS[mv]} dita` }))));

  const confirmArea = done
    ? h("div", { class: "confirm-area" },
      h("p", { class: "status waiting", "aria-live": "polite",
        text: m.oppSubmitted ? `${state.oppName} ha confermato: apertura delle buste…` : `Mossa confermata. In attesa di ${state.oppName}…` }))
    : h("div", { class: "confirm-area sticky-bar" },
      h("button", { class: "btn btn-big", type: "button", text: "Conferma mossa", "data-k": "hand-confirm",
        disabled: !move, onclick: confirmHand }),
      h("p", { class: "speed-hint", text: m.oppSubmitted
        ? `${state.oppName} ha già confermato: i suoi anelli si applicheranno prima dei tuoi.`
        : "La velocità conta: chi conferma prima applica prima i suoi anelli." }));

  out.push(h("section", { class: "card stack play" },
    h("h2", { class: "play-title", text: done ? "La tua mossa" : "Scegli la mossa" }),
    moves,
    move ? handVisual(move, placed, !done, sel)
      : h("p", { class: "muted", text: `Chi perde subisce i danni della mossa vincente. Pareggio: ${dmgText(DRAW_DAMAGE)} a testa.` }),
    myTable(m, stolen, placed, !done && !!move, slots, sel),
    confirmArea));
  out.push(deckView(m.deck.opp, `Anelli di ${state.oppName}`, "oppDeckOpen"));
  return out;
}

// ---------- hand result ----------

function outcomeHead(r) {
  if (r.outcome === 1) return ["win", "Hai vinto la mano!"];
  if (r.outcome === -1) return ["lose", "Hai perso la mano"];
  return ["draw", "Pareggio"];
}

function roundEndText(r) {
  if (r.roundWinner === "me") return `KO! Round ${r.roundNo} vinto`;
  if (r.roundWinner === "opp") return `KO… Round ${r.roundNo} perso`;
  return `Doppio KO! Round ${r.roundNo}: un punto a testa`;
}

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0");

function moveSide(side, move, rings) {
  return h("div", { class: `result-side ${side}` },
    h("span", { class: "result-emoji", text: EMOJI[move], "aria-hidden": "true" }),
    h("span", { class: "result-who", text: who(side) }),
    h("span", { class: "result-move", text: LABEL[move] }),
    h("span", { class: "result-rings", text: rings.length ? rings.map((id) => RING_BY_ID[id].icon).join(" ") : "nessun anello",
      "aria-label": rings.length ? `Anelli: ${rings.map(shortName).join(", ")}` : "nessun anello" }));
}

function ringLogList(r) {
  if (!r.log.length) return h("p", { class: "muted", text: "Nessun anello in gioco in questa mano." });
  return h("ol", { class: "ring-log" }, r.log.map((e) => h("li", { class: `log-item ${e.owner}${e.cancelled ? " cancelled" : ""}` },
    h("span", { class: `owner-tag ${e.owner}`, text: who(e.owner) }),
    h("span", { class: "log-ring" },
      h("span", { "aria-hidden": "true", text: `${RING_BY_ID[e.id]?.icon ?? "💍"} ` }),
      shortName(e.id)),
    h("span", { class: "log-note", text: e.cancelled ? `annullato: ${e.note}` : e.note }))));
}

function damageTable(r) {
  const row = (side) => {
    const [base, dmg, heal, before, after] = side === "me"
      ? [r.baseDmgMe, r.dmgMe, r.healMe, r.hpBeforeMe, r.hpMe]
      : [r.baseDmgOpp, r.dmgOpp, r.healOpp, r.hpBeforeOpp, r.hpOpp];
    return h("tr", { class: side },
      h("th", { scope: "row", text: who(side) }),
      h("td", {}, `${base} → `, h("strong", { text: String(dmg) })),
      h("td", { text: heal ? `+${heal}` : "0" }),
      h("td", {}, `${before} → `, h("strong", { text: String(after) }), h("span", { class: `delta ${after < before ? "neg" : after > before ? "pos" : ""}`, text: ` (${signed(after - before)})` })));
  };
  return h("div", { class: "table-scroll" },
    h("table", { class: "dmg-table" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: "" }),
        h("th", { scope: "col", text: "Danni base → finali" }),
        h("th", { scope: "col", text: "Cure" }),
        h("th", { scope: "col", text: "HP" }))),
      h("tbody", {}, row("me"), row("opp"))));
}

function resultPanel(r, { final = false } = {}) {
  const fresh = r !== animatedResult;
  animatedResult = r;
  const [cls, head] = outcomeHead(r);
  const speed = r.first === "me"
    ? "Sei stato più veloce: i tuoi anelli si applicano per primi"
    : `${state.oppName} è stato più veloce: i suoi anelli si applicano per primi`;
  const extras = [];
  for (const id of r.stolenMe) extras.push(h("li", { text: `${state.oppName} ti ha rubato ${RING_BY_ID[id].icon} ${shortName(id)}: resta spento fino al prossimo round.` }));
  for (const id of r.stolenOpp) extras.push(h("li", { text: `Hai rubato ${RING_BY_ID[id].icon} ${shortName(id)} a ${state.oppName}: resta spento fino al prossimo round.` }));
  return h("section", { class: `card result ${cls}${r.roundEnded ? " round-ended" : ""}${fresh ? " pop" : ""}`, "aria-live": "polite", "aria-label": "Risultato della mano" },
    r.roundEnded ? h("h2", { class: `round-end-title ${r.roundWinner}`, text: roundEndText(r) }) : null,
    h("p", { class: "result-kicker", text: `Round ${r.roundNo} · Mano ${r.handInRound}${final ? " · ultima mano" : ""}` }),
    h("p", { class: "result-head", text: head }),
    h("div", { class: "result-moves" }, moveSide("me", r.me, r.ringsMe), h("span", { class: "result-vs", text: "vs" }), moveSide("opp", r.opp, r.ringsOpp)),
    h("p", { class: `speed-line ${r.first}`, text: speed }),
    h("details", { class: "log-details", open: state.ui.logOpen, ontoggle: (e) => { state.ui.logOpen = e.target.open; } },
      h("summary", {}, `Anelli in ordine di applicazione (${r.log.length})`),
      ringLogList(r),
      extras.length ? h("ul", { class: "steal-list" }, extras) : null),
    damageTable(r));
}

// ---------- round end, game screen ----------

const roundEndKey = (r) => `${gen}:${r.hand}`;

function showRoundEnd(m) {
  const r = m.lastResult;
  return !!r && r.roundEnded && !r.matchOver && (m.phase === "roll" || m.phase === "table")
    && state.roundAck !== roundEndKey(r);
}

function renderRoundEnd(m) {
  const r = m.lastResult;
  return [
    resultPanel(r),
    h("button", { class: "btn btn-big", type: "button", "data-k": "round-next", text: `Avanti: Round ${m.roundNo}`,
      onclick: () => { state.roundAck = roundEndKey(r); render(); } }),
    h("p", { class: "muted", text: "HP di nuovo a 20, nuovo d10 e nuovo tavolo: tutti gli anelli tornano attivi." }),
  ];
}

function exitBtn() {
  return h("button", { class: "btn btn-secondary btn-quiet", type: "button", text: "Esci", onclick: () => goHome() });
}

function renderGame() {
  const m = state.match;
  animatedEnd = null; // a match is in progress, so the next end screen is a new one (even after a rematch)
  const sel = syncSelection(m);
  if (showRoundEnd(m)) {
    return [scoreboard(m, "roundEnd"), hpPanel(m, true), ...renderRoundEnd(m), exitBtn()];
  }
  let body;
  if (m.phase === "deck") body = renderDeckPhase(m, sel);
  else if (m.phase === "roll" || m.phase === "table") body = m.phase === "roll" ? rollView(m).el : renderTablePhase(m, sel);
  else body = renderHandPhase(m, sel);
  return [
    scoreboard(m),
    m.phase === "hand" ? hpPanel(m) : null,
    ...[].concat(body),
    exitBtn(),
  ];
}

// ---------- match end ----------

function roundsList(m) {
  if (!m.rounds.length) return null;
  return h("ol", { class: "round-list", "aria-label": "Round giocati" },
    m.rounds.map((rd) => h("li", { class: "round-item" },
      h("span", { class: `pip ${rd.winner}`, "aria-hidden": "true", text: String(rd.roundNo) }),
      h("span", { class: "round-item-no", text: `Round ${rd.roundNo}` }),
      h("span", { class: "round-item-who", text: winnerShort(rd.winner) }),
      h("span", { class: "round-item-hp", text: `${rd.hpMe}–${rd.hpOpp} HP` }))));
}

function matchStats(m) {
  if (!m.history.length) return null;
  const count = (fn) => m.history.filter(fn).length;
  const ringsMe = m.history.reduce((n, x) => n + x.ringsMe.length, 0);
  const ringsOpp = m.history.reduce((n, x) => n + x.ringsOpp.length, 0);
  const items = [
    ["Mani giocate", String(m.history.length)],
    ["Mani vinte", `Tu ${count((x) => x.outcome === 1)} · ${state.oppName} ${count((x) => x.outcome === -1)} · pari ${count((x) => x.outcome === 0)}`],
    ["Più veloce", `Tu ${count((x) => x.first === "me")} · ${state.oppName} ${count((x) => x.first === "opp")}`],
    ["Anelli usati", `Tu ${ringsMe} · ${state.oppName} ${ringsOpp}`],
  ];
  return h("dl", { class: "stats" }, items.map(([k, v]) => h("div", { class: "stat" }, h("dt", { text: k }), h("dd", { text: v }))));
}

function renderEnd() {
  const m = state.match;
  const won = m.winner === "me";
  const endKey = m.lastResult ?? m;
  const freshEnd = endKey !== animatedEnd;
  animatedEnd = endKey;
  const headline = m.cheated ? "L'avversario ha barato: vinci a tavolino" : won ? "Hai vinto la partita!" : "Hai perso la partita";
  const how = (change) => (change ? "cambiando anelli" : "con gli stessi anelli");
  const canKeep = !!m.deck.me && !!m.deck.opp;
  const status = [];
  if (m.oppWantsRematch) status.push(h("p", { class: "rematch-opp", "aria-live": "polite", text: `${state.oppName} vuole la rivincita ${how(m.rematchChangeDeck.opp)}` }));
  if (m.iWantRematch) status.push(h("p", { class: "status waiting", text: `Hai chiesto la rivincita ${how(m.rematchChangeDeck.me)}. In attesa di ${state.oppName}…` }));
  return [
    h("section", { class: `card end ${won ? "win" : "lose"}${freshEnd ? " pop" : ""}` },
      h("p", { class: "end-emoji", text: m.cheated ? "🚩" : won ? "🏆" : "😔", "aria-hidden": "true" }),
      h("h2", { class: "end-title", text: headline }),
      h("p", { class: "bo3", text: "Round vinti" }),
      scoreLine(m),
      roundsList(m),
      matchStats(m)),
    h("section", { class: "card stack rematch" },
      h("h2", { text: "Rivincita" }),
      ...status,
      h("button", { class: "btn", type: "button", "data-k": "rematch-same", disabled: m.iWantRematch || !canKeep,
        text: "Rivincita con gli stessi anelli", onclick: () => rematch(false) }),
      h("button", { class: "btn btn-alt", type: "button", "data-k": "rematch-change", disabled: m.iWantRematch,
        text: "Rivincita cambiando anelli", onclick: () => rematch(true) }),
      h("p", { class: "muted", text: "Si riparte quando lo chiedete entrambi. Se uno dei due vuole cambiare, entrambi rifate la scelta degli anelli." })),
    m.lastResult ? hpPanel(m, true) : null,
    m.lastResult && !m.cheated ? resultPanel(m.lastResult, { final: true }) : null,
    deckView(m.deck.opp, `Anelli di ${state.oppName}`, "oppDeckOpen"),
    deckView(m.deck.me, "I tuoi anelli", "myDeckOpen"),
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

// ---------- rules drawer (outside #app, static content) ----------

function rulesContent() {
  const sec = (titleText, ...body) => h("section", { class: "rules-section" }, h("h3", { text: titleText }), ...body);
  const ul = (...items) => h("ul", {}, items.map((x) => h("li", {}, ...[].concat(x))));
  const b = (text) => h("strong", { text });
  return [
    sec("Com'è fatta una partita",
      ul(
        [b("Partita: "), `al meglio di 3 round. Vince chi ha almeno ${ROUNDS_TO_WIN} punti round e più dell'avversario. In caso di parità (2–2, 3–3…) si gioca un altro round, finché qualcuno non passa in vantaggio.`],
        [b("Round: "), `entrambi partono da ${MAX_HP} HP e si giocano mani finché almeno uno arriva a 0 HP. Chi resta in piedi prende 1 punto; se arrivate a 0 nella stessa mano (doppio KO) prendete 1 punto a testa.`],
        [b("Mano: "), "ognuno sceglie in segreto una mossa e gli anelli da mettere sulle dita. Sasso batte Forbice, Forbice batte Carta, Carta batte Sasso."])),
    sec("Danni",
      ul(
        `Chi perde la mano subisce i danni della mossa vincente: Sasso ${DAMAGE.sasso}, Carta ${DAMAGE.carta}, Forbice ${DAMAGE.forbice}.`,
        `Pareggio: ${dmgText(DRAW_DAMAGE)} a testa.`,
        `Gli HP restano tra 0 e ${MAX_HP}.`)),
    sec("Anelli",
      ul(
        [b("Mazzo: "), `prima della partita ognuno sceglie ${DECK_SIZE} dei ${RINGS.length} anelli. Potete scegliere anche gli stessi.`],
        [b("Tavolo: "), "a inizio round si tira un d10 condiviso (da 1 a 10). Ognuno mette in segreto sul tavolo esattamente quel numero di anelli del proprio mazzo; i tavoli si rivelano insieme e restano visibili."],
        [b("Dita: "), `in ogni mano metti anelli del tuo tavolo sulle dita distese della mossa: Sasso ${SLOTS.sasso}, Carta ${SLOTS.carta}, Forbice ${SLOTS.forbice}. Le dita si riempiono da sinistra a destra.`],
        [b("Ordine: "), "gli anelli di chi conferma per primo la mossa si applicano per primi, da sinistra a destra; poi quelli dell'altro. Chi ha creato la stanza fa da arbitro e registra chi è stato più veloce."],
        "Ogni anello cambia i danni nel momento in cui si applica, quindi l'ordine conta. I danni non scendono mai sotto 0.",
        [b("Ombra: "), "si controlla prima di tutto. Se il più veloce ha l'Ombra, annulla tutti gli anelli dell'altro (anche la sua Ombra); se ce l'ha solo il più lento, annulla quelli del più veloce."],
        [b("Fenice: "), "si controlla alla fine: se la mano ti porterebbe a 0 HP, resti a 1."],
        "Un anello usato (anche se annullato) o disattivato dal Ladro resta spento fino al prossimo round.")),
    sec(`I ${RINGS.length} anelli`,
      h("ul", { class: "rules-rings" }, RINGS.map((r) => h("li", { vars: { "--gem": r.gem } },
        gemDot(r),
        h("span", { class: "ring-icon", "aria-hidden": "true", text: r.icon }),
        h("span", {}, h("strong", { text: r.name }), h("span", { class: "ring-text", text: r.text })))))),
    sec("Rivincita",
      h("p", { text: "A fine partita scegli \"Rivincita con gli stessi anelli\" o \"Rivincita cambiando anelli\". Si riparte da 0–0 quando lo chiedete entrambi; se almeno uno vuole cambiare, entrambi rifate la scelta (il mazzo precedente è già selezionato)." })),
    sec("Busta chiusa",
      h("p", { text: "Ogni scelta segreta parte prima in busta chiusa (un'impronta crittografica) e si apre solo quando avete scelto entrambi: nessuno può sbirciare, e chi bara perde a tavolino." })),
  ];
}

function setupRules() {
  const toggle = h("button", {
    class: "rules-toggle", type: "button", text: "?",
    "aria-label": "Regole", "aria-expanded": "false", "aria-controls": "rules-panel",
  });
  const close = h("button", { class: "rules-close", type: "button", text: "×", "aria-label": "Chiudi le regole" });
  const backdrop = h("div", { class: "rules-backdrop", hidden: true });
  const panel = h("aside", { id: "rules-panel", class: "rules-panel", role: "dialog", "aria-labelledby": "rules-title", hidden: true },
    h("div", { class: "rules-header" }, h("h2", { id: "rules-title", text: "Regole" }), close),
    h("div", { class: "rules-body" }, rulesContent()));
  const set = (open, { focus = true, save = true } = {}) => {
    panel.hidden = !open;
    backdrop.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-open", open);
    if (save) {
      try { localStorage.setItem(RULES_KEY, open ? "1" : "0"); } catch {}
    }
    if (focus) (open ? close : toggle).focus();
  };
  toggle.addEventListener("click", () => set(panel.hidden));
  close.addEventListener("click", () => set(false));
  backdrop.addEventListener("click", () => set(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) set(false);
  });
  document.body.append(backdrop, panel, toggle);
  let saved = false;
  try { saved = localStorage.getItem(RULES_KEY) === "1"; } catch {}
  if (saved) set(true, { focus: false, save: false });
}

// ---------- boot ----------

setupRules();
const urlCode = readRoomFromUrl();
if (urlCode) join(urlCode);
else render();
