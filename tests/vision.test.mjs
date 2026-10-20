import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardLanes, createDetector } from '../lib/vision.mjs';

const WIDTH = 700;
const HEIGHT = 120;
const calibration = { left: 0, right: 1, firstMidi: 60, lastMidi: 71, line: 0.5 };
// Independent physical key coordinates for one octave (100 px per white key).
const centers = { 60: 50, 61: 100, 62: 150, 63: 200, 64: 250, 65: 350, 66: 400, 67: 450, 68: 500, 69: 550, 70: 600, 71: 650 };
const blacks = new Set([61, 63, 66, 68, 70]);
const BLUE = [0, 170, 255]; // hue 200
const GREEN = [0, 255, 0]; // hue 120

function frame(notes = []) {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (const { pitch, color = GREEN, wide = false } of notes) {
    const half = wide ? 50 : (blacks.has(pitch) ? 20 : 33);
    for (let y = 58; y <= 62; y += 1) {
      for (let x = Math.max(0, centers[pitch] - half); x < Math.min(WIDTH, centers[pitch] + half); x += 1) {
        rgb.set(color, (y * WIDTH + x) * 3);
      }
    }
  }
  return rgb;
}

function detector(options = {}, overrides = {}) {
  return createDetector({ width: WIDTH, height: HEIGHT, fps: 20, calibration, options: { trim: false, ...options }, ...overrides });
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test('keyboard calibration preserves unequal semitone spacing and all 88 keys', () => {
  const lanes = keyboardLanes({ left: 0, right: 1, firstMidi: 60, lastMidi: 71 });
  near(lanes[0].x, 0.5 / 7);
  near(lanes[1].x, 1 / 7);
  near(lanes[4].x, 2.5 / 7);
  near(lanes[5].x, 3.5 / 7);
  near(lanes[0].width, 1 / 7);
  near(lanes[1].width, 0.62 / 7);
  const piano = keyboardLanes({});
  assert.equal(piano.length, 88);
  assert.equal(piano.filter((lane) => !lane.black).length, 52);
  near(piano[0].x, 0.5 / 52);
  near(piano.at(-1).x, 51.5 / 52);
});

test('a range starting on a black key is finite, bounded, and spans the chosen edges', () => {
  const lanes = keyboardLanes({ left: 0.1, right: 0.9, firstMidi: 61, lastMidi: 63 });
  near(lanes[0].x - lanes[0].width / 2, 0.1);
  near(lanes.at(-1).x + lanes.at(-1).width / 2, 0.9);
  assert.ok(lanes.every((lane) => Number.isFinite(lane.x) && lane.width > 0));
});

test('detects a white/black chord without phantom adjacent keys and preserves seconds', () => {
  const engine = detector({ splitMidi: 62 });
  engine.pushFrame(frame(), 0);
  engine.pushFrame(frame([{ pitch: 60 }, { pitch: 61 }]), 0.1);
  engine.pushFrame(frame([{ pitch: 60 }, { pitch: 61 }]), 0.3);
  engine.pushFrame(frame(), 0.4);
  const notes = engine.finish(0.5);
  assert.deepEqual(notes.map((note) => note.pitch), [60, 61]);
  for (const note of notes) {
    near(note.start, 0.05);
    near(note.duration, 0.3);
    assert.equal(note.hand, 'left');
    assert.equal(note.velocity, 90);
  }
});

test('one sampled gap keeps repeated notes separate even when the gap is short', () => {
  const engine = detector({ minNote: 0.04 });
  const on = frame([{ pitch: 67 }]);
  const off = frame();
  engine.pushFrame(off, 0);
  engine.pushFrame(on, 0.05);
  engine.pushFrame(on, 0.1);
  engine.pushFrame(off, 0.15);
  engine.pushFrame(on, 0.2);
  engine.pushFrame(on, 0.25);
  engine.pushFrame(off, 0.3);
  const notes = engine.finish(0.35);
  assert.equal(notes.length, 2);
  near(notes[0].start, 0.025);
  near(notes[0].duration, 0.1);
  near(notes[1].start, 0.175);
  near(notes[1].duration, 0.1);
  assert.ok(notes[1].start > notes[0].start + notes[0].duration);
});

test('minimum duration removes noise before trim chooses the first retained note', () => {
  const engine = detector({ trim: true, minNote: 0.08 });
  engine.pushFrame(frame(), 0);
  engine.pushFrame(frame([{ pitch: 60 }]), 0.02);
  engine.pushFrame(frame(), 0.04);
  engine.pushFrame(frame([{ pitch: 64 }]), 0.4);
  engine.pushFrame(frame([{ pitch: 64 }]), 0.6);
  engine.pushFrame(frame(), 0.7);
  const notes = engine.finish(0.8);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].pitch, 64);
  near(notes[0].start, 0);
  near(notes[0].duration, 0.43);
});

