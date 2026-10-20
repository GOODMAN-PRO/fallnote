import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeErrorPresentation, youtubeRetryRequest } from '../docs/youtube-errors.mjs';

test('bot check becomes concise guidance while preserving the original diagnostic', () => {
  const diagnostic = "yt-dlp exited with code 1\nERROR: [youtube] cStbWxTQTJo: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for authentication.\nhttps://github.com/yt-dlp/yt-dlp/wiki/FAQ";
  const result = youtubeErrorPresentation(diagnostic);
  assert.equal(result.kind, 'sign-in');
  assert.equal(result.offerZenRetry, true);
  assert.equal(result.details, diagnostic);
  assert.match(result.message, /requires a sign-in check/);
  assert.ok(result.message.length < 100);
});

test('rejection after explicit Zen access is distinct and does not promise success', () => {
  const result = youtubeErrorPresentation("ERROR: Sign in to confirm you're not a bot.", true);
  assert.match(result.message, /rejected the signed-in attempt/);
  assert.match(result.advice, /Open this video in Zen/);
  assert.match(result.advice, /does not guarantee/);
});

test('age and login challenges offer explicit session recovery', () => {
  for (const diagnostic of ['ERROR: Sign in to confirm your age.', 'ERROR: Please log in to watch this video.', 'ERROR: Authentication is required.']) {
    assert.equal(youtubeErrorPresentation(diagnostic).offerZenRetry, true);
  }
});

test('final error wins over unrelated earlier bot or HTTP warnings', () => {
  const result = youtubeErrorPresentation("WARNING: HTTP Error 429\nWARNING: Sign in to confirm you're not a bot.\nERROR: [youtube] Video unavailable");
  assert.equal(result.kind, 'other');
  assert.equal(result.offerZenRetry, false);
  assert.match(result.message, /video is unavailable/);
});

test('unknown diagnostics remain intact without assuming that cookies will help', () => {
  const diagnostic = 'ERROR: Requested format is not available\nTry --list-formats for a list.';
  const result = youtubeErrorPresentation(diagnostic);
  assert.equal(result.details, diagnostic);
  assert.equal(result.offerZenRetry, false);
  assert.match(result.message, /details below/);
});

test('missing Zen profile has specific guidance, without a blind signed-in retry', () => {
  const result = youtubeErrorPresentation('This Zen profile has no usable local sign-in cookies. Sign into YouTube in Zen first.', true);
  assert.equal(result.offerZenRetry, false);
  assert.match(result.message, /could not use your Zen sign-in/);
});

test('explicit retry preserves the exact failed URL and cannot follow an edited input', () => {
  const url = 'https://www.youtube.com/watch?v=cStbWxTQTJo&t=3';
  assert.deepEqual(youtubeRetryRequest(url, url), { url, useZenSession: true });
  assert.equal(youtubeRetryRequest(url, 'https://www.youtube.com/watch?v=another'), null);
  assert.equal(youtubeRetryRequest(null, url), null);
  assert.equal(youtubeRetryRequest('', ''), null);
});

test('retry cannot create a link or request for a non-YouTube or unsafe URL', () => {
  for (const url of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=id', 'https://user:secret@youtube.com/watch?v=id', 'not a URL']) {
    assert.equal(youtubeRetryRequest(url, url), null);
  }
  const short = 'https://youtu.be/cStbWxTQTJo';
  assert.deepEqual(youtubeRetryRequest(short, short), { url: short, useZenSession: true });
});
