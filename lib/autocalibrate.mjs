import { spawn } from 'node:child_process';
import { keyboardLanes } from './vision.mjs';

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = values => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const midiHz = pitch => 440 * 2 ** ((pitch - 69) / 12);

function hsv(r, g, b) {
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
  const hue = d === 0 ? 0 : hi === r ? 60 * (((g - b) / d + 6) % 6) : hi === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { hue, saturation: hi ? d / hi : 0, brightness: hi / 255 };
}

function runs(values, predicate) {
  const result = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    if (i < values.length && predicate(values[i])) { if (start < 0) start = i; }
    else if (start >= 0) { result.push({ start, end: i, width: i - start }); start = -1; }
  }
  return result;
}

/** Infer only pitch class and geometry. An octave is deliberately not guessed here. */
export function detectKeyboardGeometry(frames, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 80 ||
      !Array.isArray(frames) || frames.length < 3 || frames.some(f => f.length !== width * height * 3)) return null;
  const votes = new Float32Array(width * height);
  const firstRow = Math.floor(height * 0.45);
  for (const frame of frames) {
    for (let p = firstRow * width; p < width * height; p++) {
      const i = p * 3, hi = Math.max(frame[i], frame[i + 1], frame[i + 2]);
      const lo = Math.min(frame[i], frame[i + 1], frame[i + 2]);
      if (lo > 215 && hi - lo < 40) votes[p] += 1 / frames.length;
    }
  }
  const rows = [];
  for (let y = firstRow; y < height - 2; y++) {
    const row = votes.subarray(y * width, (y + 1) * width);
    const keys = runs(row, value => value >= 0.42).filter(run => run.width >= 4);
    // A cropped half-key at either image edge must not shift every pitch lane.
    const sortedWidths = keys.map(k => k.width).sort((a, b) => a - b);
    const typicalWidth = sortedWidths[Math.floor(sortedWidths.length / 2)];
    if (keys[0]?.width < typicalWidth * 0.72) keys.shift();
    if (keys.at(-1)?.width < typicalWidth * 0.72) keys.pop();
    if (keys.length < 14 || keys.length > 58) continue;
    const centers = keys.map(k => (k.start + k.end - 1) / 2);
    const spacing = centers.slice(1).map((x, i) => x - centers[i]);
    const step = mean(spacing), deviation = Math.sqrt(mean(spacing.map(v => (v - step) ** 2))) / step;
    const coverage = (keys.at(-1).end - keys[0].start) / width;
    if (deviation > 0.095 || coverage < 0.58 || mean(keys.map(k => k.width)) / step < 0.65) continue;
    const offset = mean(centers.map((x, i) => x - (i + 0.5) * step));
    const left = clamp(offset / width, 0, 1), right = clamp((offset + keys.length * step) / width, 0, 1);
    rows.push({ y, count: keys.length, step, left, right, score: coverage * (1 - deviation * 3) });
  }
  if (!rows.length) return null;
  const groups = new Map();
  for (const row of rows) {
    const key = row.count;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const body = [...groups.values()].sort((a, b) => b.length * mean(b.map(r => r.score)) - a.length * mean(a.map(r => r.score)))[0];
  if (body.length < Math.max(5, height * 0.018)) return null;
  const left = mean(body.map(r => r.left)), right = mean(body.map(r => r.right));
  const count = body[0].count, keyWidth = (right - left) * width / count;
  const bodyTop = Math.min(...body.map(r => r.y)), bodyBottom = Math.max(...body.map(r => r.y));
  const patterns = [];
  for (const firstPc of WHITE) {
    const firstWhite = WHITE.indexOf(firstPc), matches = [];
    for (let y = firstRow; y < bodyTop - 2; y++) {
      let score = 0, known = 0;
      for (let i = 0; i < count - 1; i++) {
        const pc = WHITE[(firstWhite + i) % 7], hasBlack = pc !== 4 && pc !== 11;
        const x = (left * width) + (i + 1) * keyWidth;
        let whiteness = 0, n = 0;
        for (let dx = -Math.max(1, Math.floor(keyWidth * 0.22)); dx <= Math.max(1, Math.floor(keyWidth * 0.22)); dx++) {
          whiteness += votes[y * width + clamp(Math.round(x + dx), 0, width - 1)]; n++;
        }
        whiteness /= n;
        if (whiteness < 0.28 || whiteness > 0.55) { score += hasBlack ? 1 - whiteness : whiteness; known++; }
      }
      if (known >= (count - 1) * 0.82 && score / known > 0.81) matches.push({ y, score: score / known });
    }
    if (matches.length >= Math.max(7, height * 0.025)) patterns.push({ firstPc, matches, score: mean(matches.map(m => m.score)) });
  }
  patterns.sort((a, b) => b.matches.length * b.score - a.matches.length * a.score);
  if (!patterns.length || (patterns[1] && patterns[1].score > patterns[0].score - 0.08)) return null;
  const best = patterns[0], blackTop = Math.min(...best.matches.map(m => m.y)), blackBottom = Math.max(...best.matches.map(m => m.y));
  const whiteY = bodyTop + (bodyBottom - bodyTop) * 0.25;
  const blackY = blackTop + (blackBottom - blackTop) * 0.54;
  const firstWhite = WHITE.indexOf(best.firstPc);
  const lastIndex = firstWhite + count - 1;
  const semitones = Math.floor(lastIndex / 7) * 12 + WHITE[lastIndex % 7] - best.firstPc;
  return {
    left, right, whiteLine: whiteY / (height - 1), blackLine: blackY / (height - 1),
    firstPitchClass: best.firstPc, semitones, whiteKeys: count,
    confidence: clamp(best.score * mean(body.map(r => r.score)), 0, 1),
    keyboardTop: blackTop / (height - 1),
  };
}

