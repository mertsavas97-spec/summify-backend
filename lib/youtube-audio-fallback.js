const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const { fetchPlayerData, fetchWithTimeout } = require('./youtube-player');
const { EXTENDED_MAX_SECONDS } = require('./youtube-pipeline-constants');

const execFileAsync = promisify(execFile);

const AUDIO_DOWNLOAD_TIMEOUT_MS =
  Number(process.env.YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_MS) || 180000;
const WHISPER_TIMEOUT_MS = Number(process.env.YOUTUBE_WHISPER_TIMEOUT_MS) || 180000;
const WHISPER_MAX_BYTES = Number(process.env.YOUTUBE_WHISPER_MAX_BYTES) || 24 * 1024 * 1024;
const CHUNK_DURATION_SECONDS =
  Number(process.env.YOUTUBE_AUDIO_CHUNK_SECONDS) || 10 * 60;

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

const INNERTUBE_CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38' },
  { clientName: 'IOS', clientVersion: '19.45.4' },
  { clientName: 'WEB', clientVersion: '2.20250217.01.00' },
];

function logEvent(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

function normalizeHostname(hostname) {
  return String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

function assertSafeYouTubeMediaUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    const err = new Error('Invalid media URL protocol');
    err.code = 'errYoutubeAudioTranscriptionFailed';
    throw err;
  }
  const host = normalizeHostname(parsed.hostname);
  const allowed =
    host.endsWith('.googlevideo.com') ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com');
  if (!allowed) {
    const err = new Error('Media URL host not allowed');
    err.code = 'errYoutubeAudioTranscriptionFailed';
    throw err;
  }
  return parsed.href;
}

function pickAudioFormat(streamingData) {
  const formats = [
    ...(streamingData?.adaptiveFormats ?? []),
    ...(streamingData?.formats ?? []),
  ];

  const audioOnly = formats.filter(
    (f) => f?.url && String(f.mimeType ?? '').startsWith('audio/'),
  );

  if (!audioOnly.length) return null;

  return audioOnly.sort((a, b) => {
    const brA = parseInt(a.bitrate ?? a.averageBitrate ?? '0', 10) || 0;
    const brB = parseInt(b.bitrate ?? b.averageBitrate ?? '0', 10) || 0;
    return brA - brB;
  })[0];
}

function extensionFromMime(mimeType) {
  const mime = String(mimeType ?? '').toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'm4a';
}

async function fetchPlayerWithClient(videoId, client) {
  const resp = await fetchWithTimeout(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      },
      body: JSON.stringify({
        context: { client },
        videoId,
      }),
    },
    AUDIO_DOWNLOAD_TIMEOUT_MS,
  );

  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.streamingData ?? null;
}

async function downloadAudioFromInnertube(videoId) {
  let lastError = null;

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const streamingData =
        (await fetchPlayerWithClient(videoId, client)) ??
        (await fetchPlayerData(videoId)).streamingData;

      const format = pickAudioFormat(streamingData);
      if (!format?.url) {
        lastError = new Error('No audio stream in player response');
        continue;
      }

      const safeUrl = assertSafeYouTubeMediaUrl(format.url);
      const resp = await fetchWithTimeout(
        safeUrl,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SummifyBot/1.0)',
          },
        },
        AUDIO_DOWNLOAD_TIMEOUT_MS,
      );

      if (!resp.ok) {
        lastError = new Error(`Audio stream HTTP ${resp.status}`);
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      return {
        buffer,
        mimeType: format.mimeType ?? 'audio/mp4',
        extension: extensionFromMime(format.mimeType),
      };
    } catch (error) {
      lastError = error;
    }
  }

  const err = new Error(lastError?.message ?? 'Innertube audio download failed');
  err.code = 'errYoutubeAudioTranscriptionFailed';
  throw err;
}

