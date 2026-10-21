import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const sourceId = '00000000-0000-4000-8000-000000000001';
const url = 'https://www.youtube.com/watch?v=7cvFTlc8zAg';
const alignment = {
  status: 'ready', confidence: 0.98,
  calibration: { left: 0, right: 1, line: 0.79, whiteLine: 0.9, blackLine: 0.79, firstMidi: 31, lastMidi: 91 },
  options: { handMode: 'color', leftHue: 205, rightHue: 45, trim: true, startTime: 6, endTime: 107, fps: 60 },
};
const notes = [{ pitch: 53, start: 0, duration: 1, velocity: 90, hand: 'left' }, { pitch: 77, start: 0, duration: 1, velocity: 90, hand: 'right' }];

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fallnote-auto-flow-'));
  const calls = { download: [], align: [], convert: [], publish: [], consent: [] };
  const video = { sourceId, name: 'Auto tutorial', width: 1280, height: 720, duration: 118, url: `/media/${sourceId}.mp4`, path: join(root, '.local', 'private.mp4'), filename: 'private.mp4' };
  const app = createApp({ root, port: 0, services: {
    findVideo: async () => video,
    zenSessionForVideo: async source => { calls.consent.push(source); return { videoUrl: source, browser: 'firefox', profile: 'local-only-profile' }; },
    downloadVideo: async (...args) => { calls.download.push(args); return overrides.downloadVideo ? overrides.downloadVideo(...args) : { sourceId }; },
    autoCalibrate: async (...args) => { calls.align.push(args); return overrides.autoCalibrate ? overrides.autoCalibrate(...args) : structuredClone(alignment); },
    convertVideo: async (...args) => { calls.convert.push(args); return overrides.convertVideo ? overrides.convertVideo(...args) : structuredClone(notes); },
    publishLibrary: async (...args) => { calls.publish.push(args); return overrides.publishLibrary ? overrides.publishLibrary(...args) : { status: 'published', url: 'https://goodman-pro.github.io/fallnote/' }; },
  } });
  t.after(async () => {
    app.server.closeAllConnections();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('fallnote-auto-flow-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs', 'library'), { recursive: true });
  await writeFile(join(root, 'docs', 'library', 'manifest.json'), '{"version":1,"songs":[]}');
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, headers = {}) {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function start(body = {}) {
    const response = await request('/api/auto-convert', { url, ...body });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return response.body.jobId;
  }
  async function wait(id, predicate = job => job.status !== 'running') {
    const deadline = Date.now() + 3000;
    do {
      const job = (await request(`/api/jobs/${id}`)).body;
      if (predicate(job)) return job;
      await delay(10);
    } while (Date.now() < deadline);
    assert.fail('Automatic job did not finish');
  }
  return { root, app, calls, video, request, start, wait };
}

test('automatic import uses inferred rows and timing, saves a real MIDI, then publishes by default', async t => {
  const f = await fixture(t);
  const job = await f.wait(await f.start());
  assert.equal(job.status, 'completed');
  assert.equal(job.result.publication.status, 'published');
  assert.deepEqual(job.result.alignment, alignment);
  assert.deepEqual(f.calls.convert[0][1], alignment.calibration);
  assert.deepEqual(f.calls.convert[0][2], alignment.options);
  assert.equal(f.calls.download[0][1], url);
  assert.equal(f.calls.download[0][2].browserSession, undefined);
  assert.equal(f.calls.consent.length, 0);
  assert.equal(f.calls.publish[0][0].verifyFile, job.result.song.file);
  assert.equal(job.result.source.path, undefined);
  assert.equal(job.result.source.filename, undefined);
  const manifest = (await f.request('/library/manifest.json')).body;
  assert.equal(manifest.songs.length, 1);
  assert.equal(manifest.songs[0].noteCount, 2);
});

test('uncertain alignment returns a usable source and suggested settings without saving or publishing', async t => {
  const uncertain = { ...alignment, status: 'needs_review', reason: 'Could not confirm the octave.' };
  const f = await fixture(t, { autoCalibrate: async () => uncertain });
  const job = await f.wait(await f.start());
  assert.equal(job.status, 'completed');
  assert.equal(job.result.source.sourceId, sourceId);
  assert.deepEqual(job.result.alignment, uncertain);
  assert.equal(job.result.song, undefined);
  assert.equal(f.calls.convert.length, 0);
  assert.equal(f.calls.publish.length, 0);
  assert.equal((await f.request('/library/manifest.json')).body.songs.length, 0);
});

test('Zen authorization applies only to an explicitly selected import and its canonical URL', async t => {
  const f = await fixture(t, { autoCalibrate: async () => ({ status: 'needs_review', reason: 'fixture' }) });
  await f.wait(await f.start({ url: 'https://youtu.be/7cvFTlc8zAg?t=8', useZenSession: true }));
  await f.wait(await f.start());
  assert.deepEqual(f.calls.consent, [url]);
  assert.equal(f.calls.download[0][2].browserSession.videoUrl, url);
  assert.equal(f.calls.download[1][2].browserSession, undefined);
});

test('automatic conversion respects publication opt-out', async t => {
  const f = await fixture(t);
  const job = await f.wait(await f.start({ publish: false }));
  assert.equal(job.status, 'completed');
  assert.equal(job.result.publication.status, 'local');
  assert.equal(f.calls.publish.length, 0);
  assert.equal((await f.request('/library/manifest.json')).body.songs.length, 1);
});

test('a publishing error preserves the converted MIDI and reports a retryable failure', async t => {
  const f = await fixture(t, { publishLibrary: async () => { throw new Error('Offline'); } });
  const job = await f.wait(await f.start());
  assert.equal(job.status, 'completed');
  assert.equal(job.result.publication.status, 'failed');
  assert.equal(job.result.publication.error, 'Offline');
  assert.equal((await f.request('/library/manifest.json')).body.songs.length, 1);
});

test('a download failure cannot proceed to alignment, conversion, publication, or an unsigned cookie retry', async t => {
  const f = await fixture(t, { downloadVideo: async () => { throw new Error('403 Forbidden'); } });
  const job = await f.wait(await f.start());
  assert.equal(job.status, 'failed');
  assert.equal(f.calls.align.length, 0);
  assert.equal(f.calls.convert.length, 0);
  assert.equal(f.calls.publish.length, 0);
  assert.equal(f.calls.consent.length, 0);
});

test('cancellation during alignment and duplicate submissions never save or publish', async t => {
  let finishAlignment;
  const f = await fixture(t, { autoCalibrate: () => new Promise(resolve => { finishAlignment = resolve; }) });
  const id = await f.start();
  await f.wait(id, job => job.progress >= 0.35);
  assert.equal((await f.request('/api/auto-convert', { url })).status, 409);
  assert.equal((await f.request(`/api/jobs/${id}/cancel`, {})).status, 200);
  finishAlignment(alignment);
  await delay(30);
  assert.equal((await f.wait(id)).status, 'cancelled');
  assert.equal(f.calls.convert.length, 0);
  assert.equal(f.calls.publish.length, 0);
});

test('invalid URLs, publication types and foreign origins are rejected before download', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auto-convert', { url: 'https://example.com/video' })).status, 400);
  assert.equal((await f.request('/api/auto-convert', { url, publish: 'yes' })).status, 400);
  assert.equal((await f.request('/api/auto-convert', { url }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal(f.calls.download.length, 0);
  assert.equal(f.calls.consent.length, 0);
});
