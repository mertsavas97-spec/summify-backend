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
 * Only treat as hard-unavailable when metadata indicates the video cannot be accessed at all.
 * LOGIN_REQUIRED / CONTENT_CHECK / missing captions must NOT block audio fallback.
 */
function classifyVideoAvailability(playabilityStatus, playabilityReason, videoDetails) {
  const status = String(playabilityStatus ?? '').toUpperCase();
  const reason = String(playabilityReason ?? '').toLowerCase();
  const hasDetails = Boolean(videoDetails?.videoId && videoDetails?.title);

  const reasonSaysRemoved =
    /video unavailable|private video|this video is private|has been removed|not available|deleted|copyright|terminated|does not exist|sign in to confirm your age/.test(
      reason,
    );

  if (status === 'OK' || !status) {
    return { isTrulyUnavailable: false, isAvailable: true };
  }

  if (hasDetails && !reasonSaysRemoved) {
    return { isTrulyUnavailable: false, isAvailable: true, degradedPlayability: status };
  }

  if (
    status === 'ERROR' &&
    (reasonSaysRemoved || !hasDetails) &&
    /unavailable|private|removed|not exist|deleted/.test(reason)
  ) {
    return { isTrulyUnavailable: true, isAvailable: false };
  }

  if (hasDetails) {
    return { isTrulyUnavailable: false, isAvailable: true, degradedPlayability: status };
  }

  if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE') {
    return { isTrulyUnavailable: false, isAvailable: true, degradedPlayability: status };
  }

  return { isTrulyUnavailable: !hasDetails, isAvailable: hasDetails };
}

/**
 * Innertube player response — does not throw on non-OK playability (caller decides).
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
  const playability = data?.playabilityStatus ?? {};
  const playabilityStatus = playability.status ?? null;
  const playabilityReason = playability.reason ?? '';
  const videoDetails = data?.videoDetails ?? null;
  const availability = classifyVideoAvailability(
    playabilityStatus,
    playabilityReason,
    videoDetails,
  );

  return {
    captionTracks:
      data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null,
    videoDetails,
    streamingData: data?.streamingData ?? null,
    playabilityStatus,
    playabilityReason,
    isAvailable: availability.isAvailable,
    isTrulyUnavailable: availability.isTrulyUnavailable,
    degradedPlayability: availability.degradedPlayability ?? null,
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
  classifyVideoAvailability,
  fetchWithTimeout,
  INNERTUBE_USER_AGENT,
};
