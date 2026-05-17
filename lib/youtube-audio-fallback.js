const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const { fetchPlayerData, fetchWithTimeout } = require('./youtube-player');

const execFileAsync = promisify(execFile);

const AUDIO_DOWNLOAD_TIMEOUT_MS =
  Number(process.env.YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_MS) || 120000;
const WHISPER_TIMEOUT_MS = Number(process.env.YOUTUBE_WHISPER_TIMEOUT_MS) || 120000;
const WHISPER_MAX_BYTES = Number(process.env.YOUTUBE_WHISPER_MAX_BYTES) || 24 * 1024 * 1024;

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

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
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const err = new Error('Invalid media URL');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  if (parsed.protocol !== 'https:') {
    const err = new Error('Invalid media URL protocol');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  const host = normalizeHostname(parsed.hostname);
  const allowed =
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host.endsWith('.googlevideo.com');

  if (!allowed) {
    const err = new Error('Media URL host not allowed');
    err.code = 'errYoutubeExtractFailed';
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
    (f) =>
      f?.url &&
      (String(f.mimeType ?? '').startsWith('audio/') ||
        (f.audioQuality && !f.qualityLabel?.includes('p'))),
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

async function downloadAudioFromInnertube(videoId) {
  const player = await fetchPlayerData(videoId);
  const format = pickAudioFormat(player.streamingData);

  if (!format?.url) {
    const err = new Error('No audio stream available');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  const safeUrl = assertSafeYouTubeMediaUrl(format.url);
  const resp = await fetchWithTimeout(
    safeUrl,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SummifyBot/1.0)' },
    },
    AUDIO_DOWNLOAD_TIMEOUT_MS,
  );

  if (!resp.ok) {
    const err = new Error('Audio download failed');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > WHISPER_MAX_BYTES) {
    const err = new Error('Audio file too large for transcription');
    err.code = 'errYoutubeExtractFailed';
    throw err;
  }

  return {
    buffer,
    mimeType: format.mimeType ?? 'audio/mp4',
    extension: extensionFromMime(format.mimeType),
  };
}

async function downloadAudioWithYtDlp(canonicalUrl) {
  const ytdlp = process.env.YT_DLP_PATH || 'yt-dlp';
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'summify-yt-'));
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s');

  try {
    await execFileAsync(
      ytdlp,
      [
        '--no-playlist',
        '--no-warnings',
        '-f',
        'ba[ext=m4a]/ba/b',
        '-o',
        outTemplate,
        '--max-filesize',
        String(WHISPER_MAX_BYTES),
        canonicalUrl,
      ],
      { timeout: AUDIO_DOWNLOAD_TIMEOUT_MS },
    );

    const files = await fs.promises.readdir(tmpDir);
    const audioFile = files.find((f) => !f.endsWith('.part'));
    if (!audioFile) {
      const err = new Error('yt-dlp produced no audio file');
      err.code = 'errYoutubeExtractFailed';
      throw err;
    }

    const filePath = path.join(tmpDir, audioFile);
    const buffer = await fs.promises.readFile(filePath);
    if (buffer.length > WHISPER_MAX_BYTES) {
      const err = new Error('Audio file too large for transcription');
      err.code = 'errYoutubeExtractFailed';
      throw err;
    }

    const ext = path.extname(audioFile).slice(1) || 'm4a';
    const mimeType =
      ext === 'webm'
        ? 'audio/webm'
        : ext === 'mp3'
          ? 'audio/mpeg'
          : 'audio/mp4';

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

async function transcribeWithGroqWhisper({ buffer, extension, mimeType }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY is not configured');
    err.code = 'errYoutubeExtractFailed';
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
  form.append('response_format', 'json');

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
      err.code = 'errYoutubeExtractFailed';
      throw err;
    }

    const text = String(json?.text ?? '').trim();
    if (!text) {
      const err = new Error('Empty transcription');
      err.code = 'errYoutubeExtractFailed';
      throw err;
    }

    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Download YouTube audio and transcribe with Groq Whisper.
 */
async function transcribeYouTubeAudioFallback(videoId, canonicalUrl) {
  const { buffer, mimeType, extension } = await downloadYouTubeAudio(
    videoId,
    canonicalUrl,
  );

  return transcribeWithGroqWhisper({ buffer, mimeType, extension });
}

module.exports = {
  transcribeYouTubeAudioFallback,
  downloadYouTubeAudio,
};
