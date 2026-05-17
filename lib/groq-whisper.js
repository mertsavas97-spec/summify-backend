const FormDataNode = require('form-data');
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

function formDataToBuffer(form) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    form.on('error', reject);
    form.on('data', (chunk) => chunks.push(chunk));
    form.on('end', () => resolve(Buffer.concat(chunks)));
    if (typeof form.read === 'function') {
      form.read();
    }
    form.resume();
  });
}

/**
 * Build multipart body for Groq / OpenAI-compatible transcription API.
 * Uses native FormData+Blob when available; otherwise buffers form-data (fixes fetch EOF).
 */
async function buildGroqTranscriptionRequest({
  buffer,
  extension,
  mimeType,
  model,
  languageHint,
  videoId,
  method,
}) {
  const prepared = await prepareAudioForWhisper({
    buffer,
    mimeType,
    extension,
    videoId,
    method: method ?? 'whisper',
  });

  const filename = `youtube-audio.${prepared.extension}`;
  const fields = {
    model,
    response_format: 'verbose_json',
  };
  if (languageHint && languageHint !== 'auto') {
    fields.language = languageHint.slice(0, 2);
  }

  if (typeof globalThis.Blob !== 'undefined' && typeof globalThis.FormData !== 'undefined') {
    try {
      const body = new globalThis.FormData();
      const blob = new globalThis.Blob([prepared.buffer], { type: prepared.mimeType });
      body.append('file', blob, filename);
      for (const [key, value] of Object.entries(fields)) {
        body.append(key, value);
      }
      return {
        prepared,
        filename,
        transport: 'native-formdata',
        body,
        headers: null,
      };
    } catch {
      /* fall through to form-data buffer */
    }
  }

  const form = new FormDataNode();
  form.append('file', prepared.buffer, {
    filename,
    contentType: prepared.mimeType,
    knownLength: prepared.buffer.length,
  });
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  const bodyBuffer = await formDataToBuffer(form);
  const headers = {
    ...form.getHeaders(),
    'Content-Length': String(bodyBuffer.length),
  };

  return {
    prepared,
    filename,
    transport: 'form-data-buffer',
    body: bodyBuffer,
    headers,
  };
}

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

  logEvent('youtube_audio_transcription_request_start', {
    videoId,
    model,
    inputBytes: buffer?.length ?? 0,
    extension,
    mimeType,
  });

  const request = await buildGroqTranscriptionRequest({
    buffer,
    extension,
    mimeType,
    model,
    languageHint,
    videoId,
    method,
  });

  logEvent('youtube_audio_transcription_start', {
    videoId,
    bytes: request.prepared.buffer.length,
    extension: request.prepared.extension,
    mimeType: request.prepared.mimeType,
    transport: request.transport,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      ...(request.headers ?? {}),
    };

    const resp = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers,
      body: request.body,
      signal: controller.signal,
    });

    const responseText = await resp.text();
    let json = null;
    try {
      json = responseText ? JSON.parse(responseText) : null;
    } catch {
      json = null;
    }

    if (!resp.ok) {
      const err = new Error(json?.error?.message ?? `Whisper HTTP ${resp.status}`);
      err.code = AUDIO_FALLBACK_ERROR;
      logEvent('youtube_audio_transcription_request_failed', {
        videoId,
        status: resp.status,
        transport: request.transport,
        bodyExcerpt: responseText.slice(0, 300),
        message: err.message,
      });
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
      logEvent('youtube_audio_transcription_request_failed', {
        videoId,
        reason: 'empty_text',
        bodyExcerpt: responseText.slice(0, 200),
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
      logEvent('youtube_audio_transcription_request_failed', {
        videoId,
        reason: 'timeout',
      });
      throw err;
    }

    const message = String(error?.message ?? error);
    if (/multipart|NextPart|EOF/i.test(message)) {
      logEvent('youtube_audio_transcription_request_failed', {
        videoId,
        reason: 'multipart_eof',
        message: message.slice(0, 200),
        transport: request.transport,
      });
      const err = new Error('Groq multipart upload failed');
      err.code = AUDIO_FALLBACK_ERROR;
      throw err;
    }

    if (!error?.code) {
      logEvent('youtube_audio_transcription_request_failed', {
        videoId,
        message: message.slice(0, 200),
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  transcribeAudioWithGroq,
  buildGroqTranscriptionRequest,
};
