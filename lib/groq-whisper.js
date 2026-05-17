const https = require('https');
const FormData = require('form-data');
const { prepareAudioForWhisper } = require('./youtube-audio-prepare');

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_TIMEOUT_MS = Number(process.env.YOUTUBE_WHISPER_TIMEOUT_MS) || 180000;
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

/**
 * Upload multipart form via https + form.pipe (reliable with form-data package).
 * Node fetch + form-data stream often yields "multipart: NextPart: EOF".
 */
function postFormData(url, form, authorization, timeoutMs = WHISPER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers = {
      ...form.getHeaders(),
      Authorization: authorization,
    };

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('Whisper request timed out'), { name: 'AbortError' }));
    });

    req.on('error', reject);
    form.pipe(req);
  });
}

/**
 * Sends YouTube audio to Groq Whisper — entry point used by youtube-audio-fallback.js
 */
async function transcribeAudioWithGroq({
  buffer,
  extension,
  mimeType,
  languageHint,
  videoId,
  method,
}) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    const err = new Error('GROQ_API_KEY is not configured on server');
    err.code = AUDIO_FALLBACK_ERROR;
    err.reason = 'missing_groq_api_key';
    throw err;
  }

  const model = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';

  const prepared = await prepareAudioForWhisper({
    buffer,
    mimeType,
    extension,
    videoId,
    method: method ?? 'whisper',
  });

  const filename = `youtube-audio.${prepared.extension || 'mp3'}`;
  const contentType = prepared.mimeType || 'audio/mpeg';
  const audioBuffer = prepared.buffer;

  logEvent('youtube_audio_buffer_ready', {
    videoId,
    method: method ?? 'whisper',
    bytes: audioBuffer.length,
    mimeType: contentType,
    filename,
  });

  logEvent('youtube_audio_transcription_request_start', {
    videoId,
    model,
    bytes: audioBuffer.length,
    filename,
    contentType,
  });

  logEvent('youtube_audio_transcription_start', {
    videoId,
    bytes: audioBuffer.length,
    extension: prepared.extension,
    mimeType: contentType,
    filename,
    transport: 'form-data',
  });

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (languageHint && languageHint !== 'auto') {
    form.append('language', languageHint.slice(0, 2));
  }
  form.append('file', audioBuffer, {
    filename,
    contentType,
    knownLength: audioBuffer.length,
  });

  const authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await postFormData(
      GROQ_TRANSCRIPTION_URL,
      form,
      authorization,
      WHISPER_TIMEOUT_MS,
    );
  } catch (error) {
    const message = String(error?.message ?? error);
    logEvent('youtube_audio_transcription_request_failed', {
      videoId,
      status: null,
      bodyExcerpt: message.slice(0, 300),
      bytes: audioBuffer.length,
      filename,
      contentType,
    });
    if (error?.name === 'AbortError') {
      const err = new Error('Whisper request timed out');
      err.code = 'errYoutubeNetworkTimeout';
      throw err;
    }
    throw error;
  }

  let json = null;
  const responseText = response.text ?? '';
  try {
    json = responseText ? JSON.parse(responseText) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const err = new Error(json?.error?.message ?? `Whisper HTTP ${response.status}`);
    err.code = AUDIO_FALLBACK_ERROR;
    logEvent('youtube_audio_transcription_request_failed', {
      videoId,
      status: response.status,
      bodyExcerpt: responseText.slice(0, 300),
      bytes: audioBuffer.length,
      filename,
      contentType,
      message: err.message,
    });
    logEvent('youtube_audio_transcription_failed', {
      videoId,
      status: response.status,
      message: err.message,
    });
    throw err;
  }

  const text = String(json?.text ?? '').trim();
  if (!text) {
    const err = new Error('Empty transcription');
    err.code = AUDIO_FALLBACK_ERROR;
    logEvent('youtube_audio_transcription_request_failed', {
      videoId,
      status: response.status,
      bodyExcerpt: responseText.slice(0, 200),
      bytes: audioBuffer.length,
      filename,
      contentType,
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
}

module.exports = {
  transcribeAudioWithGroq,
};
