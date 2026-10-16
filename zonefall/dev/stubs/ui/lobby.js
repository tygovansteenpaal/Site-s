// ZONEFALL dev/ui.html stand-in for net/lobby.js: get() returns window.__uiMock.lobby.
export function get() { return (window.__uiMock && window.__uiMock.lobby) || null; }
export function regionFromTimeZone() { return 'eu'; }
