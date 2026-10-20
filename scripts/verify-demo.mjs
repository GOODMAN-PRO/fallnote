import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { makeDemo, findVideo, convertVideo, DEMO_NOTES } from '../lib/video.mjs';
import { encodeMidi } from '../lib/midi.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mediaDir = join(root, '.local', 'verification');
await mkdir(mediaDir, { recursive: true });
const demo = await makeDemo(mediaDir);
const video = await findVideo(mediaDir, demo.sourceId);
const notes = await convertVideo(video, demo.calibration, {
  fps: 30, saturation: 0.3, minNote: 0.08, handMode: 'color', leftHue: 200, rightHue: 120, trim: true
}, { progress() {}, signal: new AbortController().signal });
const expected = DEMO_NOTES.map(note => ({ ...note, start: note.start - 0.5 }));
assert.equal(notes.length, expected.length, `Expected ${expected.length} notes; got ${notes.length}. ${JSON.stringify(notes)}`);
const key = note => `${note.pitch}:${Math.round(note.start * 10)}`;
for (const reference of expected) {
  const actual = notes.find(note => key(note) === key(reference));
  assert.ok(actual, `Missing pitch ${reference.pitch} at ${reference.start}s`);
  assert.equal(actual.hand, reference.hand);
  assert.ok(Math.abs(actual.start - reference.start) <= 0.055, `Onset error for ${reference.pitch}: ${actual.start}`);
  assert.ok(Math.abs(actual.duration - reference.duration) <= 0.075, `Duration error for ${reference.pitch}: ${actual.duration}`);
}
const midi = encodeMidi(notes, { title: 'Fallnote calibration exercise' });
assert.equal(Buffer.from(midi).subarray(0, 4).toString(), 'MThd');
await writeFile(join(mediaDir, 'verified-exercise.mid'), midi);
await writeFile(join(mediaDir, 'verification.json'), JSON.stringify({ expectedNotes: expected.length, detectedNotes: notes.length, notes, midiBytes: midi.length }, null, 2));
console.log(`PASS: H.264 video -> RGB frames -> ${notes.length} matching notes -> ${midi.length}-byte Type 1 MIDI.`);
console.log('Verified chords, black keys, both hands, held notes and same-pitch repetitions.');
