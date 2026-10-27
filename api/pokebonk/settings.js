// PokéBonk farms - GET: the shared settings. POST: change them; every launcher picks them up on its
// next sync.
const { route, requireAuth, redis, body, K, getSettings, cleanSettings, logLine, HttpError } = require('./_lib.js');

module.exports = route(async (req) => {
  requireAuth(req);
  if (req.method === 'GET') return getSettings();
  if (req.method !== 'POST') throw new HttpError(405, 'Alleen GET of POST');
  const { presets, ...next } = cleanSettings(await body(req), await getSettings());
  await redis(['SET', K('settings'), JSON.stringify(next)],
    ['LPUSH', K('log'), logLine(`[website] instellingen aangepast (versie ${next.version})`)], ['LTRIM', K('log'), 0, 299]);
  return getSettings();
});
