const { YoutubeTranscript } = require('youtube-transcript');
const { fetchWithTimeout } = require('./youtube-player');

const FILLER_RE =
  /^\[[\s]*(music|applause|laughter|silence|intro|outro)[\s]*\]$/i;

function logProvider(logEvent, event, payload) {
  logEvent(event, payload);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function isAutoCaptionTrack(track) {
  if (!track) return false;
  if (track.kind === 'asr') return true;
  const vss = String(track.vssId ?? '');
  return vss.startsWith('a.') || vss.includes('.auto');
}

function scoreCaptionTrack(track) {
  let score = 0;
  const lang = String(track.languageCode ?? '').toLowerCase();
  if (!isAutoCaptionTrack(track)) score += 100;
  if (lang === 'en' || lang.startsWith('en-')) score += 50;
  if (lang.startsWith('tr')) score += 40;
  return score;
}

function rankCaptionTracks(tracks) {
  return [...tracks].sort((a, b) => scoreCaptionTrack(b) - scoreCaptionTrack(a));
}

async function fetchTranscriptXml(trackUrl) {
  const captionUrl = new URL(trackUrl);
  if (!captionUrl.hostname.endsWith('youtube.com')) {
    throw new Error('Invalid caption URL');
  }

  const resp = await fetchWithTimeout(trackUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; SummifyTranscriptBot/1.0; +https://summify.it)',
    },
  });

  if (!resp.ok) {
    throw new Error(`Caption fetch HTTP ${resp.status}`);
  }

  return resp.text();
}

function parseTranscriptXml(xml, lang) {
  const segments = [];
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match = pRegex.exec(xml);
  while (match) {
    let text = match[3].replace(/<[^>]+>/g, '');
    text = decodeEntities(text).trim();
    if (text) {
      segments.push({
        text,
        offset: parseInt(match[1], 10),
        duration: parseInt(match[2], 10),
        language: lang,
      });
    }
    match = pRegex.exec(xml);
  }

  if (segments.length) return segments;

  const classicRe = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  let classic = classicRe.exec(xml);
  while (classic) {
    const text = decodeEntities(classic[3]).trim();
    if (text) {
      segments.push({
        text,
        offset: Math.round(parseFloat(classic[1]) * 1000),
        duration: Math.round(parseFloat(classic[2]) * 1000),
        language: lang,
      });
    }
    classic = classicRe.exec(xml);
  }

  return segments;
}

function cleanSegments(segments) {
  const cleaned = [];
  let prevText = null;
  for (const seg of segments) {
    let text = String(seg.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || FILLER_RE.test(text)) continue;
    if (prevText && prevText.toLowerCase() === text.toLowerCase()) continue;
    prevText = text;
    cleaned.push({ ...seg, text });
  }
  return cleaned;
}

async function tryYoutubeTranscriptPackage(videoId, logEvent) {
  const provider = 'youtube-transcript-package';
  logProvider(logEvent, 'transcript_provider_attempt', { videoId, provider });

  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (!transcript || transcript.length === 0) {
      throw new Error('Empty transcript');
    }

    const segments = cleanSegments(
      transcript.map((t) => ({
        text: t.text,
        offset: t.offset,
        duration: t.duration,
        language: t.lang ?? 'en',
      })),
    );

    if (!segments.length) {
      throw new Error('Empty transcript');
    }

    const text = segments.map((t) => t.text).join(' ');

    logProvider(logEvent, 'transcript_provider_success', {
      videoId,
      provider,
      segmentCount: segments.length,
    });

    return {
      text,
      segments,
      language: transcript[0]?.lang ?? 'en',
      source: 'youtube-transcript-package',
      provider,
    };
  } catch (error) {
    logProvider(logEvent, 'transcript_provider_failed', {
      videoId,
      provider,
      reason: String(error?.message ?? error).slice(0, 160),
    });
    throw new Error(`youtube-transcript package failed: ${error.message}`);
  }
}

async function tryInnertubeCaptions(videoId, captionTracks, logEvent) {
  const provider = 'innertube_captions';
  logProvider(logEvent, 'transcript_provider_attempt', { videoId, provider });

  if (!captionTracks?.length) {
    logProvider(logEvent, 'transcript_provider_failed', {
      videoId,
      provider,
      reason: 'no_tracks',
    });
    return null;
  }

  const ranked = rankCaptionTracks(captionTracks);

  for (const track of ranked) {
    const lang = track.languageCode ?? 'en';
    try {
      const xml = await fetchTranscriptXml(track.baseUrl);
      const segments = cleanSegments(parseTranscriptXml(xml, lang));
      if (segments.length) {
        logProvider(logEvent, 'transcript_provider_success', {
          videoId,
          provider,
          language: lang,
          segmentCount: segments.length,
        });
        return { segments, language: lang, provider };
      }
    } catch (error) {
      logProvider(logEvent, 'transcript_provider_failed', {
        videoId,
        provider,
        language: lang,
        reason: String(error?.message ?? error).slice(0, 120),
      });
    }
  }

  return null;
}

async function tryYoutubeTranscriptApi(videoId, lang, logEvent) {
  const provider = `youtube_transcript_api_${lang}`;
  logProvider(logEvent, 'transcript_provider_attempt', { videoId, provider });

  try {
    const raw = await YoutubeTranscript.fetchTranscript(videoId, { lang });
    const segments = cleanSegments(
      raw.map((s) => ({
        text: s.text,
        offset: s.offset,
        duration: s.duration,
        language: s.lang ?? lang,
      })),
    );
    if (!segments.length) {
      throw new Error('Empty transcript');
    }
    logProvider(logEvent, 'transcript_provider_success', {
      videoId,
      provider,
      language: lang,
      segmentCount: segments.length,
    });
    return {
      segments,
      language: raw[0]?.lang ?? lang,
      provider,
    };
  } catch (error) {
    logProvider(logEvent, 'transcript_provider_failed', {
      videoId,
      provider,
      reason: String(error?.message ?? error).slice(0, 160),
    });
    return null;
  }
}

/**
 * Try transcript providers in order until one succeeds.
 */
async function fetchTranscriptWithProviders(videoId, captionTracks, logEvent) {
  const innertube = await tryInnertubeCaptions(videoId, captionTracks, logEvent);
  if (innertube) return innertube;

  const langCandidates = ['en', 'tr', 'de', 'fr', 'es', 'ar'];
  const trackLangs = (captionTracks ?? [])
    .map((t) => t.languageCode)
    .filter(Boolean);

  const orderedLangs = [
    ...new Set([...langCandidates, ...trackLangs]),
  ];

  for (const lang of orderedLangs) {
    const api = await tryYoutubeTranscriptApi(videoId, lang, logEvent);
    if (api) return api;
  }

  return null;
}

module.exports = {
  fetchTranscriptWithProviders,
  tryYoutubeTranscriptPackage,
  cleanSegments,
};
