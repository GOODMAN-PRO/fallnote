import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const sourceId = '00000000-0000-4000-8000-000000000001';
const repository = 'fixture-owner/fixture-library';
const publishedUrl = 'https://fixture-owner.github.io/fixture-library/';
const notes = [
  { pitch: 48, start: 0, duration: 1, velocity: 80, hand: 'left' },
  { pitch: 64, start: 0.25, duration: 0.5, velocity: 90, hand: 'right' }
];
const conversionInput = {
  sourceId, title: 'Automatic publication fixture', artist: 'Test composer',
  calibration: { left: 0, right: 1, line: 0.5, firstMidi: 21, lastMidi: 108 },
  options: { handMode: 'color' }
};

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fallnote-autopublish-test-'));
  let app;
  t.after(async () => {
    if (app?.server.listening) {
      app.server.closeAllConnections();
      await new Promise((resolveClose, reject) => app.server.close(error => error ? reject(error) : resolveClose()));
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'Cleanup must remain directly inside the temporary directory');
    assert.ok(basename(root).startsWith('fallnote-autopublish-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs', 'library'), { recursive: true });
  await writeFile(join(root, 'docs', 'index.html'), '<!doctype html><title>Publication test</title>');
  await writeFile(join(root, 'docs', 'library', 'manifest.json'), '{"version":1,"songs":[]}');
  const calls = { findVideo: [], convertVideo: [], publishLibrary: [] };
  const video = { sourceId, name: 'Fixture tutorial', path: join(root, '.local', 'fixture.mp4'), duration: 2, width: 640, height: 360 };
  app = createApp({
    root, port: 0, repository,
    services: {
      findVideo: async (mediaDir, id) => {
        calls.findVideo.push({ mediaDir, id });
        assert.equal(mediaDir, join(root, '.local', 'media'));
        assert.equal(id, sourceId);
        return video;
      },
      convertVideo: async (...args) => {
        calls.convertVideo.push(args);
        return overrides.convertVideo ? overrides.convertVideo(...args) : structuredClone(notes);
      },
      publishLibrary: async args => {
        calls.publishLibrary.push(args);
        assert.equal(args.root, root);
        assert.equal(args.repository, repository);
        assert.equal(args.publishedUrl, publishedUrl);
        assert.equal(typeof args.progress, 'function');
        return overrides.publishLibrary ? overrides.publishLibrary(args) : { status: 'published', url: publishedUrl };
      }
    }
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  assert.equal(app.server.address().address, '127.0.0.1');

  function request(path, method = 'GET', data) {
    return new Promise((resolveRequest, reject) => {
      const body = data === undefined ? undefined : JSON.stringify(data);
      const outgoing = http.request({
        hostname: '127.0.0.1', port, path, method,
        headers: {
          Host: `127.0.0.1:${port}`, Connection: 'close',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
        }
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolveRequest({
            status: incoming.statusCode, headers: incoming.headers, bytes,
            json: incoming.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : undefined
          });
        });
      });
      outgoing.setTimeout(3000, () => outgoing.destroy(new Error(`Timed out requesting ${path}`)));
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }

  async function waitJob(id, predicate = job => job.status !== 'running') {
    const deadline = Date.now() + 3000;
    let job;
    do {
      const response = await request(`/api/jobs/${id}`);
      assert.equal(response.status, 200);
      job = response.json;
      if (predicate(job)) return job;
      await delay(10);
    } while (Date.now() < deadline);
    assert.fail(`Job did not reach the expected state: ${JSON.stringify(job)}`);
  }

  async function startConvert(extra = {}) {
    const response = await request('/api/convert', 'POST', { ...conversionInput, ...extra });
    assert.equal(response.status, 202, JSON.stringify(response.json));
    return response.json.jobId;
  }

  return { root, app, calls, request, waitJob, startConvert };
}

async function assertSavedDownload(context, result) {
  const manifest = await context.request('/library/manifest.json');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json.songs.length, 1);
  assert.deepEqual(manifest.json.songs[0], result.song);
  assert.deepEqual(result.notes, notes);
  const download = await context.request(`/${result.song.file}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'audio/midi');
  assert.equal(download.bytes.subarray(0, 4).toString(), 'MThd');
  assert.equal(download.bytes.readUInt16BE(8), 1);
  assert.deepEqual(download.bytes, await readFile(join(context.root, 'docs', result.song.file)));
  return download.bytes;
}

test('conversion publishes by default after saving the real MIDI and exposes the verified publication result', async t => {
  const context = await fixture(t, {
    publishLibrary: async args => {
      const manifest = JSON.parse(await readFile(join(args.root, 'docs', 'library', 'manifest.json'), 'utf8'));
      assert.equal(manifest.songs.length, 1, 'The song must be saved before publication starts');
      assert.equal(args.verifyFile, manifest.songs[0].file);
      const bytes = await readFile(join(args.root, 'docs', args.verifyFile));
      assert.equal(bytes.subarray(0, 4).toString(), 'MThd');
      args.progress(0.95, 'Fixture Pages download verified');
      return { status: 'published', url: publishedUrl };
    }
  });
  const job = await context.waitJob(await context.startConvert());
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result.publication, { status: 'published', url: publishedUrl });
  assert.equal(context.calls.convertVideo.length, 1);
  assert.equal(context.calls.publishLibrary.length, 1);
  assert.deepEqual(context.calls.convertVideo[0][1], conversionInput.calibration);
  assert.deepEqual(context.calls.convertVideo[0][2], conversionInput.options);
  await assertSavedDownload(context, job.result);
});

test('explicit publication opt-out saves a downloadable MIDI without calling the publisher', async t => {
  const context = await fixture(t, { publishLibrary: async () => { throw new Error('Publisher must not run after opt-out'); } });
  const job = await context.waitJob(await context.startConvert({ publish: false }));
  assert.equal(job.status, 'completed');
  assert.equal(job.result.publication.status, 'local');
  assert.equal(context.calls.publishLibrary.length, 0);
  await assertSavedDownload(context, job.result);
});

test('publication failure keeps conversion completed and downloadable, reports failure, and releases the library lock', async t => {
  const context = await fixture(t, { publishLibrary: async () => { throw new Error('Fixture GitHub push failed'); } });
  const job = await context.waitJob(await context.startConvert());
  assert.equal(job.status, 'completed', 'A publication failure must not discard a successful conversion');
  assert.equal(job.error, undefined);
  assert.equal(job.result.publication.status, 'failed');
  assert.match(job.result.publication.error, /Fixture GitHub push failed/);
  assert.equal(context.calls.publishLibrary.length, 1);
  const originalBytes = await assertSavedDownload(context, job.result);
  const edited = await context.request(`/api/library/${job.result.song.id}`, 'PATCH', { title: 'Saved after publication failure' });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.song.title, 'Saved after publication failure');
  assert.deepEqual((await context.request(`/${job.result.song.file}`)).bytes, originalBytes);
});

test('an unverified Pages update remains pending instead of being reported as published', async t => {
  const pending = { status: 'pending', url: publishedUrl, error: 'Fixture Pages update is not visible yet' };
  const context = await fixture(t, { publishLibrary: async () => pending });
  const job = await context.waitJob(await context.startConvert());
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result.publication, pending);
  await assertSavedDownload(context, job.result);
});

test('publishing blocks cancellation and competing writes, permits downloads, and holds the library exclusive queue', async t => {
  const publishing = deferred();
  const release = deferred();
  const context = await fixture(t, {
    publishLibrary: async args => {
      publishing.resolve(args);
      await release.promise;
      return { status: 'published', url: publishedUrl };
    }
  });
  const jobId = await context.startConvert();
  let queuedOperation;
  try {
    const publishingArgs = await Promise.race([publishing.promise, delay(3000, undefined, { ref: false }).then(() => { throw new Error('Publisher never started'); })]);
    const running = await context.waitJob(jobId, job => job.cancellable === false);
    assert.equal(running.status, 'running');
    assert.equal(running.cancellable, false);
    const manifest = (await context.request('/library/manifest.json')).json;
    const song = manifest.songs[0];
    assert.equal(publishingArgs.verifyFile, song.file);
    assert.equal((await context.request(`/${song.file}`)).status, 200, 'Publishing must leave local downloads available');
    for (const [path, method, input] of [
      [`/api/jobs/${jobId}/cancel`, 'POST', {}],
      [`/api/library/${song.id}`, 'PATCH', { title: 'Must not change' }],
      [`/api/library/${song.id}`, 'DELETE', {}],
      ['/api/convert', 'POST', conversionInput],
      ['/api/publish', 'POST', {}]
    ]) {
      const response = await context.request(path, method, input);
      assert.equal(response.status, 409, `${method} ${path}: ${JSON.stringify(response.json)}`);
    }
    assert.equal(context.calls.convertVideo.length, 1);
    assert.equal(context.calls.publishLibrary.length, 1);
    assert.equal((await context.request(`/api/jobs/${jobId}`)).json.status, 'running');
    assert.deepEqual((await context.request('/library/manifest.json')).json, manifest);
    let enteredExclusiveQueue = false;
    queuedOperation = context.app.library.exclusive(async () => { enteredExclusiveQueue = true; });
    await delay(20);
    assert.equal(enteredExclusiveQueue, false, 'Publishing must run inside library.exclusive');
    release.resolve();
    await queuedOperation;
    const completed = await context.waitJob(jobId);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result.publication.status, 'published');
    assert.equal(enteredExclusiveQueue, true);
    const editAfterPublish = await context.request(`/api/library/${song.id}`, 'PATCH', { title: 'Publishing finished' });
    assert.equal(editAfterPublish.status, 200);
  } finally {
    release.resolve();
    await queuedOperation;
    await context.waitJob(jobId);
  }
});

test('cancelling conversion before publication prevents both a saved song and a publish attempt', async t => {
  const converting = deferred();
  const release = deferred();
  const context = await fixture(t, {
    convertVideo: async () => {
      converting.resolve();
      await release.promise;
      return structuredClone(notes);
    }
  });
  const jobId = await context.startConvert();
  try {
    await Promise.race([converting.promise, delay(3000, undefined, { ref: false }).then(() => { throw new Error('Converter never started'); })]);
    const running = await context.waitJob(jobId, job => job.status === 'running');
    assert.equal(running.cancellable, true);
    assert.equal((await context.request(`/api/jobs/${jobId}/cancel`, 'POST', {})).status, 200);
    release.resolve();
    const cancelled = await context.waitJob(jobId);
    assert.equal(cancelled.status, 'cancelled');
    await delay(20);
    assert.equal(context.calls.publishLibrary.length, 0);
    assert.deepEqual((await context.request('/library/manifest.json')).json.songs, []);
  } finally {
    release.resolve();
  }
});

test('manual publication uses the same publisher and retains its pending result', async t => {
  const pending = { status: 'pending', url: publishedUrl, error: 'Fixture deployment is pending' };
  const context = await fixture(t, { publishLibrary: async () => pending });
  const conversion = await context.waitJob(await context.startConvert({ publish: false }));
  assert.equal(conversion.status, 'completed');
  assert.equal(context.calls.publishLibrary.length, 0);
  const response = await context.request('/api/publish', 'POST', {});
  assert.equal(response.status, 202);
  const published = await context.waitJob(response.json.jobId);
  assert.equal(published.type, 'publish');
  assert.equal(published.status, 'completed');
  assert.deepEqual(published.result, pending);
  assert.equal(context.calls.publishLibrary.length, 1);
  await assertSavedDownload(context, conversion.result);
});
