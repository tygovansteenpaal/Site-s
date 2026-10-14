// ZONEFALL - persisted user settings. OWNER: LEAD. Complete.
// Read with get(); change with set() (emits SETTINGS_CHANGED). UI/settings panels call set(); renderer, audio,
// input and camera listen for SETTINGS_CHANGED.
import { SETTINGS_DEFAULTS, SETTINGS_LIMITS, DEV } from '../config.js';
import { emit, EV } from './bus.js';
import { storage, clamp } from './util.js';
import { state } from './state.js';

const KEY = 'zonefall.settings.v1';
const values = { ...SETTINGS_DEFAULTS };

function sanitize(key, value) {
  const def = SETTINGS_DEFAULTS[key];
  if (def === undefined) throw new Error(`[settings] unknown setting '${key}'`);
  if (typeof def === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    const lim = SETTINGS_LIMITS[key];
    return lim ? clamp(n, lim[0], lim[1]) : n;
  }
  if (typeof def === 'boolean') return !!value;
  if (key === 'quality') return ['auto', 'low', 'medium', 'high'].includes(value) ? value : 'auto';
  if (key === 'name') return String(value || '').replace(/[^\w .\-]/g, '').trim().slice(0, 16);
  return value;
}

/** Load saved settings (call once at boot, before renderer/audio init). */
export function load() {
  const saved = storage.get(KEY, {});
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(SETTINGS_DEFAULTS)) if (k in saved) values[k] = sanitize(k, saved[k]);
  }
  if (DEV.name) values.name = sanitize('name', DEV.name);
  if (DEV.mute) values.muted = true;
  if (!values.name) values.name = 'Operator-' + Math.floor(1000 + Math.random() * 9000);
  state.name = values.name;
  return { ...values };
}

export const get = (key) => {
  if (!(key in values)) throw new Error(`[settings] unknown setting '${key}'`);
  return values[key];
};

export const all = () => ({ ...values });

export function set(key, value) {
  const v = sanitize(key, value);
  if (values[key] === v) return v;
  values[key] = v;
  if (key === 'name') state.name = v || state.name;
  storage.set(KEY, values);
  emit(EV.SETTINGS_CHANGED, { key, value: v });
  return v;
}

export function reset() {
  for (const k of Object.keys(SETTINGS_DEFAULTS)) if (k !== 'name') set(k, SETTINGS_DEFAULTS[k]);
}
