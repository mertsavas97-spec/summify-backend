const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const { normalizeHostname } = require('./url-security');

const FETCH_TIMEOUT_MS = Number(process.env.ARTICLE_FETCH_TIMEOUT_MS) || 25000;
const MAX_HTML_BYTES = Number(process.env.ARTICLE_MAX_HTML_BYTES) || 5 * 1024 * 1024;
const ARTICLE_MAX_CHARS = Number(process.env.ARTICLE_MAX_CHARS) || 14000;
const ARTICLE_MIN_CHARS = Number(process.env.ARTICLE_MIN_CHARS) || 200;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 SummifyArticleBot/1.0',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

function logEvent(event, payload = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    }),
  );
}

function capText(text, maxChars = ARTICLE_MAX_CHARS) {
  if (!text || text.length <= maxChars) return text ?? '';
  return `${text.slice(0, maxChars)}\n\n[Article truncated for analysis]`;
}

function cleanParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

function buildArticleText({ title, sourceDomain, author, publishedAt, body }) {
  const sections = [`Title: ${title}`, `Source: ${sourceDomain}`];
  if (author) sections.push(`Author: ${author}`);
  if (publishedAt) sections.push(`Published: ${publishedAt}`);
  sections.push('');
  sections.push(body);
  return sections.join('\n').trim();
}

function isHtmlContentType(contentType) {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

async function readResponseWithSizeLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength && contentLength > maxBytes) {
    const err = new Error('HTML response too large');
    err.code = 'errArticleExtractFailed';
    throw err;
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const err = new Error('HTML response too large');
      err.code = 'errArticleExtractFailed';
      throw err;
    }
    return text;
  }

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      const err = new Error('HTML response too large');
      err.code = 'errArticleExtractFailed';
      throw err;
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);
  return buffer.toString('utf8');
}

/**
 * Fetch HTML with timeout, size, and content-type guards.
 */
async function fetchArticleHtml(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    const statusCode = response.status;
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      const err = new Error(`HTTP ${statusCode}`);
      err.code = 'errUrlCouldNotOpen';
      err.statusCode = statusCode;
      throw err;
    }

    if (!isHtmlContentType(contentType)) {
      const err = new Error('Response is not HTML');
      err.code = 'errArticleExtractFailed';
      err.statusCode = statusCode;
      throw err;
    }

    const html = await readResponseWithSizeLimit(response, MAX_HTML_BYTES);
    const rawHtmlChars = html.length;
    const durationMs = Date.now() - startedAt;

    return { html, rawHtmlChars, statusCode, durationMs };
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error('Fetch timed out');
      err.code = 'errUrlCouldNotOpen';
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract article using Mozilla Readability + JSDOM.
 */
function extractWithReadability(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const document = dom.window.document;
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    const err = new Error('Readability could not parse article');
    err.code = 'errArticleExtractFailed';
    throw err;
  }

  const sourceDomain = normalizeHostname(new URL(pageUrl).hostname);
  const title = (article.title || document.title || sourceDomain).trim();
  const author = article.byline?.trim() || null;
  const publishedAt = article.publishedTime?.trim() || null;

  const paragraphs = cleanParagraphs(article.textContent ?? '');
  const body = paragraphs.join('\n\n');

  let text = buildArticleText({
    title,
    sourceDomain,
    author,
    publishedAt,
    body,
  });

  text = capText(text);

  return {
    title,
    sourceDomain,
    author,
    publishedAt,
    text,
    extractedChars: text.length,
    extractionMethod: 'readability',
  };
}

/**
 * Full server-side article extraction pipeline.
 */
async function extractArticleFromUrl(url) {
  const parsedUrl = new URL(url);
  const domain = normalizeHostname(parsedUrl.hostname);

  logEvent('article_extract_start', { domain, url });

  const pipelineStart = Date.now();
  let fetchMeta;

  try {
    fetchMeta = await fetchArticleHtml(url);
    logEvent('article_fetch_done', {
      domain,
      statusCode: fetchMeta.statusCode,
      rawHtmlChars: fetchMeta.rawHtmlChars,
      durationMs: fetchMeta.durationMs,
    });

    const extracted = extractWithReadability(fetchMeta.html, url);

    if (extracted.extractedChars < ARTICLE_MIN_CHARS) {
      const err = new Error('Article text too short');
      err.code = 'errArticleTooShort';
      throw err;
    }

    logEvent('article_readability_done', {
      domain,
      extractedChars: extracted.extractedChars,
      rawHtmlChars: fetchMeta.rawHtmlChars,
      durationMs: Date.now() - pipelineStart,
      extractionMethod: extracted.extractionMethod,
    });

    return {
      ...extracted,
      rawHtmlChars: fetchMeta.rawHtmlChars,
      publishDate: extracted.publishedAt,
    };
  } catch (error) {
    logEvent('article_extract_failed', {
      domain,
      durationMs: Date.now() - pipelineStart,
      errorCode: error.code ?? 'errArticleExtractFailed',
      statusCode: error.statusCode ?? fetchMeta?.statusCode ?? null,
      rawHtmlChars: fetchMeta?.rawHtmlChars ?? null,
      message: error.message,
    });
    throw error;
  }
}

module.exports = {
  extractArticleFromUrl,
  ARTICLE_MIN_CHARS,
  ARTICLE_MAX_CHARS,
  logEvent,
};
