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
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  if (parsed.pathname.startsWith('/shorts/')) {
    const id = parsed.pathname.split('/')[2];
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  if (parsed.pathname.startsWith('/embed/')) {
    const id = parsed.pathname.split('/')[2];
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
    const id = parsed.searchParams.get('v');
    return id && VIDEO_ID_RE.test(id) ? id : null;
  }

  const pathMatch = parsed.pathname.match(/\/(?:v|e(?:mbed)?)\/([^/?&]+)/);
  if (pathMatch && VIDEO_ID_RE.test(pathMatch[1])) {
    return pathMatch[1];
  }

  return null;
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

  const videoId = parseYouTubeVideoId(parsed.href);
  if (!videoId) {
    const err = new Error('Could not parse YouTube video ID');
    err.code = 'errYoutubeInvalidUrl';
    throw err;
  }

  return {
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

module.exports = {
  validateYouTubeUrl,
  parseYouTubeVideoId,
  isYouTubeHostname,
  VIDEO_ID_RE,
};
