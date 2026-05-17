const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const FormData = require('form-data');
const ytdl = require('@distube/ytdl-core');
const { YtDlp } = require('ytdlp-nodejs');
const { fetchPlayerData, fetchWithTimeout } = require('./youtube-player');
const { EXTENDED_MAX_SECONDS } = require('./youtube-pipeline-constants');
const {
  initYouTubeCookies,
  getYtdlpCookiesOptions,
  appendYtDlpCliCookieArgs,
  mapYtdlpDownloadError,
  mapCombinedDownloadErrors,
  logCookiesUsedForYtdlp,
} = require('./youtube-cookies');

const execFileAsync = promisify(execFile);

const AUDIO_DOWNLOAD_TIMEOUT_MS =
  Number(process.env.YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_MS) || 180000;
const WHISPER_TIMEOUT_MS = Number(process.env.YOUTUBE_WHISPER_TIMEOUT_MS) || 180000;
const WHISPER_MAX_BYTES = Number(process.env.YOUTUBE_WHISPER_MAX_BYTES) || 24 * 1024 * 1024;
const CHUNK_DURATION_SECONDS =
  Number(process.env.YOUTUBE_AUDIO_CHUNK_SECONDS) || 10 * 60;

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

let ytdlpNodeClient = null;

function getYtdlpNodeClient() {
  if (!ytdlpNodeClient) {
    ytdlpNodeClient = new YtDlp({
      binaryPath: process.env.YT_DLP_PATH || undefined,
    });
  }
  return ytdlpNodeClient;
}

const INNERTUBE_CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38' },
  { clientName: 'IOS', clientVersion: '19.45.4' },
  { clientName: 'WEB', clientVersion: '2.20250217.01.00' },
  { clientName: 'MWEB', clientVersion: '2.20250217.01.00' },
];

const AUDIO_FALLBACK_ERROR = 'errYoutubeAudioFallbackFailed';

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
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }
  const host = normalizeHostname(parsed.hostname);
  const allowed =
    host.endsWith('.googlevideo.com') ||
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host.endsWith('.googlevideo.com');
  if (!allowed) {
    const err = new Error('Media URL host not allowed');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }
  return parsed.href;
}

function extensionFromMime(mimeType) {
  const mime = String(mimeType ?? '').toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('opus')) return 'webm';
  return 'm4a';
}

