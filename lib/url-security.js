const dns = require('dns').promises;
const net = require('net');

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'www.youtube.com',
]);

function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const n = ip.toLowerCase();
    if (n === '::1' || n === '::') return true;
    if (n.startsWith('fc') || n.startsWith('fd')) return true;
    if (n.startsWith('fe80')) return true;
    if (n.startsWith('::ffff:')) {
      const mapped = n.slice(7);
      if (net.isIPv4(mapped)) return isPrivateOrReservedIp(mapped);
    }
  }

  return false;
}

function normalizeHostname(hostname) {
  return String(hostname ?? '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

function isBlockedHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (net.isIP(host) && isPrivateOrReservedIp(host)) return true;
  if (YOUTUBE_HOSTS.has(host) || host.endsWith('.youtube.com')) return true;
  return false;
}

/**
 * Validate and normalize article URL. Throws Error with `code` for i18n mapping.
 */
function validateArticleUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    const err = new Error('Invalid URL');
    err.code = 'errInvalidUrl';
    throw err;
  }

  let parsed;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    const err = new Error('Invalid URL');
    err.code = 'errInvalidUrl';
    throw err;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('Only http and https URLs are allowed');
    err.code = 'errInvalidUrl';
    throw err;
  }

  if (parsed.username || parsed.password) {
    const err = new Error('URL credentials are not allowed');
    err.code = 'errInvalidUrl';
    throw err;
  }

  if (isBlockedHostname(parsed.hostname)) {
    const host = normalizeHostname(parsed.hostname);
    const isYoutube =
      YOUTUBE_HOSTS.has(host) ||
      host.endsWith('.youtube.com') ||
      host === 'youtu.be';
    const err = new Error(
      isYoutube ? 'YouTube URLs are not supported' : 'This URL is not allowed',
    );
    err.code = isYoutube ? 'errYoutubeNotSupported' : 'errInvalidUrl';
    throw err;
  }

  return parsed.href;
}

/**
 * DNS-aware SSRF guard — blocks private/reserved resolved addresses.
 */
async function assertSafeUrl(urlString) {
  const parsed = new URL(urlString);
  if (isBlockedHostname(parsed.hostname)) {
    const err = new Error('Blocked hostname');
    err.code =
      normalizeHostname(parsed.hostname).includes('youtube') ||
      YOUTUBE_HOSTS.has(normalizeHostname(parsed.hostname))
        ? 'errYoutubeNotSupported'
        : 'errInvalidUrl';
    throw err;
  }

  if (net.isIP(parsed.hostname) && isPrivateOrReservedIp(parsed.hostname)) {
    const err = new Error('Private network URLs are not allowed');
    err.code = 'errInvalidUrl';
    throw err;
  }

  let records;
  try {
    records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    const err = new Error('Could not resolve hostname');
    err.code = 'errUrlCouldNotOpen';
    throw err;
  }

  for (const { address } of records) {
    if (isPrivateOrReservedIp(address)) {
      const err = new Error('URL resolves to a private network address');
      err.code = 'errInvalidUrl';
      throw err;
    }
  }
}

module.exports = {
  validateArticleUrl,
  assertSafeUrl,
  normalizeHostname,
};
