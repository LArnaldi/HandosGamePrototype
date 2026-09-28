// app.js: UI rendering and glue between game logic (game.js) and networking (net.js).
// Screens: home, lobby (host waiting), joining (guest), game (includes end-of-match view),
// disconnected. All DOM is built with textContent; opponent data is never parsed as HTML.

import { Match, MOVES, EMOJI, LABEL, WIN_SCORE } from "./game.js";
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
};

let net = null; // current net handle
let session = 0; // bumps on every new/closed session so stale callbacks are ignored
let queue = Promise.resolve();
let animatedResult = null; // lastResult object whose reveal animation already played
let animatedEnd = null; // match end (keyed by final result) whose animation already played

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

function startGame() {
  state.match = new Match();
  state.oppName = DEFAULT_OPP;
  animatedResult = null;
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
    onOpponent: () => { if (s === session) startGame(); },
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
    onOpen: () => { if (s === session) startGame(); },
  });
  render();
}

// ---------- protocol ----------

const isInt = (x) => Number.isInteger(x) && x > 0;

function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
  enqueue(async () => {
    const m = state.match;
    if (!m) return;
    switch (msg.t) {
      case "hello":
        state.oppName = cleanName(msg.name, DEFAULT_OPP);
        break;
      case "commit":
        if (!isInt(msg.round) || typeof msg.hash !== "string" || !/^[0-9a-f]{64}$/.test(msg.hash)) return;
        m.receiveCommit({ t: "commit", round: msg.round, hash: msg.hash });
        if (m.revealReady()) send(m.takeReveal());
        break;
      case "reveal":
        if (!isInt(msg.round) || typeof msg.move !== "string" || typeof msg.salt !== "string") return;
        await m.receiveReveal({ t: "reveal", round: msg.round, move: msg.move, salt: msg.salt });
        break;
      case "rematch":
        m.receiveRematch();
        break;
      default:
        break; // unknown type: ignore
    }
  });
}

function pickMove(move) {
  const m = state.match;
  if (!m || m.myMove) return;
  const pending = m.pick(move); // claims the move synchronously
  render(); // show the choice immediately
  enqueue(async () => {
    const commit = await pending;
    if (!commit || state.match !== m) return;
    send(commit);
    if (m.revealReady()) send(m.takeReveal());
  });
}

function rematch() {
  const m = state.match;
  if (!m) return;
  const msg = m.requestRematch();
  send(msg);
  render();
}

// ---------- rendering ----------

function render() {
  const view = {
    home: renderHome,
    lobby: renderLobby,
    joining: renderJoining,
    game: () => (state.match?.winner ? renderEnd() : renderGame()),
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

function scoreboard(m) {
  return h("div", { class: "scoreboard" },
    h("span", { class: "score-name", text: "Tu" }),
    h("span", { class: "score-num", text: `${m.scores.me} – ${m.scores.opp}` }),
    h("span", { class: "score-name opp", text: state.oppName }));
}

function revealCard(r) {
  const fresh = r !== animatedResult;
  animatedResult = r;
  const [text, cls] = r.outcome === 1 ? ["Hai vinto il round!", "win"]
    : r.outcome === -1 ? ["Hai perso il round", "lose"]
    : ["Pareggio", "draw"];
  const side = (who, move) => h("div", { class: "reveal-side" },
    h("span", { class: "reveal-emoji", text: EMOJI[move], "aria-label": LABEL[move] }),
    h("span", { class: "reveal-who", text: who }));
  return h("section", { class: `card reveal ${cls}${fresh ? " pop" : ""}`, "aria-live": "polite" },
    h("div", { class: "reveal-row" },
      side("Tu", r.me),
      h("span", { class: "reveal-vs", text: "vs" }),
      side(state.oppName, r.opp)),
    h("p", { class: "reveal-outcome", text }));
}

function renderGame() {
  const m = state.match;
  const picked = m.myMove;
  const hands = h("div", { class: "hands" },
    MOVES.map((mv) => h("button", {
      class: `hand-btn${picked === mv ? " chosen" : ""}`,
      type: "button",
      disabled: !!picked,
      "aria-pressed": picked === mv ? "true" : "false",
      onclick: () => pickMove(mv),
    }, h("span", { class: "hand-emoji", text: EMOJI[mv], "aria-hidden": "true" }),
       h("span", { class: "hand-label", text: LABEL[mv] }))));

  let status;
  if (picked) status = m.oppHash ? `${state.oppName} ha scelto…` : `In attesa di ${state.oppName}…`;
  else if (m.oppHash) status = `${state.oppName} ha scelto`;
  else status = "Scegli la tua mossa";

  return [
    scoreboard(m),
    h("p", { class: "round-info" },
      h("strong", { text: `Round ${m.round}` }), " · ", `Primo a ${WIN_SCORE} vince`),
    !picked && m.lastResult ? revealCard(m.lastResult) : null,
    hands,
    h("p", { class: `status${picked ? " waiting" : ""}`, "aria-live": "polite", text: status }),
    h("button", { class: "btn btn-secondary btn-quiet", type: "button", text: "Esci", onclick: () => goHome() }),
  ];
}

function renderEnd() {
  const m = state.match;
  const won = m.winner === "me";
  const endKey = m.lastResult ?? m;
  const freshEnd = endKey !== animatedEnd;
  animatedEnd = endKey;
  const headline = m.cheated ? "L'avversario ha barato — vinci a tavolino" : won ? "Hai vinto!" : "Hai perso";
  let rematchInfo = null;
  if (m.iWantRematch) rematchInfo = `In attesa che ${state.oppName} accetti…`;
  else if (m.oppWantsRematch) rematchInfo = `${state.oppName} vuole la rivincita!`;
  return [
    h("section", { class: `card end ${won ? "win" : "lose"}${freshEnd ? " pop" : ""}` },
      h("p", { class: "end-emoji", text: m.cheated ? "🚩" : won ? "🏆" : "😔", "aria-hidden": "true" }),
      h("h2", { class: "end-title", text: headline }),
      h("p", { class: "end-score", text: `Tu ${m.scores.me} – ${m.scores.opp} ${state.oppName}` })),
    m.lastResult && !m.cheated ? revealCard(m.lastResult) : null,
    rematchInfo ? h("p", { class: "status", "aria-live": "polite", text: rematchInfo }) : null,
    h("button", {
      class: "btn",
      type: "button",
      disabled: m.iWantRematch,
      text: m.oppWantsRematch ? "Accetta rivincita" : "Rivincita",
      onclick: rematch,
    }),
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