function parseBitrate(format) {
  const candidates = [
    format.audioBitrate,
    format.bitrate,
    format.averageBitrate,
    format.abr,
  ];
  for (const value of candidates) {
    const n = parseInt(String(value ?? ''), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function formatHasAudio(format) {
  if (!format) return false;
  if (format.hasAudio === true) return true;
  const mime = String(format.mimeType ?? format.mime ?? '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  if (format.audioQuality || format.audioBitrate || format.audioSampleRate) return true;
  if (String(format.audioTrack?.displayName ?? '')) return true;
  return false;
}

function formatHasVideo(format) {
  if (!format) return false;
  if (format.hasVideo === true) return true;
  const mime = String(format.mimeType ?? format.mime ?? '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  if (format.qualityLabel || format.height || format.width) return true;
  return false;
}

function formatIsAudioOnly(format) {
  return formatHasAudio(format) && !formatHasVideo(format);
}

function scoreAudioFormat(format) {
  let score = parseBitrate(format);
  const mime = String(format.mimeType ?? format.mime ?? '').toLowerCase();

  if (formatIsAudioOnly(format)) score += 1_000_000;
  if (mime.includes('audio/mp4') || mime.includes('m4a')) score += 500_000;
  if (mime.includes('audio/webm') || mime.includes('opus')) score -= 50_000;
  if (formatHasVideo(format)) score -= 200_000;

  return score;
}

/**
 * Rank audio formats: audio-only → prefer mp4/m4a (reliable CDN) → highest bitrate.
 */
function rankAudioFormats(formats) {
  return (formats ?? [])
    .filter((f) => f && (f.url || f.signatureCipher || f.cipher))
    .filter(formatHasAudio)
    .sort((a, b) => scoreAudioFormat(b) - scoreAudioFormat(a));
}

/**
 * Select best audio format (first in ranked list).
 */
function selectBestAudioFormat(formats, { videoId, source } = {}) {
  const ranked = rankAudioFormats(formats);

  logEvent('youtube_audio_formats_found', {
    videoId,
    source,
    total: ranked.length,
    audioOnly: ranked.filter(formatIsAudioOnly).length,
    withAudio: ranked.length,
    topItags: ranked.slice(0, 4).map((f) => f.itag),
  });

  const picked = ranked[0] ?? null;

  if (picked) {
    logEvent('youtube_audio_format_selected', {
      videoId,
      source,
      itag: picked.itag ?? null,
      mimeType: picked.mimeType ?? picked.mime ?? null,
      audioBitrate: parseBitrate(picked),
      audioOnly: formatIsAudioOnly(picked),
      hasVideo: formatHasVideo(picked),
    });
  }

  return picked;
}

async function streamToBuffer(readable, maxBytes = WHISPER_MAX_BYTES) {
  const chunks = [];
  let total = 0;

  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        readable.destroy();
        const err = new Error(`Audio download exceeds ${maxBytes} bytes`);
        err.code = AUDIO_FALLBACK_ERROR;
        reject(err);
        return;
      }
      chunks.push(chunk);
    };

    readable.on('data', onData);
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

const YTDL_PLAYER_CLIENTS = ['ANDROID', 'IOS', 'WEB_EMBEDDED', 'TV'];

/**
 * Primary downloader — bundled yt-dlp via ytdlp-nodejs (handles n/signature/cookies).
 */
async function downloadWithYtdlpNode(videoId, canonicalUrl) {
  const url = canonicalUrl || `https://www.youtube.com/watch?v=${videoId}`;

  await initYouTubeCookies();

  logEvent('youtube_audio_download_start', { videoId, method: 'ytdlp-nodejs', url });

  const ytdlp = getYtdlpNodeClient();
  const cookieOpts = getYtdlpCookiesOptions();

  let streamBuilder = ytdlp.stream(url).filter('audioonly');
  if (cookieOpts.cookies) {
    streamBuilder = streamBuilder.cookies(cookieOpts.cookies);
    logCookiesUsedForYtdlp();
  }

  let buffer;
  try {
    buffer = await streamBuilder.toBuffer();
  } catch (error) {
    throw mapYtdlpDownloadError(error);
  }

  if (!buffer?.length) {
    const err = new Error('ytdlp-nodejs: empty audio buffer');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  if (buffer.length > WHISPER_MAX_BYTES) {
    const err = new Error('ytdlp-nodejs: audio exceeds max Whisper size');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  const mimeType = 'audio/webm';
  const extension = 'webm';

  logEvent('youtube_audio_download_done', {
    videoId,
    method: 'ytdlp-nodejs',
    bytes: buffer.length,
    mimeType,
    extension,
  });

  return { buffer, mimeType, extension, method: 'ytdlp-nodejs' };
}

async function downloadWithYtdlCore(videoId, canonicalUrl) {
  const url = canonicalUrl || `https://www.youtube.com/watch?v=${videoId}`;

  logEvent('youtube_audio_download_start', { videoId, method: 'ytdl-core', url });

  let info;
  try {
    info = await ytdl.getInfo(url, { playerClients: YTDL_PLAYER_CLIENTS });
  } catch (error) {
    const err = new Error(`ytdl-core getInfo failed: ${error.message}`);
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  const ranked = rankAudioFormats(info.formats);
  if (!ranked.length) {
    const err = new Error('ytdl-core: no audio format available');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  let lastError = null;
  for (const format of ranked.slice(0, 6)) {
    try {
      logEvent('youtube_audio_format_selected', {
        videoId,
        source: 'ytdl-core',
        itag: format.itag,
        mimeType: format.mimeType,
        audioBitrate: parseBitrate(format),
      });

      const stream = ytdl.downloadFromInfo(info, {
        format,
        quality: format.itag,
        highWaterMark: 1 << 25,
      });

      const buffer = await streamToBuffer(stream);
      const mimeType = format.mimeType ?? 'audio/mp4';
      const extension = extensionFromMime(mimeType);

      logEvent('youtube_audio_download_done', {
        videoId,
        method: 'ytdl-core',
        bytes: buffer.length,
        mimeType,
        extension,
        itag: format.itag,
      });

      return { buffer, mimeType, extension, method: 'ytdl-core' };
    } catch (error) {
      lastError = error;
      logEvent('youtube_audio_format_failed', {
        videoId,
        method: 'ytdl-core',
        itag: format.itag,
        reason: String(error?.message ?? error).slice(0, 120),
      });
    }
  }

  const err = new Error(lastError?.message ?? 'ytdl-core: all formats failed');
  err.code = AUDIO_FALLBACK_ERROR;
  throw err;
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

const INNERTUBE_RANGE_CHUNK_BYTES = 1024 * 1024;

async function fetchInnertubeAudioBuffer(videoId, format, clientName) {
  if (!format?.url) {
    throw new Error('Innertube format has no URL');
  }

  const safeUrl = assertSafeYouTubeMediaUrl(format.url);
  const userAgent =
    clientName === 'IOS'
      ? 'com.google.ios.youtube/19.45.4 (iPhone14,3; iOS 16.0)'
      : 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

  const baseHeaders = {
    'User-Agent': userAgent,
    Referer: 'https://www.youtube.com/',
    Origin: 'https://www.youtube.com',
    Accept: '*/*',
  };

  async function fetchRange(rangeHeader) {
    const headers = { ...baseHeaders };
    if (rangeHeader) headers.Range = rangeHeader;

    const resp = await fetchWithTimeout(
      safeUrl,
      { headers },
      AUDIO_DOWNLOAD_TIMEOUT_MS,
    );

    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Innertube audio HTTP ${resp.status}`);
    }

    return Buffer.from(await resp.arrayBuffer());
  }

  let buffer;
  try {
    buffer = await fetchRange(null);
  } catch {
    buffer = null;
  }

  if (!buffer?.length) {
    const chunks = [];
    let offset = 0;

    while (offset < WHISPER_MAX_BYTES) {
      const end = offset + INNERTUBE_RANGE_CHUNK_BYTES - 1;
      const part = await fetchRange(`bytes=${offset}-${end}`);
      if (!part.length) break;
      chunks.push(part);
      offset += part.length;
      if (part.length < INNERTUBE_RANGE_CHUNK_BYTES) break;
    }

    buffer = Buffer.concat(chunks);
  }

  if (!buffer.length) {
    throw new Error('Innertube audio empty response');
  }
  if (buffer.length > WHISPER_MAX_BYTES) {
    throw new Error('Innertube audio exceeds max size');
  }

  return buffer;
}

async function downloadAudioFromInnertube(videoId) {
  let lastError = null;

  for (const client of INNERTUBE_CLIENTS) {
    try {
      const streamingData =
        (await fetchPlayerWithClient(videoId, client)) ??
        (await fetchPlayerData(videoId)).streamingData;

      const ranked = rankAudioFormats([
        ...(streamingData?.adaptiveFormats ?? []),
        ...(streamingData?.formats ?? []),
      ]);

      if (!ranked.length) {
        lastError = new Error('Innertube: no audio formats in player response');
        continue;
      }

      logEvent('youtube_audio_formats_found', {
        videoId,
        source: `innertube_${client.clientName}`,
        total: ranked.length,
        topItags: ranked.slice(0, 4).map((f) => f.itag),
      });

      logEvent('youtube_audio_download_start', {
        videoId,
        method: 'innertube',
        client: client.clientName,
      });

      for (const format of ranked.slice(0, 8)) {
        try {
          logEvent('youtube_audio_format_selected', {
            videoId,
            source: `innertube_${client.clientName}`,
            itag: format.itag,
            mimeType: format.mimeType,
            audioBitrate: parseBitrate(format),
          });

          const buffer = await fetchInnertubeAudioBuffer(
            videoId,
            format,
            client.clientName,
          );
          const mimeType = format.mimeType ?? 'audio/mp4';
          const extension = extensionFromMime(mimeType);

          logEvent('youtube_audio_download_done', {
            videoId,
            method: 'innertube',
            client: client.clientName,
            itag: format.itag,
            bytes: buffer.length,
            mimeType,
          });

          return { buffer, mimeType, extension, method: 'innertube' };
        } catch (formatError) {
          lastError = formatError;
          logEvent('youtube_audio_format_failed', {
            videoId,
            method: 'innertube',
            client: client.clientName,
            itag: format.itag,
            reason: String(formatError?.message ?? formatError).slice(0, 120),
          });
        }
      }
    } catch (error) {
      lastError = error;
    }
  }

  const err = new Error(lastError?.message ?? 'Innertube audio download failed');
  err.code = AUDIO_FALLBACK_ERROR;
  throw err;
}

async function downloadAudioWithYtDlpNodeSection(canonicalUrl, section, videoId) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'summify-yt-'));
  const outBase = path.join(tmpDir, 'audio');

  logEvent('youtube_audio_download_start', {
    videoId,
    method: 'ytdlp-nodejs',
    url: canonicalUrl,
    section,
  });

  try {
    await initYouTubeCookies();
    const ytdlp = getYtdlpNodeClient();
    const cookieOpts = getYtdlpCookiesOptions();
    if (cookieOpts.cookies) logCookiesUsedForYtdlp();

    try {
      await ytdlp.downloadAsync(canonicalUrl, {
        format: 'ba/b',
        output: outBase,
        noPlaylist: true,
        downloadSections: section,
        maxFilesize: String(WHISPER_MAX_BYTES),
        ...cookieOpts,
      });
    } catch (error) {
      throw mapYtdlpDownloadError(error);
    }

    const files = await fs.promises.readdir(tmpDir);
    const audioFile = files.find((f) => !f.endsWith('.part'));
    if (!audioFile) {
      throw new Error('ytdlp-nodejs section: no output file');
    }

    const filePath = path.join(tmpDir, audioFile);
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(audioFile).slice(1) || 'webm';
    const mimeType =
      ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

    logEvent('youtube_audio_download_done', {
      videoId,
      method: 'ytdlp-nodejs',
      section,
      bytes: buffer.length,
    });

    return { buffer, mimeType, extension: ext, method: 'ytdlp-nodejs' };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function downloadAudioWithYtDlp(canonicalUrl, section = null, videoId = null) {
  const ytdlp = process.env.YT_DLP_PATH || 'yt-dlp';
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'summify-yt-'));
  const outTemplate = path.join(tmpDir, 'audio.%(ext)s');

  logEvent('youtube_audio_download_start', {
    videoId,
    method: 'yt-dlp',
    url: canonicalUrl,
    section,
  });

  await initYouTubeCookies();

  let args = [
    '--no-playlist',
    '--no-warnings',
    '-f',
    'ba[abr<=128]/ba/b',
    '-o',
    outTemplate,
    '--max-filesize',
    String(WHISPER_MAX_BYTES),
  ];

  args = appendYtDlpCliCookieArgs(args);

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
      err.code = AUDIO_FALLBACK_ERROR;
      throw err;
    }

    const filePath = path.join(tmpDir, audioFile);
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(audioFile).slice(1) || 'm4a';
    const mimeType =
      ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

    logEvent('youtube_audio_download_done', {
      videoId,
      method: 'yt-dlp',
      bytes: buffer.length,
      extension: ext,
    });

    return { buffer, mimeType, extension: ext, method: 'yt-dlp' };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Try ytdlp-nodejs → ytdl-core → system yt-dlp → innertube.
 */
async function downloadYouTubeAudio(videoId, canonicalUrl) {
  const errors = [];

  try {
    return await downloadWithYtdlpNode(videoId, canonicalUrl);
  } catch (ytdlpNodeError) {
    if (ytdlpNodeError?.code === 'errYoutubeBotVerificationRequired') {
      throw ytdlpNodeError;
    }
    errors.push(`ytdlp-nodejs: ${ytdlpNodeError.message}`);
    logEvent('youtube_audio_method_skipped', {
      videoId,
      method: 'ytdlp-nodejs',
      reason: String(ytdlpNodeError?.message ?? ytdlpNodeError).slice(0, 160),
    });
  }

  try {
    return await downloadWithYtdlCore(videoId, canonicalUrl);
  } catch (ytdlError) {
    errors.push(`ytdl-core: ${ytdlError.message}`);
    logEvent('youtube_audio_method_skipped', {
      videoId,
      method: 'ytdl-core',
      reason: String(ytdlError?.message ?? ytdlError).slice(0, 160),
    });
  }

  try {
    return await downloadAudioWithYtDlp(canonicalUrl, null, videoId);
  } catch (ytdlpError) {
    const mapped = mapYtdlpDownloadError(ytdlpError);
    if (mapped?.code === 'errYoutubeBotVerificationRequired') {
      throw mapped;
    }
    errors.push(`yt-dlp: ${ytdlpError.message}`);
    logEvent('youtube_audio_method_skipped', {
      videoId,
      method: 'yt-dlp',
      reason: String(ytdlpError?.message ?? ytdlpError).slice(0, 160),
    });
  }

  try {
    return await downloadAudioFromInnertube(videoId);
  } catch (innertubeError) {
    errors.push(`innertube: ${innertubeError.message}`);
    logEvent('youtube_audio_method_skipped', {
      videoId,
      method: 'innertube',
      reason: String(innertubeError?.message ?? innertubeError).slice(0, 160),
    });
  }

  throw mapCombinedDownloadErrors(errors);
}

async function transcribeBufferWithGroq({ buffer, extension, mimeType, languageHint, videoId }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY is not configured on server');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  logEvent('youtube_audio_transcription_start', {
    videoId,
    bytes: buffer.length,
    extension,
    mimeType,
  });

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
      err.code = AUDIO_FALLBACK_ERROR;
      logEvent('youtube_audio_transcription_failed', {
        videoId,
        status: resp.status,
        message: err.message,
      });
      throw err;
    }

    const text = String(json?.text ?? '').trim();
    if (!text) {
      const err = new Error('Empty transcription');
      err.code = AUDIO_FALLBACK_ERROR;
      logEvent('youtube_audio_transcription_failed', {
        videoId,
        reason: 'empty_text',
      });
      throw err;
    }

    const detectedLanguage = json?.language ?? languageHint ?? 'auto';

    logEvent('youtube_audio_transcription_done', {
      videoId,
      language: detectedLanguage,
      extractedChars: text.length,
    });

    logEvent('transcript_language_detected', {
      videoId,
      language: detectedLanguage,
      source: 'whisper',
    });

    return { text, language: detectedLanguage };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const err = new Error('Whisper request timed out');
      err.code = 'errYoutubeNetworkTimeout';
      logEvent('youtube_audio_transcription_failed', {
        videoId,
        reason: 'timeout',
      });
      throw err;
    }
    if (!error?.code) {
      logEvent('youtube_audio_transcription_failed', {
        videoId,
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function transcribeSingleAudio(videoId, canonicalUrl, languageHint) {
  const { buffer, mimeType, extension, method } = await downloadYouTubeAudio(
    videoId,
    canonicalUrl,
  );

  logEvent('youtube_audio_download_selected', { videoId, method, bytes: buffer.length });

  if (buffer.length <= WHISPER_MAX_BYTES) {
    return transcribeBufferWithGroq({
      buffer,
      mimeType,
      extension,
      languageHint,
      videoId,
    });
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
      try {
        chunk = await downloadAudioWithYtDlpNodeSection(canonicalUrl, section, videoId);
      } catch {
        chunk = await downloadAudioWithYtDlp(canonicalUrl, section, videoId);
      }
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
      videoId,
    });

    texts.push(result.text);
    if (result.language) detectedLanguage = result.language;
  }

  if (!texts.length) {
    const err = new Error('Chunked audio transcription produced no text');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  return { text: texts.join('\n\n'), language: detectedLanguage };
}

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
        err.code = AUDIO_FALLBACK_ERROR;
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
    if (!error.code) {
      error.code = AUDIO_FALLBACK_ERROR;
    }
    logEvent('youtube_audio_fallback_failed', {
      videoId,
      durationSeconds,
      errorCode: error.code,
      message: String(error?.message ?? error).slice(0, 200),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

module.exports = {
  transcribeYouTubeAudioFallback,
  downloadYouTubeAudio,
  selectBestAudioFormat,
  rankAudioFormats,
  formatHasAudio,
  formatHasVideo,
};
