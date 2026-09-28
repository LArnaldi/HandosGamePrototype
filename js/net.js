// net.js: PeerJS wrapper (host/guest connections, room codes, JSON message protocol); uses global `Peer`.
// No DOM, no game rules. Touches `Peer`/`window`/`location` only when called, never at import time.
//
// API
//   hostRoom({onCode, onOpponent, onMessage, onClose, onError}) -> handle
//     onCode(code)      peer registered as "handos-proto-" + code (id taken -> new code, max 5 tries)
//     onOpponent()      first guest connection is open (extra guests get {t:"full"} and are closed)
//   joinRoom(code, {onOpen, onMessage, onClose, onError}) -> handle
//     code is trimmed/uppercased; onOpen() when connected to the host.
//     A {t:"full"} from the host ends the session with onError("Stanza piena", "full"), which can
//     arrive right after onOpen.
//   Shared callbacks:
//     onMessage(msg)       every JSON message from the opponent (except "full")
//     onClose()            once, when the opponent connection closes/fails after it was open
//     onError(text, type)  once, fatal error before an opponent was connected; text is Italian,
//                          type is the PeerJS error type or "full" | "invalid-code" | "timeout"
//     After onClose/onError the session is torn down and no more callbacks fire.
//   handle: send(msg) -> bool (false if not connected), close() (= destroy(); no callbacks fire)
//   buildInviteLink(code) -> location.origin + location.pathname + "?r=" + code
//   readRoomFromUrl()     -> valid 5-char code from ?r=, or null

import { makeRoomCode, ROOM_ALPHABET } from "./game.js";

export const ID_PREFIX = "handos-proto-";
const MAX_ID_TRIES = 5;
const JOIN_TIMEOUT_MS = 15000;
const CONN_OPTS = { reliable: true, serialization: "json" };

const ERRORS = {
  "network": "Connessione al server non riuscita. Controlla la rete.",
  "server-error": "Il server di connessione non risponde. Riprova più tardi.",
  "socket-error": "Connessione al server persa.",
  "socket-closed": "Connessione al server persa.",
  "browser-incompatible": "Il tuo browser non supporta il gioco online (WebRTC).",
  "peer-unavailable": "Stanza non trovata. Controlla il codice.",
  "unavailable-id": "Impossibile creare la stanza. Riprova.",
  "full": "Stanza piena.",
  "invalid-code": "Codice stanza non valido.",
  "timeout": "Impossibile collegarsi alla stanza.",
};
const errorText = (type) => ERRORS[type] || "Errore di connessione.";

export function normalizeCode(code) {
  return String(code ?? "").trim().toUpperCase();
}

export function isRoomCode(code) {
  return typeof code === "string" && code.length === 5 && [...code].every((c) => ROOM_ALPHABET.includes(c));
}

export function buildInviteLink(code) {
  return location.origin + location.pathname + "?r=" + code;
}

export function readRoomFromUrl() {
  const code = normalizeCode(new URLSearchParams(location.search).get("r"));
  return isRoomCode(code) ? code : null;
}

// Common session state: one peer, at most one opponent connection, a single terminal callback.
function session(cb) {
  const s = { peer: null, conn: null, connected: false, done: false };
  const onUnload = () => s.close();
  const hasWindow = typeof window !== "undefined" && window.addEventListener;
  if (hasWindow) window.addEventListener("beforeunload", onUnload);

  s.close = () => {
    if (s.done) return;
    s.done = true;
    if (hasWindow) window.removeEventListener("beforeunload", onUnload);
    try { s.conn?.close(); } catch {}
    try { s.peer?.destroy(); } catch {}
  };
  // Terminal event: onClose if the opponent was connected, otherwise onError.
  s.end = (type) => {
    if (s.done) return;
    const wasConnected = s.connected && type !== "full";
    s.close();
    if (wasConnected) cb.onClose?.();
    else cb.onError?.(errorText(type), type);
  };
  // onEarlyFail: called instead of ending the session if conn fails before opening.
  s.wire = (conn, onOpen, onEarlyFail) => {
    s.conn = conn;
    const fail = () => {
      if (!s.connected && onEarlyFail) onEarlyFail();
      else s.end("peer-unavailable");
    };
    conn.on("open", () => { if (s.done) return; s.connected = true; onOpen(); });
    conn.on("data", (msg) => {
      if (s.done) return;
      if (msg?.t === "full") s.end("full");
      else cb.onMessage?.(msg);
    });
    conn.on("close", fail);
    conn.on("error", fail);
  };
  s.peerEvents = (peer) => {
    // Lost the signaling server: try to re-register; the P2P link itself may still be fine.
    peer.on("disconnected", () => { if (!s.done && s.peer === peer && !peer.destroyed) peer.reconnect(); });
    peer.on("close", () => { if (s.peer === peer) s.end("socket-closed"); });
  };
  s.handle = {
    send(msg) {
      if (s.done || !s.connected || !s.conn?.open) return false;
      s.conn.send(msg);
      return true;
    },
    close: s.close,
    destroy: s.close,
  };
  return s;
}

// Signaling-only failures don't matter once the P2P link is up.
const SIGNALING = new Set(["network", "server-error", "socket-error", "socket-closed", "disconnected"]);

export function hostRoom(cb = {}) {
  const s = session(cb);
  let tries = 0;
  const start = () => {
    const code = makeRoomCode();
    const peer = (s.peer = new Peer(ID_PREFIX + code));
    peer.on("open", () => { if (!s.done && s.peer === peer) cb.onCode?.(code); });
    peer.on("connection", (conn) => {
      if (s.done) return conn.close();
      if (s.conn) {
        conn.on("open", () => { conn.send({ t: "full" }); setTimeout(() => conn.close(), 500); });
        return;
      }
      // A guest that fails before opening frees the slot instead of killing the room.
      s.wire(conn, () => cb.onOpponent?.(), () => { if (s.conn === conn) s.conn = null; });
    });
    peer.on("error", (err) => {
      if (s.peer !== peer) return;
      if (err.type === "unavailable-id" && ++tries < MAX_ID_TRIES) {
        s.peer = null; // detach first so the old peer's "close" is ignored
        peer.destroy();
        return start();
      }
      if (s.connected && SIGNALING.has(err.type)) return;
      s.end(err.type);
    });
    s.peerEvents(peer);
  };
  start();
  return s.handle;
}

export function joinRoom(code, cb = {}) {
  const s = session(cb);
  code = normalizeCode(code);
  if (!isRoomCode(code)) {
    queueMicrotask(() => s.end("invalid-code"));
    return s.handle;
  }
  const timer = setTimeout(() => { if (!s.connected) s.end("timeout"); }, JOIN_TIMEOUT_MS);
  const peer = (s.peer = new Peer());
  peer.on("open", () => {
    if (s.done) return;
    s.wire(peer.connect(ID_PREFIX + code, CONN_OPTS), () => { clearTimeout(timer); cb.onOpen?.(); });
  });
  peer.on("error", (err) => {
    if (s.connected && SIGNALING.has(err.type)) return;
    s.end(err.type);
  });
  s.peerEvents(peer);
  const close = s.close;
  s.close = s.handle.close = s.handle.destroy = () => { clearTimeout(timer); close(); };
  return s.handle;
}
