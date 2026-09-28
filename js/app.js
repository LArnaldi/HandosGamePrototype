// app.js: UI rendering and glue between game logic (game.js) and networking (net.js).
// Screens: home, lobby (host waiting), joining (guest), game, disconnected. The game screen follows
// the Match phases (see game.js): deck builder -> d10 roll -> table pick -> hands (move + rings on
// fingers) -> round-end panel -> ... -> match end with rematch. A rules drawer ("?") lives outside
// #app and is available on every screen.
// All DOM is built with textContent; names and other network data are never parsed as HTML.

import { Match, MOVES, EMOJI, LABEL, MAX_HP, DAMAGE, DRAW_DAMAGE, ROUNDS_TO_WIN } from "./game.js";
import { RINGS, RING_BY_ID, SLOTS, DECK_SIZE } from "./rings.js";
import { hostRoom, joinRoom, buildInviteLink, readRoomFromUrl, normalizeCode } from "./net.js";
import { sfx, unlockAudio, isMuted, setMuted } from "./audio.js";

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
  ui: { logOpen: true, myDeckOpen: false },
  roundAck: null, // key of the round-ending hand whose panel the player dismissed
};

let net = null; // current net handle
let session = 0; // bumps on every new/closed session so stale callbacks are ignored
let queue = Promise.resolve();
let gen = 0; // bumps for every new match (including rematches), to key one-shot animations
let lastPhase = null;
let animatedEnd = null; // match end (keyed by final result) whose animation already played
let hpAnim = null; // {result, start}: damage animation of the last resolved hand (plays once)
let rollAnim = null; // {key, start}: d10 roll animation of the current round (plays once)
let rollTimer = null; // re-render when the d10 roll settles
let dieTicker = null; // random faces while the die rolls
const rollSfx = { rolling: null, settled: null }; // round keys whose d10 sounds already played

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
  root.classList.toggle("wide", state.screen === "game");
  root.replaceChildren(...[].concat(view()).filter(Boolean));
  if (focusKey) {
    const el = [...root.querySelectorAll("[data-k]")].find((x) => x.dataset.k === focusKey);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }
  refreshTip();
  soundTransitions(m);
  syncBreakdown(m);
}

// Wide (landscape desktop) layout of the hand phase; re-render when crossing the breakpoint.
let wideMq = null;
try { wideMq = matchMedia("(min-width: 1000px)"); } catch {}
const isWide = () => !!wideMq?.matches;
wideMq?.addEventListener?.("change", () => render());

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
  const bars = hpBars(m, showKo);
  return h("div", { class: "hp-panel" }, bars.me, bars.opp);
}

function hpBars(m, showKo = false) {
  const r = m.lastResult;
  if (r && hpAnim?.result !== r) {
    hpAnim = { result: r, start: reducedMotion() ? -Infinity : performance.now() };
  }
  const elapsed = r ? performance.now() - hpAnim.start : Infinity;
  const fresh = !!r && (showKo || (r.roundNo === m.roundNo && m.phase === "hand"));
  const hpMe = showKo && r ? r.hpMe : m.hp.me;
  const hpOpp = showKo && r ? r.hpOpp : m.hp.opp;
  return {
    me: hpBar("me", "I tuoi HP", [h("span", { class: "hp-tag", text: "Tu" }), state.name],
      hpMe, fresh ? r.hpBeforeMe : hpMe, elapsed),
    opp: hpBar("opp", `HP di ${state.oppName}`, [state.oppName],
      hpOpp, fresh ? r.hpBeforeOpp : hpOpp, elapsed),
  };
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

// The physical ring: a metal band lying on the table (the hole shows the wood and the icon),
// with the gem mounted on top in its setting. Purely decorative.
function ringArt(ring) {
  return h("span", { class: "rt-ring", "aria-hidden": "true", vars: { "--gem": ring.gem } },
    h("span", { class: "rt-band" }),
    h("span", { class: "rt-icon", text: ring.icon }),
    h("span", { class: "rt-gem" }));
}

// Deck builder / table picker card: the ring on a wooden coaster, full name, rules text; a toggle.
function ringCard(id, { selected, disabled, onclick, key }) {
  const ring = RING_BY_ID[id];
  return h("button", {
    class: `ring-card${selected ? " is-selected" : ""}`,
    type: "button",
    "aria-pressed": selected ? "true" : "false",
    disabled: !!disabled,
    "data-k": key,
    "data-sfx": selected ? "ringOff" : "ringOn",
    vars: { "--gem": ring.gem },
    onclick,
  },
    h("span", { class: "rc-plate" }, ringArt(ring)),
    h("span", { class: "rc-body" },
      h("span", { class: "ring-name", text: ring.name }),
      h("span", { class: "ring-text", text: ring.text })),
    h("span", { class: "ring-check", "aria-hidden": "true", text: selected ? "✓" : "" }));
}

// Table ring: a physical ring lying on the wooden table, short name below.
// status: active | placed | used | stolen. `lines`: state lines for the tooltip (and the label).
// Interactive tokens use aria-disabled (not `disabled`) so hover and focus still show the tooltip.
function ringToken(id, { status = "active", badge, onclick, disabled, key, lines = [], sound } = {}) {
  const ring = RING_BY_ID[id];
  const tag = onclick ? "button" : "div";
  const label = [`${ring.name}: ${ring.text}`, ...lines].join(". ");
  return h(tag, {
    class: `ring-token is-${status}`,
    type: onclick ? "button" : null,
    "aria-disabled": onclick && disabled ? "true" : null,
    tabindex: onclick ? null : "0",
    role: onclick ? null : "img",
    "data-k": key,
    "data-sfx": sound,
    "data-ring": id,
    "data-tip": lines.join("\n"),
    "aria-label": label,
    onclick: onclick ? (e) => { if (!disabled) onclick(e); } : null,
  },
    ringArt(ring),
    h("span", { class: "rt-name", "aria-hidden": "true", text: shortName(id) }),
    status === "stolen" ? h("span", { class: "rt-seal", "aria-hidden": "true", text: "Rubato" }) : null,
    badge ? h("span", { class: "rt-badge", "aria-hidden": "true", text: badge }) : null);
}

const ringTable = (ids, keyPrefix) =>
  h("div", { class: "ring-table" }, ids.map((id) => ringToken(id, { key: `${keyPrefix}-${id}` })));

const STATE_LINE = {
  used: "Usato in questo round",
  stolen: "Rubato dal Ladro: spento fino al prossimo round",
};

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
    ringTable(ids, `dv-${uiKey}`));
}

