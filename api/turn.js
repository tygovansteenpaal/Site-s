// ZONEFALL TURN credentials (Vercel serverless function, GET /api/turn).
// Players behind strict NATs (mobile networks, some routers) cannot open a direct WebRTC connection; a TURN server
// relays their traffic instead. This asks Cloudflare Realtime TURN for short-lived credentials so the API token never
// reaches the browser. Configure in Vercel > Project > Settings > Environment Variables:
//   CF_TURN_KEY_ID     the TURN key id     (Cloudflare dashboard > Realtime > TURN Server)
//   CF_TURN_API_TOKEN  that key's API token
// Without them the function answers 503 with an empty list and the game keeps using direct connections only.
const TTL = 6 * 3600;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const id = process.env.CF_TURN_KEY_ID, token = process.env.CF_TURN_API_TOKEN;
  if (!id || !token) { res.status(503).json({ iceServers: [], error: 'TURN not configured' }); return; }
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TTL }),
    });
    if (!r.ok) { res.status(502).json({ iceServers: [], error: `Cloudflare answered ${r.status}` }); return; }
    const j = await r.json();
    const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
    res.status(200).json({ iceServers: list, ttl: TTL });
  } catch (e) {
    res.status(502).json({ iceServers: [], error: String(e && e.message || e) });
  }
};
