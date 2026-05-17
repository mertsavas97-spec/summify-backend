const express = require('express');
const cors = require('cors');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { validateArticleUrl, assertSafeUrl } = require('./lib/url-security');
const { extractArticleFromUrl } = require('./lib/article-extract');
const { extractYouTubeContent } = require('./lib/youtube-extract');

const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.json({ status: 'Summify backend running' });
});

app.post('/extract-pdf', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) {
      return res.status(400).json({ error: 'No base64 data provided' });
    }

    const buffer = Buffer.from(base64, 'base64');
    const data = await pdfParse(buffer);
    const text = data.text?.trim();

    if (!text || text.length < 100) {
      return res.status(422).json({
        error: 'Could not extract text from this PDF.',
      });
    }

    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: 'PDF processing failed: ' + err.message });
  }
});

function sendArticleError(res, status, code, message) {
  res.status(status).json({
    success: false,
    error: code,
    message,
  });
}

app.post('/extract-article', express.json({ limit: '32kb' }), async (req, res) => {
  let domain = null;

  try {
    const { url } = req.body ?? {};
    if (!url || typeof url !== 'string') {
      return sendArticleError(res, 400, 'errInvalidUrl', 'A valid URL is required.');
    }

    let normalizedUrl;
    try {
      normalizedUrl = validateArticleUrl(url);
      domain = new URL(normalizedUrl).hostname;
    } catch (validationError) {
      return sendArticleError(
        res,
        400,
        validationError.code ?? 'errInvalidUrl',
        validationError.message,
      );
    }

    try {
      await assertSafeUrl(normalizedUrl);
    } catch (ssrfError) {
      return sendArticleError(
        res,
        400,
        ssrfError.code ?? 'errInvalidUrl',
        'This URL is not allowed.',
      );
    }

    const result = await extractArticleFromUrl(normalizedUrl);

    res.json({
      success: true,
      title: result.title,
      sourceDomain: result.sourceDomain,
      author: result.author ?? null,
      publishedAt: result.publishedAt ?? null,
      publishDate: result.publishDate ?? null,
      text: result.text,
      extractedChars: result.extractedChars,
      rawHtmlChars: result.rawHtmlChars,
      extractionMethod: result.extractionMethod,
    });
  } catch (err) {
    const code = err.code ?? 'errArticleExtractFailed';
    const status =
      code === 'errArticleTooShort'
        ? 422
        : code === 'errUrlCouldNotOpen'
          ? 502
          : 500;

    sendArticleError(
      res,
      status,
      code,
      code === 'errArticleTooShort'
        ? 'This page has too little readable article text.'
        : code === 'errUrlCouldNotOpen'
          ? 'This URL could not be opened.'
          : 'Could not extract article text from this page.',
    );
  }
});

function sendYoutubeError(res, status, code, message, extra = {}) {
  res.status(status).json({
    success: false,
    error: code,
    errorKey: code,
    message,
    reason: extra.reason ?? message,
    stage: extra.stage ?? null,
    videoId: extra.videoId ?? null,
    transcriptErrorKey: extra.transcriptErrorKey ?? null,
    audioErrorKey: extra.audioErrorKey ?? null,
  });
}

app.post('/extract-youtube', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const { url } = req.body ?? {};
    if (!url || typeof url !== 'string') {
      return sendYoutubeError(
        res,
        400,
        'errYoutubeInvalidUrl',
        'A valid YouTube URL is required.',
      );
    }

    const result = await extractYouTubeContent(url);

    res.json({
      success: true,
      videoId: result.videoId,
      title: result.title,
      channel: result.channel ?? null,
      duration: result.duration ?? null,
      language: result.language,
      sourceDomain: result.sourceDomain,
      text: result.text,
      segments: result.segments ?? [],
      extractedChars: result.extractedChars,
      extractionMethod: result.extractionMethod,
      transcriptSource: result.transcriptSource ?? 'captions',
      processingTier: result.processingTier ?? 'fast',
      thumbnail: result.thumbnail ?? null,
    });
  } catch (err) {
    const code =
      err.code ??
      err.errorKey ??
      'errYoutubeAnalysisFailed';
    const status =
      code === 'errYoutubeInvalidUrl'
        ? 400
        : code === 'errYoutubeVideoTooLong' || code === 'errYoutubeTooLongForFree'
          ? 422
          : code === 'errYoutubeVideoUnavailable' ||
              code === 'errYoutubeAgeRestricted' ||
              code === 'errYoutubeRegionBlocked'
            ? 404
            : code === 'errYoutubeNetworkTimeout'
              ? 504
              : 422;

    const messages = {
      errYoutubeInvalidUrl: 'Please enter a valid YouTube URL.',
      errYoutubeTooLongForFree: 'This video is too long to analyze on the free tier.',
      errYoutubeVideoTooLong:
        'This video is longer than 60 minutes. Try a shorter video for now.',
      errYoutubeVideoUnavailable: 'This video is unavailable or private.',
      errYoutubeAgeRestricted: 'This video is age-restricted and cannot be analyzed.',
      errYoutubeRegionBlocked: 'This video is not available in your region.',
      errYoutubeTranscriptUnavailable: 'Captions are unavailable for this video.',
      errYoutubeAudioFallbackFailed:
        'Audio transcription failed for this YouTube video.',
      errYoutubeAudioTranscriptionFailed:
        'Audio transcription failed for this YouTube video.',
      errYoutubeNetworkTimeout: 'YouTube extraction timed out. Check your connection and retry.',
      errYoutubeAnalysisFailed:
        'Captions and audio transcription both failed for this video.',
    };

    sendYoutubeError(
      res,
      status,
      code,
      messages[code] ?? messages.errYoutubeAnalysisFailed,
      {
        stage: err.stage,
        videoId: err.videoId,
        reason: err.reason,
        transcriptErrorKey: err.transcriptErrorKey,
        audioErrorKey: err.audioErrorKey,
      },
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
