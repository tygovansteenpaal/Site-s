// PokéBonk farms: a launcher reports in (about once a minute) with its live windows, changed account
// profiles, new runs and new log lines. The answer carries the shared settings, so changes made on
// the website reach every PC.
const { route, requireAuth, redis, body, K, getSettings, HttpError } = require('./_lib.js');

module.exports = route(async (req) => {
  if (requireAuth(req) !== 'launcher') throw new HttpError(403, 'Alleen voor launchers');
  if (req.method !== 'POST') throw new HttpError(405, 'Alleen POST');
  const b = await body(req);
  const id = String(b.pcId || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (!id) throw new HttpError(400, 'pcId ontbreekt');
  const name = String(b.pcName || 'pc').slice(0, 64);

  const cmds = [
    ['SADD', K('pcs'), id],
    // a PC that stops syncing disappears after 10 minutes
    ['SET', K(`pc:${id}`), JSON.stringify({ name, os: String(b.os || '').slice(0, 16), at: Date.now(), live: (b.live || []).slice(0, 50) }), 'EX', 600],
  ];
  for (const p of (b.profiles || []).slice(0, 50)) {
    if (!p || typeof p.name !== 'string' || !p.name) continue;
    cmds.push(['SADD', K('accounts'), p.name], ['SET', K(`account:${p.name}`), JSON.stringify({ ...p, pc: name, lastSeen: Date.now() })]);
  }
  const runs = (b.runs || []).slice(0, 500).map((r) => JSON.stringify({ ...r, pc: name }));
  if (runs.length) cmds.push(['LPUSH', K('runs'), ...runs], ['LTRIM', K('runs'), 0, 9999]);
  const log = (b.log || []).slice(-100).map((l) => `${String(l).slice(0, 300)} (${name})`);
  if (log.length) cmds.push(['LPUSH', K('log'), ...log], ['LTRIM', K('log'), 0, 299]);
  await redis(...cmds);
  return { settings: await getSettings() };
});