/** Circular color clusters retain their spatial ordering, including hues near 0/360. */
export function discoverHandColors(samples) {
  let remaining = samples.filter(s => Number.isFinite(s.hue) && Number.isFinite(s.x) && s.saturation >= 0.3 && s.brightness >= 0.35);
  if (remaining.length < 16) return null;
  const total = remaining.length, clusters = [];
  for (let i = 0; i < 3 && remaining.length; i++) {
    let bestHue = 0, bestCount = 0;
    for (let h = 0; h < 360; h += 5) {
      const n = remaining.filter(s => hueDistance(s.hue, h) <= 22).length;
      if (n > bestCount) { bestHue = h; bestCount = n; }
    }
    const members = remaining.filter(s => hueDistance(s.hue, bestHue) <= 22);
    const angle = Math.atan2(mean(members.map(s => Math.sin(s.hue * Math.PI / 180))), mean(members.map(s => Math.cos(s.hue * Math.PI / 180))));
    clusters.push({ hue: (angle * 180 / Math.PI + 360) % 360, x: mean(members.map(s => s.x)), xs: members.map(s => s.x), count: members.length });
    remaining = remaining.filter(s => hueDistance(s.hue, bestHue) > 22);
  }
  if (clusters.length < 2 || clusters[1].count < 6 || clusters[1].count / total < 0.025 ||
      (clusters[0].count + clusters[1].count) / total < 0.82 || hueDistance(clusters[0].hue, clusters[1].hue) < 40) return null;
  const pair = clusters.slice(0, 2).sort((a, b) => a.x - b.x);
  if (pair[1].x - pair[0].x < 0.08) return null;
  const rightPositions = pair[1].xs.sort((a, b) => a - b);
  let orderedPairs = 0;
  for (const x of pair[0].xs) {
    let lo = 0, hi = rightPositions.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rightPositions[mid] <= x) lo = mid + 1; else hi = mid; }
    orderedPairs += rightPositions.length - lo;
  }
  if (orderedPairs / (pair[0].count * pair[1].count) < 0.65) return null;
  return { leftHue: Math.round(pair[0].hue), rightHue: Math.round(pair[1].hue), confidence: (pair[0].count + pair[1].count) / total };
}

