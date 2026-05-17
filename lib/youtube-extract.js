const { YoutubeTranscript } = require('youtube-transcript');
const { validateYouTubeUrl } = require('./youtube-url');
const {
  fetchPlayerData,
  getDurationSeconds,
  fetchWithTimeout,
} = require('./youtube-player');
const { transcribeYouTubeAudioFallback } = require('./youtube-audio-fallback');

const FETCH_TIMEOUT_MS = Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS) || 25000;
const TRANSCRIPT_MAX_CHARS = Number(process.env.YOUTUBE_MAX_CHARS) || 14000;
const TRANSCRIPT_MIN_CHARS = Number(process.env.YOUTUBE_MIN_CHARS) || 200;
const MAX_DURATION_SECONDS =
  Number(process.env.YOUTUBE_MAX_DURATION_SECONDS) || 20 * 60;

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

function formatDurationSeconds(seconds) {
  if (!seconds || seconds <= 0) return null;
  return formatTimestamp(seconds * 1000);
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

  const err = new Error('YouTube extraction failed');
  err.code = error?.code ?? 'errYoutubeExtractFailed';
  err.videoId = videoId;
  return err;
}

function isTranscriptUnavailableError(error) {
  return (
    error?.code === 'errYoutubeTranscriptUnavailable' ||
    /transcript unavailable|no transcripts|empty transcript|too short/i.test(
      String(error?.message ?? ''),
    )
  );
}

async function fetchTranscriptSegments(videoId, captionTracks) {
  let tracks = captionTracks;
  if (tracks === undefined) {
    const player = await fetchPlayerData(videoId);
    tracks = player.captionTracks;
  }

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
  };
}

