// ZONEFALL - main loop. OWNER: LEAD.
// Variable timestep, clamped. Systems that need stable physics sub-step internally (see ARCHITECTURE.md 2.3).
// Browsers stop requestAnimationFrame in hidden tabs. An online host still has to simulate the bots and every online
// player has to keep sending snapshots, so while the document is hidden and opts.background() says so, a tiny worker
// timer (worker timers are not throttled like page timers) drives the same frame function at HIDDEN_HZ with
// hidden = true, and the frame skips rendering.

const MAX_DT = 0.05;
const HIDDEN_HZ = 20;
const WORKER_SRC = 'let id=0;onmessage=(e)=>{clearInterval(id);id=0;if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};';

/**
 * @param {(dt:number, now:number, hidden:boolean) => void} frame  called once per tick; dt in seconds (0 < dt <= 0.05)
 * @param {{background?: () => boolean}} [opts]  background(): keep simulating while the tab is hidden
 * @returns {{start():void, stop():void, running:boolean, fps:number}}
 */
export function createLoop(frame, opts = {}) {
  let raf = 0, last = 0, acc = 0, frames = 0, fpsFrom = 0;
  let worker = null, workerFailed = false;
  const loop = {
    running: false,
    fps: 0,          // measured over real time (dt is clamped for the simulation, the rate is not)
    frames: 0,       // ticks since start (tests wait on it)
    start() {
      if (loop.running) return;
      loop.running = true;
      last = performance.now();
      fpsFrom = last;
      raf = requestAnimationFrame(tick);
      syncHidden();
    },
    stop() {
      loop.running = false;
      cancelAnimationFrame(raf);
      if (worker) worker.postMessage(0);
    },
  };

  function step(now, hidden) {
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) return;
    if (dt > MAX_DT) dt = MAX_DT;   // tab switches and long stalls do not explode physics
    frames++;
    loop.frames++;
    acc = (now - fpsFrom) / 1000;
    if (acc >= 0.5) { loop.fps = Math.round((frames / acc) * 10) / 10; frames = 0; fpsFrom = now; }
    frame(dt, now, hidden);
  }

  function tick(now) {
    if (!loop.running) return;
    raf = requestAnimationFrame(tick);
    step(now, false);
  }

  function hiddenTick() {
    if (!loop.running || !document.hidden) return;
    const now = performance.now();
    if (opts.background && !opts.background()) { last = now; return; }
    step(now, true);
  }

  function ensureWorker() {
    if (worker || workerFailed || typeof Worker === 'undefined') return worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
      worker.onmessage = hiddenTick;
    } catch (err) {
      workerFailed = true;
      console.warn('[loop] background timer unavailable; the simulation pauses while the tab is hidden', err);
    }
    return worker;
  }

  function syncHidden() {
    if (typeof document === 'undefined') return;
    last = performance.now();
    if (document.hidden && loop.running && opts.background) {
      if (ensureWorker()) worker.postMessage(1000 / HIDDEN_HZ);
    } else if (worker) worker.postMessage(0);
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', syncHidden);
  return loop;
}