function keySamples(frame, width, height, geometry) {
  const base = 24 + geometry.firstPitchClass;
  const lanes = keyboardLanes({ ...geometry, firstMidi: base, lastMidi: base + geometry.semitones });
  const samples = [];
  let neutralWhites = 0;
  for (const lane of lanes) {
    const x = Math.round(lane.x * width), y = Math.round((lane.black ? geometry.blackLine : geometry.whiteLine) * (height - 1));
    const colors = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const p = (clamp(y + dy, 0, height - 1) * width + clamp(x + dx, 0, width - 1)) * 3;
      colors.push(hsv(frame[p], frame[p + 1], frame[p + 2]));
    }
    const active = colors.filter(c => c.saturation >= 0.1 && c.brightness >= 0.22);
    if (!lane.black && colors.filter(c => c.saturation < 0.22 && c.brightness > 0.55).length >= 5) neutralWhites++;
    if (active.length >= 6) {
      const angle = Math.atan2(mean(active.map(c => Math.sin(c.hue * Math.PI / 180))), mean(active.map(c => Math.cos(c.hue * Math.PI / 180))));
      samples.push({ pitch: lane.pitch, x: lane.x, hue: (angle * 180 / Math.PI + 360) % 360,
        saturation: mean(active.map(c => c.saturation)), brightness: mean(active.map(c => c.brightness)) });
    }
  }
  // A disappearing keyboard is an outro, not a large chord.
  return neutralWhites / geometry.whiteKeys >= 0.48 && samples.length <= 16 ? samples : [];
}

/** Preserve genuine pickups and final notes, including notes separated by long rests. */
export function findActiveSpan(observations, duration, step = 0.5) {
  const active = observations.filter(o => o.pitches.length > 0 && o.pitches.length <= 16);
  if (active.length < 8 || active.at(-1).time - active[0].time < 3) return null;
  return { startTime: Math.max(0, active[0].time - step - 0.1), endTime: Math.min(duration, active.at(-1).time + step + 0.35) };
}

/** Radix-2 FFT of a Hann-windowed mono sample, with magnitude output. */
export function magnitudeSpectrum(samples, center, size = 8192) {
  if (!Number.isInteger(size) || size < 256 || (size & (size - 1)) !== 0) throw new TypeError('FFT size must be a power of two of at least 256.');
  const re = new Float64Array(size), im = new Float64Array(size);
  const start = Math.round(center) - size / 2;
  for (let i = 0; i < size; i++) re[i] = (samples[start + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tmp = re[i]; re[i] = re[j]; re[j] = tmp; }
  }
  for (let len = 2; len <= size; len *= 2) {
    const angle = -2 * Math.PI / len, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
    for (let block = 0; block < size; block += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = block + j, b = a + len / 2, tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const next = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = next;
      }
    }
  }
  return Float64Array.from(re.subarray(0, size / 2), (value, i) => Math.hypot(value, im[i]) / size);
}

function spectralPeak(spectrum, frequency, sampleRate) {
  const bin = frequency * (spectrum.length * 2) / sampleRate;
  if (bin < 1 || bin > spectrum.length - 2) return 0;
  const radius = Math.max(1, bin * 0.012);
  let peak = 0;
  for (let i = Math.max(1, Math.floor(bin - radius)); i <= Math.min(spectrum.length - 1, Math.ceil(bin + radius)); i++) peak = Math.max(peak, spectrum[i]);
  return peak;
}

