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
 * Ensure path is a readable file (not /tmp or a directory).
 */
function validateAndApplyCookiePath(candidatePath, sourceLabel) {
  const pathBasename = candidatePath ? path.basename(candidatePath) : null;
  let exists = false;
  let isFile = false;

  try {
    if (candidatePath) {
      const stat = fs.statSync(candidatePath);
      exists = true;
      isFile = stat.isFile() && stat.size > 0;
    }
  } catch {
    exists = false;
    isFile = false;
  }

  logCookiesEvent('youtube_cookies_path_checked', {
    exists,
    isFile,
    pathBasename,
    source: sourceLabel,
  });

  if (!exists || !isFile) {
    logCookiesEvent('youtube_cookies_invalid_path', {
      pathBasename,
      source: sourceLabel,
      reason: !exists ? 'not_found' : 'not_a_file',
    });
    cookiesFilePath = null;
    cookiesSource = 'none';
    return null;
  }

  cookiesFilePath = candidatePath;
  cookiesSource = sourceLabel;
  return cookiesFilePath;
}

async function initYouTubeCookies() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    cookiesFilePath = null;
    cookiesSource = 'none';

    const envPath = process.env.YOUTUBE_COOKIES_PATH?.trim();
    const envBase64 = process.env.YOUTUBE_COOKIES_BASE64?.trim();

    if (envPath) {
      const resolved = validateAndApplyCookiePath(envPath, 'path');
      if (resolved) {
        logCookiesEvent('youtube_cookies_configured', { source: 'path' });
        logCookiesEvent('youtube_cookies_file_ready', { source: 'path', pathBasename: path.basename(resolved) });
        return resolved;
      }
    }

    if (envBase64) {
      try {
        const decoded = Buffer.from(envBase64, 'base64');
        if (!decoded.length) {
          throw new Error('Decoded cookies buffer is empty');
        }
        await fs.promises.writeFile(COOKIES_TEMP_FILE, decoded, { mode: 0o600 });
        const resolved = validateAndApplyCookiePath(COOKIES_TEMP_FILE, 'base64');
        if (resolved) {
          logCookiesEvent('youtube_cookies_configured', { source: 'base64' });
          logCookiesEvent('youtube_cookies_file_ready', {
            source: 'base64',
            pathBasename: path.basename(resolved),
          });
          return resolved;
        }
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

/** CLI --cookies path only when validated as a file. */
function getCliCookiesPath() {
  if (!cookiesFilePath) return null;
  try {
    const stat = fs.statSync(cookiesFilePath);
    if (!stat.isFile() || stat.size === 0) {
      logCookiesEvent('youtube_cookies_invalid_path', {
        pathBasename: path.basename(cookiesFilePath),
        reason: 'not_a_file_at_use',
      });
      return null;
    }
    return cookiesFilePath;
  } catch {
    logCookiesEvent('youtube_cookies_invalid_path', {
      pathBasename: path.basename(cookiesFilePath),
      reason: 'stat_failed_at_use',
    });
    return null;
  }
}

/** Do not pass cookies via ytdlp-nodejs fluent API (causes EISDIR). */
function getYtdlpCookiesOptions() {
  return {};
}

function appendYtDlpCliCookieArgs(args) {
  const cookiePath = getCliCookiesPath();
  if (!cookiePath) return args;
  logCookiesEvent('youtube_cookies_used_for_ytdlp', { source: cookiesSource });
  return [...args, '--cookies', cookiePath];
}

/** Append validated --cookies CLI args (alias for audio fallback). */
function appendCookiesArgs(args) {
  return appendYtDlpCliCookieArgs(args);
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

function mapYtdlpDownloadError(error) {
  if (isYoutubeBotVerificationError(error) && cookiesSource === 'none') {
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
  const err = new Error(combined || 'All audio download methods failed');
  err.code = 'errYoutubeAudioFallbackFailed';
  err.methodFailures = errors;
  return err;
}

module.exports = {
  initYouTubeCookies,
  getYouTubeCookiesPath,
  getYouTubeCookiesSource,
  getCliCookiesPath,
  getYtdlpCookiesOptions,
  appendYtDlpCliCookieArgs,
  appendCookiesArgs,
  isYoutubeBotVerificationError,
  mapYtdlpDownloadError,
  mapCombinedDownloadErrors,
  logCookiesUsedForYtdlp() {
    const cookiePath = getCliCookiesPath();
    if (cookiePath) {
      logCookiesEvent('youtube_cookies_used_for_ytdlp', { source: cookiesSource });
    }
  },
};
