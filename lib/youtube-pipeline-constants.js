/** YouTube ingestion limits and tiers (seconds). */

const FAST_PATH_MAX_SECONDS =
  Number(process.env.YOUTUBE_FAST_PATH_MAX_SECONDS) || 20 * 60;
const EXTENDED_MAX_SECONDS =
  Number(process.env.YOUTUBE_EXTENDED_MAX_SECONDS) || 60 * 60;
const TRANSCRIPT_MAX_CHARS = Number(process.env.YOUTUBE_MAX_CHARS) || 14000;
const TRANSCRIPT_MIN_CHARS = Number(process.env.YOUTUBE_MIN_CHARS) || 200;

function getDurationTier(durationSeconds) {
  if (durationSeconds <= 0) return 'fast';
  if (durationSeconds <= FAST_PATH_MAX_SECONDS) return 'fast';
  if (durationSeconds <= EXTENDED_MAX_SECONDS) return 'extended';
  return 'too_long';
}

module.exports = {
  FAST_PATH_MAX_SECONDS,
  EXTENDED_MAX_SECONDS,
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MIN_CHARS,
  getDurationTier,
};
