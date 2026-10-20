import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePreview } from '../lib/video.mjs';

// Integration check: needs ffmpeg/ffprobe on PATH. No network or browser data.
// Run with: node scripts/verify-preview.mjs
const execute = promisify(execFile);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const local = resolve(workspace, '.local');
await mkdir(local, { recursive: true });
const directory = await mkdtemp(join(local, 'preview-check-'));
const duration = 2;

async function ffmpeg(args) {
  return execute('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args], {
    windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer',
  });
}

async function inspect(path) {
  const { stdout } = await execute('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration:format=duration',
    '-of', 'json', path,
  ], { windowsHide: true, timeout: 30000 });
  return JSON.parse(stdout);
}

async function signalStats(path) {
  const { stdout } = await ffmpeg([
    '-i', path, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000',
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
  ]);
  assert.equal(stdout.length % 4, 0, 'decoded PCM must contain complete float samples');
  const sampleCount = stdout.length / 4;
  let squares = 0, peak = 0, positiveCrossings = 0, previous = 0;
  for (let index = 0; index < sampleCount; index++) {
    const value = stdout.readFloatLE(index * 4);
    assert.ok(Number.isFinite(value), 'decoded audio sample must be finite');
    squares += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (previous <= 0 && value > 0) positiveCrossings++;
    previous = value;
  }
  return {
    seconds: sampleCount / 48000,
    rms: Math.sqrt(squares / sampleCount),
    peak,
    approximateFrequency: positiveCrossings / (sampleCount / 48000),
  };
}

try {
  const results = [];
  for (const kind of ['tone', 'muted-audio', 'no-audio']) {
    const source = join(directory, `${kind}.mkv`);
    const preview = join(directory, `${kind}-preview.mp4`);
    const inputs = ['-f', 'lavfi', '-i', `color=c=0x1c2034:s=320x180:r=24:d=${duration}`];
    if (kind === 'tone') {
      inputs.push('-f', 'lavfi', '-i', `sine=frequency=523.25:sample_rate=48000:duration=${duration}`);
    } else if (kind === 'muted-audio') {
      inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono');
    }
    await ffmpeg([
      ...inputs, '-t', String(duration),
      '-map', '0:v:0', ...(kind === 'no-audio' ? ['-an'] : ['-map', '1:a:0', '-c:a', 'pcm_s16le']),
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', source,
    ]);
    const returned = await preparePreview(source, preview);
    assert.equal(returned, preview);
    const data = await inspect(preview);
    const videos = data.streams.filter(stream => stream.codec_type === 'video');
    const audios = data.streams.filter(stream => stream.codec_type === 'audio');
    assert.equal(videos.length, 1);
    assert.equal(videos[0].codec_name, 'h264');
    assert.ok(videos[0].width <= 1280 && videos[0].height <= 720);
    assert.ok(Math.abs(Number(data.format.duration) - duration) < 0.1, `${kind}: preview changed video duration`);
    assert.equal(audios.length, kind === 'no-audio' ? 0 : 1);
    const result = { kind, video: videos[0].codec_name, audio: audios[0]?.codec_name ?? null, duration: Number(data.format.duration) };
    if (kind !== 'no-audio') {
      assert.equal(audios[0].codec_name, 'aac');
      const stats = await signalStats(preview);
      assert.ok(Math.abs(stats.seconds - duration) < 0.1, `${kind}: decoded audio has the wrong duration`);
      if (kind === 'tone') {
        assert.ok(stats.rms > 0.02 && stats.peak > 0.05, 'sine audio must remain audible');
        assert.ok(Math.abs(stats.approximateFrequency - 523.25) < 15, 'sine pitch must survive transcoding');
      } else {
        assert.ok(stats.peak < 0.00001, 'muted audio must remain silent');
      }
      Object.assign(result, { rms: +stats.rms.toFixed(6), peak: +stats.peak.toFixed(6), frequency: +stats.approximateFrequency.toFixed(2) });
    }
    results.push(result);
  }
  console.log(JSON.stringify({ passed: true, cases: results }, null, 2));
} finally {
  // Verify the resolved cleanup target remains inside this workspace's local
  // fixture directory before recursively removing only this run's files.
  const realLocal = await realpath(local);
  const realDirectory = await realpath(directory);
  assert.ok(realDirectory.startsWith(realLocal + sep));
  assert.ok(basename(realDirectory).startsWith('preview-check-'));
  await rm(realDirectory, { recursive: true, force: true });
}
