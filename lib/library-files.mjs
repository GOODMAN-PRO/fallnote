const midiPath = /^library\/midi\/[A-Za-z0-9_.-]+\.mid$/;

/** All public downloads belonging to one song, including optional hand exports. */
export function songFiles(song) {
  const invalid = () => { throw new Error('The library index contains an invalid MIDI file path.'); };
  if (!song || typeof song.file !== 'string' || !midiPath.test(song.file)) invalid();
  const files = [song.file];
  if (song.handFiles !== undefined) {
    if (!song.handFiles || typeof song.handFiles !== 'object' || Array.isArray(song.handFiles) ||
        typeof song.handFiles.both !== 'string' || Object.keys(song.handFiles).some(key => !['both', 'left', 'right'].includes(key))) invalid();
    for (const file of Object.values(song.handFiles)) {
      if (typeof file !== 'string' || !midiPath.test(file)) invalid();
      files.push(file);
    }
  }
  return [...new Set(files)];
}
