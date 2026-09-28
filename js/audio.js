// audio.js: tavern sound effects synthesized with the Web Audio API (no audio files).
// The AudioContext is created lazily on the first user gesture (autoplay policy); before that,
// sfx() is a no-op. Mute is persisted in localStorage.
//
// API: unlockAudio(), sfx(name), isMuted(), setMuted(bool)

const MUTE_KEY = "handos-muted";
const VOLUME = 0.32;

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch {}

export const isMuted = () => muted;

export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch {}
  if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : VOLUME, ctx.currentTime, 0.02);
}

export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") ctx.resume();
  } catch {}
}

// ---------- primitives (t: seconds from now) ----------

function env(g, t0, vol, attack, decay) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function tone(freq, { t = 0, type = "sine", vol = 0.3, attack = 0.005, decay = 0.25, slide, lp } = {}) {
  const t0 = ctx.currentTime + t;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + attack + decay);
  env(g, t0, vol, attack, decay);
  let node = o;
  if (lp) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(lp, t0);
    o.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(master);
  o.start(t0);
  o.stop(t0 + attack + decay + 0.05);
}

function noise({ t = 0, vol = 0.2, attack = 0.002, decay = 0.08, type = "bandpass", freq = 1500, q = 1, sweep } = {}) {
  const t0 = ctx.currentTime + t;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + attack + decay);
  f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, vol, attack, decay);
  s.connect(f);
  f.connect(g);
  g.connect(master);
  s.start(t0, Math.random() * 0.5);
  s.stop(t0 + attack + decay + 0.05);
}

// Lute-ish pluck: bright triangle + octave, quick lowpass decay.
function pluck(freq, t = 0, vol = 0.22, decay = 0.5) {
  tone(freq, { t, type: "triangle", vol, decay, lp: freq * 4 });
  tone(freq * 2, { t, type: "sine", vol: vol * 0.35, decay: decay * 0.5 });
  noise({ t, vol: vol * 0.25, decay: 0.02, freq: freq * 3, q: 2 });
}

// Metallic ring clink: inharmonic partials.
function clink(freq, t = 0, vol = 0.12, decay = 0.35) {
  for (const [mul, v] of [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]]) {
    tone(freq * mul, { t, vol: vol * v, decay: decay / Math.sqrt(mul) });
  }
}

function wood(t = 0, vol = 0.22, freq = 1700) {
  noise({ t, vol, decay: 0.035, freq, q: 5 });
  tone(freq * 0.45, { t, vol: vol * 0.5, decay: 0.04, slide: freq * 0.3 });
}

function drum(t = 0, vol = 0.5, f0 = 140, f1 = 45, decay = 0.3) {
  tone(f0, { t, vol, decay, slide: f1 });
  noise({ t, vol: vol * 0.35, decay: 0.08, type: "lowpass", freq: 600 });
}

const N = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A3: 220, E3: 164.81, C3: 130.81, G3: 196, Bb3: 233.08, Eb4: 311.13 };

