import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, readdir, realpath } from 'node:fs/promises';
import { join, extname, basename, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { run } from './process.mjs';
import { createDetector, keyboardLanes } from './vision.mjs';

export const DEMO_CALIBRATION = { left: 0.05, right: 0.95, line: 0.75, firstMidi: 21, lastMidi: 108 };
export const DEMO_NOTES = [
  { pitch: 48, start: 0.5, duration: 1.5, hand: 'left' },
  { pitch: 60, start: 0.5, duration: 0.4, hand: 'right' },
  { pitch: 64, start: 0.5, duration: 0.4, hand: 'right' },
  { pitch: 67, start: 0.5, duration: 0.4, hand: 'right' },
  { pitch: 60, start: 1.1, duration: 0.4, hand: 'right' },
  { pitch: 61, start: 1.7, duration: 0.5, hand: 'right' },
  { pitch: 53, start: 2.4, duration: 1.4, hand: 'left' },
  { pitch: 65, start: 2.4, duration: 0.6, hand: 'right' },
  { pitch: 69, start: 2.4, duration: 0.6, hand: 'right' },
  { pitch: 72, start: 3.2, duration: 0.6, hand: 'right' },
  { pitch: 48, start: 4.2, duration: 1.2, hand: 'left' },
  { pitch: 60, start: 4.2, duration: 1.2, hand: 'right' },
  { pitch: 64, start: 4.2, duration: 1.2, hand: 'right' },
  { pitch: 67, start: 4.2, duration: 1.2, hand: 'right' }
];

export function youtubeUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Paste a valid YouTube video link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an https YouTube video link.');
  const host = url.hostname.toLowerCase();
  const allowed = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
  if (!allowed.includes(host)) throw new Error('Only YouTube video links are supported.');
  const segments = url.pathname.split('/').filter(Boolean);
  const id = host === 'youtu.be' ? segments[0] :
    url.pathname === '/watch' ? url.searchParams.get('v') :
      ['shorts', 'embed', 'live'].includes(segments[0]) ? segments[1] : null;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id || '')) throw new Error('Open an individual YouTube video and paste its link.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export async function zenSessionForVideo(videoUrl, roaming = process.env.APPDATA) {
  if (!roaming) throw new Error('Zen sign-in is currently supported on Windows only.');
  const zenRoot = resolve(roaming, 'zen');
  let ini;
  try { ini = await readFile(join(zenRoot, 'profiles.ini'), 'utf8'); }
  catch { throw new Error('Zen was not found. Open Zen and sign into YouTube, or import without browser sign-in.'); }
  const sections = [];
  let section;
  for (const line of ini.split(/\r?\n/)) {
    const header = /^\[(.+)\]$/.exec(line.trim());
    if (header) { section = { name: header[1] }; sections.push(section); }
    else if (section) {
      const pair = /^([^=]+)=(.*)$/.exec(line.trim());
      if (pair) section[pair[1]] = pair[2];
    }
  }
  const installed = sections.find(item => item.name.startsWith('Install') && item.Default);
  const fallback = sections.find(item => item.name.startsWith('Profile') && item.Default === '1');
  const selected = installed?.Default || fallback?.Path;
  if (!selected) throw new Error('No default Zen profile was found.');
  const profile = resolve(zenRoot, selected);
  // This feature supports Zen's ordinary local profile folder only.
  if (!profile.startsWith(zenRoot + sep)) throw new Error('This Zen profile is outside its standard folder. Use a local video upload instead.');
  let realProfile;
  try {
    const realRoot = await realpath(zenRoot);
    realProfile = await realpath(profile);
    const cookiePath = await realpath(join(profile, 'cookies.sqlite'));
    if (!realProfile.startsWith(realRoot + sep) || !cookiePath.startsWith(realProfile + sep) ||
        !(await stat(cookiePath)).isFile()) throw new Error('Invalid cookie location.');
  } catch { throw new Error('This Zen profile has no usable local sign-in cookies. Sign into YouTube in Zen first.'); }
  return { browser: 'firefox', profile: realProfile, videoUrl: youtubeUrl(videoUrl) };
}

export async function probe(path) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', path
  ], { timeout: 30000 });
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  const duration = Number(data.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error('This file does not contain a readable video.');
  if (duration > 1200) throw new Error('Choose a tutorial under 20 minutes.');
  if (stream.width > 8192 || stream.height > 8192) throw new Error('Video resolution exceeds 8192 pixels.');
  return { duration, width: stream.width, height: stream.height };
}

