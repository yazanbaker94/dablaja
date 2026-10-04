// Deterministic YouTube thumbnail derivation for locally saved sessions.
// The output is restricted to YouTube's image CDN and never accepts a caller-
// supplied image host. Non-YouTube and malformed URLs intentionally return an
// empty string so the library can use its bundled fallback asset.

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;
const PATH_VIDEO_PREFIXES = new Set(['embed', 'shorts', 'live']);

function cleanVideoId(value) {
  const id = String(value || '').trim();
  return VIDEO_ID_PATTERN.test(id) ? id : '';
}

function isYouTubeHost(hostname) {
  return hostname === 'youtube.com'
    || hostname.endsWith('.youtube.com')
    || hostname === 'youtube-nocookie.com'
    || hostname.endsWith('.youtube-nocookie.com');
}

export function youtubeVideoId(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (hostname === 'youtu.be') {
    return cleanVideoId(url.pathname.split('/').filter(Boolean)[0]);
  }
  if (!isYouTubeHost(hostname)) return '';

  const queryId = cleanVideoId(url.searchParams.get('v'));
  if (queryId) return queryId;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && PATH_VIDEO_PREFIXES.has(parts[0].toLowerCase())) {
    return cleanVideoId(parts[1]);
  }
  return '';
}

export function youtubeThumbnailUrl(value) {
  const videoId = youtubeVideoId(value);
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
}
