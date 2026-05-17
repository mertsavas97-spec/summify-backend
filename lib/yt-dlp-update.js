const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveYtDlpBinaryPath() {
  try {
    const { getYtDlpPath } = require('./youtube-audio-fallback');
    if (typeof getYtDlpPath === 'function') {
      return getYtDlpPath();
    }
  } catch {
    // fall through
  }

  try {
    const { BIN_DIR } = require('ytdlp-nodejs');
    const platform =
      process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'win32'
          ? 'win32'
          : 'linux';
    const candidate = path.join(BIN_DIR, `yt-dlp_${platform}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // fall through
  }

  const platform =
    process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'win32'
        : 'linux';
  return path.join(__dirname, '..', 'node_modules', 'ytdlp-nodejs', 'bin', `yt-dlp_${platform}`);
}

function getYtDlpVersion() {
  const ytdlpPath = resolveYtDlpBinaryPath();
  return execSync(`"${ytdlpPath}" --version`, {
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
}

function updateYtDlp() {
  try {
    const ytdlpPath = resolveYtDlpBinaryPath();

    console.log('[startup] Updating yt-dlp...', { pathBasename: path.basename(ytdlpPath) });

    try {
      execSync('pip install --upgrade yt-dlp', { stdio: 'pipe', timeout: 60000 });
      console.log('[startup] yt-dlp updated via pip');
      return;
    } catch {
      // pip unavailable or failed
    }

    try {
      const binDir = path.dirname(ytdlpPath);
      fs.mkdirSync(binDir, { recursive: true });
      execSync(
        `curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${ytdlpPath}" && chmod +x "${ytdlpPath}"`,
        { stdio: 'pipe', timeout: 30000, shell: true },
      );
      console.log('[startup] yt-dlp updated via curl');
      return;
    } catch {
      // curl failed
    }

    try {
      execSync(`"${ytdlpPath}" -U`, { stdio: 'pipe', timeout: 30000 });
      console.log('[startup] yt-dlp self-updated');
    } catch (error) {
      console.warn('[startup] yt-dlp update failed:', error.message);
    }
  } catch (error) {
    console.warn('[startup] yt-dlp update error:', error.message);
  }
}

module.exports = {
  updateYtDlp,
  getYtDlpVersion,
  resolveYtDlpBinaryPath,
};
