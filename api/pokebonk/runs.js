// PokéBonk farms: finished runs of all accounts, newest first (the newest 10 000 are kept).
const { route, requireAuth, redis, parse, K } = require('./_lib.js');

module.exports = route(async (req) => {
  requireAuth(req);
  const [raw] = await redis(['LRANGE', K('runs'), 0, 9999]);
  return raw.map((r) => parse(r)).filter(Boolean);
});
