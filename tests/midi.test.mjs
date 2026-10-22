import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('default export remains byte-for-byte compatible with the existing conductor layout', () => {
  const notes = [note(), note({ pitch: 48, start: 0.5, duration: 2, velocity: 73, hand: 'left' })];
  const options = { title: 'Piano étude', tempo: 137.5 };
  const bytes = encodeMidi(notes, options);
  // Captured before adding hand export options; protects the existing working MIDI format.
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '4e60b7a225ded400ebb98c99b3d4f8c74d8eb33644b3cd3b43fade50455c4791');
  assert.deepEqual(encodeMidi(notes, { ...options, layout: 'conductor-first', hand: 'both' }), bytes);
});

test('hand-tracks export has right then left musical tracks, with tempo and meter in the first track', () => {
  const parsed = parseMidi(encodeMidi([
    note({ pitch: 72, start: 2, duration: 0.5, velocity: 45, hand: 'left' }),
    note({ pitch: 48, start: 2, duration: 1, velocity: 112 }),
    note({ pitch: 60, start: 3, duration: 0.25, velocity: 62, hand: 'left' }),
    note({ pitch: 60, start: 3, duration: 0.5, velocity: 99 }),
  ], { title: 'Crossed hands', layout: 'hand-tracks' }));
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ppq, 480);
  assert.equal(parsed.tracks.length, 2);
  const [right, left] = parsed.tracks;
  assert.deepEqual(parsed.tracks.map((track) => new TextDecoder().decode(track.find((event) => event.type === 3).data)), ['Right Hand', 'Left Hand']);
  assert.equal(new TextDecoder().decode(right.find((event) => event.type === 1).data), 'Crossed hands');
  assert.deepEqual(right.filter((event) => [0x51, 0x58].includes(event.type)).map((event) => [event.tick, event.type, [...event.data]]), [
    [0, 0x58, [4, 2, 24, 8]], [0, 0x51, [7, 161, 32]],
  ]);
  assert.equal(left.filter((event) => [0x51, 0x58].includes(event.type)).length, 0);
  assert.deepEqual(parsed.tracks.map((track) => {
    const program = track.find((event) => (event.status & 0xf0) === 0xc0);
    return [program.tick, program.status, program.program];
  }), [[0, 0xc0, 0], [0, 0xc1, 0]]);
  const events = (track) => track.filter((event) => [0x80, 0x90].includes(event.status & 0xf0));
  // Assignment follows the supplied hand, even with crossed hands and a shared pitch.
  assert.deepEqual(events(right), [
    { tick: 1920, status: 0x90, pitch: 48, velocity: 112 },
    { tick: 2880, status: 0x80, pitch: 48, velocity: 0 },
    { tick: 2880, status: 0x90, pitch: 60, velocity: 99 },
    { tick: 3360, status: 0x80, pitch: 60, velocity: 0 },
  ]);
  assert.deepEqual(events(left), [
    { tick: 1920, status: 0x91, pitch: 72, velocity: 45 },
    { tick: 2400, status: 0x81, pitch: 72, velocity: 0 },
    { tick: 2880, status: 0x91, pitch: 60, velocity: 62 },
    { tick: 3120, status: 0x81, pitch: 60, velocity: 0 },
  ]);
  assert.ok(parsed.tracks.every((track) => track.at(-1).tick === 3360));
});

test('individual hands retain intro rests and the full original song duration in either layout', () => {
  const notes = [
    note({ pitch: 72, start: 3, duration: 0.5, velocity: 47, hand: 'left' }),
    note({ pitch: 48, start: 5, duration: 3, velocity: 110 }),
  ];
  for (const layout of ['conductor-first', 'hand-tracks']) {
    const both = parseMidi(encodeMidi(notes, { layout, tempo: 137.5 }));
    for (const hand of ['left', 'right']) {
      const parsed = parseMidi(encodeMidi(notes, { layout, hand, tempo: 137.5 }));
      assert.equal(parsed.tracks.length, both.tracks.length);
      parsed.tracks.forEach((track, index) => {
        const original = both.tracks[index];
        const name = new TextDecoder().decode(track.find((event) => event.type === 3).data);
        const expectedName = hand === 'left' ? 'Left Hand' : 'Right Hand';
        const musicalEvents = (events) => events.filter((event) => [0x80, 0x90].includes(event.status & 0xf0));
        assert.deepEqual(musicalEvents(track), name === expectedName ? musicalEvents(original) : []);
        assert.equal(track.at(-1).tick, original.at(-1).tick);
        assert.ok(track.at(-1).tick > 8000);
      });
    }
  }
});

test('one-hand source and empty source retain stable hand-track indexes without inventing notes', () => {
  for (const sourceHand of ['left', 'right']) {
    const notes = [note({ start: 4, duration: 2, hand: sourceHand })];
    for (const selectedHand of ['both', 'left', 'right']) {
      const parsed = parseMidi(encodeMidi(notes, { layout: 'hand-tracks', hand: selectedHand }));
      assert.equal(parsed.tracks.length, 2);
      assert.ok(parsed.tracks.every((track) => track.at(-1).tick === 5760));
      parsed.tracks.forEach((track, index) => {
        const on = track.filter((event) => (event.status & 0xf0) === 0x90);
        const trackHand = index === 0 ? 'right' : 'left';
        assert.equal(on.length, trackHand === sourceHand && [sourceHand, 'both'].includes(selectedHand) ? 1 : 0);
        if (on.length) assert.equal(on[0].tick, 3840);
      });
    }
  }
  const empty = parseMidi(encodeMidi([], { layout: 'hand-tracks' }));
  assert.equal(empty.tracks.length, 2);
  assert.ok(empty.tracks.every((track) => track.at(-1).tick === 0));
  assert.equal(empty.tracks.flat().filter((event) => (event.status & 0xf0) === 0x90).length, 0);
});

test('exports a valid type-1 file with conductor and independent named hand tracks', () => {
  const parsed = parseMidi(encodeMidi([note(), note({ pitch: 48, hand: 'left' })], { title: 'Piano étude' }));
  assert.equal(parsed.format, 1);
  assert.equal(parsed.ppq, 480);
  assert.equal(parsed.tracks.length, 3);
  // Pianogram played the notes but did not display them without explicit meter.
  const meter = parsed.tracks[0].filter((event) => event.type === 0x58);
  assert.equal(meter.length, 1);
  assert.equal(meter[0].tick, 0);
  assert.deepEqual([...meter[0].data], [4, 2, 24, 8]);
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
  for (const layout of ['other', '', null, 0]) assert.throws(() => encodeMidi([note()], { layout }), /layout/);
  for (const hand of ['other', '', null, 0]) assert.throws(() => encodeMidi([note()], { hand }), /hand/);
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