async function downloadAudioWithYtDlp(canonicalUrl, section = null) {
  const ytdlp = process.env.YT_DLP_PATH || 'yt-dlp';
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'summify-yt-'));
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '-f',
    'ba[abr<=64]/ba[filesize<24M]/ba/b',
    '-o',
    outTemplate,
    '--max-filesize',
    String(WHISPER_MAX_BYTES),
  ];

  if (section) {
    args.push('--download-sections', section);
  }

  args.push(canonicalUrl);

  try {
    await execFileAsync(ytdlp, args, { timeout: AUDIO_DOWNLOAD_TIMEOUT_MS });

    const files = await fs.promises.readdir(tmpDir);
    const audioFile = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
    if (!audioFile) {
      const err = new Error('yt-dlp produced no audio file');
      err.code = 'errYoutubeAudioTranscriptionFailed';
      throw err;
    }

    const filePath = path.join(tmpDir, audioFile);
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(audioFile).slice(1) || 'm4a';
    const mimeType =
      ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

    return { buffer, mimeType, extension: ext };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadYouTubeAudio(videoId, canonicalUrl) {
  try {
    return await downloadAudioWithYtDlp(canonicalUrl);
  } catch (ytdlpError) {
    logEvent('youtube_audio_ytdlp_skipped', {
      videoId,
      message: String(ytdlpError?.message ?? ytdlpError).slice(0, 200),
    });
    return downloadAudioFromInnertube(videoId);
  }
}

async function transcribeBufferWithGroq({ buffer, extension, mimeType, languageHint }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY is not configured on server');
    err.code = 'errYoutubeAudioTranscriptionFailed';
    throw err;
  }

  const model = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';
  const filename = `youtube-audio.${extension || 'm4a'}`;

  const form = new FormData();
  form.append('file', buffer, {
    filename,
    contentType: mimeType ?? 'audio/mp4',
  });
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  if (languageHint && languageHint !== 'auto') {
    form.append('language', languageHint.slice(0, 2));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const resp = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      body: form,
      signal: controller.signal,
    });

    let json;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }

    if (!resp.ok) {
      const err = new Error(json?.error?.message ?? 'Whisper transcription failed');
      err.code = 'errYoutubeAudioTranscriptionFailed';
      throw err;
    }

    const text = String(json?.text ?? '').trim();
    if (!text) {
      const err = new Error('Empty transcription');
      err.code = 'errYoutubeAudioTranscriptionFailed';
      throw err;
    }

    const detectedLanguage = json?.language ?? languageHint ?? 'auto';
    logEvent('transcript_language_detected', {
      language: detectedLanguage,
      source: 'whisper',
    });

    return { text, language: detectedLanguage };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const err = new Error('Whisper request timed out');
      err.code = 'errYoutubeNetworkTimeout';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function transcribeSingleAudio(videoId, canonicalUrl, languageHint) {
  const { buffer, mimeType, extension } = await downloadYouTubeAudio(
    videoId,
    canonicalUrl,
  );

  if (buffer.length <= WHISPER_MAX_BYTES) {
    return transcribeBufferWithGroq({ buffer, mimeType, extension, languageHint });
  }

  return null;
}

async function transcribeChunkedAudio(videoId, canonicalUrl, durationSeconds, languageHint) {
  const texts = [];
  let detectedLanguage = languageHint ?? 'auto';
  const chunkCount = Math.ceil(durationSeconds / CHUNK_DURATION_SECONDS);

  for (let i = 0; i < chunkCount; i += 1) {
    const start = i * CHUNK_DURATION_SECONDS;
    const end = Math.min((i + 1) * CHUNK_DURATION_SECONDS, durationSeconds);
    const section = `*${start}-${end}`;

    logEvent('youtube_audio_chunk_start', { videoId, section, index: i, chunkCount });

    let chunk;
    try {
      chunk = await downloadAudioWithYtDlp(canonicalUrl, section);
    } catch (error) {
      logEvent('youtube_audio_chunk_failed', {
        videoId,
        section,
        reason: String(error?.message ?? error).slice(0, 120),
      });
      continue;
    }

    const result = await transcribeBufferWithGroq({
      buffer: chunk.buffer,
      mimeType: chunk.mimeType,
      extension: chunk.extension,
      languageHint: detectedLanguage !== 'auto' ? detectedLanguage : languageHint,
    });

    texts.push(result.text);
    if (result.language) detectedLanguage = result.language;
  }

  if (!texts.length) {
    const err = new Error('Chunked audio transcription produced no text');
    err.code = 'errYoutubeAudioTranscriptionFailed';
    throw err;
  }

  return { text: texts.join('\n\n'), language: detectedLanguage };
}

/**
 * Download YouTube audio and transcribe with Groq Whisper (chunked when needed).
 */
async function transcribeYouTubeAudioFallback(
  videoId,
  canonicalUrl,
  { durationSeconds = 0, languageHint = null } = {},
) {
  logEvent('youtube_audio_fallback_started', { videoId, durationSeconds });

  const startedAt = Date.now();

  try {
    let result;

    const needsChunking =
      durationSeconds > CHUNK_DURATION_SECONDS &&
      durationSeconds <= EXTENDED_MAX_SECONDS;

    if (needsChunking) {
      result = await transcribeChunkedAudio(
        videoId,
        canonicalUrl,
        durationSeconds,
        languageHint,
      );
    } else {
      const single = await transcribeSingleAudio(videoId, canonicalUrl, languageHint);
      if (single) {
        result = single;
      } else if (durationSeconds > 0) {
        result = await transcribeChunkedAudio(
          videoId,
          canonicalUrl,
          durationSeconds,
          languageHint,
        );
      } else {
        const err = new Error('Audio file too large and duration unknown');
        err.code = 'errYoutubeAudioTranscriptionFailed';
        throw err;
      }
    }

    logEvent('youtube_audio_fallback_success', {
      videoId,
      durationSeconds,
      language: result.language,
      extractedChars: result.text.length,
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (error) {
    logEvent('youtube_audio_fallback_failed', {
      videoId,
      durationSeconds,
      errorCode: error?.code ?? 'errYoutubeAudioTranscriptionFailed',
      message: String(error?.message ?? error).slice(0, 200),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

module.exports = {
  transcribeYouTubeAudioFallback,
  downloadYouTubeAudio,
};
