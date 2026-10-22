import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { youtubeUrl } from '../lib/video.mjs';

let root;
let app;
let port;
const missingId = '00000000-0000-4000-8000-000000000099';
const fixtureBytes = Buffer.from('0123456789abcdef');

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'fallnote-server-test-'));
  await mkdir(join(root, 'docs', 'library'), { recursive: true });
  await writeFile(join(root, 'docs', 'index.html'), '<!doctype html><title>Test library</title>');
  await writeFile(join(root, 'docs', 'library', 'manifest.json'), '{"version":1,"songs":[]}');
  await writeFile(join(root, 'docs', 'fixture.mid'), fixtureBytes);
  await writeFile(join(root, 'private-secret.txt'), 'PRIVATE_SENTINEL_NOT_PUBLIC');
  app = createApp({ root, port: 0 });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  port = app.server.address().port;
});

test.after(async () => {
  if (app) {
    app.server.closeAllConnections();
    await new Promise((resolveClose, reject) => app.server.close(error => error ? reject(error) : resolveClose()));
  }
  if (root) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'Cleanup must remain inside the temporary directory');
    assert.ok(basename(root).startsWith('fallnote-server-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

function request(path, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolveRequest, reject) => {
    const framing = body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) };
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { Host: `127.0.0.1:${port}`, Connection: 'close', ...framing, ...headers }
    }, incoming => {
      const data = [];
      incoming.on('data', chunk => data.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        resolveRequest({
          status: incoming.statusCode,
          headers: incoming.headers,
          bytes: Buffer.concat(data),
          text: Buffer.concat(data).toString('utf8')
        });
        outgoing.destroy();
      });
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error(`Timed out requesting ${path}`)));
    outgoing.on('error', reject);
    if (chunks) {
      // Separate writes with a turn of the event loop to exercise UTF-8 boundaries.
      (async () => {
        for (const chunk of chunks) {
          outgoing.write(chunk);
          await new Promise(resolveTick => setTimeout(resolveTick, 10));
        }
        outgoing.end();
      })().catch(reject);
    } else {
      outgoing.end(body);
    }
  });
}

function jsonRequest(path, method, data, headers = {}) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data)
  });
}

test('serves local static library with MIME and no-sniff headers', async () => {
  assert.equal(app.server.address().address, '127.0.0.1');
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.match(index.text, /Test library/);
  const manifest = await request('/library/manifest.json');
  assert.equal(manifest.status, 200);
  assert.deepEqual(JSON.parse(manifest.text), { version: 1, songs: [] });
});

