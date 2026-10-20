const PPQ = 480;
const MAX_VLQ = 0x0fffffff;
const encoder = new TextEncoder();

function finiteNumber(value, name, min, max = Infinity, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be ${integer ? 'an integer' : 'a finite number'} between ${min} and ${max}.`);
  }
  return value;
}

/** Return independent, sorted note objects without mutating the caller's data. */
export function validateNotes(notes) {
  if (!Array.isArray(notes)) throw new TypeError('Notes must be an array.');
  return notes.map((note, index) => {
    if (!note || typeof note !== 'object') throw new TypeError(`Note ${index} must be an object.`);
    const pitch = finiteNumber(note.pitch, `Note ${index} pitch`, 0, 127, true);
    const start = finiteNumber(note.start, `Note ${index} start`, 0);
    const duration = finiteNumber(note.duration, `Note ${index} duration`, Number.MIN_VALUE);
    const velocity = finiteNumber(note.velocity ?? 90, `Note ${index} velocity`, 1, 127, true);
    if (!Number.isFinite(start + duration)) throw new RangeError(`Note ${index} end time is too large.`);
    if (note.hand !== 'left' && note.hand !== 'right') throw new TypeError(`Note ${index} hand must be "left" or "right".`);
    return { pitch, start, duration, velocity, hand: note.hand };
  }).sort((a, b) => a.start - b.start || a.pitch - b.pitch || a.hand.localeCompare(b.hand));
}

function variableLength(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_VLQ) {
    throw new RangeError('MIDI event gaps must fit the four-byte Standard MIDI File delta-time limit.');
  }
  const bytes = [value % 128];
  while (value >= 128) {
    value = Math.floor(value / 128);
    bytes.unshift((value % 128) | 0x80);
  }
  return bytes;
}

function be32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('MIDI track is too large.');
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function append(target, bytes) {
  // Avoid spread/call argument limits for large songs or metadata strings.
  for (const byte of bytes) target.push(byte);
}

function textMeta(type, text) {
  const bytes = encoder.encode(text);
  return [0xff, type, ...variableLength(bytes.length), ...bytes];
}

function trackChunk(events, endTick) {
  const body = [];
  let previous = 0;
  events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.pitch - b.pitch);
  for (const event of events) {
    append(body, variableLength(event.tick - previous));
    append(body, event.bytes);
    previous = event.tick;
  }
  append(body, variableLength(endTick - previous));
  append(body, [0xff, 0x2f, 0x00]);
  return [0x4d, 0x54, 0x72, 0x6b, ...be32(body.length), ...body];
}

/** Standard MIDI File type 1, with a conductor and two named piano hand tracks. */
export function encodeMidi(inputNotes, { title = 'Fallnote', tempo = 120 } = {}) {
  const notes = validateNotes(inputNotes);
  if (typeof title !== 'string') throw new TypeError('MIDI title must be a string.');
  if (encoder.encode(title).length > 65535) throw new RangeError('MIDI title is too long.');
  finiteNumber(tempo, 'Tempo', Number.MIN_VALUE);
  const microsPerQuarter = Math.round(60000000 / tempo);
  if (!Number.isInteger(microsPerQuarter) || microsPerQuarter < 1 || microsPerQuarter > 0xffffff) {
    throw new RangeError('Tempo is outside the Standard MIDI File tempo range.');
  }
  // Use the encoded, rounded tempo, so changing tempo does not change seconds.
  const ticksPerSecond = PPQ * 1000000 / microsPerQuarter;
  const timed = notes.map((note) => {
    const startTick = Math.round(note.start * ticksPerSecond);
    const endTick = Math.max(startTick + 1, Math.round((note.start + note.duration) * ticksPerSecond));
    if (!Number.isSafeInteger(startTick) || !Number.isSafeInteger(endTick)) throw new RangeError('MIDI note time is too large.');
    return { ...note, startTick, endTick };
  });
  const endTick = timed.reduce((end, note) => Math.max(end, note.endTick), 0);
  const conductor = trackChunk([
    { tick: 0, order: 0, pitch: 0, bytes: textMeta(0x03, title) },
    { tick: 0, order: 1, pitch: 0, bytes: [0xff, 0x51, 3, (microsPerQuarter >>> 16) & 255, (microsPerQuarter >>> 8) & 255, microsPerQuarter & 255] },
  ], endTick);
  const tracks = ['left', 'right'].map((hand, channel) => {
    const events = [
      { tick: 0, order: 0, pitch: 0, bytes: textMeta(0x03, hand === 'left' ? 'Left Hand' : 'Right Hand') },
      { tick: 0, order: 1, pitch: 0, bytes: [0xc0 | channel, 0] },
    ];
    for (const note of timed) {
      if (note.hand !== hand) continue;
      // At the same tick, release the previous note before retriggering it.
      events.push({ tick: note.endTick, order: 2, pitch: note.pitch, bytes: [0x80 | channel, note.pitch, 0] });
      events.push({ tick: note.startTick, order: 3, pitch: note.pitch, bytes: [0x90 | channel, note.pitch, note.velocity] });
    }
    return trackChunk(events, endTick);
  });
  const file = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 3, (PPQ >>> 8) & 255, PPQ & 255];
  append(file, conductor);
  for (const track of tracks) append(file, track);
  return Uint8Array.from(file);
}
