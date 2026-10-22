export function isMidiFilePath(file) {
  return typeof file === 'string' && /^library\/midi\/[A-Za-z0-9_.-]+\.mid$/i.test(file);
}

function downloadTitle(title) {
  const clean = String(title || 'Piano song')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.mid$/i, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 160)
    .trim();
  return clean || 'Piano song';
}

export function handDownloadOptions(song = {}) {
  const files = song.handFiles || {};
  const counts = song.handCounts || {};
  const hands = ['left', 'right'].filter(hand =>
    isMidiFilePath(files[hand]) && Number.isInteger(counts[hand]) && counts[hand] > 0);
  const split = isMidiFilePath(files.both) || hands.length > 0;
  const title = downloadTitle(song.title);
  const options = [];
  const both = isMidiFilePath(files.both) ? files.both : song.file;
  if (isMidiFilePath(both)) {
    options.push({
      hand: 'both', label: split ? 'Both hands' : 'Download MIDI', file: both,
      filename: `${title}${split ? ' - Both hands' : ''}.mid`,
    });
  }
  for (const hand of hands) {
    const label = hand === 'left' ? 'Left hand' : 'Right hand';
    options.push({ hand, label, file: files[hand], filename: `${title} - ${label}.mid` });
  }
  return options;
}
