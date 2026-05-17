const { fetchWithTimeout } = require('./youtube-player');

async function fetchVideoMetadata(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const resp = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      { headers: { Accept: 'application/json' } },
    );
    if (!resp.ok) {
      return { title: videoId, channel: null, thumbnail };
    }
    const data = await resp.json();
    return {
      title: data.title ?? videoId,
      channel: data.author_name ?? null,
      thumbnail,
    };
  } catch {
    return { title: videoId, channel: null, thumbnail };
  }
}

function mapPlayabilityToError(playabilityStatus, playabilityReason, videoDetails) {
  const status = String(playabilityStatus ?? '').toUpperCase();
  const reason = String(playabilityReason ?? '').toLowerCase();
  const hasDetails = Boolean(videoDetails?.videoId);

  if (/age|confirm your age|adult/i.test(reason)) {
    const err = new Error('Age restricted');
    err.code = 'errYoutubeAgeRestricted';
    return err;
  }

  if (/not available in your country|region|geo|country/i.test(reason)) {
    const err = new Error('Region blocked');
    err.code = 'errYoutubeRegionBlocked';
    return err;
  }

  if (
    /private|unavailable|removed|deleted|copyright|terminated|not exist/i.test(reason) &&
    !hasDetails
  ) {
    const err = new Error('Video unavailable');
    err.code = 'errYoutubeVideoUnavailable';
    return err;
  }

  if (status === 'ERROR' && !hasDetails) {
    const err = new Error('Video unavailable');
    err.code = 'errYoutubeVideoUnavailable';
    return err;
  }

  return null;
}

module.exports = {
  fetchVideoMetadata,
  mapPlayabilityToError,
};
