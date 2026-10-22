import test from 'node:test';
import assert from 'node:assert/strict';
import { handDownloadOptions, isMidiFilePath } from '../docs/hand-downloads.mjs';

const song = {
  title: 'Piano song', file: 'library/midi/song.mid',
  handFiles: {
    both: 'library/midi/song-hands.mid',
    left: 'library/midi/song-left.mid',
    right: 'library/midi/song-right.mid',
  },
  handCounts: { left: 25, right: 40 },
};

test('hand downloads prefer the compatible combined export and name each hand', () => {
  const before = structuredClone(song);
  assert.deepEqual(handDownloadOptions(song), [
    { hand: 'both', label: 'Both hands', file: song.handFiles.both, filename: 'Piano song - Both hands.mid' },
    { hand: 'left', label: 'Left hand', file: song.handFiles.left, filename: 'Piano song - Left hand.mid' },
    { hand: 'right', label: 'Right hand', file: song.handFiles.right, filename: 'Piano song - Right hand.mid' },
  ]);
  assert.deepEqual(song, before);
});

test('empty or unknown hand counts never advertise an empty hand download', () => {
  for (const count of [0, -1, undefined, NaN, '25', 1.5]) {
    const options = handDownloadOptions({ ...song, handCounts: { left: count, right: 40 } });
    assert.deepEqual(options.map(option => option.hand), ['both', 'right']);
  }
});

test('legacy songs retain their existing master download', () => {
  assert.deepEqual(handDownloadOptions({ title: 'Old song', file: song.file }), [
    { hand: 'both', label: 'Download MIDI', file: song.file, filename: 'Old song.mid' },
  ]);
});

test('invalid variants are omitted and the original master remains a safe fallback', () => {
  const options = handDownloadOptions({
    ...song, handFiles: { both: '../song.mid', left: 'https://example.com/song.mid', right: song.handFiles.right },
  });
  assert.deepEqual(options.map(option => option.file), [song.file, song.handFiles.right]);
  assert.equal(options[0].label, 'Both hands');
  assert.deepEqual(handDownloadOptions({ file: 'https://example.com/song.mid' }), []);
});

test('only local library MIDI paths are accepted', () => {
  for (const file of [undefined, null, '', '../song.mid', '/library/midi/song.mid', 'library/midi/../song.mid',
    'library/midi/song.mid?download=1', 'library/midi/song.mid#x', 'library/midi/song%2f.mid',
    'library\\midi\\song.mid', 'https://example.com/song.mid', 'javascript:alert(1)']) {
    assert.equal(isMidiFilePath(file), false, String(file));
  }
  assert.equal(isMidiFilePath('library/midi/my-song_2.1.mid'), true);
});

test('download names preserve readable Unicode and replace filename separators', () => {
  const options = handDownloadOptions({ ...song, title: '  夜の歌: Piano / "Live"\\Take?  ' });
  assert.equal(options[1].filename, '夜の歌 Piano Live Take - Left hand.mid');
  assert.equal(handDownloadOptions({ ...song, title: '../' })[0].filename, 'Piano song - Both hands.mid');
  assert.equal(handDownloadOptions({ ...song, title: 'Song.mid' })[0].filename, 'Song - Both hands.mid');
});
