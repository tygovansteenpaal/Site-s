// PokéBonk farms: the key that opens the encrypted downloads in /pokebonk/downloads. The repository is
// public, so the downloads are stored there only encrypted; a signed-in browser gets this key and
// decrypts the file it downloads. The launcher that built them uploads the key (PUT).
const { route, requireAuth, redis, body, parse, K, HttpError } = require('./_lib.js');

module.exports = route(async (req) => {
  const who = requireAuth(req);
  if (req.method === 'GET') {
    const [raw] = await redis(['GET', K('dlkey')]);
    const k = parse(raw);
    if (!k?.key) throw new HttpError(404, 'De downloads zijn nog niet vrijgegeven: start de launcher die ze bouwde, gekoppeld aan deze site.');
    return k;
  }
  if (req.method !== 'PUT' || who !== 'launcher') throw new HttpError(405, 'Alleen GET, of PUT door een launcher');
  const { key, build } = await body(req);
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/=]{40,60}$/.test(key)) throw new HttpError(400, 'Ongeldige sleutel');
  await redis(['SET', K('dlkey'), JSON.stringify({ key, build: String(build || '').slice(0, 40), at: Date.now() })]);
  return { ok: true };
});
