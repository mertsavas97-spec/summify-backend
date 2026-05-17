const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_USER_AGENT =
  'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

const FETCH_TIMEOUT_MS = Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS) || 25000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Innertube player response (ANDROID client) — captions, duration, streaming URLs.
 */
async function fetchPlayerData(videoId) {
  const resp = await fetchWithTimeout(INNERTUBE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': INNERTUBE_USER_AGENT,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
        },
      },
      videoId,
    }),
  });

  if (!resp.ok) {
    const err = new Error('YouTube player request failed');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  const data = await resp.json();
  const playability = data?.playabilityStatus?.status;

  if (playability && playability !== 'OK') {
    const reason = data?.playabilityStatus?.reason ?? playability;
    const err = new Error(reason);
    err.code =
      playability === 'LOGIN_REQUIRED' || playability === 'ERROR'
        ? 'errYoutubeVideoUnavailable'
        : 'errYoutubeVideoUnavailable';
    throw err;
  }

  return {
    captionTracks:
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null,
    videoDetails: data?.videoDetails ?? null,
    streamingData: data?.streamingData ?? null,
  };
}

function getDurationSeconds(videoDetails) {
  const raw = videoDetails?.lengthSeconds;
  const sec = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

module.exports = {
  fetchPlayerData,
  getDurationSeconds,
  fetchWithTimeout,
  INNERTUBE_USER_AGENT,
};
