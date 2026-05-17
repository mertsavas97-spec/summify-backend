const {
  extractYouTubeTextWithFallback,
  TRANSCRIPT_MIN_CHARS,
} = require('./youtube-pipeline');
const { TRANSCRIPT_MAX_CHARS, EXTENDED_MAX_SECONDS } = require('./youtube-pipeline-constants');

async function extractYouTubeContent(rawUrl) {
  return extractYouTubeTextWithFallback(rawUrl);
}

const extractYouTubeTranscript = extractYouTubeContent;

module.exports = {
  extractYouTubeContent,
  extractYouTubeTranscript,
  extractYouTubeTextWithFallback,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MIN_CHARS,
  EXTENDED_MAX_SECONDS,
};
