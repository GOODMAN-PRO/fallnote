import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname, join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { executablePresent, run } from './lib/process.mjs';
import { createLibrary } from './lib/library.mjs';
import { registerVideo, findVideo, downloadVideo, convertVideo, makeDemo, youtubeUrl, zenSessionForVideo } from './lib/video.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.mid': 'audio/midi' };
const MAX_UPLOAD = 750 * 1024 * 1024;

export function createApp({ root = ROOT, port = 8788, repository = process.env.FALLNOTE_REPOSITORY || 'GOODMAN-PRO/fallnote' } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const mediaDir = join(root, '.local', 'media');
  const library = createLibrary(root);
  const jobs = new Map();
  const publishedUrl = `https://${repository.split('/')[0].toLowerCase()}.github.io/${repository.split('/')[1]}/`;
  let dependencies;
  let libraryBusy = false;
  let portInUse = port;
  const server = http.createServer(async (req, res) => {
    try {
      const allowedHosts = [`localhost:${portInUse}`, `127.0.0.1:${portInUse}`];
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Local requests only.' });
      if (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`)) return json(res, 403, { error: 'This request must come from the local Fallnote app.' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && path === '/api/status') {
        dependencies ||= Promise.all([executablePresent('ffmpeg'), executablePresent('ffprobe'), executablePresent('yt-dlp'), executablePresent('gh')])
          .then(([ffmpeg, ffprobe, ytdlp, github]) => ({ ffmpeg, ffprobe, ytdlp, github }));
        return json(res, 200, { local: true, version: '1.0.0', dependencies: await dependencies, repository, publishedUrl });
      }
      const videoMatch = path.match(/^\/api\/videos\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && videoMatch) {
        const { path: localPath, filename, ...video } = await findVideo(mediaDir, videoMatch[1]);
        return json(res, 200, video);
      }
      const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(res, 404, { error: 'Job not found. It may have ended before the app restarted.' });
        if (req.method === 'GET' && !jobMatch[2]) return json(res, 200, publicJob(job));
        if (req.method === 'POST' && jobMatch[2]) {
          await body(req);
          if (job.type === 'publish') return json(res, 409, { error: 'Publishing cannot be cancelled once the Git push starts.' });
          if (job.status === 'running') { job.controller.abort(); job.status = 'cancelled'; job.message = 'Cancelled.'; }
          return json(res, 200, { ok: true });
        }
      }
      if (req.method === 'POST' && path === '/api/videos') {
        if (mediaType(req) !== 'application/octet-stream') return json(res, 415, { error: 'Upload a video file.' });
        if (Number(req.headers['content-length']) > MAX_UPLOAD) return json(res, 413, { error: 'Choose a video smaller than 750 MB.' });
        const sourceId = randomUUID();
        const name = decodeURIComponent(req.headers['x-filename'] || 'tutorial.mp4');
        const extension = extname(name).toLowerCase();
        if (!['.mp4', '.webm', '.mov', '.mkv', '.m4v'].includes(extension)) return json(res, 400, { error: 'Use an MP4, WebM, MOV, MKV or M4V video.' });
        await mkdir(mediaDir, { recursive: true });
        const target = join(mediaDir, sourceId + extension);
        let bytes = 0;
        const limit = new Transform({ transform(chunk, _, next) {
          bytes += chunk.length;
          next(bytes > MAX_UPLOAD ? new Error('Video exceeds 750 MB.') : null, chunk);
        } });
        try {
          await pipeline(req, limit, createWriteStream(target, { flags: 'wx' }));
          return json(res, 201, await registerVideo(mediaDir, sourceId, target, name));
        } catch (error) { await unlink(target).catch(() => {}); throw error; }
      }
      if (req.method === 'POST' && path === '/api/youtube') {
        const { url: input, useZenSession } = await body(req);
        const source = youtubeUrl(input);
        // Consent belongs to this request only; it is never saved or reused.
        const job = startJob('youtube', async context => {
          const browserSession = useZenSession === true ? await zenSessionForVideo(source) : undefined;
          return downloadVideo(mediaDir, source, { ...context, browserSession });
        });
        return json(res, 202, { jobId: job.id });
      }
      if (req.method === 'POST' && path === '/api/demo') {
        await body(req);
        return json(res, 200, await makeDemo(mediaDir));
      }
      if (req.method === 'POST' && path === '/api/convert') {
        const input = await body(req);
        const video = await findVideo(mediaDir, input.sourceId);
        if (!input.calibration || typeof input.calibration !== 'object') throw new Error('Calibrate the keyboard before converting.');
        const options = input.options || {};
        if (libraryBusy) throw Object.assign(new Error('Wait for library publishing to finish.'), { status: 409 });
        const job = startJob('convert', async context => {
          const notes = await convertVideo(video, input.calibration, options, context);
          if (context.signal.aborted) throw new Error('Cancelled.');
          if (notes.length > 100000) throw new Error('Too many notes detected. Check the scan line and video background.');
          const song = await library.save(notes, { title: input.title || video.name, artist: input.artist, sourceName: video.name, handMode: options.handMode });
          return { song, notes };
        });
        return json(res, 202, { jobId: job.id });
      }
      const songMatch = path.match(/^\/api\/library\/([a-f0-9-]{36})$/);
      if (songMatch && ['PATCH', 'DELETE'].includes(req.method)) {
        if (libraryBusy) throw Object.assign(new Error('Wait for publishing to finish.'), { status: 409 });
        const input = await body(req);
        if (req.method === 'PATCH') return json(res, 200, { song: await library.update(songMatch[1], input) });
        await library.remove(songMatch[1]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/publish') {
        await body(req);
        if ([...jobs.values()].some(job => job.status === 'running')) throw Object.assign(new Error('Wait for the current job to finish before publishing.'), { status: 409 });
        const job = startJob('publish', async context => {
          libraryBusy = true;
          try {
            return await library.exclusive(async () => {
              context.progress(0.1, 'Checking the GitHub repository…');
              const { stdout: remote } = await run('git', ['remote', 'get-url', 'origin'], { cwd: root });
              if (![ `https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git` ].includes(remote.trim())) throw new Error('The Git remote does not match this library. Check FALLNOTE_REPOSITORY.');
              const { stdout: branch } = await run('git', ['branch', '--show-current'], { cwd: root });
              if (branch.trim() !== 'main') throw new Error('Switch this app repository to main before publishing.');
              await run('git', ['add', '--', 'docs/library'], { cwd: root });
              const { stdout: changes } = await run('git', ['diff', '--cached', '--name-only', '--', 'docs/library'], { cwd: root });
              if (changes.trim()) {
                await run('git', ['commit', '-m', 'Update MIDI library', '--only', '--', 'docs/library'], { cwd: root });
              }
              context.progress(0.55, 'Sending the library to GitHub…');
              await run('git', ['push', 'origin', 'main'], { cwd: root, timeout: 120000 });
              return { url: publishedUrl, message: 'Saved to GitHub. Pages may take a minute to update.' };
            });
          } finally { libraryBusy = false; }
        });
        return json(res, 202, { jobId: job.id });
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'API endpoint not found.' });
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
      if (path.startsWith('/media/')) {
        const filename = path.slice('/media/'.length);
        if (!/^[a-f0-9-]{36}(?:-preview)?\.(mp4|webm|mkv|mov|m4v)$/.test(filename)) return json(res, 404, { error: 'Video not found.' });
        return await serveFile(req, res, join(mediaDir, filename));
      }
      const staticRoot = resolve(root, 'docs');
      const file = resolve(staticRoot, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(staticRoot + sep)) return json(res, 403, { error: 'Invalid path.' });
      return await serveFile(req, res, file);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message || 'Request failed.' });
    }
  });
  function startJob(type, task) {
    if ([...jobs.values()].some(job => job.status === 'running')) throw Object.assign(new Error('Wait for the current job to finish or cancel it.'), { status: 409 });
    while (jobs.size >= 20) jobs.delete(jobs.keys().next().value);
    const job = { id: randomUUID(), type, status: 'running', progress: 0, message: type === 'youtube' ? 'Requesting video from YouTube…' : 'Starting…', controller: new AbortController() };
    jobs.set(job.id, job);
    Promise.resolve().then(() => task({
      signal: job.controller.signal,
      progress: (value, message) => { if (job.status === 'running') { job.progress = value; job.message = message; } }
    })).then(result => {
      if (job.status === 'cancelled') return;
      job.status = 'completed'; job.progress = 1; job.message = 'Complete'; job.result = result;
    }).catch(error => {
      if (job.controller.signal.aborted) { job.status = 'cancelled'; job.message = 'Cancelled.'; }
      else { job.status = 'failed'; job.error = error.message; job.message = error.message; }
    });
    return job;
  }
  server.on('listening', () => { portInUse = server.address().port; });
  server.on('close', () => { for (const job of jobs.values()) job.controller.abort(); });
  return { server, library, jobs, mediaDir };
}

function publicJob(job) { const { controller, ...result } = job; return result; }
function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (mediaType(req) !== 'application/json') throw Object.assign(new Error('Expected JSON request.'), { status: 415 });
  let input = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 100000) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try {
    const result = JSON.parse(input || '{}');
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch { throw new Error('Invalid JSON request.'); }
}
function mediaType(req) { return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(); }
async function serveFile(req, res, path) {
  const info = await stat(path);
  if (!info.isFile()) throw Object.assign(new Error('File not found.'), { status: 404 });
  let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    status = 206;
  }
  const headers = { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Content-Length': Math.max(0, end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || info.size === 0) return res.end();
  await pipeline(createReadStream(path, { start, end }), res);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8788);
  const { server } = createApp({ port });
  server.requestTimeout = 10 * 60 * 1000;
  server.listen(port, '127.0.0.1', () => console.log(`Fallnote is ready at http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to another number and retry.` : error.message); process.exitCode = 1; });
}
