const { normalizeYouTubeUrl } = require('./youtube-url');
const { fetchPlayerData, getDurationSeconds } = require('./youtube-player');
const { fetchVideoMetadata, mapPlayabilityToError } = require('./youtube-metadata');
const {
  fetchTranscriptWithProviders,
  tryYoutubeTranscriptPackage,
  cleanSegments,
} = require('./youtube-transcript-providers');
const { transcribeYouTubeAudioFallback } = require('./youtube-audio-fallback');
const {
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MIN_CHARS,
  getDurationTier,
} = require('./youtube-pipeline-constants');

function logEvent(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
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

function formatDurationSeconds(seconds) {
  if (!seconds || seconds <= 0) return null;
  return formatTimestamp(seconds * 1000);
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
    if (paragraph.length && gap > 8000) flushParagraph();

    if (includeTimestamps && seg.offset != null) {
      const line = `[${formatTimestamp(seg.offset)}] ${seg.text}`;
      if (gap > 8000) lines.push(line);
      else paragraph.push(line);
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
    '\n\n[··· middle omitted for analysis ···]\n\n',
    text.slice(-tail),
  ].join('');
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

function buildSuccessPayload({
  videoId,
  metadata,
  durationSeconds,
  language,
  text,
  segments,
  extractionMethod,
  transcriptSource,
  processingTier,
  transcriptProvider,
}) {
  const durationLabel = formatDurationSeconds(durationSeconds);

  return {
    success: true,
    videoId,
    title: metadata.title,
    channel: metadata.channel,
    thumbnail: metadata.thumbnail,
    duration: durationLabel,
    durationSeconds,
    language,
    sourceDomain: 'youtube.com',
    text,
    segments: segments ?? [],
    extractedChars: text.length,
    extractionMethod,
    transcriptSource,
    processingTier,
    transcriptProvider,
  };
}

/**
 * Stage 2 — transcript/caption providers (never throws on missing captions).
 */
async function tryYouTubeTranscriptProviders({
  videoId,
  metadata,
  durationSeconds,
  captionTracks,
}) {
  let transcript = null;

  try {
    const pkg = await tryYoutubeTranscriptPackage(videoId, logEvent);
    if (pkg?.segments?.length) {
      transcript = {
        segments: pkg.segments,
        language: pkg.language,
        provider: pkg.provider,
      };
    }
  } catch {
    // fall through to innertube / per-language providers
  }

  if (!transcript) {
    transcript = await fetchTranscriptWithProviders(videoId, captionTracks, logEvent);
  }

  if (!transcript?.segments?.length) {
    return {
      success: false,
      errorKey: 'errYoutubeTranscriptUnavailable',
      reason: 'no_captions_from_providers',
      stage: 'transcript',
    };
  }

  const cleaned = cleanSegments(transcript.segments);
  if (!cleaned.length) {
    return {
      success: false,
      errorKey: 'errYoutubeTranscriptUnavailable',
      reason: 'empty_cleaned_segments',
      stage: 'transcript',
    };
  }

  const body = segmentsToText(cleaned, { includeTimestamps: true });
  const text = buildDocumentText({
    metadata,
    videoId,
    language: transcript.language,
    durationLabel: formatDurationSeconds(durationSeconds),
    body,
    extractionNote: transcript.provider ?? 'captions',
  });

  if (text.length < TRANSCRIPT_MIN_CHARS) {
    return {
      success: false,
      errorKey: 'errYoutubeTranscriptUnavailable',
      reason: 'transcript_too_short',
      stage: 'transcript',
    };
  }

  const isPackageProvider = transcript.provider === 'youtube-transcript-package';

  logEvent('transcript_language_detected', {
    videoId,
    language: transcript.language,
    source: isPackageProvider ? 'youtube-transcript-package' : 'captions',
  });

  return {
    success: true,
    method: isPackageProvider ? 'transcript' : 'captions',
    text,
    language: transcript.language,
    segments: cleaned,
    extractionMethod: isPackageProvider ? 'transcript' : 'backend_youtube_transcript',
    transcriptSource: isPackageProvider ? 'youtube-transcript-package' : 'captions',
    transcriptProvider: transcript.provider,
    processingTier: getDurationTier(durationSeconds),
  };
}

/**
 * Stage 3 — audio download + Groq Whisper (real path in youtube-audio-fallback.js).
 */
async function tryYouTubeAudioFallback({
  videoId,
  metadata,
  canonicalUrl,
  durationSeconds,
  transcriptErrorKey,
}) {
  logEvent('youtube_audio_fallback_started', {
    videoId,
    durationSeconds,
    reason: transcriptErrorKey || 'captions_unavailable',
  });

  try {
    const whisper = await transcribeYouTubeAudioFallback(videoId, canonicalUrl, {
      durationSeconds,
      languageHint: null,
    });

    const body = String(whisper.text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) {
      logEvent('youtube_audio_fallback_failed', {
        videoId,
        errorKey: 'errYoutubeAudioFallbackFailed',
        reason: 'empty_whisper_text',
      });
      return {
        success: false,
        errorKey: 'errYoutubeAudioFallbackFailed',
        reason: 'empty_whisper_text',
        stage: 'audio',
      };
    }

    const text = buildDocumentText({
      metadata,
      videoId,
      language: whisper.language ?? 'auto',
      durationLabel: formatDurationSeconds(durationSeconds),
      body,
      extractionNote: 'audio transcription (Whisper)',
    });

    if (text.length < TRANSCRIPT_MIN_CHARS) {
      logEvent('youtube_audio_fallback_failed', {
        videoId,
        errorKey: 'errYoutubeAudioFallbackFailed',
        reason: 'audio_transcript_too_short',
      });
      return {
        success: false,
        errorKey: 'errYoutubeAudioFallbackFailed',
        reason: 'audio_transcript_too_short',
        stage: 'audio',
      };
    }

    logEvent('youtube_audio_fallback_success', {
      videoId,
      language: whisper.language,
      extractedChars: text.length,
    });

    return {
      success: true,
      method: 'audio_fallback',
      text,
      language: whisper.language ?? 'auto',
      segments: [],
      extractionMethod: 'youtube_audio_whisper',
      transcriptSource: 'audio_fallback',
      transcriptProvider: 'whisper',
      processingTier: getDurationTier(durationSeconds),
    };
  } catch (error) {
    const errorKey =
      error?.code === 'errYoutubeNetworkTimeout'
        ? 'errYoutubeNetworkTimeout'
        : error?.code === 'errYoutubeBotVerificationRequired'
          ? 'errYoutubeBotVerificationRequired'
          : 'errYoutubeAudioFallbackFailed';

    logEvent('youtube_audio_fallback_failed', {
      videoId,
      errorKey,
      reason: String(error?.message ?? error).slice(0, 200),
    });

    return {
      success: false,
      errorKey,
      reason: String(error?.message ?? error).slice(0, 200),
      stage: 'audio',
    };
  }
}

/**
 * Full pipeline: normalize → metadata → transcript → audio → structured failure.
 */
async function extractYouTubeTextWithFallback(rawUrl) {
  const normalized = normalizeYouTubeUrl(rawUrl);
  if (!normalized.videoId) {
    const err = new Error('Could not parse YouTube video ID');
    err.code = 'errYoutubeInvalidUrl';
    err.stage = 'normalize';
    throw err;
  }

  const { videoId, canonicalUrl, originalUrl } = {
    videoId: normalized.videoId,
    canonicalUrl: normalized.normalizedUrl,
    originalUrl: normalized.originalUrl,
  };

  const startedAt = Date.now();

  logEvent('youtube_pipeline_start', {
    originalUrl,
    normalizedUrl: canonicalUrl,
    videoId,
  });
  logEvent('youtube_extract_start', { url: canonicalUrl, originalUrl });
  logEvent('youtube_video_id_detected', { videoId, originalUrl });

  const [metadata, player] = await Promise.all([
    fetchVideoMetadata(videoId),
    fetchPlayerData(videoId),
  ]);

  const durationSeconds = getDurationSeconds(player.videoDetails);
  const processingTier = getDurationTier(durationSeconds);

  if (player.videoDetails?.title) metadata.title = player.videoDetails.title;
  if (player.videoDetails?.author) metadata.channel = player.videoDetails.author;

  logEvent('youtube_metadata_checked', {
    videoId,
    title: metadata.title,
    duration: durationSeconds,
    thumbnail: metadata.thumbnail,
    isAvailable: player.isAvailable !== false,
    isTrulyUnavailable: player.isTrulyUnavailable === true,
    playabilityStatus: player.playabilityStatus,
    processingTier,
  });

  const playabilityError = mapPlayabilityToError(
    player.playabilityStatus,
    player.playabilityReason,
    player.videoDetails,
  );
  if (playabilityError) {
    const hardBlock =
      playabilityError.code === 'errYoutubeAgeRestricted' ||
      playabilityError.code === 'errYoutubeRegionBlocked' ||
      player.isTrulyUnavailable;
    if (hardBlock) {
      playabilityError.stage = 'metadata';
      playabilityError.videoId = videoId;
      throw playabilityError;
    }
  }

  if (processingTier === 'too_long') {
    const err = new Error('Video exceeds maximum supported duration');
    err.code = 'errYoutubeVideoTooLong';
    err.stage = 'metadata';
    err.videoId = videoId;
    err.durationSeconds = durationSeconds;
    throw err;
  }

  const transcriptResult = await tryYouTubeTranscriptProviders({
    videoId,
    metadata,
    durationSeconds,
    captionTracks: player.captionTracks,
  });

  if (transcriptResult.success && transcriptResult.text?.trim().length >= TRANSCRIPT_MIN_CHARS) {
    const payload = buildSuccessPayload({
      videoId,
      metadata,
      durationSeconds,
      language: transcriptResult.language,
      text: transcriptResult.text,
      segments: transcriptResult.segments,
      extractionMethod: transcriptResult.extractionMethod,
      transcriptSource: transcriptResult.transcriptSource,
      processingTier: transcriptResult.processingTier,
      transcriptProvider: transcriptResult.transcriptProvider,
    });

    logEvent('youtube_pipeline_completed', {
      videoId,
      method: transcriptResult.method ?? 'captions',
      extractionMethod: payload.extractionMethod,
      transcriptSource: payload.transcriptSource,
      extractedChars: payload.extractedChars,
      durationMs: Date.now() - startedAt,
    });

    return payload;
  }

  const audioResult = await tryYouTubeAudioFallback({
    videoId,
    metadata,
    canonicalUrl,
    durationSeconds,
    transcriptErrorKey: transcriptResult.errorKey,
  });

  if (audioResult.success && audioResult.text?.trim().length >= TRANSCRIPT_MIN_CHARS) {
    const payload = buildSuccessPayload({
      videoId,
      metadata,
      durationSeconds,
      language: audioResult.language,
      text: audioResult.text,
      segments: audioResult.segments,
      extractionMethod: audioResult.extractionMethod,
      transcriptSource: audioResult.transcriptSource,
      processingTier: audioResult.processingTier,
      transcriptProvider: audioResult.transcriptProvider,
    });

    logEvent('youtube_pipeline_completed', {
      videoId,
      method: 'audio_fallback',
      extractionMethod: payload.extractionMethod,
      extractedChars: payload.extractedChars,
      durationMs: Date.now() - startedAt,
    });

    return payload;
  }

  logEvent('youtube_pipeline_failed', {
    videoId,
    transcriptError: transcriptResult.errorKey,
    audioError: audioResult.errorKey,
    durationMs: Date.now() - startedAt,
  });

  const finalKey =
    audioResult.errorKey ||
    transcriptResult.errorKey ||
    'errYoutubeAnalysisFailed';

  const err = new Error(finalKey);
  err.code = finalKey;
  err.stage = audioResult.stage || transcriptResult.stage || 'pipeline';
  err.videoId = videoId;
  err.reason = audioResult.reason || transcriptResult.reason;
  err.transcriptErrorKey = transcriptResult.errorKey;
  err.audioErrorKey = audioResult.errorKey;
  throw err;
}

module.exports = {
  extractYouTubeTextWithFallback,
  tryYouTubeTranscriptProviders,
  tryYouTubeAudioFallback,
  logEvent,
  TRANSCRIPT_MIN_CHARS,
};
