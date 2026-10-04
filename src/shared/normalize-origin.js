// Single origin→hostname normalizer shared by session records and site
// volume profiles. Accepts full HTTP(S) origins/URLs or bare hostnames and
// always returns "host" or "host:port" — never a full URL.
//
// Security rules: only HTTP(S) protocols; URLs carrying credentials are
// REJECTED outright (not stripped); malformed hosts, invalid ports,
// leading/trailing hyphens in labels and repeated dots are rejected.

const HOST_WITH_PORT = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*:\d{1,5}$/;
const HOST_BARE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function validHostWithPort(host) {
  const portText = host.slice(host.lastIndexOf(':') + 1);
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) return false;
  return HOST_WITH_PORT.test(host);
}

export function normalizeOrigin(value) {
  let raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('://') || raw.startsWith('//')) {
    let parsed;
    try {
      parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    } catch {
      return '';
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    if (parsed.username || parsed.password) return ''; // credentials rejected
    raw = parsed.host;
  } else if (/^[a-z][a-z0-9+.-]*:[^0-9]/.test(raw)) {
    // Looks like scheme-prefixed non-HTTP input (javascript:, data:, …).
    // A digit after the colon means host:port (example.com:8443), not a scheme.
    return '';
  }
  raw = raw.replace(/\.+$/, '');
  if (!raw || raw.includes(' ') || raw.includes('/')) return '';
  const hasPort = raw.includes(':');
  const valid = hasPort ? validHostWithPort(raw) : HOST_BARE.test(raw);
  if (!valid) return '';
  return raw.slice(0, 300);
}

export function hostnameOf(value) {
  const origin = normalizeOrigin(value);
  return origin ? origin.replace(/:\d{1,5}$/, '') : '';
}