function buildDocumentText({
  metadata,
  videoId,
  language,
  durationLabel,
  body,
  extractionNote,
}) {
  const header = [
    `Title: ${metadata.title}`,
    `Source: youtube.com`,
    `Channel: ${metadata.channel ?? 'unknown'}`,
    `Video ID: ${videoId}`,
    `Language: ${language}`,
    durationLabel ? `Duration: ${durationLabel}` : null,
    extractionNote ? `Extraction: ${extractionNote}` : null,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  return capTranscriptText(`${header}\n${body}`.trim());
}

async function tryExtractTranscript(
  videoId,
  metadata,
  durationSeconds,
  captionTracks,
) {
  try {
    const transcriptResult = await fetchTranscriptSegments(videoId, captionTracks);

    const cleaned = cleanSegments(transcriptResult.segments);
    if (!cleaned.length) {
      const err = new Error('No usable transcript text');
      err.code = 'errYoutubeTranscriptUnavailable';
      throw err;
    }

    const lastSeg = cleaned[cleaned.length - 1];
    const durationMs = (lastSeg.offset ?? 0) + (lastSeg.duration ?? 0);
    const durationLabel =
      durationSeconds > 0
        ? formatDurationSeconds(durationSeconds)
        : formatDuration(durationMs);

    const body = segmentsToText(cleaned, { includeTimestamps: true });
    const text = buildDocumentText({
      metadata,
      videoId,
      language: transcriptResult.language,
      durationLabel,
      body,
    });

    const extractedChars = text.length;
    if (extractedChars < TRANSCRIPT_MIN_CHARS) {
      const err = new Error('Transcript too short');
      err.code = 'errYoutubeTranscriptUnavailable';
      throw err;
    }

    return {
      videoId,
      title: metadata.title,
      channel: metadata.channel,
      duration: durationLabel,
      durationSeconds,
      language: transcriptResult.language,
      sourceDomain: 'youtube.com',
      text,
      segments: cleaned.map((s) => ({
        text: s.text,
        offset: s.offset,
        duration: s.duration,
      })),
      extractedChars,
      extractionMethod: 'backend_youtube_transcript',
      transcriptSource: 'captions',
    };
  } catch (error) {
    if (isTranscriptUnavailableError(error)) {
      return null;
    }
    throw error.code ? error : mapYoutubeError(error, videoId);
  }
}

async function extractViaAudioFallback(videoId, metadata, canonicalUrl, durationSeconds) {
  logEvent('youtube_audio_fallback_start', { videoId, durationSeconds });

  const fallbackStartedAt = Date.now();
  const rawTranscript = await transcribeYouTubeAudioFallback(videoId, canonicalUrl);
  const cleanedBody = rawTranscript.replace(/\s+/g, ' ').trim();

  if (cleanedBody.length < TRANSCRIPT_MIN_CHARS) {
    const err = new Error('Transcription too short');
    err.code = 'errYoutubeAnalysisFailed';
    throw err;
  }

  const durationLabel =
    durationSeconds > 0 ? formatDurationSeconds(durationSeconds) : null;

  const text = buildDocumentText({
    metadata,
    videoId,
    language: metadata.languageGuess ?? 'auto',
    durationLabel,
    body: cleanedBody,
    extractionNote: 'audio transcription (Whisper)',
  });

  logEvent('youtube_audio_fallback_done', {
    videoId,
    extractedChars: text.length,
    durationMs: Date.now() - fallbackStartedAt,
  });

  return {
    videoId,
    title: metadata.title,
    channel: metadata.channel,
    duration: durationLabel,
    durationSeconds,
    language: metadata.languageGuess ?? 'auto',
    sourceDomain: 'youtube.com',
    text,
    segments: [],
    extractedChars: text.length,
    extractionMethod: 'youtube_audio_whisper_fallback',
    transcriptSource: 'audio_fallback',
  };
}

/**
 * YouTube extraction: captions fast path, then audio + Whisper fallback.
 */
async function extractYouTubeContent(rawUrl) {
  const { videoId, canonicalUrl } = validateYouTubeUrl(rawUrl);
  const domain = 'youtube.com';

  logEvent('youtube_extract_start', { domain, url: canonicalUrl, videoId });

  const startedAt = Date.now();

  try {
    const [metadata, player] = await Promise.all([
      fetchVideoMetadata(videoId),
      fetchPlayerData(videoId),
    ]);

    const durationSeconds = getDurationSeconds(player.videoDetails);
    if (durationSeconds > MAX_DURATION_SECONDS) {
      const err = new Error('Video exceeds maximum duration');
      err.code = 'errYoutubeTooLongForFree';
      err.durationSeconds = durationSeconds;
      throw err;
    }

    if (player.videoDetails?.title) {
      metadata.title = player.videoDetails.title;
    }
    if (player.videoDetails?.author) {
      metadata.channel = player.videoDetails.author;
    }

    const transcriptResult = await tryExtractTranscript(
      videoId,
      metadata,
      durationSeconds,
      player.captionTracks,
    );

    if (transcriptResult) {
      logEvent('youtube_extract_done', {
        domain,
        videoId,
        title: metadata.title,
        language: transcriptResult.language,
        extractedChars: transcriptResult.extractedChars,
        extractionMethod: transcriptResult.extractionMethod,
        transcriptSource: transcriptResult.transcriptSource,
        durationSeconds,
        durationMs: Date.now() - startedAt,
      });
      return transcriptResult;
    }

    logEvent('youtube_transcript_unavailable', {
      domain,
      videoId,
      durationSeconds,
    });

    const audioResult = await extractViaAudioFallback(
      videoId,
      metadata,
      canonicalUrl,
      durationSeconds,
    );

    logEvent('youtube_extract_done', {
      domain,
      videoId,
      title: metadata.title,
      language: audioResult.language,
      extractedChars: audioResult.extractedChars,
      extractionMethod: audioResult.extractionMethod,
      transcriptSource: audioResult.transcriptSource,
      durationSeconds,
      durationMs: Date.now() - startedAt,
    });

    return audioResult;
  } catch (error) {
    const mapped = error.code ? error : mapYoutubeError(error, videoId);
    if (
      mapped.code === 'errYoutubeTranscriptUnavailable' ||
      mapped.code === 'errYoutubeExtractFailed'
    ) {
      mapped.code = 'errYoutubeAnalysisFailed';
    }
    logEvent('youtube_extract_failed', {
      domain,
      videoId,
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code ?? 'errYoutubeAnalysisFailed',
      message: mapped.message,
    });
    throw mapped;
  }
}

/** @deprecated Use extractYouTubeContent */
const extractYouTubeTranscript = extractYouTubeContent;

module.exports = {
  extractYouTubeContent,
  extractYouTubeTranscript,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MIN_CHARS,
  MAX_DURATION_SECONDS,
};
