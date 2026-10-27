// PokéBonk farms: POST { password } signs the browser in (cookie); DELETE signs it out.
const { route, body, checkPassword, setAuthCookie, clearAuthCookie, HttpError } = require('./_lib.js');

module.exports = route(async (req, res) => {
  if (req.method === 'DELETE') { clearAuthCookie(req, res); return { ok: true }; }
  if (req.method !== 'POST') throw new HttpError(405, 'Alleen POST');
  const { password } = await body(req);
  await new Promise((r) => setTimeout(r, 400));   // a small delay makes guessing passwords slow
  if (!checkPassword(password)) throw new HttpError(401, 'Verkeerd wachtwoord');
  setAuthCookie(req, res);
  return { ok: true };
});
