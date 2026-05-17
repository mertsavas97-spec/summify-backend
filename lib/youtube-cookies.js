const fs = require('fs');
const os = require('os');
const path = require('path');

const COOKIES_TEMP_FILE = path.join(os.tmpdir(), 'youtube-cookies.txt');

let cookiesSource = 'none';
let cookiesFilePath = null;
let initPromise = null;

const BOT_VERIFICATION_RE =
  /sign in to confirm|confirm you.?re not a bot|not a bot|cookies-from-browser|use --cookies\b|bot verification|confirm you.?re not a robot/i;

function logCookiesEvent(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

/**
 * Load cookies from YOUTUBE_COOKIES_PATH (preferred) or YOUTUBE_COOKIES_BASE64.
 * Safe to call multiple times; runs once.
 */
async function initYouTubeCookies() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const envPath = process.env.YOUTUBE_COOKIES_PATH?.trim();
    const envBase64 = process.env.YOUTUBE_COOKIES_BASE64?.trim();

    if (envPath) {
      try {
        await fs.promises.access(envPath, fs.constants.R_OK);
        const stat = await fs.promises.stat(envPath);
        if (!stat.isFile() || stat.size === 0) {
          throw new Error('Cookies path is empty or not a file');
        }
        cookiesFilePath = envPath;
        cookiesSource = 'path';
        logCookiesEvent('youtube_cookies_configured', { source: 'path' });
        logCookiesEvent('youtube_cookies_file_ready', { source: 'path' });
        return cookiesFilePath;
      } catch (error) {
        logCookiesEvent('youtube_cookies_configured', {
          source: 'none',
          reason: 'path_unusable',
          message: String(error?.message ?? error).slice(0, 120),
        });
      }
    }

    if (envBase64) {
      try {
        const decoded = Buffer.from(envBase64, 'base64');
        if (!decoded.length) {
          throw new Error('Decoded cookies buffer is empty');
        }
        await fs.promises.writeFile(COOKIES_TEMP_FILE, decoded, { mode: 0o600 });
        cookiesFilePath = COOKIES_TEMP_FILE;
        cookiesSource = 'base64';
        logCookiesEvent('youtube_cookies_configured', { source: 'base64' });
        logCookiesEvent('youtube_cookies_file_ready', { source: 'base64' });
        return cookiesFilePath;
      } catch (error) {
        logCookiesEvent('youtube_cookies_configured', {
          source: 'none',
          reason: 'base64_write_failed',
          message: String(error?.message ?? error).slice(0, 120),
        });
      }
    }

    logCookiesEvent('youtube_cookies_configured', { source: 'none' });
    return null;
  })();

  return initPromise;
}

function getYouTubeCookiesPath() {
  return cookiesFilePath;
}

function getYouTubeCookiesSource() {
  return cookiesSource;
}

function getYtdlpCookiesOptions() {
  if (!cookiesFilePath) return {};
  return { cookies: cookiesFilePath };
}

function appendYtDlpCliCookieArgs(args) {
  if (!cookiesFilePath) return args;
  logCookiesEvent('youtube_cookies_used_for_ytdlp', { source: cookiesSource });
  return [...args, '--cookies', cookiesFilePath];
}

function isYoutubeBotVerificationError(errorOrMessage) {
  const text =
    typeof errorOrMessage === 'string'
      ? errorOrMessage
      : [
          errorOrMessage?.message,
          errorOrMessage?.stderr,
          errorOrMessage?.stdout,
        ]
          .filter(Boolean)
          .join(' ');
  return BOT_VERIFICATION_RE.test(text);
}

/**
 * Map yt-dlp bot/sign-in failures when cookies are not configured.
 */
function mapYtdlpDownloadError(error) {
  if (
    isYoutubeBotVerificationError(error) &&
    cookiesSource === 'none'
  ) {
    const err = new Error(
      'YouTube requires verification for this video. Configure cookies or try another video.',
    );
    err.code = 'errYoutubeBotVerificationRequired';
    return err;
  }
  return error;
}

function mapCombinedDownloadErrors(errors) {
  const combined = errors.join(' | ');
  if (isYoutubeBotVerificationError(combined) && cookiesSource === 'none') {
    const err = new Error(
      'YouTube requires verification for this video. Configure cookies or try another video.',
    );
    err.code = 'errYoutubeBotVerificationRequired';
    return err;
  }
  const err = new Error(
    combined || 'All audio download methods failed',
  );
  err.code = 'errYoutubeAudioFallbackFailed';
  return err;
}

module.exports = {
  initYouTubeCookies,
  getYouTubeCookiesPath,
  getYouTubeCookiesSource,
  getYtdlpCookiesOptions,
  appendYtDlpCliCookieArgs,
  isYoutubeBotVerificationError,
  mapYtdlpDownloadError,
  mapCombinedDownloadErrors,
  logCookiesUsedForYtdlp() {
    if (cookiesFilePath) {
      logCookiesEvent('youtube_cookies_used_for_ytdlp', { source: cookiesSource });
    }
  },
};