// ---------- deck builder ----------

function renderDeckPhase(m, sel) {
  if (m.submitted) {
    return h("section", { class: "card stack phase-deck" },
      h("h2", { text: "Anelli scelti" }),
      ringTable(m.deck.me, "mydeck"),
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
      h("button", { class: "btn btn-small", type: "button", text: "Conferma", "data-k": "deck-confirm", "data-sfx": "confirm",
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
  const rk = `${gen}:${m.roundNo}`;
  if (rollSfx.rolling !== rk) { rollSfx.rolling = rk; sfx("diceRoll"); }
  if (m.phase === "roll") {
    return { rolling: true, el: h("section", { class: "card roll", "aria-live": "polite" },
      die(null, true),
      h("p", { class: "roll-text", text: "Tiro del d10 a due mani…" })) };
  }
  const key = `${gen}:${m.roundNo}`;
  if (rollAnim?.key !== key) rollAnim = { key, start: reducedMotion() ? -Infinity : performance.now() };
  const left = ROLL_MS - (performance.now() - rollAnim.start);
  if (left <= 0 && rollSfx.settled !== key) { rollSfx.settled = key; sfx("diceSettle"); }
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
      ringTable(m.table.me, "mytable"),
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
        h("button", { class: "btn btn-small", type: "button", text: "Conferma", "data-k": "table-confirm", "data-sfx": "confirm",
          disabled: n !== m.d10, onclick: confirmTable })));
  }
  return [roll.el, pick];
}

// ---------- hand phase ----------

const FINGER_HEIGHTS = { 5: [58, 84, 100, 88, 66], 2: [96, 100] }; // % of the finger area, left to right

function handVisual(move, placed, editable, sel) {
  const slots = SLOTS[move];
  if (!slots) {
    return h("div", { class: "hand-area fist" },
      h("span", { class: "fist-emoji", "aria-hidden": "true", text: EMOJI.sasso }),
      h("p", { class: "muted", text: `Sasso: nessun dito disteso, niente anelli. Colpisce forte (${dmgText(DAMAGE.sasso)}).` }));
  }
  const heights = FINGER_HEIGHTS[slots] ?? Array(slots).fill(100);
  const fingers = [];
  for (let i = 0; i < slots; i++) {
    const id = placed[i];
    const ring = id ? RING_BY_ID[id] : null;
    const label = id ? `Dito ${i + 1}: ${ring.name}: ${ring.text}${editable ? " (tocca per togliere)" : ""}` : `Dito ${i + 1}: libero`;
    const tip = id ? { "data-ring": id, "data-tip": [`Sul dito ${i + 1}`, editable ? "Tocca per toglierlo" : null].filter(Boolean).join("\n") } : {};
    // A filled finger wears the same ring as on the table: band around the finger, gem on top.
    const content = id
      ? [h("span", { class: "slot-band", "aria-hidden": "true" }, h("span", { class: "slot-icon", text: ring.icon })),
        h("span", { class: "rt-gem slot-gem", "aria-hidden": "true" }),
        h("span", { class: "slot-name", "aria-hidden": "true", text: shortName(id) })]
      : [h("span", { class: "slot-num", "aria-hidden": "true", text: String(i + 1) })];
    const slot = editable && id
      ? h("button", { class: "finger-slot filled", type: "button", "aria-label": label, "data-k": `finger-${i}`, "data-sfx": "ringOff", ...tip,
        vars: { "--gem": ring.gem },
        onclick: () => { sel.rings.splice(i, 1); render(); } }, ...content)
      : h("span", { class: `finger-slot${id ? " filled" : ""}`, role: "img", "aria-label": label,
        tabindex: id ? "0" : null, "data-k": id ? `fingerv-${i}` : null, ...tip,
        vars: id ? { "--gem": ring.gem } : null }, ...content);
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

function oppTable(m, stolen, boxed = false) {
  return h("section", { class: `table-block opp${boxed ? " boxed" : ""}`, "aria-label": `Tavolo di ${state.oppName}` },
    h("div", { class: "table-head" },
      h("h3", { class: "table-title", text: `Tavolo di ${state.oppName}` }),
      h("span", { class: `opp-status${m.oppSubmitted ? " done" : ""}`, "aria-live": "polite",
        text: m.oppSubmitted ? `✓ ${state.oppName} ha confermato` : "sta scegliendo…" })),
    h("div", { class: "ring-table" }, m.table.opp.map((id) => {
      const status = tableStatus(m, "opp", id, stolen);
      return ringToken(id, { status, key: `opp-${id}`, lines: [STATE_LINE[status] ?? "Attivo in questo round"] });
    })));
}

function myTable(m, stolen, placed, editable, slots, sel, boxed = false) {
  return h("section", { class: `table-block me${boxed ? " boxed" : ""}`, "aria-label": "Il tuo tavolo" },
    h("div", { class: "table-head" },
      h("h3", { class: "table-title", text: "Il tuo tavolo" }),
      h("span", { class: "muted", text: `${m.active.me.length}/${m.table.me.length} attivi` })),
    h("div", { class: "ring-table" }, m.table.me.map((id) => {
      let status = tableStatus(m, "me", id, stolen);
      const finger = placed.indexOf(id);
      if (status === "active" && finger >= 0) status = "placed";
      const canTap = editable && (status === "placed" || (status === "active" && placed.length < slots));
      const lines = status === "placed" ? [`Sul dito ${finger + 1}`, editable ? "Tocca per toglierlo" : null]
        : status !== "active" ? [STATE_LINE[status]]
        : [!editable ? (m.submitted ? "Attivo in questo round" : "Scegli prima una mossa (Sasso non ha dita)")
          : canTap ? "Tocca per metterlo sul prossimo dito libero" : "Dita piene: togline uno per metterlo"];
      return ringToken(id, {
        status,
        badge: status === "placed" ? `dito ${finger + 1}` : undefined,
        key: `mine-${id}`,
        lines: lines.filter(Boolean),
        onclick: editable ? () => {
          if (status === "placed") sel.rings.splice(finger, 1);
          else sel.rings.push(id);
          render();
        } : null,
        disabled: !canTap,
        sound: status === "placed" ? "ringOff" : "ringOn",
      });
    })),
    h("p", { class: "muted tip-hint", text: "Passa sopra un anello (o tienilo premuto) per leggerne l'effetto." }));
}

function renderHandPhase(m, sel, wide) {
  const done = m.submitted;
  const move = done ? m.myMove : sel.move;
  const placed = done ? m.myRings : sel.rings;
  const slots = move ? SLOTS[move] : 0;
  const stolen = stolenThisRound(m);

  const moves = h("div", { class: "moves", role: "group", "aria-label": "Mossa" },
    MOVES.map((mv) => h("button", {
      class: `move-btn${move === mv ? " chosen" : ""}`,
      type: "button",
      disabled: done,
      "aria-pressed": move === mv ? "true" : "false",
      "data-k": `move-${mv}`,
      "data-sfx": "select",
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
      h("button", { class: "btn btn-big", type: "button", text: "Conferma mossa", "data-k": "hand-confirm", "data-sfx": "confirm",
        disabled: !move, onclick: confirmHand }),
      h("p", { class: "speed-hint", text: m.oppSubmitted
        ? `${state.oppName} ha già confermato: i suoi anelli si applicheranno prima dei tuoi.`
        : "La velocità conta: chi conferma prima applica prima i suoi anelli." }));

  const playTitle = h("h2", { class: "play-title", text: done ? "La tua mossa" : "Scegli la mossa" });
  const hand = move ? handVisual(move, placed, !done, sel)
    : h("p", { class: "muted", text: `Chi perde subisce i danni della mossa vincente. Pareggio: ${dmgText(DRAW_DAMAGE)} a testa.` });
  const mine = myTable(m, stolen, placed, !done && !!move, slots, sel, wide);
  const opp = oppTable(m, stolen, wide);

  if (!wide) {
    return [
      scoreboard(m),
      hpPanel(m),
      opp,
      h("section", { class: "card stack play" }, playTitle, moves, hand, mine, confirmArea),
    ];
  }
  // Wide screens: a tavern table in three columns (you | the play | the opponent).
  const hp = hpBars(m);
  return [h("div", { class: "hand-layout" },
    h("div", { class: "col col-me" }, h("div", { class: "hp-panel" }, hp.me), mine),
    h("div", { class: "col col-center" },
      scoreboard(m),
      h("section", { class: "card stack play" }, playTitle, moves, hand, confirmArea)),
    h("div", { class: "col col-opp" }, h("div", { class: "hp-panel" }, hp.opp), opp))];
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

function stealList(r) {
  const extras = [];
  for (const id of r.stolenMe) extras.push(h("li", { text: `${state.oppName} ti ha rubato ${RING_BY_ID[id].icon} ${shortName(id)}: resta spento fino al prossimo round.` }));
  for (const id of r.stolenOpp) extras.push(h("li", { text: `Hai rubato ${RING_BY_ID[id].icon} ${shortName(id)} a ${state.oppName}: resta spento fino al prossimo round.` }));
  return extras.length ? h("ul", { class: "steal-list" }, extras) : null;
}

function resultPanel(r, { final = false } = {}) {
  const [cls, head] = outcomeHead(r);
  const speed = r.first === "me"
    ? "Sei stato più veloce: i tuoi anelli si applicano per primi"
    : `${state.oppName} è stato più veloce: i suoi anelli si applicano per primi`;
  return h("section", { class: `card result ${cls}${r.roundEnded ? " round-ended" : ""}`, "aria-label": "Ultima mano" },
    r.roundEnded ? h("h2", { class: `round-end-title ${r.roundWinner}`, text: roundEndText(r) }) : null,
    h("p", { class: "result-kicker", text: `Round ${r.roundNo} · Mano ${r.handInRound}${final ? " · ultima mano" : ""}` }),
    h("p", { class: "result-head", text: head }),
    h("div", { class: "result-moves" }, moveSide("me", r.me, r.ringsMe), h("span", { class: "result-vs", text: "vs" }), moveSide("opp", r.opp, r.ringsOpp)),
    h("p", { class: `speed-line ${r.first}`, text: speed }),
    h("details", { class: "log-details", open: state.ui.logOpen, ontoggle: (e) => { state.ui.logOpen = e.target.open; } },
      h("summary", {}, `Anelli in ordine di applicazione (${r.log.length})`),
      ringLogList(r),
      stealList(r)),
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
    h("section", { class: `card result round-ended ${outcomeHead(r)[0]}` },
      h("h2", { class: `round-end-title ${r.roundWinner}`, text: roundEndText(r) })),
    h("button", { class: "btn btn-big", type: "button", "data-k": "round-next", text: `Avanti: Round ${m.roundNo}`,
      onclick: () => { state.roundAck = roundEndKey(r); render(); } }),
    h("p", { class: "muted", text: `HP di nuovo a ${MAX_HP}, nuovo d10 e nuovo tavolo: tutti gli anelli tornano attivi.` }),
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
  else return [...renderHandPhase(m, sel, isWide()), exitBtn()];
  return [scoreboard(m), ...[].concat(body), exitBtn()];
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

// ---------- sounds tied to state transitions ----------

const snd = { screen: null, err: "", key: null, oppSub: false, phase: null };

function soundTransitions(m) {
  const scr = state.screen;
  if (snd.screen && scr !== snd.screen) {
    if (scr === "game" && (snd.screen === "lobby" || snd.screen === "joining")) sfx("joined");
    else if (scr === "disconnected") sfx("disconnect");
  }
  if (state.error && state.error !== snd.err) sfx("error");
  snd.screen = scr;
  snd.err = state.error;
  if (scr !== "game" || !m) {
    snd.key = snd.phase = null;
    return;
  }
  const key = `${gen}:${m.phase}:${m.roundNo}:${m.hand}`;
  if (key === snd.key && m.oppSubmitted && !snd.oppSub) sfx("oppConfirm");
  if (m.phase === "hand" && snd.phase === "table") sfx("tableReveal");
  snd.key = key;
  snd.oppSub = !!m.oppSubmitted;
  snd.phase = m.phase;
}

// ---------- hand breakdown overlay (local to this client, outside #app) ----------
// After a hand resolves, a modal replays it step by step in application order: the clash with the
// base damage, then each ring (with its delta), then the resulting HP. Deltas are read from the
// engine's log notes (they carry the numbers); the last step always shows the engine's final values.
// The Match keeps receiving messages meanwhile: the overlay only covers the board.

const STEP_MS = 650;
const CLASH_MS = 950;
const bd = { el: null, result: null, match: null, steps: null, i: 0, timer: null, seen: null, prev: null };
const OTHER_SIDE = { me: "opp", opp: "me" };
const lastNum = (s) => { const x = String(s).match(/(\d+)(?!.*\d)/); return x ? Number(x[1]) : 0; };

// Applies one log entry to the running {dmg, heal}; returns the chips to show and the step sound.
function applyLogEntry(e, cur) {
  const self = e.owner;
  const other = OTHER_SIDE[self];
  const note = e.note || "";
  const chips = [];
  const add = (side, n) => {
    cur.dmg[side] += n;
    chips.push({ text: `+${n} ⚔`, kind: side === other ? "bonus" : "hurt", target: side });
  };
  const shield = (to) => {
    const n = cur.dmg[self] - to;
    cur.dmg[self] = to;
    chips.push({ text: n > 0 ? `−${n} 🛡` : "0 🛡", kind: "shield", target: self });
  };
  if (e.cancelled) chips.push({ text: "annullato", kind: "cancel", target: self });
  else if (note === "nessun effetto") chips.push({ text: "nessun effetto", kind: "none", target: self });
  else {
    switch (e.id) {
      case "ferro": shield(Math.max(0, cur.dmg[self] - lastNum(note))); break;
      case "nebbia": shield(lastNum(note)); break;
      case "pace": case "montagna": shield(0); break;
      case "vampiro": case "guaritore": {
        const n = lastNum(note);
        cur.heal[self] += n;
        chips.push({ text: `+${n} ❤`, kind: "heal", target: self });
        break;
      }
      case "doppio-taglio": {
        const side = /subiti/.test(note) ? self : other;
        cur.dmg[side] = lastNum(note);
        chips.push({ text: "×2 ⚔", kind: side === other ? "bonus" : "hurt", target: side });
        break;
      }
      case "tuono": add(/subito/.test(note) ? self : other, lastNum(note)); break;
      case "sacrificio": add(self, 2); if (/\+4 danni$/.test(note)) add(other, 4); break;
      case "sorte": {
        const n = lastNum(note);
        chips.push({ text: `🎲 ${n}`, kind: "none", target: self });
        add(other, n);
        break;
      }
      case "ladro": chips.push({ text: "rubato", kind: "steal", target: other }); break;
      case "fenice": chips.push({ text: "resti a 1 HP", kind: "heal", target: self }); break;
      case "ombra": chips.push({ text: "anelli annullati", kind: "cancel-other", target: other }); break;
      default: add(other, lastNum(note));
    }
  }
  const main = chips.find((c) => c.kind !== "none") ?? chips[0];
  const sound = { bonus: "bonus", hurt: "hurtSelf", shield: "shield", heal: "heal", cancel: "cancel", "cancel-other": "cancel", steal: "steal" }[main.kind] ?? "none";
  return { chips, sound };
}

function buildSteps(r) {
  const cur = { dmg: { me: r.baseDmgMe, opp: r.baseDmgOpp }, heal: { me: 0, opp: 0 } };
  const snap = () => ({ dmg: { ...cur.dmg }, heal: { ...cur.heal } });
  const steps = [{ kind: "clash", ...snap() }];
  r.log.forEach((e, idx) => {
    const eff = applyLogEntry(e, cur);
    steps.push({ kind: "ring", entry: e, idx, ...eff, ...snap() });
  });
  steps.push({ kind: "final", dmg: { me: r.dmgMe, opp: r.dmgOpp }, heal: { me: r.healMe, opp: r.healOpp } });
  return steps;
}

const hpBefore = (r, side) => (side === "me" ? r.hpBeforeMe : r.hpBeforeOpp);
function hpAt(r, st, side) {
  if (st.kind === "final") return side === "me" ? r.hpMe : r.hpOpp;
  return Math.min(MAX_HP, Math.max(0, hpBefore(r, side) - st.dmg[side] + st.heal[side]));
}

function syncBreakdown(m) {
  if (state.screen !== "game" || !m) return closeBreakdown();
  const r = m.lastResult;
  if (r && r !== bd.seen) {
    bd.seen = r;
    if (!m.cheated) openBreakdown(m, r);
  } else if (bd.result?.roundEnded && state.roundAck === roundEndKey(bd.result)) {
    closeBreakdown();
  }
}

function openBreakdown(m, r) {
  closeBreakdown();
  bd.result = r;
  bd.match = m;
  bd.steps = buildSteps(r);
  bd.prev = null;
  bd.el = h("div", { class: "bd-overlay", role: "dialog", "aria-modal": "true", "aria-label": `Risultato della mano ${r.handInRound}` });
  document.body.append(bd.el);
  showStep(reducedMotion() ? bd.steps.length - 1 : 0);
}

function closeBreakdown() {
  clearTimeout(bd.timer);
  bd.timer = null;
  bd.el?.remove();
  bd.el = bd.result = bd.match = bd.steps = bd.prev = null;
}

function proceedBreakdown() {
  const r = bd.result;
  if (r?.roundEnded) state.roundAck = roundEndKey(r);
  closeBreakdown();
  render();
}

function showStep(i) {
  clearTimeout(bd.timer);
  bd.timer = null;
  bd.i = i;
  const last = i === bd.steps.length - 1;
  paintBreakdown();
  stepSound(bd.steps[i]);
  if (!last) bd.timer = setTimeout(() => showStep(i + 1), i === 0 ? CLASH_MS : STEP_MS);
}

function stepSound(st) {
  const r = bd.result;
  if (st.kind === "clash") return sfx("handReveal");
  if (st.kind === "ring") return sfx(st.sound);
  const dMe = r.hpMe - r.hpBeforeMe;
  const dOpp = r.hpOpp - r.hpBeforeOpp;
  if (r.roundEnded) sfx(r.roundWinner === "both" ? "doubleKo" : "ko");
  else if (dMe < 0 || dOpp < 0) sfx("hit");
  else if (dMe > 0 || dOpp > 0) sfx("heal");
  else sfx("none");
  const w = bd.match?.winner;
  const later = r.matchOver ? (w === "me" ? "matchWon" : "matchLost")
    : r.roundWinner === "me" ? "roundWon" : r.roundWinner === "opp" ? "roundLost" : null;
  if (later) setTimeout(() => sfx(later), 550);
}

function animateIn(el, keyframes, ms = 380) {
  if (!reducedMotion() && typeof el.animate === "function") el.animate(keyframes, { duration: ms, easing: "cubic-bezier(.2,1.4,.4,1)" });
}
const POP = [{ transform: "scale(0.4)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.6 }, { transform: "scale(1)", opacity: 1 }];

function chipEl(c, big) {
  const target = c.kind === "none" || c.kind === "cancel" ? null
    : c.kind === "heal" ? `cura: ${who(c.target)}` : c.kind === "steal" ? `a ${who(c.target)}`
    : c.kind === "cancel-other" ? `di ${who(c.target)}` : `danni a ${who(c.target)}`;
  return h("span", { class: `bd-chip ${c.kind}${big ? " big" : ""}` },
    h("span", { class: "bd-chip-text", text: c.text }),
    big && target ? h("span", { class: "bd-chip-sub", text: target }) : null);
}

function bdSide(side, st, r) {
  const move = side === "me" ? r.me : r.opp;
  const prev = bd.prev;
  const hp = hpAt(r, st, side);
  const prevHp = prev ? prev.hp[side] : hpBefore(r, side);
  const dmgEl = h("dd", { text: String(st.dmg[side]) });
  const healEl = h("dd", { text: st.heal[side] ? `+${st.heal[side]}` : "0" });
  const pct = (hp / MAX_HP) * 100;
  const level = pct > 50 ? "high" : pct > 25 ? "mid" : "low";
  const fill = h("div", { class: `hp-fill ${level}` });
  fill.style.width = `${pct}%`;
  const el = h("div", { class: `bd-side ${side}` },
    h("p", { class: "bd-who" },
      h("span", { class: "bd-name", text: side === "me" ? `Tu · ${state.name}` : state.oppName }),
      r.first === side ? h("span", { class: "bd-fast", text: "più veloce" }) : null),
    h("span", { class: "bd-emoji", "aria-hidden": "true", text: EMOJI[move] }),
    h("p", { class: "bd-move", text: LABEL[move] }),
    h("dl", { class: "bd-counters" },
      h("div", { class: "bd-count dmg" }, h("dt", { text: "Danni" }), dmgEl),
      h("div", { class: "bd-count heal" }, h("dt", { text: "Cure" }), healEl)),
    h("div", { class: "bd-vial" },
      h("div", { class: "hp-track", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(MAX_HP),
        "aria-valuenow": String(hp), "aria-label": `HP di ${who(side)}` }, fill),
      h("p", { class: "bd-hp" }, `HP ${hpBefore(r, side)} → `, h("strong", { text: String(hp) }))));
  if (prev) {
    if (prev.dmg[side] !== st.dmg[side]) animateIn(dmgEl, POP), dmgEl.classList.add("changed");
    if (prev.heal[side] !== st.heal[side]) animateIn(healEl, POP), healEl.classList.add("changed");
  }
  if (prevHp !== hp && !reducedMotion() && typeof fill.animate === "function") {
    fill.animate([{ width: `${(prevHp / MAX_HP) * 100}%` }, { width: `${pct}%` }], { duration: 450, easing: "ease-out" });
    if (hp < prevHp) el.animate(SHAKE, { duration: 380 });
  }
  return el;
}

function bdCenter(st, r) {
  if (st.kind === "clash") {
    const [cls, head] = outcomeHead(r);
    const why = r.outcome === 0 ? `Pareggio: ${dmgText(DRAW_DAMAGE)} a testa`
      : r.outcome === 1 ? `${LABEL[r.me]} batte ${LABEL[r.opp]}: ${dmgText(DAMAGE[r.me])} a ${state.oppName}`
      : `${LABEL[r.opp]} batte ${LABEL[r.me]}: ${dmgText(DAMAGE[r.opp])} a te`;
    const el = h("div", { class: `bd-center clash ${cls}` },
      h("span", { class: "bd-vs", "aria-hidden": "true", text: "vs" }),
      h("p", { class: "bd-head", text: head }),
      h("p", { class: "bd-why", text: why }),
      h("p", { class: "muted", text: r.log.length ? `Ora ${plural(r.log.length, "anello", "anelli")} in ordine di applicazione…` : "Nessun anello in gioco." }));
    animateIn(el, POP, 450);
    return el;
  }
  if (st.kind === "ring") {
    const e = st.entry;
    const ring = RING_BY_ID[e.id];
    const art = h("span", { class: "bd-ring" }, ringArt(ring));
    const el = h("div", { class: `bd-center ring ${e.owner}${e.cancelled ? " cancelled" : ""}` },
      h("p", { class: "bd-step", text: `Anello ${st.idx + 1} di ${r.log.length}` }),
      art,
      h("p", { class: "bd-ring-name", text: ring.name }),
      h("p", { class: `bd-owner ${e.owner}` }, e.owner === "me" ? "Tuo" : `di ${state.oppName}`,
        r.first === e.owner ? h("span", { class: "bd-fast", text: "più veloce" }) : null),
      h("div", { class: "bd-chips" }, st.chips.map((c) => chipEl(c, true))),
      e.note !== "nessun effetto" ? h("p", { class: "bd-note", text: e.cancelled ? `annullato: ${e.note}` : e.note }) : null);
    animateIn(art, [{ transform: "translateY(-1.5rem) rotate(-20deg) scale(0.6)", opacity: 0 }, { transform: "none", opacity: 1 }], 420);
    for (const c of el.querySelectorAll(".bd-chip")) animateIn(c, POP, 450);
    return el;
  }
  const [cls, head] = outcomeHead(r);
  const extra = [];
  for (const id of r.stolenMe) extra.push(h("li", { text: `${state.oppName} ti ha rubato ${RING_BY_ID[id].icon} ${shortName(id)}` }));
  for (const id of r.stolenOpp) extra.push(h("li", { text: `Hai rubato ${RING_BY_ID[id].icon} ${shortName(id)} a ${state.oppName}` }));
  const el = h("div", { class: `bd-center final ${cls}` },
    r.roundEnded ? h("p", { class: `round-end-title ${r.roundWinner}`, text: roundEndText(r) }) : h("p", { class: "bd-head", text: head }),
    h("p", { class: "bd-why" }, `Danni finali: Tu ${r.dmgMe} · ${state.oppName} ${r.dmgOpp}`),
    r.healMe || r.healOpp ? h("p", { class: "bd-why", text: `Cure: Tu +${r.healMe} · ${state.oppName} +${r.healOpp}` }) : null,
    extra.length ? h("ul", { class: "steal-list" }, extra) : null);
  animateIn(el, POP, 450);
  return el;
}

function bdTrack(r) {
  if (!r.log.length) return null;
  const upto = bd.steps[bd.i].kind === "final" ? r.log.length : bd.steps[bd.i].kind === "ring" ? bd.steps[bd.i].idx : -1;
  return h("ol", { class: "bd-track", "aria-label": "Anelli in ordine di applicazione" }, r.log.map((e, idx) => {
    const st = bd.steps[idx + 1];
    const status = idx < upto ? "done" : idx === upto ? "current" : "pending";
    return h("li", { class: `bd-item ${e.owner} is-${status}${e.cancelled ? " cancelled" : ""}`,
      "data-ring": e.id, "data-tip": `${e.owner === "me" ? "Tuo" : `Di ${state.oppName}`}\n${e.cancelled ? `annullato: ${e.note}` : e.note}`,
      tabindex: "0", "aria-label": `${idx + 1}. ${RING_BY_ID[e.id].name} (${who(e.owner)}): ${e.note}` },
      h("span", { class: "bd-item-no", "aria-hidden": "true", text: String(idx + 1) }),
      ringArt(RING_BY_ID[e.id]),
      h("span", { class: "bd-item-name", "aria-hidden": "true", text: shortName(e.id) }),
      h("span", { class: `owner-tag ${e.owner}`, "aria-hidden": "true", text: e.owner === "me" ? "Tu" : state.oppName }),
      status !== "pending" ? h("span", { class: "bd-item-chips", "aria-hidden": "true" }, st.chips.map((c) => chipEl(c, false))) : null);
  }));
}

function paintBreakdown() {
  const r = bd.result;
  const st = bd.steps[bd.i];
  const last = bd.i === bd.steps.length - 1;
  const nextText = r.matchOver ? "Vai al resoconto" : r.roundEnded ? `Avanti: Round ${r.roundNo + 1}` : "Prossima mano";
  const btn = last
    ? h("button", { class: "btn btn-big", type: "button", "data-sfx": "confirm", text: nextText, onclick: proceedBreakdown })
    : h("button", { class: "btn btn-secondary btn-small", type: "button", text: "Salta", onclick: () => showStep(bd.steps.length - 1) });
  const panel = h("section", { class: `card bd-panel ${outcomeHead(r)[0]}` },
    h("p", { class: "result-kicker", text: `Round ${r.roundNo} · Mano ${r.handInRound}` }),
    h("div", { class: "bd-arena" }, bdSide("me", st, r), h("div", { class: "bd-mid", "aria-live": "polite" }, bdCenter(st, r)), bdSide("opp", st, r)),
    bdTrack(r),
    h("div", { class: "bd-foot" }, btn));
  bd.el.replaceChildren(panel);
  bd.prev = { dmg: { ...st.dmg }, heal: { ...st.heal }, hp: { me: hpAt(r, st, "me"), opp: hpAt(r, st, "opp") } };
  btn.focus({ preventScroll: true });
}

// ---------- mute toggle (outside #app, next to the rules button) ----------

function setupMute() {
  const b = h("button", { class: "mute-toggle", type: "button", "data-sfx": "none" });
  const paint = () => {
    b.textContent = isMuted() ? "🔇" : "🔊";
    b.setAttribute("aria-label", isMuted() ? "Attiva i suoni" : "Disattiva i suoni");
    b.setAttribute("aria-pressed", isMuted() ? "true" : "false");
    b.title = isMuted() ? "Suoni disattivati" : "Suoni attivi";
  };
  b.addEventListener("click", () => { setMuted(!isMuted()); paint(); if (!isMuted()) sfx("click"); });
  paint();
  document.body.append(b);
  // Audio starts on the first gesture (autoplay policy); every button gets its sound.
  for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, unlockAudio, { capture: true, passive: true });
  document.addEventListener("click", (e) => {
    unlockAudio();
    const el = e.target instanceof Element ? e.target.closest("button, summary") : null;
    if (!el || el.disabled || el === b) return;
    sfx(el.getAttribute("aria-disabled") === "true" ? "error" : el.dataset.sfx || "click");
  }, true);
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

// ---------- ring tooltip (one shared parchment popover, outside #app) ----------
// Any element with data-ring (and optional data-tip: state lines separated by "\n") gets it on
// mouse hover and keyboard focus. On touch, a tap keeps its normal action and a long press shows
// the tooltip (read-only rings also show it on tap). Text is set with textContent only.

const LONG_PRESS_MS = 450;
const tipUi = { el: null, gem: null, icon: null, name: null, text: null, list: null, anchor: null, key: null, press: null, eatClick: false };

const ringAnchor = (target) => (target instanceof Element ? target.closest("[data-ring]") : null);

function showTip(anchor, animate = true) {
  const ring = RING_BY_ID[anchor.dataset.ring];
  if (!ring) return;
  const t = tipUi;
  t.gem.style.setProperty("--gem", ring.gem);
  t.icon.textContent = ring.icon;
  t.name.textContent = ring.name;
  t.text.textContent = ring.text;
  const lines = (anchor.dataset.tip || "").split("\n").filter(Boolean);
  t.list.replaceChildren(...lines.map((line) => h("li", { text: line })));
  t.list.hidden = !lines.length;
  t.anchor = anchor;
  t.key = anchor.dataset.k || null;
  positionTip();
  if (animate && !t.el.classList.contains("show")) {
    t.el.classList.remove("show");
    void t.el.offsetWidth; // restart the entry transition
  }
  t.el.classList.add("show");
}

function hideTip() {
  tipUi.anchor = null;
  tipUi.key = null;
  tipUi.el?.classList.remove("show");
}

// Above the ring, centered; flips below when there is no room, clamped to the viewport.
function positionTip() {
  const { el, anchor } = tipUi;
  const a = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const gap = 10;
  const pad = 8;
  let below = a.top - gap - ht < pad;
  if (below && a.bottom + gap + ht > vh - pad && a.top > vh - a.bottom) below = false;
  const cx = a.left + a.width / 2;
  const left = Math.max(pad, Math.min(cx - w / 2, vw - w - pad));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(below ? a.bottom + gap : a.top - gap - ht)}px`;
  el.dataset.side = below ? "below" : "above";
  el.style.setProperty("--ax", `${Math.round(Math.max(16, Math.min(cx - left, w - 16)))}px`);
}

// After a re-render the anchor is a new element: follow it by its data-k, or close.
function refreshTip() {
  const t = tipUi;
  if (!t.anchor || t.anchor.isConnected) return;
  const next = t.key ? [...document.querySelectorAll("[data-ring][data-k]")].find((x) => x.dataset.k === t.key) : null;
  if (next) showTip(next, false);
  else hideTip();
}

function setupTooltip() {
  const t = tipUi;
  t.gem = h("span", { class: "tip-gem" }, h("span", { class: "rt-gem" }));
  t.icon = h("span", { class: "tip-icon" });
  t.name = h("span", { class: "tip-name" });
  t.text = h("p", { class: "tip-text" });
  t.list = h("ul", { class: "tip-state" });
  t.el = h("div", { class: "ring-tip", "aria-hidden": "true" },
    h("div", { class: "tip-head" }, t.gem, t.icon, t.name), t.text, t.list);
  document.body.append(t.el);

  const cancelPress = () => { clearTimeout(t.press?.timer); t.press = null; };
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const a = ringAnchor(e.target);
    if (a && a !== t.anchor) showTip(a);
  });
  document.addEventListener("pointerout", (e) => {
    if (e.pointerType === "touch") return;
    const a = ringAnchor(e.target);
    if (a && a === t.anchor && !a.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const a = ringAnchor(e.target);
    if (a && a === e.target && a.matches(":focus-visible")) showTip(a);
  });
  document.addEventListener("focusout", (e) => {
    if (t.anchor && e.target === t.anchor) hideTip();
  });
  document.addEventListener("pointerdown", (e) => {
    t.eatClick = false;
    t.lastType = e.pointerType;
    cancelPress();
    if (e.pointerType !== "touch") return;
    const a = ringAnchor(e.target);
    if (!a) return;
    t.press = { x: e.clientX, y: e.clientY,
      timer: setTimeout(() => { t.press = null; t.eatClick = true; showTip(a); }, LONG_PRESS_MS) };
  });
  document.addEventListener("pointermove", (e) => {
    if (t.press && Math.hypot(e.clientX - t.press.x, e.clientY - t.press.y) > 10) cancelPress();
  });
  document.addEventListener("pointerup", cancelPress);
  document.addEventListener("pointercancel", cancelPress);
  // The click after a long press must not also place/remove the ring.
  document.addEventListener("click", (e) => {
    if (t.eatClick) {
      t.eatClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const a = ringAnchor(e.target);
    if (a && a.tagName !== "BUTTON" && t.lastType === "touch") { if (a === t.anchor) hideTip(); else showTip(a); } // read-only ring: tap toggles
    else if (!a && t.lastType === "touch") hideTip();
  }, true);
  document.addEventListener("contextmenu", (e) => { if (ringAnchor(e.target)) e.preventDefault(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
  window.addEventListener("scroll", () => { if (t.anchor) positionTip(); }, { passive: true, capture: true });
  window.addEventListener("resize", hideTip);
}

// ---------- boot ----------

setupRules();
setupMute();
setupTooltip();
const urlCode = readRoomFromUrl();
if (urlCode) join(urlCode);
else render();
