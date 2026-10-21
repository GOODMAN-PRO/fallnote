import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { autoCalibrate, detectKeyboardGeometry, discoverHandColors, findActiveSpan, magnitudeSpectrum, resolveOctave } from '../lib/autocalibrate.mjs';

const WHITE = [0, 2, 4, 5, 7, 9, 11];
function pianoFrames({ width = 720, height = 280, count = 36, firstPc = 7, left = 0, right = 1, cropped = false, highlights = true } = {}) {
  const frames = [];
  const step = (right - left) * width / count;
  const top = Math.round(height * 0.60), tip = Math.round(height * 0.81), bottom = Math.round(height * 0.96);
  const start = WHITE.indexOf(firstPc);
  for (let index = 0; index < 9; index++) {
    const frame = new Uint8Array(width * height * 3);
    const fill = (x1, y1, x2, y2, color) => {
      for (let y = Math.max(0, Math.round(y1)); y < Math.min(height, Math.round(y2)); y++) {
        for (let x = Math.max(0, Math.round(x1)); x < Math.min(width, Math.round(x2)); x++) frame.set(color, (y * width + x) * 3);
      }
    };
    for (let i = cropped ? -1 : 0; i < count + (cropped ? 1 : 0); i++) {
      const x = left * width + i * step;
      fill(x + 1, top, x + step - 1, bottom, [249, 249, 249]);
      // Moving colored key highlights must not erase the underlying stable geometry.
      if (highlights && i === (index * 3) % count) fill(x + 1, top, x + step - 1, bottom, [35, 150, 240]);
    }
    for (let i = cropped ? -1 : 0; i < count + (cropped ? 1 : 0); i++) {
      const x = left * width + i * step;
      const pc = WHITE[((start + i) % 7 + 7) % 7];
      if (pc !== 4 && pc !== 11 && (i < count - 1 || cropped)) fill(x + step * 0.69, top, x + step * 1.31, tip, [8, 8, 8]);
    }
    frames.push(frame);
  }
  return { frames, width, height, top, tip, bottom };
}

