// PokéBonk farms: live view for the dashboard - every window of every PC that synced in the last
// few minutes, the latest runs and the shared settings. Same shape as the launcher's own /data.
const { route, requireAuth, redis, parse, K, getSettings } = require('./_lib.js');

module.exports = route(async (req) => {
  requireAuth(req);
  const [pcIds, runsRaw] = await redis(['SMEMBERS', K('pcs')], ['LRANGE', K('runs'), 0, 299]);
  const pcRaw = pcIds.length ? (await redis(['MGET', ...pcIds.map((id) => K(`pc:${id}`))]))[0] : [];
  const pcs = [], accounts = [];
  pcIds.forEach((id, i) => {
    const pc = parse(pcRaw[i]);
    if (!pc) return;   // expired: that PC stopped syncing
    const stale = Date.now() - pc.at > 3 * 60 * 1000;
    pcs.push({ id, name: pc.name, at: pc.at, os: pc.os, windows: (pc.live || []).length, stale });
    for (const a of pc.live || []) accounts.push({ ...a, pc: pc.name, unreachable: a.unreachable || stale });
  });
  accounts.sort((a, b) => String(a.pc).localeCompare(String(b.pc)) || (a.slot ?? 99) - (b.slot ?? 99));
  return {
    updated: Date.now(), cloud: true, pcs, accounts,
    recent: runsRaw.map((r) => parse(r)).filter(Boolean).reverse(),
    settings: await getSettings(),
  };
});
