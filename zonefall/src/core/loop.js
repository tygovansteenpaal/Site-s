// ZONEFALL - main loop. OWNER: LEAD. Complete.
// Variable timestep, clamped. Systems that need stable physics sub-step internally (see ARCHITECTURE.md 2.3).

const MAX_DT = 0.05;

/**
 * @param {(dt:number, now:number) => void} frame  called once per animation frame; dt in seconds (0 < dt <= 0.05)
 * @returns {{start():void, stop():void, running:boolean, fps:number}}
 */
export function createLoop(frame) {
  let raf = 0, last = 0, acc = 0, frames = 0;
  const loop = {
    running: false,
    fps: 0,
    start() {
      if (loop.running) return;
      loop.running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      loop.running = false;
      cancelAnimationFrame(raf);
    },
  };
  function tick(now) {
    if (!loop.running) return;
    raf = requestAnimationFrame(tick);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) return;
    if (dt > MAX_DT) dt = MAX_DT;   // tab switches and long stalls do not explode physics
    acc += dt; frames++;
    if (acc >= 0.5) { loop.fps = Math.round(frames / acc); acc = 0; frames = 0; }
    frame(dt, now);
  }
  return loop;
}
