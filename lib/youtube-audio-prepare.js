const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MIN_AUDIO_BYTES = Number(process.env.YOUTUBE_MIN_AUDIO_BYTES) || 50 * 1024;
const WHISPER_NATIVE_EXTENSIONS = new Set(['mp3', 'm4a', 'mpeg', 'mpga', 'wav', 'flac', 'mp4']);

function logEvent(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

function getFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch {
    /* optional dependency */
  }
  const envPath = process.env.FFMPEG_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  return 'ffmpeg';
}

function needsAudioConversion(extension, mimeType) {
  const ext = String(extension ?? '').toLowerCase();
  const mime = String(mimeType ?? '').toLowerCase();

  if (ext === 'webm' || ext === 'opus' || ext === 'ogg') return true;
  if (mime.includes('webm') || mime.includes('opus') || mime.includes('ogg')) return true;

  if (WHISPER_NATIVE_EXTENSIONS.has(ext)) return false;
  if (
    mime.includes('mpeg') ||
    mime.includes('mp3') ||
    mime.includes('mp4') ||
    mime.includes('wav') ||
    mime.includes('flac')
  ) {
    return false;
  }

  return true;
}

function validateAudioBuffer(buffer, { videoId, method, mimeType, extension }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('Audio buffer missing or empty');
    err.code = 'errYoutubeAudioFallbackFailed';
    throw err;
  }

  if (buffer.length < MIN_AUDIO_BYTES) {
    const err = new Error(
      `Audio buffer too small for transcription (${buffer.length} bytes, min ${MIN_AUDIO_BYTES})`,
    );
    err.code = 'errYoutubeAudioFallbackFailed';
    throw err;
  }

  logEvent('youtube_audio_buffer_ready', {
    videoId,
    method,
    bytes: buffer.length,
    mimeType: mimeType ?? null,
    extension: extension ?? null,
  });

  return buffer;
}

async function convertBufferToMp3(buffer, inputExtension, videoId, method) {
  const ffmpegPath = getFfmpegPath();
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'summify-ffmpeg-'));
  const inputExt = inputExtension || 'webm';
  const inputPath = path.join(tmpDir, `input.${inputExt}`);
  const outputPath = path.join(tmpDir, 'output.mp3');

  logEvent('youtube_audio_convert_start', {
    videoId,
    method,
    inputExtension: inputExt,
    inputBytes: buffer.length,
  });

  try {
    await fs.promises.writeFile(inputPath, buffer);

    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-vn',
        '-acodec',
        'libmp3lame',
        '-q:a',
        '4',
        '-y',
        outputPath,
      ],
      { timeout: 120000 },
    );

    const mp3Buffer = await fs.promises.readFile(outputPath);
    if (!mp3Buffer.length || mp3Buffer.length < MIN_AUDIO_BYTES) {
      throw new Error('ffmpeg produced empty or too small mp3 output');
    }

    logEvent('youtube_audio_convert_done', {
      videoId,
      method,
      outputBytes: mp3Buffer.length,
      outputExtension: 'mp3',
    });

    return {
      buffer: mp3Buffer,
      extension: 'mp3',
      mimeType: 'audio/mpeg',
    };
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Validate download buffer and normalize to Groq-friendly mp3/m4a when needed.
 */
async function prepareAudioForWhisper({
  buffer,
  mimeType,
  extension,
  videoId,
  method,
}) {
  validateAudioBuffer(buffer, { videoId, method, mimeType, extension });

  if (!needsAudioConversion(extension, mimeType)) {
    const ext = String(extension ?? 'm4a').toLowerCase();
    const mime =
      mimeType ??
      (ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/mp4');
    return { buffer, extension: ext, mimeType: mime };
  }

  return convertBufferToMp3(buffer, extension, videoId, method);
}

function finalizeAudioDownload({ videoId, method, buffer, mimeType, extension }) {
  validateAudioBuffer(buffer, { videoId, method, mimeType, extension });
  return { buffer, mimeType, extension, method };
}

module.exports = {
  MIN_AUDIO_BYTES,
  validateAudioBuffer,
  prepareAudioForWhisper,
  finalizeAudioDownload,
  needsAudioConversion,
};