export async function registerVideo(mediaDir, sourceId, path, name, extras = {}) {
  const info = await probe(path);
  const video = { sourceId, name: name.slice(0, 200), url: `/media/${basename(path)}`, ...info, ...extras };
  await writeFile(join(mediaDir, `${sourceId}.json`), JSON.stringify({ ...video, filename: basename(path) }));
  return video;
}

export async function findVideo(mediaDir, sourceId) {
  if (!/^[a-f0-9-]{36}$/.test(sourceId || '')) throw new Error('Select a video first.');
  const video = JSON.parse(await readFile(join(mediaDir, `${sourceId}.json`), 'utf8'));
  const path = join(mediaDir, basename(video.filename));
  await stat(path);
  return { ...video, path };
}

export async function downloadVideo(mediaDir, input, { signal, progress, browserSession }) {
  const url = youtubeUrl(input);
  // This hook is only for explicitly authorised, one-video local invocations.
  // The HTTP API never accepts or forwards browser-session configuration.
  let authentication = ['--no-cookies', '--no-cookies-from-browser'];
  if (browserSession) {
    if (browserSession.browser !== 'firefox' || browserSession.videoUrl !== url ||
        typeof browserSession.profile !== 'string' || !isAbsolute(browserSession.profile) ||
        /[\r\n\0]/.test(browserSession.profile)) {
      throw new Error('Browser permission must specify this exact video and an absolute Firefox/Zen profile.');
    }
    authentication = ['--no-cookies', '--cookies-from-browser', `firefox:${browserSession.profile}`];
  }
  const sourceId = randomUUID();
  const output = join(mediaDir, `${sourceId}.%(ext)s`);
  await mkdir(mediaDir, { recursive: true });
  let lineBuffer = '';
  await run('yt-dlp', [
    '--ignore-config', '--no-playlist', '--encoding', 'utf-8', ...authentication,
    '--no-exec', '--no-write-thumbnail', '--no-write-subs', '--no-write-auto-subs',
    '--no-warnings', '--newline', '--socket-timeout', '20', '--retries', '2',
    '--fragment-retries', '2', '--max-filesize', '750M',
    '--match-filters', 'duration <= 1200 & !is_live',
    '--js-runtimes', 'node',
    '-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]/bestvideo[height<=720]/best[height<=720]',
    '--write-info-json', '--output', output, '--', url
  ], {
    signal, timeout: 600000,
    onOutput(chunk) {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop();
      for (const line of lines) {
        const percentage = line.match(/\[download\]\s+([\d.]+)%/);
        if (percentage) progress(Math.min(0.9, Number(percentage[1]) / 100 * 0.9), 'Downloading video…');
      }
    }
  });
  const files = await readdir(mediaDir);
  const filename = files.find(name => name.startsWith(sourceId + '.') && ['.mp4', '.webm', '.mkv', '.mov'].includes(extname(name)));
  if (!filename) throw new Error('YouTube did not provide a downloadable video. Try another tutorial or upload a video file.');
  const info = JSON.parse(await readFile(join(mediaDir, `${sourceId}.info.json`), 'utf8'));
  progress(0.94, 'Preparing video preview…');
  const inputPath = join(mediaDir, filename);
  // MP4/H.264 preview is supported by desktop browsers. Video-only is sufficient for visual extraction.
  const previewPath = join(mediaDir, `${sourceId}-preview.mp4`);
  await run('ffmpeg', [
    '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-threads', '2',
    '-i', inputPath, '-map', '0:v:0', '-an', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2',
    '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', previewPath
  ], { signal, timeout: 600000 });
  return registerVideo(mediaDir, sourceId, previewPath, info.title || 'YouTube tutorial');
}