/** Resolve octave only from audio agreement with several independently observed keys. */
export function resolveOctave(observations, samples, sampleRate = 11025, { firstPitchClass, semitones } = {}) {
  if (!samples?.length || !Number.isFinite(sampleRate) || sampleRate < 8000 || !Number.isInteger(firstPitchClass) || !Number.isInteger(semitones)) return null;
  const viable = observations.filter(o => o.pitches.length > 0 && o.pitches.length <= 8 && o.time * sampleRate < samples.length);
  if (viable.length < 8) return null;
  const selected = viable.filter((_, i) => i % Math.max(1, Math.floor(viable.length / 48)) === 0).slice(0, 64);
  const candidates = [];
  for (let firstMidi = firstPitchClass; firstMidi + semitones <= 108; firstMidi += 12) {
    if (firstMidi < 12) continue;
    candidates.push({ firstMidi, score: 0, supported: 0, notes: 0, subharmonics: 0, eligible: 0, ambiguousPitches: new Set() });
  }
  let audible = 0;
  for (const observation of selected) {
    const spectrum = magnitudeSpectrum(samples, observation.time * sampleRate);
    const energy = Math.max(...spectrum);
    if (energy < 0.0002) continue;
    audible++;
    for (const candidate of candidates) {
      const offset = candidate.firstMidi - (24 + firstPitchClass);
      for (const pitch of observation.pitches) {
        const frequency = midiHz(pitch + offset), fundamental = spectralPeak(spectrum, frequency, sampleRate) / energy;
        let harmonic = 0;
        for (let n = 2; n <= 4; n++) harmonic += spectralPeak(spectrum, frequency * n, sampleRate) / energy / (n * n);
        candidate.score += Math.sqrt(fundamental) + 1.3 * Math.sqrt(harmonic);
        candidate.supported += fundamental > 0.055 ? 1 : 0;
        candidate.notes++;
        // A weak lower fundamental plus its odd harmonic can expose a dominant
        // second harmonic. Do not call that louder harmonic an octave proof.
        const explainedByOtherKey = observation.pitches.some(other => other < pitch && (pitch - other) % 12 === 0) || observation.pitches.includes(pitch + 7);
        if (!explainedByOtherKey) {
          candidate.eligible++;
          if (spectralPeak(spectrum, frequency / 2, sampleRate) / energy > 0.006 &&
              spectralPeak(spectrum, frequency * 1.5, sampleRate) / energy > 0.035) {
            candidate.subharmonics++;
            candidate.ambiguousPitches.add(pitch);
          }
        }
      }
    }
  }
  for (const candidate of candidates) {
    candidate.score /= Math.max(1, candidate.notes);
    candidate.support = candidate.supported / Math.max(1, candidate.notes);
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0], second = candidates[1];
  const margin = best && second ? (best.score - second.score) / Math.max(best.score, 1e-9) : 0;
  const distinct = new Set(selected.flatMap(o => o.pitches)).size;
  if (!best || audible < 8 || distinct < 4 || best.support < 0.62 || margin < 0.13 || best.score < 0.35) return null;
  if (best.eligible >= 8 && best.subharmonics / best.eligible > 0.55 && best.ambiguousPitches.size >= 4) return null;
  return { firstMidi: best.firstMidi, lastMidi: best.firstMidi + semitones,
    confidence: Math.min(best.support, clamp(margin / 0.3, 0, 1)), margin, support: best.support, audibleSamples: audible };
}

async function streamFrames(path, width, height, fps, onFrame, signal, scanRows) {
  return new Promise((resolve, reject) => {
    let filter = `fps=${fps},scale=${width}:${height}`;
    if (scanRows) {
      filter += `,format=rgb24,split[a][b];[a]crop=${width}:3:0:${scanRows.white - 1}[w];` +
        `[b]crop=${width}:3:0:${scanRows.black - 1}[k];[w][k]vstack=inputs=2`;
    }
    const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', path,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filter, '-threads', '2', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
    { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const bytes = width * (scanRows ? 6 : height) * 3;
    let buffer = Buffer.allocUnsafe(bytes), offset = 0, index = 0, stderr = '', failed = false;
    const fail = error => { if (!failed) { failed = true; child.kill(); reject(error); } };
    const timer = setTimeout(() => fail(new Error('Automatic calibration timed out while reading video.')), 180000);
    child.on('error', fail);
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
    child.stdout.on('data', chunk => {
      try {
        for (let at = 0; at < chunk.length;) {
          const count = Math.min(bytes - offset, chunk.length - at);
          chunk.copy(buffer, offset, at, at + count); at += count; offset += count;
          if (offset === bytes) { onFrame(buffer, index / fps, index++); buffer = Buffer.allocUnsafe(bytes); offset = 0; }
        }
      } catch (error) { fail(error); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (signal?.aborted) reject(new Error('Cancelled.'));
      else if (code !== 0) reject(new Error(stderr || 'Could not read video for automatic calibration.'));
      else resolve(index);
    });
  });
}

async function readAudio(path, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', path,
      '-map', '0:a:0?', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '11025', '-threads', '2', '-f', 'f32le', 'pipe:1'],
    { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let length = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('Automatic calibration timed out while reading audio.')); }, 90000);
    child.on('error', error => { failed = true; clearTimeout(timer); reject(error); });
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > 60_000_000) { failed = true; child.kill(); clearTimeout(timer); reject(new Error('Audio is too long for automatic calibration.')); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (signal?.aborted) { reject(new Error('Cancelled.')); return; }
      if (code !== 0 || !length) { resolve(null); return; }
      const bytes = Buffer.concat(chunks);
      // Buffer offsets are not necessarily aligned to Float32Array boundaries.
      const samples = new Float32Array(Math.floor(bytes.length / 4));
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
      resolve(samples);
    });
  });
}

