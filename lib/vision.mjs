const WHITE_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11];
const BLACK_WIDTH = 0.62;
const DEFAULT_OPTIONS = Object.freeze({
  saturation: 0.3,
  brightness: 0.25,
  minNote: 0.08,
  splitMidi: 60,
  trim: true,
  handMode: 'pitch',
  leftHue: 200,
  rightHue: 120,
});

function numberInRange(value, name, min, max = Infinity, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`);
  }
  return value;
}

function validateKeyboard(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Calibration must be an object.');
  const left = numberInRange(input.left ?? 0, 'Keyboard left edge', 0, 1);
  const right = numberInRange(input.right ?? 1, 'Keyboard right edge', 0, 1);
  const firstMidi = numberInRange(input.firstMidi ?? 21, 'First MIDI note', 0, 127, true);
  const lastMidi = numberInRange(input.lastMidi ?? 108, 'Last MIDI note', 0, 127, true);
  if (left >= right) throw new RangeError('Keyboard left edge must be before its right edge.');
  if (firstMidi > lastMidi) throw new RangeError('First MIDI note must not exceed the last MIDI note.');
  return { left, right, firstMidi, lastMidi };
}

/** The horizontal coordinate system is white-key widths, not equal semitones. */
export function keyboardLanes(input = {}) {
  const { left, right, firstMidi, lastMidi } = validateKeyboard(input);
  const keys = [];
  for (let pitch = firstMidi; pitch <= lastMidi; pitch += 1) {
    const pitchClass = pitch % 12;
    const whiteIndex = WHITE_PITCH_CLASSES.indexOf(pitchClass);
    const black = whiteIndex === -1;
    const withinOctave = black
      ? WHITE_PITCH_CLASSES.findIndex((value) => value > pitchClass)
      : whiteIndex + 0.5;
    keys.push({ pitch, position: Math.floor(pitch / 12) * 7 + withinOctave, size: black ? BLACK_WIDTH : 1, black });
  }
  // Include the full first and last visible keys, even for a range beginning on a sharp.
  const low = Math.min(...keys.map((key) => key.position - key.size / 2));
  const high = Math.max(...keys.map((key) => key.position + key.size / 2));
  const scale = (right - left) / (high - low);
  return keys.map((key) => ({
    pitch: key.pitch,
    x: left + (key.position - low) * scale,
    width: key.size * scale,
    black: key.black,
  }));
}

function hueDistance(a, b) {
  const distance = Math.abs(a - b) % 360;
  return Math.min(distance, 360 - distance);
}

function pixelColor(rgb, offset, saturationThreshold, brightnessThreshold, handMode, leftHue, rightHue) {
  const r = rgb[offset] / 255;
  const g = rgb[offset + 1] / 255;
  const b = rgb[offset + 2] / 255;
  const high = Math.max(r, g, b);
  const low = Math.min(r, g, b);
  const delta = high - low;
  // Achromatic and nearly black pixels cannot carry a reliable note colour.
  if (high < brightnessThreshold || delta === 0 || delta / high < saturationThreshold) return null;
  let hue;
  if (high === r) hue = 60 * (((g - b) / delta) % 6);
  else if (high === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  hue = (hue + 360) % 360;
  if (handMode === 'color') {
    const leftDistance = hueDistance(hue, leftHue);
    const rightDistance = hueDistance(hue, rightHue);
    if (Math.min(leftDistance, rightDistance) > 50) return null;
    return { hue, hand: leftDistance <= rightDistance ? 'left' : 'right' };
  }
  return { hue, hand: null };
}

/**
 * Scan a narrow horizontal strip of RGB24 video frames.
 *
 * There is intentionally no temporal gap filling: one sampled absent frame
 * closes a note, preserving repetitions. Durations shorter than minNote are
 * discarded at finish. Sampling cannot recover gaps shorter than a frame.
 */
export function createDetector({ width, height, fps, calibration = {}, options = {} } = {}) {
  numberInRange(width, 'Frame width', 1, Number.MAX_SAFE_INTEGER, true);
  numberInRange(height, 'Frame height', 1, Number.MAX_SAFE_INTEGER, true);
  numberInRange(fps, 'Frames per second', Number.MIN_VALUE);
  const frameBytes = width * height * 3;
  if (!Number.isSafeInteger(frameBytes)) throw new RangeError('Frame dimensions are too large.');
  if (!options || typeof options !== 'object') throw new TypeError('Options must be an object.');
  const keyboard = validateKeyboard(calibration);
  const line = numberInRange(calibration.line ?? 0.75, 'Scan line', 0, 1);
  const config = { ...DEFAULT_OPTIONS, ...options };
  numberInRange(config.saturation, 'Saturation threshold', 0, 1);
  numberInRange(config.brightness, 'Brightness threshold', 0, 1);
  numberInRange(config.minNote, 'Minimum note duration', 0);
  numberInRange(config.splitMidi, 'Hand split MIDI note', 0, 127, true);
  numberInRange(config.leftHue, 'Left-hand hue', 0, 360);
  numberInRange(config.rightHue, 'Right-hand hue', 0, 360);
  if (config.handMode !== 'pitch' && config.handMode !== 'color') throw new TypeError('Hand mode must be "pitch" or "color".');
  if (typeof config.trim !== 'boolean') throw new TypeError('Trim must be a boolean.');
  config.leftHue %= 360;
  config.rightHue %= 360;
  if (config.handMode === 'color' && hueDistance(config.leftHue, config.rightHue) < 1) {
    throw new RangeError('Choose distinct left-hand and right-hand hues.');
  }

  const lanes = keyboardLanes(keyboard);
  const row = Math.round(line * (height - 1));
  const yMin = Math.max(0, row - 1);
  const yMax = Math.min(height - 1, row + 1);
  const samples = lanes.map((lane) => {
    const center = lane.x * width;
    const radius = Math.max(0.5, lane.width * width * (lane.black ? 0.18 : 0.14));
    const xMin = Math.max(0, Math.min(width - 1, Math.floor(center - radius)));
    const xMax = Math.max(xMin, Math.min(width - 1, Math.ceil(center + radius) - 1));
    return { ...lane, xMin, xMax };
  });
  const active = new Map();
  const finished = [];
  let lastFrameTime = null;
  let result = null;

  function colorAt(rgb, x, y) {
    return pixelColor(rgb, (y * width + x) * 3, config.saturation, config.brightness, config.handMode, config.leftHue, config.rightHue);
  }

  function sampleLane(rgb, lane) {
    const groups = { any: { count: 0, sin: 0, cos: 0 }, left: { count: 0, sin: 0, cos: 0 }, right: { count: 0, sin: 0, cos: 0 } };
    const total = (lane.xMax - lane.xMin + 1) * (yMax - yMin + 1);
    for (let y = yMin; y <= yMax; y += 1) {
      for (let x = lane.xMin; x <= lane.xMax; x += 1) {
        const color = colorAt(rgb, x, y);
        if (!color) continue;
        const group = groups[color.hand ?? 'any'];
        group.count += 1;
        group.sin += Math.sin(color.hue * Math.PI / 180);
        group.cos += Math.cos(color.hue * Math.PI / 180);
      }
    }
    const hand = config.handMode === 'color'
      ? (groups.left.count >= groups.right.count ? 'left' : 'right')
      : (lane.pitch < config.splitMidi ? 'left' : 'right');
    const group = groups[config.handMode === 'color' ? hand : 'any'];
    if (group.count / total < 0.68) return null;
    return { hand, hue: (Math.atan2(group.sin, group.cos) * 180 / Math.PI + 360) % 360 };
  }

  function close(pitch, end) {
    const current = active.get(pitch);
    if (!current) return;
    active.delete(pitch);
    const duration = end - current.start;
    if (duration > 0 && duration + 1e-9 >= config.minNote) {
      finished.push({ pitch, start: current.start, duration, velocity: 90, hand: current.hand });
    }
  }

  return {
    pushFrame(rgb, timeSeconds) {
      if (result) throw new Error('Cannot push frames after finishing the detector.');
      if (!(rgb instanceof Uint8Array || rgb instanceof Uint8ClampedArray) || rgb.length !== frameBytes) {
        throw new TypeError(`Expected an RGB24 byte array of exactly ${frameBytes} bytes.`);
      }
      numberInRange(timeSeconds, 'Frame timestamp', 0);
      if (lastFrameTime !== null && timeSeconds <= lastFrameTime) {
        throw new RangeError('Frame timestamps must strictly increase.');
      }
      const detections = samples.map((lane) => sampleLane(rgb, lane));
      // Two touching white bars can paint the position of the black key between
      // them. Require independent colour/shape evidence for that black key.
      // A truly contiguous same-colour three-note chord is visually ambiguous.
      for (let i = 1; i < samples.length - 1; i += 1) {
        if (!samples[i].black || !detections[i] || samples[i - 1].black || samples[i + 1].black) continue;
        const left = detections[i - 1];
        const black = detections[i];
        const right = detections[i + 1];
        if (!left || !right || hueDistance(left.hue, black.hue) > 22 || hueDistance(right.hue, black.hue) > 22) continue;
        let matching = 0;
        let total = 0;
        const from = Math.max(0, Math.floor(samples[i - 1].x * width));
        const to = Math.min(width - 1, Math.ceil(samples[i + 1].x * width));
        for (let x = from; x <= to; x += 1) {
          total += 1;
          const color = colorAt(rgb, x, row);
          if (color && hueDistance(color.hue, black.hue) <= 22) matching += 1;
        }
        if (matching / total > 0.94) detections[i] = null;
      }

      const transitionTime = lastFrameTime === null ? timeSeconds : (lastFrameTime + timeSeconds) / 2;
      for (let i = 0; i < samples.length; i += 1) {
        const { pitch } = samples[i];
        const detection = detections[i];
        const current = active.get(pitch);
        if (current && (!detection || current.hand !== detection.hand)) close(pitch, transitionTime);
        if (detection && !active.has(pitch)) active.set(pitch, { start: transitionTime, hand: detection.hand });
      }
      lastFrameTime = timeSeconds;
    },
    finish(endSeconds) {
      numberInRange(endSeconds, 'End timestamp', 0);
      if (lastFrameTime !== null && endSeconds < lastFrameTime) {
        throw new RangeError('End timestamp must not precede the last frame.');
      }
      if (!result) {
        for (const pitch of [...active.keys()]) close(pitch, endSeconds);
        finished.sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.hand.localeCompare(b.hand));
        const offset = config.trim && finished.length ? finished[0].start : 0;
        result = finished.map((note) => ({ ...note, start: Math.max(0, note.start - offset) }));
      }
      return result.map((note) => ({ ...note }));
    },
  };
}
