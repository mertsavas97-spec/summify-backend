const { YoutubeTranscript } = require('youtube-transcript');
const { validateYouTubeUrl } = require('./youtube-url');

const FETCH_TIMEOUT_MS = Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS) || 25000;
const TRANSCRIPT_MAX_CHARS = Number(process.env.YOUTUBE_MAX_CHARS) || 14000;
const TRANSCRIPT_MIN_CHARS = Number(process.env.YOUTUBE_MIN_CHARS) || 200;

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_USER_AGENT =
  'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

const FILLER_RE =
  /^\[[\s]*(music|applause|laughter|silence|intro|outro)[\s]*\]$/i;

function logEvent(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function formatTimestamp(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  return formatTimestamp(ms);
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
  if (track.isTranslatable) score += 2;

  return score;
}

function selectBestCaptionTrack(tracks) {
  if (!tracks?.length) return null;

  const englishManual = tracks.find(
    (t) =>
      !isAutoCaptionTrack(t) &&
      String(t.languageCode ?? '').toLowerCase().startsWith('en'),
  );
  if (englishManual) return englishManual;

  const anyManual = tracks.find((t) => !isAutoCaptionTrack(t));
  if (anyManual) return anyManual;

  const englishAuto = tracks.find((t) =>
    String(t.languageCode ?? '').toLowerCase().startsWith('en'),
  );
  if (englishAuto) return englishAuto;

  return [...tracks].sort((a, b) => scoreCaptionTrack(b) - scoreCaptionTrack(a))[0];
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCaptionTracks(videoId) {
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

  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
}

async function fetchTranscriptXml(trackUrl) {
  const captionUrl = new URL(trackUrl);
  if (!captionUrl.hostname.endsWith('youtube.com')) {
    const err = new Error('Invalid caption URL');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  const resp = await fetchWithTimeout(trackUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; SummifyTranscriptBot/1.0; +https://summify.it)',
    },
  });

  if (!resp.ok) {
    const err = new Error('Caption fetch failed');
    err.code = 'errYoutubeTranscriptUnavailable';
    throw err;
  }

  return resp.text();
}

function parseTranscriptXml(xml, lang) {
  const segments = [];

  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match = pRegex.exec(xml);
  while (match) {
    const offset = parseInt(match[1], 10);
    const duration = parseInt(match[2], 10);
    let text = match[3].replace(/<[^>]+>/g, '');
    text = decodeEntities(text).trim();
    if (text) {
      segments.push({ text, offset, duration, language: lang });
    }
    match = pRegex.exec(xml);
  }

  if (segments.length) return segments;

  const classicRe = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  let classic = classicRe.exec(xml);
  while (classic) {
    const offset = Math.round(parseFloat(classic[1]) * 1000);
    const duration = Math.round(parseFloat(classic[2]) * 1000);
    const text = decodeEntities(classic[3]).trim();
    if (text) {
      segments.push({ text, offset, duration, language: lang });
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

function segmentsToText(segments, { includeTimestamps = true } = {}) {
  const lines = [];
  let paragraph = [];
  let lastOffset = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      lines.push(paragraph.join(' '));
      paragraph = [];
    }
  };

  for (const seg of segments) {
    const gap = seg.offset - lastOffset;
    if (paragraph.length && gap > 8000) {
      flushParagraph();
    }

    if (includeTimestamps && seg.offset != null) {
      const line = `[${formatTimestamp(seg.offset)}] ${seg.text}`;
      if (gap > 8000) {
        lines.push(line);
      } else {
        paragraph.push(line);
      }
    } else {
      paragraph.push(seg.text);
    }
    lastOffset = seg.offset + (seg.duration ?? 0);
  }

  flushParagraph();
  return lines.join('\n\n');
}

function capTranscriptText(text, maxChars = TRANSCRIPT_MAX_CHARS) {
  if (!text || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.35);
  const tail = Math.floor(maxChars * 0.25);
  return [
    text.slice(0, head),
    '\n\n[··· middle of transcript omitted for analysis ···]\n\n',
    text.slice(-tail),
  ].join('');
}

async function fetchVideoMetadata(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const resp = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`,
      {
        headers: { Accept: 'application/json' },
      },
    );
    if (!resp.ok) return { title: videoId, channel: null };
    const data = await resp.json();
    return {
      title: data.title ?? videoId,
      channel: data.author_name ?? null,
    };
  } catch {
    return { title: videoId, channel: null };
  }
}

function mapYoutubeError(error, videoId) {
  const name = error?.constructor?.name ?? '';
  const message = String(error?.message ?? '');

  if (name.includes('VideoUnavailable') || /no longer available/i.test(message)) {
    const err = new Error('Video unavailable');
    err.code = 'errYoutubeVideoUnavailable';
    return err;
  }
  if (
    name.includes('NotAvailable') ||
    name.includes('Disabled') ||
    /no transcripts/i.test(message)
  ) {
    const err = new Error('Transcript unavailable');
    err.code = 'errYoutubeTranscriptUnavailable';
    return err;
  }
  if (name.includes('TooManyRequest')) {
    const err = new Error('YouTube rate limited');
    err.code = 'errYoutubeExtractFailed';
    return err;
  }

  const err = new Error('YouTube transcript extraction failed');
  err.code = 'errYoutubeExtractFailed';
  err.videoId = videoId;
  return err;
}

async function fetchTranscriptSegments(videoId) {
  let tracks = await fetchCaptionTracks(videoId);
  let track = selectBestCaptionTrack(tracks);

  if (!track) {
    const fallback = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    return {
      segments: fallback.map((s) => ({
        text: s.text,
        offset: s.offset,
        duration: s.duration,
        language: s.lang ?? 'en',
      })),
      language: fallback[0]?.lang ?? 'en',
      extractionMethod: 'youtube_transcript',
    };
  }

  const lang = track.languageCode ?? 'en';
  const xml = await fetchTranscriptXml(track.baseUrl);
  const segments = parseTranscriptXml(xml, lang);

  if (!segments.length) {
    const err = new Error('Empty transcript');
    err.code = 'errYoutubeTranscriptUnavailable';
    throw err;
  }

  return {
    segments,
    language: lang,
    extractionMethod: 'youtube_transcript',
  };
}

/**
 * Full YouTube transcript extraction pipeline.
 */
async function extractYouTubeTranscript(rawUrl) {
  const { videoId, canonicalUrl } = validateYouTubeUrl(rawUrl);
  const domain = 'youtube.com';

  logEvent('youtube_extract_start', { domain, url: canonicalUrl });
  logEvent('youtube_video_id_detected', { domain, videoId });

  const startedAt = Date.now();

  try {
    const [metadata, transcriptResult] = await Promise.all([
      fetchVideoMetadata(videoId),
      fetchTranscriptSegments(videoId),
    ]);

    const cleaned = cleanSegments(transcriptResult.segments);
    if (!cleaned.length) {
      const err = new Error('No usable transcript text');
      err.code = 'errYoutubeTranscriptUnavailable';
      throw err;
    }

    const lastSeg = cleaned[cleaned.length - 1];
    const durationMs = (lastSeg.offset ?? 0) + (lastSeg.duration ?? 0);

    const body = segmentsToText(cleaned, { includeTimestamps: true });
    const header = [
      `Title: ${metadata.title}`,
      `Source: youtube.com`,
      `Channel: ${metadata.channel ?? 'unknown'}`,
      `Video ID: ${videoId}`,
      `Language: ${transcriptResult.language}`,
      durationMs ? `Duration: ${formatDuration(durationMs)}` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n');

    let text = capTranscriptText(`${header}\n${body}`.trim());
    const extractedChars = text.length;

    if (extractedChars < TRANSCRIPT_MIN_CHARS) {
      const err = new Error('Transcript too short');
      err.code = 'errYoutubeTranscriptUnavailable';
      throw err;
    }

    logEvent('youtube_transcript_done', {
      domain,
      videoId,
      title: metadata.title,
      language: transcriptResult.language,
      extractedChars,
      segmentCount: cleaned.length,
      durationMs: Date.now() - startedAt,
      extractionMethod: transcriptResult.extractionMethod,
    });

    return {
      videoId,
      title: metadata.title,
      channel: metadata.channel,
      duration: formatDuration(durationMs),
      language: transcriptResult.language,
      sourceDomain: 'youtube.com',
      text,
      segments: cleaned.map((s) => ({
        text: s.text,
        offset: s.offset,
        duration: s.duration,
      })),
      extractedChars,
      extractionMethod: transcriptResult.extractionMethod,
    };
  } catch (error) {
    const mapped = error.code ? error : mapYoutubeError(error, videoId);
    logEvent('youtube_extract_failed', {
      domain,
      videoId,
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code ?? 'errYoutubeExtractFailed',
      message: mapped.message,
    });
    throw mapped;
  }
}

module.exports = {
  extractYouTubeTranscript,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MIN_CHARS,
};
