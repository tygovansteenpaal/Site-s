// PokéBonk farms: the accounts' logins, encrypted by the launcher with the password before they leave
// the PC (AES-GCM, key from PBKDF2). This route only stores and returns the sealed blob.
const { route, requireAuth, redis, body, parse, K, HttpError } = require('./_lib.js');

module.exports = route(async (req) => {
  if (requireAuth(req) !== 'launcher') throw new HttpError(403, 'Alleen voor launchers');
  if (req.method === 'GET') {
    const [raw] = await redis(['GET', K('vault')]);
    return parse(raw, {}) || {};
  }
  if (req.method !== 'PUT') throw new HttpError(405, 'Alleen GET of PUT');
  const v = await body(req);
  for (const k of ['salt', 'nonce', 'tag', 'data']) if (typeof v[k] !== 'string') throw new HttpError(400, 'Ongeldige kluis');
  if (v.data.length > 2_000_000) throw new HttpError(413, 'Kluis te groot');
  await redis(['SET', K('vault'), JSON.stringify({ v: 1, salt: v.salt, iter: v.iter, nonce: v.nonce, tag: v.tag, data: v.data, at: Date.now() })]);
  return { ok: true };
});