const SOUNDS = {
  click: () => wood(0, 0.16),
  select: () => { wood(0, 0.12, 1300); pluck(N.G4, 0.01, 0.16, 0.35); },
  ringOn: () => clink(1850, 0, 0.12),
  ringOff: () => clink(1400, 0, 0.08, 0.2),
  confirm: () => { pluck(N.G4, 0); pluck(N.B4, 0.07); pluck(N.D5, 0.14); pluck(N.G5, 0.21, 0.18, 0.7); },
  oppConfirm: () => { wood(0, 0.2, 900); wood(0.12, 0.16, 900); },
  error: () => { tone(160, { type: "square", vol: 0.08, decay: 0.12, lp: 800 }); tone(120, { t: 0.14, type: "square", vol: 0.08, decay: 0.18, lp: 700 }); },
  diceRoll: () => { let t = 0; for (let i = 0; i < 14; i++) { t += 0.05 + Math.random() * 0.06; wood(t, 0.07 + Math.random() * 0.1, 1200 + Math.random() * 1600); } },
  diceSettle: () => { wood(0, 0.25, 900); drum(0.01, 0.2, 180, 90, 0.12); },
  tableReveal: () => { noise({ vol: 0.12, decay: 0.45, type: "lowpass", freq: 300, sweep: 3000, q: 0.7 }); pluck(N.C4, 0.3); pluck(N.E4, 0.36); pluck(N.G4, 0.42); clink(1900, 0.5, 0.06); },
  handReveal: () => { drum(0, 0.45, 110, 40, 0.35); noise({ t: 0.02, vol: 0.12, decay: 0.2, type: "highpass", freq: 3000 }); clink(1500, 0.03, 0.07, 0.3); },
  bonus: () => { clink(1600, 0, 0.1); tone(N.E5, { t: 0.04, type: "triangle", vol: 0.12, decay: 0.2 }); tone(N.A4 * 2, { t: 0.1, type: "triangle", vol: 0.12, decay: 0.3 }); },
  hurtSelf: () => { tone(N.A3, { type: "sawtooth", vol: 0.07, decay: 0.25, slide: N.E3, lp: 900 }); clink(900, 0, 0.06, 0.2); },
  shield: () => { tone(260, { type: "square", vol: 0.06, decay: 0.3, lp: 1400 }); clink(780, 0, 0.12, 0.5); },
  heal: () => { for (const [i, f] of [N.C5, N.E5, N.G5].entries()) tone(f, { t: i * 0.08, vol: 0.1, decay: 0.7 }); clink(3000, 0.24, 0.04, 0.6); },
  cancel: () => { tone(420, { type: "sawtooth", vol: 0.07, decay: 0.35, slide: 140, lp: 1000 }); noise({ vol: 0.06, decay: 0.3, type: "bandpass", freq: 900, sweep: 200 }); },
  steal: () => { noise({ vol: 0.12, decay: 0.18, freq: 800, sweep: 4000, q: 1.5 }); clink(2200, 0.15, 0.08, 0.2); clink(1600, 0.25, 0.06, 0.2); },
  none: () => wood(0, 0.08, 1000),
  hit: () => { drum(0, 0.6, 130, 40, 0.35); noise({ vol: 0.15, decay: 0.12, type: "lowpass", freq: 900 }); },
  ko: () => { drum(0, 0.7, 120, 30, 0.6); tone(N.G3, { t: 0.1, type: "sawtooth", vol: 0.08, decay: 0.8, slide: N.C3, lp: 700 }); },
  doubleKo: () => { drum(0, 0.6, 130, 35, 0.4); drum(0.22, 0.6, 110, 30, 0.6); },
  roundWon: () => { [N.C4, N.E4, N.G4, N.C5].forEach((f, i) => pluck(f, i * 0.1, 0.2, i === 3 ? 0.9 : 0.4)); },
  roundLost: () => { [N.A4, N.E4, N.C4, N.A3].forEach((f, i) => pluck(f, i * 0.13, 0.18, i === 3 ? 0.9 : 0.4)); },
  matchWon: () => {
    const seq = [[N.C4, 0, 0.15], [N.C4, 0.16, 0.1], [N.C4, 0.28, 0.1], [N.E4, 0.4, 0.2], [N.G4, 0.62, 0.2], [N.C5, 0.84, 0.9]];
    for (const [f, t, d] of seq) {
      tone(f, { t, type: "sawtooth", vol: 0.07, attack: 0.02, decay: d + 0.15, lp: 2200 });
      tone(f * 1.005, { t, type: "square", vol: 0.04, attack: 0.02, decay: d + 0.15, lp: 1800 });
    }
    drum(0.84, 0.35, 120, 50, 0.4);
    clink(2600, 0.9, 0.05, 0.8);
  },
  matchLost: () => { [[N.G4, 0], [N.Eb4, 0.3], [N.C4, 0.6], [N.G3, 0.9]].forEach(([f, t], i) => tone(f, { t, type: "triangle", vol: 0.14, attack: 0.02, decay: i === 3 ? 1.1 : 0.4 })); drum(0.9, 0.3, 90, 35, 0.6); },
  joined: () => { clink(1320, 0, 0.1, 0.6); clink(1760, 0.14, 0.1, 0.8); pluck(N.G4, 0.1, 0.12); },
  disconnect: () => { tone(N.E4, { type: "triangle", vol: 0.14, decay: 0.3 }); tone(N.A3, { t: 0.2, type: "triangle", vol: 0.14, decay: 0.6 }); },
};

export function sfx(name) {
  if (muted || !ctx || ctx.state === "closed") return;
  const fn = SOUNDS[name];
  if (!fn) return;
  try {
    if (ctx.state === "suspended") ctx.resume();
    fn();
  } catch {}
}
