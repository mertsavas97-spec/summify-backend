const FormData = require('form-data');
const { prepareAudioForWhisper } = require('./youtube-audio-prepare');

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_TIMEOUT_MS = Number(process.env.YOUTUBE_WHISPER_TIMEOUT_MS) || 180000;
const MIN_AUDIO_BYTES = 50 * 1024;
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

function validateAudioBufferForGroq(audioBuffer) {
  if (!audioBuffer) {
    const err = new Error('Audio buffer is missing');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }
  if (!Buffer.isBuffer(audioBuffer)) {
    const err = new Error('Audio buffer is not a Buffer');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }
  if (audioBuffer.length <= MIN_AUDIO_BYTES) {
    const err = new Error(
      `Audio buffer too small for Whisper (${audioBuffer.length} bytes, min ${MIN_AUDIO_BYTES})`,
    );
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }
}

/**
 * Sends YouTube audio to Groq Whisper (used by lib/youtube-audio-fallback.js).
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

  const audioBuffer = prepared.buffer;
  validateAudioBufferForGroq(audioBuffer);

  const filename = `youtube-audio.${prepared.extension || 'mp3'}`;
  const contentType = prepared.mimeType || 'audio/mpeg';

  logEvent('youtube_audio_buffer_ready', {
    bytes: audioBuffer.length,
    filename,
    contentType,
    model,
  });

  logEvent('youtube_audio_transcription_request_start', {
    videoId,
    model,
    bytes: audioBuffer.length,
    filename,
    contentType,
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

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...form.getHeaders(),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  let response;
  let responseText = '';

  try {
    const fetchOptions = {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
      duplex: 'half',
    };

    response = await fetch(GROQ_TRANSCRIPTION_URL, fetchOptions);
    responseText = await response.text();
  } catch (error) {
    const message = String(error?.message ?? error);
    logEvent('youtube_audio_transcription_request_failed', {
      videoId,
      status: null,
      bodyExcerpt: message.slice(0, 500),
      bytes: audioBuffer.length,
      filename,
      contentType,
    });
    if (error?.name === 'AbortError') {
      const err = new Error('Whisper request timed out');
      err.code = 'errYoutubeNetworkTimeout';
      throw err;
    }
    const err = new Error(message || 'Groq transcription request failed');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    logEvent('youtube_audio_transcription_request_failed', {
      videoId,
      status: response.status,
      bodyExcerpt: responseText.slice(0, 500),
      bytes: audioBuffer.length,
      filename,
      contentType,
    });
    const err = new Error(
      `Whisper HTTP ${response.status}: ${responseText.slice(0, 200)}`,
    );
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  let json = null;
  try {
    json = responseText ? JSON.parse(responseText) : null;
  } catch {
    json = null;
  }

  const text = String(json?.text ?? '').trim();
  if (!text) {
    logEvent('youtube_audio_transcription_request_failed', {
      videoId,
      status: response.status,
      bodyExcerpt: responseText.slice(0, 500),
      bytes: audioBuffer.length,
      filename,
      contentType,
      reason: 'empty_text',
    });
    const err = new Error('Empty transcription from Groq');
    err.code = AUDIO_FALLBACK_ERROR;
    throw err;
  }

  const detectedLanguage = json?.language ?? languageHint ?? 'auto';

  logEvent('youtube_audio_transcription_done', {
    videoId,
    language: detectedLanguage,
    extractedChars: text.length,
    status: response.status,
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