test('rejects hostile Host, Origin and cross-site requests before processing writes', async () => {
  for (const headers of [
    { Host: `evil.example:${port}` },
    { Host: `127.0.0.1:${port}.evil.example` },
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: `http://127.0.0.1:${port + 1}` },
    { 'Sec-Fetch-Site': 'cross-site' }
  ]) {
    const response = await jsonRequest(`/api/library/${missingId}`, 'PATCH', { reviewed: true }, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const allowed = await request('/', { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(allowed.status, 200);
  const preflight = await request('/api/videos', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 403);
});

test('encoded traversal and local media paths cannot expose private files', async () => {
  for (const path of [
    '/%2e%2e%2fprivate-secret.txt',
    '/..%5cprivate-secret.txt',
    '/media/..%2fprivate-secret.txt',
    '/media/..%5cprivate-secret.txt',
    '/.local/private-secret.txt'
  ]) {
    const response = await request(path);
    assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.ok(!response.text.includes('PRIVATE_SENTINEL_NOT_PUBLIC'));
  }
  assert.equal((await request('/bad%escape')).status, 400);
});

test('requires exact JSON or upload MIME types and rejects malformed request bodies', async () => {
  for (const contentType of ['text/plain', 'application/json-invalid', 'application/octet-stream']) {
    const response = await jsonRequest(`/api/library/${missingId}`, 'PATCH', {}, { 'Content-Type': contentType });
    assert.equal(response.status, 415, contentType);
  }
  for (const contentType of ['application/json', 'application/octet-stream-invalid']) {
    const response = await request('/api/videos', {
      method: 'POST', headers: { 'Content-Type': contentType, 'X-Filename': 'test.mp4' }
    });
    assert.equal(response.status, 415, contentType);
  }
  for (const value of ['{broken', '[]', 'null', '"string"']) {
    const response = await request(`/api/library/${missingId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: value
    });
    assert.equal(response.status, 400, value);
  }
  const charset = await jsonRequest(`/api/library/${missingId}`, 'PATCH', {}, { 'Content-Type': 'application/json; charset=utf-8' });
  assert.equal(charset.status, 404, 'A valid parameterized JSON MIME type must be accepted');
});

test('rejects an oversized raw upload from its declared length without creating a video', async () => {
  const response = await request('/api/videos', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(750 * 1024 * 1024 + 1),
      'X-Filename': 'large.mp4'
    }
  });
  assert.equal(response.status, 413);
  const localFiles = await readdir(join(root, '.local')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(localFiles, []);
});

test('YouTube URL validation blocks other hosts, schemes, credentials and playlists without starting jobs', async () => {
  for (const url of [
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ',
    'http://youtube.com/watch?v=dQw4w9WgXcQ',
    'file:///C:/private.mp4',
    'https://www.youtube.com/playlist?list=PLexample',
    'https://www.youtube.com/watch?v=invalid',
    'https://user:password@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:444/watch?v=dQw4w9WgXcQ'
  ]) {
    const response = await jsonRequest('/api/youtube', 'POST', { url });
    assert.equal(response.status, 400, url);
  }
  assert.equal(app.jobs.size, 0);
  assert.equal(youtubeUrl('https://youtu.be/dQw4w9WgXcQ?t=20'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(youtubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('MIDI downloads support bounded ranges, suffixes, HEAD and invalid-range responses', async () => {
  const full = await request('/fixture.mid');
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/midi');
  assert.deepEqual(full.bytes, fixtureBytes);
  const range = await request('/fixture.mid', { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.text, '2345');
  assert.equal(range.headers['content-range'], 'bytes 2-5/16');
  const suffix = await request('/fixture.mid', { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.text, 'cdef');
  const clamped = await request('/fixture.mid', { headers: { Range: 'bytes=13-100' } });
  assert.equal(clamped.text, 'def');
  const head = await request('/fixture.mid', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers['content-length'], '16');
  for (const invalid of ['bytes=99-', 'bytes=8-3', 'bytes=-', 'bytes=0-1,3-4']) {
    const response = await request('/fixture.mid', { headers: { Range: invalid } });
    assert.equal(response.status, 416, invalid);
    assert.equal(response.headers['content-range'], 'bytes */16');
  }
});

test('library saves real MIDI, edits only supported metadata, preserves Unicode and removes files', async () => {
  const notes = [
    { pitch: 48, start: 0, duration: 1, velocity: 80, hand: 'left' },
    { pitch: 60, start: 0.5, duration: 0.5, velocity: 90, hand: 'right' }
  ];
  const song = await app.library.save(notes, { title: 'Original', artist: 'Test', sourceName: 'Fixture video' });
  const download = await request(`/${song.file}`);
  assert.equal(download.status, 200);
  assert.equal(download.bytes.subarray(0, 4).toString(), 'MThd');
  assert.equal(download.bytes.readUInt16BE(8), 1, 'Export is Standard MIDI File type 1');
  assert.deepEqual(song.handCounts, { left: 1, right: 1 });
  assert.deepEqual(Object.keys(song.handFiles).sort(), ['both', 'left', 'right']);
  for (const file of Object.values(song.handFiles)) {
    const handDownload = await request(`/${file}`);
    assert.equal(handDownload.status, 200);
    assert.equal(handDownload.bytes.subarray(0, 4).toString(), 'MThd');
    assert.equal(handDownload.bytes.readUInt16BE(10), 2, 'Hand downloads have two musical tracks');
  }
  const changed = await jsonRequest(`/api/library/${song.id}`, 'PATCH', {
    title: 'Revised\u0000 title', artist: 'Composer', reviewed: true,
    id: missingId, file: '../private-secret.txt', noteCount: -1, handFiles: { both: '../private-secret.txt' }
  });
  assert.equal(changed.status, 200);
  const updated = JSON.parse(changed.text).song;
  assert.equal(updated.title, 'Revised title');
  assert.equal(updated.artist, 'Composer');
  assert.equal(updated.reviewed, true);
  assert.equal(updated.id, song.id);
  assert.equal(updated.file, song.file);
  assert.equal(updated.noteCount, 2);
  assert.deepEqual(updated.handFiles, song.handFiles);
  const encoded = Buffer.from(JSON.stringify({ title: '夜のピアノ 🎹' }));
  const firstMultibyte = encoded.findIndex(byte => byte > 127);
  const unicode = await request(`/api/library/${song.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    chunks: [encoded.subarray(0, firstMultibyte + 1), encoded.subarray(firstMultibyte + 1)]
  });
  assert.equal(unicode.status, 200);
  assert.equal(JSON.parse(unicode.text).song.title, '夜のピアノ 🎹');
  const onDisk = JSON.parse(await readFile(join(root, 'docs', 'library', 'manifest.json'), 'utf8'));
  assert.equal(onDisk.songs[0].title, '夜のピアノ 🎹');
  const removed = await jsonRequest(`/api/library/${song.id}`, 'DELETE', {});
  assert.equal(removed.status, 200);
  assert.equal((await request(`/${song.file}`)).status, 404);
  for (const file of Object.values(song.handFiles)) assert.equal((await request(`/${file}`)).status, 404);
  assert.equal((await app.library.read()).songs.length, 0);
  for (const method of ['PATCH', 'DELETE']) {
    const absent = await jsonRequest(`/api/library/${song.id}`, method, {});
    assert.equal(absent.status, 404);
  }
});

test('serialized library writes preserve simultaneous saves', async () => {
  const notes = [{ pitch: 60, start: 0, duration: 0.25, velocity: 90, hand: 'right' }];
  const saved = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    app.library.save(notes, { title: `Concurrent ${index}` })
  ));
  const manifest = await app.library.read();
  assert.equal(manifest.songs.length, saved.length);
  assert.equal(new Set(manifest.songs.map(song => song.id)).size, saved.length);
  for (const song of saved) {
    assert.equal((await request(`/${song.file}`)).status, 200);
    assert.equal(song.handFiles.left, undefined, 'No empty left-hand download is advertised');
    assert.equal(song.handCounts.right, 1);
    assert.equal((await request(`/${song.handFiles.right}`)).status, 200);
  }
  await Promise.all(saved.map(song => app.library.remove(song.id)));
  assert.deepEqual((await app.library.read()).songs, []);
});