/** Static, straight-on falling-note keyboards only; no layout/title presets or octave guesses. */
export async function autoCalibrate(video, { signal, progress = () => {} } = {}) {
  if (!video || typeof video.path !== 'string' || !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 1200 ||
      !Number.isFinite(video.width) || !Number.isFinite(video.height) || video.width < 100 || video.height < 80) throw new TypeError('A valid local video is required for automatic calibration.');
  if (signal?.aborted) throw new Error('Cancelled.');
  const review = (reason, extra = {}) => ({ status: 'needs_review', confidence: 0, reason, ...extra });
  const width = Math.min(640, video.width), height = Math.round(video.height * width / video.width);
  const frames = [];
  progress(0.05, 'Finding the keyboard and its black-key pattern');
  await streamFrames(video.path, width, height, 24 / video.duration, frame => { if (frames.length < 25) frames.push(frame); }, signal);
  const geometry = detectKeyboardGeometry(frames, width, height);
  if (!geometry || geometry.confidence < 0.69) return review('The video does not show a stable, straight-on piano keyboard clearly enough. Adjust the keyboard alignment manually.');
  progress(0.32, 'Finding the hand colors and the start and end of the music');
  const rawObservations = [], colorSamples = [];
  const scanFps = 20;
  const scanRows = { white: clamp(Math.round(geometry.whiteLine * (height - 1)), 1, height - 2), black: clamp(Math.round(geometry.blackLine * (height - 1)), 1, height - 2) };
  const stripGeometry = { ...geometry, whiteLine: 1 / 5, blackLine: 4 / 5 };
  // Decode just the two three-pixel strips at a cadence finer than minNote.
  // Sampling the whole song also preserves brief pickups before long rests.
  await streamFrames(video.path, width, height, scanFps, (frame, time, index) => {
    const samples = keySamples(frame, width, 6, stripGeometry);
    // FFmpeg's nearest-rounded fps filter selects near the middle of each interval.
    rawObservations.push({ time: time + 0.5 / scanFps, samples });
    if (index % 10 === 0) colorSamples.push(...samples);
  }, signal, scanRows);
  const colors = discoverHandColors(colorSamples);
  if (!colors) return review('The two hand colors could not be separated reliably. Choose the colors and keyboard range manually.', { summary: { whiteKeys: geometry.whiteKeys } });
  const observations = rawObservations.map(o => ({ time: o.time, pitches: o.samples.filter(s => Math.min(hueDistance(s.hue, colors.leftHue), hueDistance(s.hue, colors.rightHue)) < 28).map(s => s.pitch) }));
  const span = findActiveSpan(observations, video.duration, 1 / scanFps);
  if (!span) return review('Too few clear played keys were found to identify the musical section reliably.');
  progress(0.7, 'Checking the exact octave against the video audio');
  const samples = await readAudio(video.path, signal);
  const octave = resolveOctave(observations.filter(o => o.time >= span.startTime && o.time <= span.endTime), samples, 11025, geometry);
  const summary = { whiteKeys: geometry.whiteKeys, firstPitchClass: geometry.firstPitchClass, startTime: span.startTime, endTime: span.endTime };
  if (!octave) return review(samples ? 'The audio did not confirm one keyboard octave clearly enough. Check the first and last notes manually.' :
    'This video has no usable audio, so the absolute octave cannot be confirmed. Check the first and last notes manually.', { summary });
  const calibration = { left: geometry.left, right: geometry.right, firstMidi: octave.firstMidi, lastMidi: octave.lastMidi,
    line: geometry.whiteLine, whiteLine: geometry.whiteLine, blackLine: geometry.blackLine };
  const options = { fps: 60, handMode: 'color', leftHue: colors.leftHue, rightHue: colors.rightHue,
    saturation: 0.1, brightness: 0.22, minNote: 0.07, trim: true, ...span };
  const confidence = Math.min(geometry.confidence, colors.confidence, octave.confidence);
  progress(1, 'Keyboard, hand colors, and octave confirmed');
  return { status: 'ready', calibration, options, confidence,
    reason: 'Keyboard geometry and played notes agree with the audio.', summary: { ...summary, audioSamples: octave.audibleSamples, octaveMargin: octave.margin } };
}
