// BLOKSTORM - 8 bit style sound effects made with the Web Audio API. No sound files.
let ctx = null, master = null, volume = 0.5;

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function setVolume(v) { volume = v; if (master) master.gain.value = v; }

function tone(freq, dur, type = 'square', vol = 0.2, to = null, delay = 0) {
  const a = ac(), t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol = 0.25, cutoff = 1800) {
  const a = ac(), n = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = a.createBufferSource(); s.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
  const g = a.createGain(); g.gain.value = vol;
  s.connect(f); f.connect(g); g.connect(master); s.start();
}

const SFX = {
  click: () => tone(660, 0.05, 'square', 0.12),
  place: () => { noise(0.07, 0.25, 900); tone(180, 0.06, 'square', 0.1, 120); },
  dig: () => noise(0.05, 0.14, 1400),
  break: () => { noise(0.14, 0.3, 1100); tone(140, 0.1, 'square', 0.1, 70); },
  swing: () => noise(0.08, 0.1, 3200),
  hit: () => { tone(220, 0.09, 'square', 0.2, 110); noise(0.06, 0.2, 2400); },
  crit: () => { tone(1200, 0.06, 'square', 0.14, 700); tone(1500, 0.08, 'square', 0.12, 900, 0.05); },
  hurt: () => tone(160, 0.18, 'sawtooth', 0.22, 70),
  pickup: () => { tone(700, 0.05, 'square', 0.12); tone(1050, 0.07, 'square', 0.12, null, 0.05); },
  drip: () => tone(520, 0.06, 'triangle', 0.16, 780),
  bow: () => tone(300, 0.14, 'triangle', 0.22, 90),
  throw: () => noise(0.1, 0.12, 2600),
  eat: () => { tone(300, 0.05, 'square', 0.12); tone(260, 0.05, 'square', 0.12, null, 0.08); tone(340, 0.06, 'square', 0.12, null, 0.16); },
  boom: () => { noise(0.5, 0.6, 600); tone(90, 0.4, 'sawtooth', 0.3, 35); },
  chest: () => { tone(330, 0.08, 'square', 0.14); tone(440, 0.08, 'square', 0.14, null, 0.08); tone(660, 0.14, 'square', 0.14, null, 0.16); },
  block: () => { tone(900, 0.05, 'square', 0.16, 500); noise(0.05, 0.16, 4000); },
  wind: () => { noise(0.35, 0.35, 2200); tone(500, 0.3, 'sine', 0.12, 1400); },
  warp: () => tone(900, 0.25, 'sine', 0.2, 200),
  die: () => { tone(300, 0.2, 'square', 0.2, 150); tone(150, 0.4, 'square', 0.2, 50, 0.2); },
  kill: () => { tone(520, 0.08, 'square', 0.16); tone(780, 0.14, 'square', 0.16, null, 0.08); },
  tick: () => tone(440, 0.08, 'square', 0.16),
  step: () => noise(0.045, 0.07, 700 + Math.random() * 300),
  land: () => { noise(0.09, 0.2, 500); tone(110, 0.08, 'sine', 0.14, 60); },
  go: () => tone(880, 0.3, 'square', 0.18),
  zone: () => { tone(200, 0.3, 'sawtooth', 0.16, 150); tone(200, 0.3, 'sawtooth', 0.16, 150, 0.4); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.18, null, i * 0.14)),
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.22, 'square', 0.16, null, i * 0.18)),
};
let wind = null;
/** Soft wind while a round is running, so the sky islands do not feel silent. */
export function ambient(on) {
  try {
    if (on && !wind) {
      const a = ac(), n = a.sampleRate * 3, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
      let v = 0;
      for (let i = 0; i < n; i++) { v = v * 0.985 + (Math.random() * 2 - 1) * 0.015; d[i] = v * 6 * (0.6 + 0.4 * Math.sin((i / n) * Math.PI * 2)); }
      const s = a.createBufferSource(); s.buffer = buf; s.loop = true;
      const g = a.createGain(); g.gain.value = 0.16;
      s.connect(g); g.connect(master); s.start();
      wind = { s, g };
    } else if (!on && wind) { wind.s.stop(); wind = null; }
  } catch { /* audio not allowed yet */ }
}
export function sfx(name) { try { SFX[name] && SFX[name](); } catch { /* audio not allowed yet */ } }
