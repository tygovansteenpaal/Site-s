// PokéBonk farms: every account profile ever synced (catches, League, counters ...), kept permanently.
const { route, requireAuth, redis, parse, K } = require('./_lib.js');

module.exports = route(async (req) => {
  requireAuth(req);
  const [names] = await redis(['SMEMBERS', K('accounts')]);
  if (!names.length) return [];
  const [raw] = await redis(['MGET', ...names.map((n) => K(`account:${n}`))]);
  return raw.map((r) => parse(r)).filter(Boolean);
});