export async function convertVideo(video, calibration, options, { signal, progress }) {
  const fps = Number(options.fps || 30);
  if (![24, 30, 60].includes(fps)) throw new Error('Choose 24, 30 or 60 frames per second.');
  const startTime = Number(options.startTime ?? 0);
  const endTime = Number(options.endTime ?? video.duration);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 ||
      endTime > video.duration + 0.05 || endTime <= startTime) {
    throw new Error('Choose a start and end time inside the video, with the end after the start.');
  }
  const clipDuration = endTime - startTime;
  const width = Math.min(1280, video.width);
  const height = Math.max(2, Math.round(video.height * width / video.width));
  const detector = createDetector({ width, height, fps, calibration, options });
  const child = spawn('ffmpeg', [
    '-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-threads', '2',
    '-ss', String(startTime), '-i', video.path, '-t', String(clipDuration),
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `fps=${fps},scale=${width}:${height}`,
    '-threads', '2', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'
  ], { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '';
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(signal?.aborted ? 'Cancelled.' : errorText || 'Video decoding failed.')));
  });
  // Mark rejection handled while the stream is being consumed.
  completion.catch(() => {});
  const frameSize = width * height * 3;
  let pending = Buffer.allocUnsafe(frameSize), offset = 0, frame = 0;
  const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
  try {
    for await (const chunk of child.stdout) {
      let position = 0;
      while (position < chunk.length) {
        const length = Math.min(frameSize - offset, chunk.length - position);
        chunk.copy(pending, offset, position, position + length);
        position += length;
        offset += length;
        if (offset === frameSize) {
          detector.pushFrame(pending, frame / fps);
          frame++;
          offset = 0;
          if (frame % fps === 0) progress(Math.min(0.99, frame / fps / clipDuration), `Reading notes: ${Math.floor(frame / fps)} / ${Math.ceil(clipDuration)} seconds`);
        }
      }
    }
    await completion;
    if (!frame) throw new Error('No video frames could be decoded.');
    return detector.finish(frame / fps);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
}

export async function makeDemo(mediaDir) {
  const sourceId = '00000000-0000-4000-8000-000000000001';
  const path = join(mediaDir, `${sourceId}.mp4`);
  await mkdir(mediaDir, { recursive: true });
  try {
    await stat(path);
    return registerVideo(mediaDir, sourceId, path, 'Fallnote calibration exercise', { calibration: DEMO_CALIBRATION, options: { handMode: 'color', leftHue: 200, rightHue: 120, trim: true } });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const width = 1040, height = 360, fps = 30, duration = 6.5;
  const lanes = keyboardLanes(DEMO_CALIBRATION);
  const child = spawn('ffmpeg', [
    '-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '15',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'Demo rendering failed.')));
  });
  completion.catch(() => {});
  const stdinError = new Promise((_, reject) => child.stdin.once('error', reject));
  stdinError.catch(() => {});
  function rect(frame, x, y, w, h, color) {
    const top = Math.max(0, Math.floor(y)), bottom = Math.min(height, Math.ceil(y + h));
    const left = Math.max(0, Math.floor(x)), right = Math.min(width, Math.ceil(x + w));
    for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
      const at = (row * width + col) * 3;
      frame[at] = color[0]; frame[at + 1] = color[1]; frame[at + 2] = color[2];
    }
  }
  try {
    for (let index = 0; index < duration * fps; index++) {
      const frame = Buffer.alloc(width * height * 3, 18);
      const time = index / fps, strike = height * DEMO_CALIBRATION.line, speed = 100;
      for (const note of DEMO_NOTES) {
        const lane = lanes.find(lane => lane.pitch === note.pitch);
        const w = lane.width * width * .72;
        const bottom = strike + (time - note.start) * speed;
        const top = bottom - note.duration * speed;
        rect(frame, lane.x * width - w / 2, top, w, Math.min(bottom, strike + 3) - top, note.hand === 'left' ? [25, 170, 240] : [40, 225, 75]);
      }
      // Piano starts beneath scan line so the detector sees bars, not key highlights.
      for (const lane of lanes.filter(lane => !lane.black)) {
        rect(frame, (lane.x - lane.width / 2) * width + 1, strike + 5, lane.width * width - 2, height - strike, [235, 235, 235]);
      }
      for (const lane of lanes.filter(lane => lane.black)) {
        rect(frame, (lane.x - lane.width / 2) * width, strike + 5, lane.width * width, 49, [35, 35, 38]);
      }
      if (!child.stdin.write(frame)) await Promise.race([once(child.stdin, 'drain'), stdinError, completion]);
    }
    child.stdin.end();
    await completion;
  } catch (error) { child.kill(); throw error; }
  return registerVideo(mediaDir, sourceId, path, 'Fallnote calibration exercise', { calibration: DEMO_CALIBRATION, options: { handMode: 'color', leftHue: 200, rightHue: 120, trim: true } });
}