function near(actual, expected, epsilon) { assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`); }

test('geometry identifies the G white-key pattern and separate rows without inventing an octave', () => {
  const fixture = pianoFrames();
  const result = detectKeyboardGeometry(fixture.frames, fixture.width, fixture.height);
  assert.ok(result);
  assert.equal(result.firstPitchClass, 7);
  assert.equal(result.whiteKeys, 36);
  assert.equal(result.semitones, 60);
  assert.equal(result.firstMidi, undefined);
  near(result.left, 0, 2 / fixture.width);
  near(result.right, 1, 2 / fixture.width);
  assert.ok(result.blackLine * (fixture.height - 1) > fixture.top);
  assert.ok(result.blackLine * (fixture.height - 1) < fixture.tip);
  assert.ok(result.whiteLine * (fixture.height - 1) > fixture.tip);
});

test('partial white keys at the screen edges do not shift a cropped E..B keyboard', () => {
  const fixture = pianoFrames({ width: 680, count: 33, firstPc: 4, left: 10 / 680, right: 670 / 680, cropped: true });
  const result = detectKeyboardGeometry(fixture.frames, fixture.width, fixture.height);
  assert.ok(result);
  assert.equal(result.firstPitchClass, 4);
  assert.equal(result.whiteKeys, 33);
  assert.equal(result.semitones, 55);
  near(result.left, 10 / 680, 2 / 680);
  near(result.right, 670 / 680, 2 / 680);
});

test('geometry follows moved keyboard bounds and another pitch-class pattern', () => {
  const fixture = pianoFrames({ count: 29, firstPc: 0, left: 0.12, right: 0.88 });
  const result = detectKeyboardGeometry(fixture.frames, fixture.width, fixture.height);
  assert.ok(result);
  assert.equal(result.firstPitchClass, 0);
  assert.equal(result.whiteKeys, 29);
  assert.equal(result.semitones, 48);
  near(result.left, 0.12, 2 / fixture.width);
  near(result.right, 0.88, 2 / fixture.width);
});

test('blank images and white rectangles are not accepted as a piano', () => {
  assert.equal(detectKeyboardGeometry([new Uint8Array(300 * 200 * 3)], 300, 200), null);
  assert.equal(detectKeyboardGeometry(Array.from({ length: 4 }, () => new Uint8Array(300 * 200 * 3).fill(240)), 300, 200), null);
});

test('circular hue clusters handle red wraparound and order the hands spatially', () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({ hue: i % 2 ? 1 : 359, x: 0.3, saturation: 0.8, brightness: 0.8 }));
  samples.push(...Array.from({ length: 60 }, () => ({ hue: 210, x: 0.7, saturation: 0.75, brightness: 0.8 })));
  const result = discoverHandColors(samples);
  assert.ok(result.leftHue <= 1 || result.leftHue >= 359);
  assert.equal(result.rightHue, 210);
  assert.equal(result.confidence, 1);
});

test('a single hand color or several competing colors requires review', () => {
  const color = hue => Array.from({ length: 30 }, () => ({ hue, x: hue / 360, saturation: 0.8, brightness: 0.8 }));
  assert.equal(discoverHandColors(color(210)), null);
  assert.equal(discoverHandColors([...color(10), ...color(110), ...color(210)]), null);
});

test('different colors with identical spatial distributions do not imply different hands', () => {
  const samples = [40, 200].flatMap(hue => Array.from({ length: 80 }, (_, i) => ({ hue, x: (i % 20) / 20, saturation: 0.8, brightness: 0.8 })));
  assert.equal(discoverHandColors(samples), null);
});

test('musical span retains a pickup before a long rest and a separated final note', () => {
  const observations = [1, 20, 20.5, 21, 21.5, 22, 22.5, 23, 40].map(time => ({ time, pitches: [60] }));
  const span = findActiveSpan(observations, 45);
  near(span.startTime, 0.4, 1e-9);
  near(span.endTime, 40.85, 1e-9);
  assert.equal(findActiveSpan([{ time: 1, pitches: [60] }], 5), null);
});

test('FFT identifies a known tone and rejects invalid window sizes', () => {
  const rate = 11025;
  const samples = Float32Array.from({ length: 12000 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / rate));
  const spectrum = magnitudeSpectrum(samples, 6000);
  const peak = spectrum.indexOf(Math.max(...spectrum));
  near(peak * rate / 8192, 440, rate / 8192);
  assert.throws(() => magnitudeSpectrum(samples, 6000, 1000), /power of two/);
});

function melody({ offset = 12, harmonic = true, constantPitch = null } = {}) {
  const rate = 11025, notes = [32, 36, 40, 44, 47, 43, 35, 39, 46, 40, 32, 47];
  const samples = new Float32Array(rate * (notes.length + 2));
  const observations = notes.map((pitch, i) => ({ time: i + 0.5, pitches: [pitch] }));
  for (let n = 0; n < notes.length; n++) {
    const frequency = 440 * 2 ** (((constantPitch ?? notes[n] + offset) - 69) / 12);
    for (let i = Math.floor((n + 0.08) * rate); i < Math.floor((n + 0.92) * rate); i++) {
      const phase = 2 * Math.PI * frequency * (i - n * rate) / rate;
      samples[i] = 0.3 * Math.sin(phase) + (harmonic ? 0.22 * Math.sin(phase * 2) + 0.13 * Math.sin(phase * 3) + 0.06 * Math.sin(phase * 4) : 0);
    }
  }
  return { samples, observations, rate };
}

test('audio resolves absolute octave from multiple played keys with piano harmonics', () => {
  const fixture = melody();
  const result = resolveOctave(fixture.observations, fixture.samples, fixture.rate, { firstPitchClass: 4, semitones: 55 });
  assert.ok(result);
  assert.equal(result.firstMidi, 40);
  assert.equal(result.lastMidi, 95);
  assert.ok(result.margin >= 0.13);
});

test('the octave follows audio transposition, not a fixed keyboard-width assumption', () => {
  const fixture = melody({ offset: 0, harmonic: false });
  const result = resolveOctave(fixture.observations, fixture.samples, fixture.rate, { firstPitchClass: 4, semitones: 55 });
  assert.ok(result);
  assert.equal(result.firstMidi, 28);
  assert.equal(result.lastMidi, 83);
});

test('silent, missing, unrelated, or insufficient audio cannot confirm an octave', () => {
  const fixture = melody({ constantPitch: 65 });
  const geometry = { firstPitchClass: 4, semitones: 55 };
  assert.equal(resolveOctave(fixture.observations, null, fixture.rate, geometry), null);
  assert.equal(resolveOctave(fixture.observations, new Float32Array(fixture.samples.length), fixture.rate, geometry), null);
  assert.equal(resolveOctave(fixture.observations, fixture.samples, fixture.rate, geometry), null);
  assert.equal(resolveOctave(fixture.observations.slice(0, 3), fixture.samples, fixture.rate, geometry), null);
});

test('a dominant second harmonic and weak lower fundamental trigger octave review', () => {
  const rate = 11025, pitches = [50, 53, 58, 60];
  const samples = Float32Array.from({ length: rate * 13 }, (_, i) => {
    const time = i / rate, index = Math.floor(time);
    if (index >= 12) return 0;
    const frequency = 440 * 2 ** ((pitches[index % 4] - 69) / 12), phase = 2 * Math.PI * frequency * time;
    return 0.4 * (0.02 * Math.sin(phase) + Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
  });
  const observations = Array.from({ length: 12 }, (_, i) => ({ time: i + 0.5, pitches: [pitches[i % 4]] }));
  assert.equal(resolveOctave(observations, samples, rate, { firstPitchClass: 7, semitones: 60 }), null);
});

test('automatic calibration validates input and honors already cancelled work before spawning', async () => {
  await assert.rejects(autoCalibrate({}), /valid local video/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(autoCalibrate({ path: 'unused.mp4', width: 1280, height: 720, duration: 30 }, { signal: controller.signal }), /Cancelled/);
});

test('actual video scan keeps a 100ms pickup and tail between coarse sample times', { timeout: 30000 }, async t => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) { t.skip('FFmpeg is unavailable for the integration fixture.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'fallnote-autocalibration-'));
  try {
    const path = join(directory, 'short-pickup.mp4'), width = 580, height = 280, duration = 13, fps = 40;
    const fixture = pianoFrames({ width, height, count: 29, firstPc: 0, highlights: false });
    const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${width}x${height}`,
      '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', path],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const completed = once(child, 'close');
    for (let i = 0; i < duration * fps; i++) {
      const time = i / fps, frame = Buffer.from(fixture.frames[0]);
      const active = [];
      if (time >= 1.05 && time < 1.15) active.push([7, [35, 150, 240]]);
      if (time >= 5 && time < 10.8 && (time - 5) % 0.6 < 0.45) {
        const key = Math.floor((time - 5) / 0.6) % 3 * 2;
        active.push([7 + key, [35, 150, 240]], [14 + key, [255, 200, 25]]);
      }
      if (time >= 12.05 && time < 12.15) active.push([18, [255, 200, 25]]);
      for (const [key, color] of active) {
        for (let y = fixture.tip; y < fixture.bottom; y++) for (let x = key * 20 + 1; x < (key + 1) * 20 - 1; x++) frame.set(color, (y * width + x) * 3);
      }
      if (!child.stdin.write(frame)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    const [code] = await completed;
    assert.equal(code, 0, stderr);
    const result = await autoCalibrate({ path, width, height, duration });
    assert.equal(result.status, 'needs_review', 'A silent video must still need an absolute octave check.');
    assert.match(result.reason, /no usable audio/);
    assert.ok(result.summary.startTime < 1.05, JSON.stringify(result));
    assert.ok(result.summary.endTime >= 12.15, JSON.stringify(result));
  } finally {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('fallnote-autocalibration-'));
    await rm(target, { recursive: true, force: true });
  }
});
