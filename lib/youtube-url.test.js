const assert = require('assert');
const {
  parseYouTubeVideoId,
  validateYouTubeUrl,
  normalizeYouTubeUrl,
  VIDEO_ID_RE,
} = require('./youtube-url');

const CASES = [
  ['https://youtu.be/eGk94K1grWw', 'eGk94K1grWw'],
  ['https://youtu.be/eGk94K1grWw?si=qH9Z3KQ8GVaVdqhp', 'eGk94K1grWw'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
  ['https://www.youtube.com/shorts/eGk94K1grWw', 'eGk94K1grWw'],
  ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
];

let passed = 0;
for (const [url, expectedId] of CASES) {
  const id = parseYouTubeVideoId(url);
  assert.strictEqual(id, expectedId, `parse failed for ${url}`);
  assert(VIDEO_ID_RE.test(id), `id format failed for ${url}`);
  const validated = validateYouTubeUrl(url);
  assert.strictEqual(validated.videoId, expectedId);
  const normalized = normalizeYouTubeUrl(url);
  assert.strictEqual(normalized.videoId, expectedId);
  assert.strictEqual(
    normalized.normalizedUrl,
    `https://www.youtube.com/watch?v=${expectedId}`,
  );
  passed += 1;
}

console.log(`youtube-url.test.js: ${passed}/${CASES.length} passed`);
