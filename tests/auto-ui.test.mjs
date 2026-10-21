import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeVideo, youtubeRequest, retryYoutubeRequest, createYoutubeRunGate, scanRows } from '../docs/auto-flow.mjs';

const url = 'https://www.youtube.com/watch?v=cStbWxTQTJo';

test('automatic paste accepts full YouTube video links supported by the importer', () => {
  for (const value of [url, url + '&t=3', 'https://youtu.be/cStbWxTQTJo?si=abc', 'https://m.youtube.com/shorts/cStbWxTQTJo', 'https://www.youtube.com/embed/cStbWxTQTJo', 'https://music.youtube.com/watch?v=cStbWxTQTJo']) {
    assert.equal(youtubeVideo(value).id, 'cStbWxTQTJo');
    assert.equal(youtubeVideo(value).url, value);
  }
});

test('partial text, playlists, unsafe hosts and credentials cannot trigger automatic work', () => {
  for (const value of ['', 'youtube.com/watch?v=cStbWxTQTJo', 'https://youtube.com', 'https://youtube.com/playlist?list=123', url.slice(0, -1), 'http://youtube.com/watch?v=cStbWxTQTJo', 'https://youtube.com.evil.test/watch?v=cStbWxTQTJo', 'https://user:secret@youtube.com/watch?v=cStbWxTQTJo', 'https://youtube.com:8443/watch?v=cStbWxTQTJo', 'here is ' + url, url + '\nmore']) {
    assert.equal(youtubeVideo(value), null, value);
    assert.equal(youtubeRequest({ url: value }), null, value);
  }
});

test('automatic and manual submissions select different endpoints and share one publish choice', () => {
  assert.deepEqual(youtubeRequest({ url }), { path: 'api/auto-convert', body: { url, useZenSession: false, publish: true } });
  assert.deepEqual(youtubeRequest({ url, publish: false }), { path: 'api/auto-convert', body: { url, useZenSession: false, publish: false } });
  assert.deepEqual(youtubeRequest({ url, automatic: false }), { path: 'api/youtube', body: { url, useZenSession: false } });
});

test('a previous request never supplies Zen permission to a new request', () => {
  assert.equal(youtubeRequest({ url, useZenSession: true }).body.useZenSession, true);
  assert.equal(youtubeRequest({ url }).body.useZenSession, false);
  assert.equal(youtubeRequest({ url, useZenSession: 'true' }).body.useZenSession, false);
});

test('explicit Zen retry preserves the failed automatic mode, exact URL and publish opt-out', () => {
  const failure = { url: url + '&t=3', automatic: true, publish: false };
  assert.deepEqual(retryYoutubeRequest(failure, failure.url), { path: 'api/auto-convert', body: { url: failure.url, useZenSession: true, publish: false } });
  assert.equal(retryYoutubeRequest(failure, url), null);
  assert.equal(retryYoutubeRequest(null, url), null);
});

test('a manual import failure retries as manual even when automatic mode is now selected elsewhere', () => {
  const failure = { url, automatic: false, publish: true };
  assert.deepEqual(retryYoutubeRequest(failure, url), { path: 'api/youtube', body: { url, useZenSession: true } });
});

test('a retry respects a newly unchecked publish choice and cannot expand an original opt-out', () => {
  assert.equal(retryYoutubeRequest({ url, automatic: true, publish: true }, url, false).body.publish, false);
  assert.equal(retryYoutubeRequest({ url, automatic: true, publish: false }, url, true).body.publish, false);
});

test('paste and Enter cannot start concurrent jobs, and completion does not silently requeue', () => {
  const gate = createYoutubeRunGate(), request = youtubeRequest({ url });
  assert.equal(gate.claim(request, 'paste'), true);
  assert.equal(gate.claim(request, 'submit'), false);
  assert.equal(gate.claim(youtubeRequest({ url: 'https://youtu.be/BO5naP1aOfw' }), 'paste'), false);
  gate.finish();
  assert.equal(gate.claim(request, 'paste'), false);
  assert.equal(gate.claim(request, 'submit'), true);
});

test('a delayed paste after Enter and alternate links to the same video cannot duplicate the automatic job', () => {
  const gate = createYoutubeRunGate();
  assert.equal(gate.claim(youtubeRequest({ url }), 'submit'), true);
  gate.finish();
  assert.equal(gate.claim(youtubeRequest({ url: 'https://youtu.be/cStbWxTQTJo' }), 'paste'), false);
  assert.equal(gate.claim(youtubeRequest({ url }), 'retry'), true);
});

test('manual mode never starts on paste, but an explicit manual import remains available', () => {
  const gate = createYoutubeRunGate(), request = youtubeRequest({ url, automatic: false });
  assert.equal(gate.claim(request, 'paste'), false);
  assert.equal(gate.claim(null, 'paste'), false);
  assert.equal(gate.claim(request, 'submit'), true);
});

test('separate white and black scan rows survive unrelated edits and reset only on an edited scan line', () => {
  const calibration = { left: .04, right: .96, line: .87, whiteLine: .91375, blackLine: .86425 };
  assert.deepEqual(scanRows(calibration), { whiteLine: .91375, blackLine: .86425 });
  assert.deepEqual(scanRows({ ...calibration, left: .05 }), { whiteLine: .91375, blackLine: .86425 });
  assert.deepEqual(scanRows(calibration, true), {});
  assert.deepEqual(scanRows({ whiteLine: NaN, blackLine: 1.1 }), {});
  assert.deepEqual(scanRows({ whiteLine: .75 }), { whiteLine: .75 });
});
