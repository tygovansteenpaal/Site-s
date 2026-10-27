// PokéBonk farms: the launchers' log lines (each tagged with its PC), oldest first like launcher.log.
const { route, requireAuth, redis, K } = require('./_lib.js');

module.exports = route(async (req) => {
  requireAuth(req);
  const [lines] = await redis(['LRANGE', K('log'), 0, 299]);
  return lines.reverse();
});
