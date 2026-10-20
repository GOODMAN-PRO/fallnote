import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMidi, validateNotes } from '../lib/midi.mjs';

// Independent SMF reader checks actual bytes, lengths, variable-length values,
// event order, and reconstructed seconds instead of testing private helpers.
function parseMidi(bytes) {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = () => { const value = view.getUint16(offset); offset += 2; return value; };
  const u32 = () => { const value = view.getUint32(offset); offset += 4; return value; };
  const ascii = (length) => { const value = new TextDecoder().decode(bytes.subarray(offset, offset + length)); offset += length; return value; };
  const vlq = () => {
    let value = 0;
    let count = 0;
    let byte;
    do {
      byte = bytes[offset++];
      assert.ok(Number.isInteger(byte), 'unexpected EOF');
      value = value * 128 + (byte & 127);
      count += 1;
      assert.ok(count <= 4, 'SMF delta-time exceeds four bytes');
    } while (byte & 128);
    return value;
  };
  assert.equal(ascii(4), 'MThd');
  assert.equal(u32(), 6);
  const format = u16();
  const trackCount = u16();
  const ppq = u16();
  const tracks = [];
  for (let i = 0; i < trackCount; i += 1) {
    assert.equal(ascii(4), 'MTrk');
    const length = u32();
    const end = offset + length;
    let tick = 0;
    const events = [];
    while (offset < end) {
      tick += vlq();
      const status = bytes[offset++];
      if (status === 0xff) {
        const type = bytes[offset++];
        const size = vlq();
        const data = bytes.slice(offset, offset + size);
        offset += size;
        events.push({ tick, status, type, data });
      } else if ((status & 0xf0) === 0xc0) {
        events.push({ tick, status, program: bytes[offset++] });
      } else {
        assert.ok([0x80, 0x90].includes(status & 0xf0));
        events.push({ tick, status, pitch: bytes[offset++], velocity: bytes[offset++] });
      }
    }
    assert.equal(offset, end);
    assert.equal(events.at(-1).type, 0x2f);
    tracks.push(events);
  }
  assert.equal(offset, bytes.length);
  return { format, ppq, tracks };
}

const note = (overrides = {}) => ({ pitch: 60, start: 0, duration: 1, velocity: 90, hand: 'right', ...overrides });

test('exports a valid type-1 file with conductor and independent named hand tracks', () => {
  const parsed = parseMidi(encodeMidi([note(), note({ pitch: 48, hand: 'left' })], { title: 'Piano étude' }));
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ppq, 480);
  assert.equal(parsed.tracks.length, 3);
  const names = parsed.tracks.map((track) => new TextDecoder().decode(track.find((event) => event.type === 3).data));
  assert.deepEqual(names, ['Piano étude', 'Left Hand', 'Right Hand']);
  assert.deepEqual([...parsed.tracks[0].find((event) => event.type === 0x51).data], [7, 161, 32]);
  assert.equal(parsed.tracks[1].find((event) => (event.status & 0xf0) === 0xc0).program, 0);
  assert.equal(parsed.tracks[2].find((event) => (event.status & 0xf0) === 0xc0).program, 0);
  const left = parsed.tracks[1].find((event) => (event.status & 0xf0) === 0x90);
  const right = parsed.tracks[2].find((event) => (event.status & 0xf0) === 0x90);
  assert.equal(left.pitch, 48);
  assert.equal(right.pitch, 60);
  assert.notEqual(left.status & 15, right.status & 15);
});

test('seconds survive arbitrary tempo and multi-byte delta times within one tick', () => {
  const input = note({ start: 123.456, duration: 3.789 });
  for (const tempo of [60, 120, 137.5]) {
    const parsed = parseMidi(encodeMidi([input], { tempo }));
    const tempoData = parsed.tracks[0].find((event) => event.type === 0x51).data;
    const micros = tempoData[0] * 65536 + tempoData[1] * 256 + tempoData[2];
    const secondsPerTick = micros / 1000000 / parsed.ppq;
    const on = parsed.tracks[2].find((event) => (event.status & 0xf0) === 0x90);
    const off = parsed.tracks[2].find((event) => (event.status & 0xf0) === 0x80);
    assert.ok(Math.abs(on.tick * secondsPerTick - input.start) <= secondsPerTick);
    assert.ok(Math.abs((off.tick - on.tick) * secondsPerTick - input.duration) <= secondsPerTick);
  }
});

test('same-tick note-off precedes retriggered note-on', () => {
  const parsed = parseMidi(encodeMidi([note(), note({ start: 1 })]));
  const atBoundary = parsed.tracks[2].filter((event) => event.tick === 960 && event.pitch === 60);
  assert.deepEqual(atBoundary.map((event) => event.status & 0xf0), [0x80, 0x90]);
});

test('simultaneous chords keep every pitch and short notes get nonzero duration', () => {
  const parsed = parseMidi(encodeMidi([note({ pitch: 64 }), note({ pitch: 60 }), note({ pitch: 67, duration: 1e-6 })]));
  const track = parsed.tracks[2];
  assert.deepEqual(track.filter((event) => (event.status & 0xf0) === 0x90).map((event) => event.pitch), [60, 64, 67]);
  assert.equal(track.find((event) => (event.status & 0xf0) === 0x80 && event.pitch === 67).tick, 1);
});

test('empty songs produce valid empty piano tracks and do not manufacture notes', () => {
  const parsed = parseMidi(encodeMidi([]));
  assert.equal(parsed.tracks.flat().filter((event) => (event.status & 0xf0) === 0x90).length, 0);
  assert.ok(parsed.tracks.every((track) => track.at(-1).tick === 0));
});

test('validation makes copies, supplies velocity, sorts, and rejects invalid values', () => {
  const raw = [{ pitch: 70, start: 2, duration: 1, hand: 'left' }, note()];
  const normalized = validateNotes(raw);
  assert.equal(normalized[0].start, 0);
  assert.equal(normalized[1].velocity, 90);
  normalized[1].pitch = 0;
  assert.equal(raw[0].pitch, 70);
  for (const bad of [
    { pitch: -1 }, { pitch: 128 }, { pitch: 60.5 }, { start: -1 }, { start: NaN },
    { duration: 0 }, { duration: -1 }, { duration: Infinity }, { velocity: 0 },
    { velocity: 128 }, { hand: 'both' },
  ]) assert.throws(() => validateNotes([note(bad)]));
  assert.throws(() => validateNotes(null), /array/);
  assert.throws(() => validateNotes([null]), /object/);
  assert.throws(() => encodeMidi([note()], { tempo: 0 }), /Tempo/);
  assert.throws(() => encodeMidi([note()], { tempo: 1 }), /tempo range/);
  assert.throws(() => encodeMidi([note()], { tempo: Infinity }), /Tempo/);
  assert.throws(() => encodeMidi([note()], { title: 7 }), /title/);
  assert.throws(() => encodeMidi([note({ start: 1000000 })]), /delta-time/);
});

test('large songs do not hit JavaScript spread argument limits', () => {
  const notes = Array.from({ length: 20000 }, (_, index) => note({
    start: index * 0.1, duration: 0.08, pitch: 48 + index % 24, hand: index % 2 ? 'left' : 'right',
  }));
  const bytes = encodeMidi(notes);
  assert.ok(bytes.length > 160000);
  const parsed = parseMidi(bytes);
  assert.equal(parsed.tracks.flat().filter((event) => (event.status & 0xf0) === 0x90).length, 20000);
});
