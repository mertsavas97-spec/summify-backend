const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'www.youtube.com',
]);

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

function normalizeHostname(hostname) {
  return String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

function isYouTubeHostname(hostname) {
  const host = normalizeHostname(hostname);
  return YOUTUBE_HOSTS.has(host) || host.endsWith('.youtube.com');
}

/**
 * Sanitize a candidate ID segment (strip query/hash fragments if embedded).
 */
function sanitizeVideoIdSegment(segment) {
  if (!segment) return null;
  const cleaned = String(segment)
    .trim()
    .split(/[?#&]/)[0]
    .trim();
  return VIDEO_ID_RE.test(cleaned) ? cleaned : null;
}

/**
 * Extract 11-char video ID from supported YouTube URL shapes.
 */
function parseYouTubeVideoId(rawUrl) {
  let parsed;
  try {
    parsed = new URL(
      String(rawUrl).trim().includes('://')
        ? String(rawUrl).trim()
        : `https://${String(rawUrl).trim()}`,
    );
  } catch {
    return null;
  }

  if (!isYouTubeHostname(parsed.hostname)) {
    return null;
  }

  const host = normalizeHostname(parsed.hostname);

  if (host === 'youtu.be') {
    const pathId = parsed.pathname.split('/').filter(Boolean)[0];
    const fromPath = sanitizeVideoIdSegment(pathId);
    if (fromPath) return fromPath;
    const fromQuery = sanitizeVideoIdSegment(parsed.searchParams.get('v'));
    if (fromQuery) return fromQuery;
    return null;
  }

  const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?#&]+)/);
  if (shortsMatch) {
    return sanitizeVideoIdSegment(shortsMatch[1]);
  }

  const embedMatch = parsed.pathname.match(/^\/embed\/([^/?#&]+)/);
  if (embedMatch) {
    return sanitizeVideoIdSegment(embedMatch[1]);
  }

  if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
    return sanitizeVideoIdSegment(parsed.searchParams.get('v'));
  }

  const pathMatch = parsed.pathname.match(/\/(?:v|e(?:mbed)?)\/([^/?#&]+)/);
  if (pathMatch) {
    return sanitizeVideoIdSegment(pathMatch[1]);
  }

  return sanitizeVideoIdSegment(parsed.searchParams.get('v'));
}

/**
 * Canonical watch URL for a validated video ID.
 */
function buildCanonicalYouTubeUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Normalize any supported YouTube URL to canonical watch form.
 */
function normalizeYouTubeUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  const originalUrl = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  const videoId = parseYouTubeVideoId(originalUrl);
  if (!videoId) {
    return { originalUrl, normalizedUrl: originalUrl, videoId: null };
  }
  return {
    originalUrl,
    normalizedUrl: buildCanonicalYouTubeUrl(videoId),
    videoId,
  };
}

/**
 * Validate YouTube URL and return canonical watch URL + video ID.
 */
function validateYouTubeUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    const err = new Error('Invalid YouTube URL');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    const err = new Error('Invalid YouTube URL');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('Invalid YouTube URL');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  if (parsed.username || parsed.password) {
    const err = new Error('Invalid YouTube URL');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  if (!isYouTubeHostname(parsed.hostname)) {
    const err = new Error('Not a YouTube URL');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  const videoId = parseYouTubeVideoId(trimmed);
  if (!videoId) {
    const err = new Error('Could not parse YouTube video ID');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  return {
    videoId,
    canonicalUrl: buildCanonicalYouTubeUrl(videoId),
    originalUrl: trimmed,
  };
}

module.exports = {
  validateYouTubeUrl,
  parseYouTubeVideoId,
  normalizeYouTubeUrl,
  buildCanonicalYouTubeUrl,
  isYouTubeHostname,
  sanitizeVideoIdSegment,
  VIDEO_ID_RE,
};
