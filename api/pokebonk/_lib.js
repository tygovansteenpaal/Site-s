// PokéBonk farms (/pokebonk) - shared helpers for the /api/pokebonk/* routes: Upstash Redis over
// REST, password auth, JSON in/out. Configure in Vercel > Project > Settings > Environment Variables:
//   DASHBOARD_PASSWORD   the password for the dashboard and the launchers
//   Upstash Redis        Storage > Upstash, connected to the project (sets KV_REST_API_URL / _TOKEN)
const crypto = require('node:crypto');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const K = (key) => `pb:${key}`;   // every key lives under pb: so it can share a database with other sites

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Runs several Redis commands in one round trip; returns their results in order.
async function redis(...commands) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new HttpError(500, 'Geen database gekoppeld: voeg Upstash Redis toe aan dit Vercel-project.');
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new HttpError(502, `Database gaf ${r.status}`);
  return (await r.json()).map((x) => {
    if (x.error) throw new HttpError(502, x.error);
    return x.result;
  });
}

const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

// The dashboard cookie holds a hash of the password, never the password itself.
const cookieValue = () => crypto.createHash('sha256').update(`pokebonk-farms:${PASSWORD}`).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function checkPassword(pw) {
  if (!PASSWORD) throw new HttpError(500, 'DASHBOARD_PASSWORD is niet ingesteld in Vercel.');
  return same(pw || '', PASSWORD);
}

// Browser (cookie) or launcher (Authorization: Bearer <password>).
function requireAuth(req) {
  if (!PASSWORD) throw new HttpError(500, 'DASHBOARD_PASSWORD is niet ingesteld in Vercel.');
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer && same(bearer, PASSWORD)) return 'launcher';
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('pb_auth='));
  if (cookie && same(cookie.slice(8), cookieValue())) return 'browser';
  throw new HttpError(401, 'Niet ingelogd');
}

// Secure on https (always on Vercel); plain http only happens when testing locally
const secure = (req) => ((req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '');
function setAuthCookie(req, res) {
  res.setHeader('Set-Cookie', `pb_auth=${cookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 60}${secure(req)}`);
}
function clearAuthCookie(req, res) {
  res.setHeader('Set-Cookie', `pb_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`);
}

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return parse(req.body, {}) || {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return parse(Buffer.concat(chunks).toString('utf8'), {}) || {};
}

// Wraps a handler: JSON responses, no caching, errors as { error }.
function route(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.status(200).json(out ?? {});
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e);
      res.status(status).json({ error: e.message || 'Fout' });
    }
  };
}

// ---------- shared settings (same shape as the launcher's) ----------
const BOT_DEFAULTS = {
  preset: 'normal', lowGfx: true, rotate: true, rotateEvery: 1, autoTune: true, autoRestart: true, useBoosts: true,
  allowCursed: false, throwBalls: true, shop: true, buyLab: true, claimQuests: true, claimTasks: true, minStardust: 0,
};
const PRESETS = { normal: 'Normal', speedrun: 'Speedrun', killfarm: 'Kill farm', survival: 'Survival' };

async function getSettings() {
  const [raw] = await redis(['GET', K('settings')]);
  const s = parse(raw, {}) || {};
  return {
    fps: 30, renderScale: 0.5, windowWidth: 516, windowHeight: 300, tileWindows: true, botOn: true, version: 0,
    ...s, bot: { ...BOT_DEFAULTS, ...(s.bot || {}) }, presets: PRESETS,
  };
}

// Same checks as the launcher: every value clamped before it is stored.
function cleanSettings(s, prev) {
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const bot = { ...prev.bot };
  for (const [k, v] of Object.entries(s.bot || {})) {
    if (!(k in BOT_DEFAULTS)) continue;
    if (k === 'preset') { if (v in PRESETS) bot.preset = v; }
    else if (k === 'rotateEvery') bot.rotateEvery = Math.round(num(v, 1, 50, bot.rotateEvery));
    else if (k === 'minStardust') bot.minStardust = Math.round(num(v, 0, 1e6, bot.minStardust));
    else if (typeof BOT_DEFAULTS[k] === 'boolean') bot[k] = bool(v, bot[k]);
  }
  return {
    fps: Math.round(num(s.fps, 0, 60, prev.fps)),
    renderScale: Math.round(num(s.renderScale, 0.2, 1, prev.renderScale) * 100) / 100,
    windowWidth: Math.round(num(s.windowWidth, 200, 2000, prev.windowWidth)),
    windowHeight: Math.round(num(s.windowHeight, 150, 1500, prev.windowHeight)),
    tileWindows: bool(s.tileWindows, prev.tileWindows),
    botOn: bool(s.botOn, prev.botOn),
    bot,
    version: (prev.version || 0) + 1,
    updatedAt: Date.now(),
  };
}

const logLine = (text) => `${new Date().toISOString().slice(11, 19)} ${text}`;

module.exports = {
  HttpError, redis, parse, K, checkPassword, requireAuth, setAuthCookie, clearAuthCookie, body, route,
  BOT_DEFAULTS, PRESETS, getSettings, cleanSettings, logLine,
};