test('calibrated hues assign hands independently of pitch and ignore unrelated colours', () => {
  const engine = detector({ handMode: 'color', leftHue: 200, rightHue: 120 });
  const on = frame([{ pitch: 60, color: GREEN }, { pitch: 67, color: BLUE }, { pitch: 71, color: [255, 0, 0] }]);
  engine.pushFrame(on, 0.2);
  const notes = engine.finish(0.6);
  assert.deepEqual(notes.map(({ pitch, hand }) => ({ pitch, hand })), [{ pitch: 60, hand: 'right' }, { pitch: 67, hand: 'left' }]);
  near(notes[0].duration, 0.4);
});

test('hue matching wraps through red and a colour hand change splits a sustained pitch', () => {
  const engine = detector({ handMode: 'color', leftHue: 359, rightHue: 120, minNote: 0 });
  engine.pushFrame(frame([{ pitch: 60, color: [255, 0, 8] }]), 0);
  engine.pushFrame(frame([{ pitch: 60, color: GREEN }]), 0.2);
  engine.pushFrame(frame(), 0.4);
  const notes = engine.finish(0.5);
  assert.deepEqual(notes.map((note) => note.hand), ['left', 'right']);
  near(notes[0].duration, 0.1);
  near(notes[1].start, 0.1);
});

test('bright grey keyboard pixels and dark saturated noise are not notes', () => {
  const engine = detector();
  engine.pushFrame(frame([{ pitch: 60, color: [255, 255, 255] }, { pitch: 64, color: [0, 20, 0] }]), 0);
  assert.deepEqual(engine.finish(0.5), []);
});

test('brightness threshold separates bright notes from a saturated background of the same hue', () => {
  const engine = detector({
    handMode: 'color', leftHue: 200, rightHue: 120, brightness: 0.55,
    // Other pipeline options must not change engine behaviour or fail validation.
    startTime: 5, endTime: 105,
  });
  const dark = frame([{ pitch: 60, color: [0, 80, 120] }]);
  const bright = frame([{ pitch: 60, color: BLUE }]);
  engine.pushFrame(dark, 0);
  engine.pushFrame(bright, 0.1);
  engine.pushFrame(bright, 0.3);
  engine.pushFrame(dark, 0.4);
  const notes = engine.finish(0.5);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].pitch, 60);
  assert.equal(notes[0].hand, 'left');
  near(notes[0].start, 0.05);
  near(notes[0].duration, 0.3);
});

test('default brightness threshold rejects moderately dark saturated pixels', () => {
  const engine = detector();
  engine.pushFrame(frame([{ pitch: 60, color: [0, 40, 60] }]), 0);
  assert.deepEqual(engine.finish(0.5), []);
});

test('touching full-width white bars do not invent a black note between them', () => {
  const engine = detector();
  engine.pushFrame(frame([{ pitch: 60, wide: true }, { pitch: 62, wide: true }]), 0);
  assert.deepEqual(engine.finish(0.3).map((note) => note.pitch), [60, 62]);
});

test('finish closes held notes, is repeatable, and returns independent note objects', () => {
  const engine = detector();
  engine.pushFrame(frame([{ pitch: 69 }]), 0.1);
  const first = engine.finish(1);
  near(first[0].duration, 0.9);
  first[0].pitch = 1;
  assert.equal(engine.finish(1)[0].pitch, 69);
  assert.throws(() => engine.pushFrame(frame(), 1.1), /after finishing/);
});

test('invalid calibration, options, frame bytes, and timestamps fail explicitly', () => {
  assert.throws(() => keyboardLanes({ left: 0.8, right: 0.2 }), /left edge/);
  assert.throws(() => keyboardLanes({ firstMidi: 90, lastMidi: 30 }), /First MIDI/);
  assert.throws(() => keyboardLanes({ firstMidi: 60.5 }), /integer/);
  for (const invalid of [
    { saturation: NaN }, { saturation: 1.1 }, { brightness: -0.1 }, { brightness: 1.1 }, { brightness: NaN },
    { minNote: -1 }, { splitMidi: 128 },
    { leftHue: -2 }, { rightHue: Infinity }, { trim: 'yes' }, { handMode: 'auto' },
    { handMode: 'color', leftHue: 360, rightHue: 0 },
  ]) assert.throws(() => detector(invalid));
  assert.throws(() => detector({}, { width: 0 }), /Frame width/);
  assert.throws(() => detector({}, { fps: 0 }), /Frames per second/);
  assert.throws(() => detector({}, { calibration: { ...calibration, line: 1.1 } }), /Scan line/);
  const engine = detector();
  assert.throws(() => engine.pushFrame(new Uint8Array(2), 0), /RGB24/);
  assert.throws(() => engine.pushFrame(frame(), NaN), /timestamp/);
  engine.pushFrame(frame(), 1);
  assert.throws(() => engine.pushFrame(frame(), 1), /strictly increase/);
  assert.throws(() => engine.pushFrame(frame(), 0.5), /strictly increase/);
  assert.throws(() => engine.finish(0.9), /precede/);
});
