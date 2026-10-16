// ZONEFALL dev/ui.html stand-in for net/session.js: diagnostics() returns window.__uiMock.diag when present.
export function diagnostics() {
  const m = window.__uiMock && window.__uiMock.diag;
  return m || { status: 'offline', transport: 'nostr', relaysOpen: 0, peers: [], hostId: null, isHost: true };
}
export const online = () => false;
