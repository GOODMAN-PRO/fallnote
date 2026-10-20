const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  local: false, ready: false, busy: false, source: null, songs: [], job: null,
  result: null, overlay: true, audio: null, audioToken: 0, editing: null,
};
const presets = { 88: [21, 108], 61: [36, 96], 76: [28, 103] };
const defaults = { left: .04, right: .96, line: .76, firstMidi: 21, lastMidi: 108 };
const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const video = $('#source-video');
const overlay = $('#calibration-overlay');
const iconPaths = {
  play: '<path d="m9 5 11 7-11 7V5Z" fill="currentColor"/>',
  pause: '<path d="M8 5h3v14H8zm6 0h3v14h-3z" fill="currentColor"/>',
  music: '<path d="M9 18V5l11-2v13M9 9l11-2" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><ellipse cx="6" cy="18" rx="3" ry="2" fill="currentColor"/><ellipse cx="17" cy="16" rx="3" ry="2" fill="currentColor"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  muted: '<path d="M11 5 6 9H3v6h3l5 4V5Zm5 4 6 6m0-6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = iconPaths[name] || '';
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function button(text, className, action) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function formatTime(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function noteName(pitch) { return `${noteNames[pitch % 12]}${Math.floor(pitch / 12) - 1}`; }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function showNotice(message, error = false) {
  $('#notice-text').textContent = message;
  $('#notice').classList.toggle('error', error);
  $('#notice').hidden = false;
}

function apiUrl(path) { return new URL(path.replace(/^\/+/, ''), document.baseURI); }
async function request(path, options = {}) {
  const { raw, ...rest } = options;
  const response = await fetch(apiUrl(path), {
    ...rest,
    headers: raw ? rest.headers : { 'Content-Type': 'application/json', ...rest.headers },
  });
  const type = response.headers.get('content-type') || '';
  let body;
  if (type.includes('application/json')) body = await response.json();
  else if (!response.ok) throw new Error(`Request failed (${response.status}). Open Fallnote through the local app to convert videos.`);
  else throw new Error('The local app returned an unexpected response. Restart it and try again.');
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function midiUrl(file) {
  if (typeof file !== 'string' || !/^library\/midi\/[A-Za-z0-9_.-]+\.mid$/i.test(file)) {
    throw new Error('This song has an invalid MIDI file path.');
  }
  return new URL(file, document.baseURI).href;
}

function updateAvailability() {
  $$('[data-local]').forEach(node => { node.disabled = !state.local || (state.busy && node.hasAttribute('data-idle')); });
  $('#calibration-fields').disabled = !state.local || !state.source || state.busy;
  $('#step-status').textContent = state.busy ? 'Working on your video…' : state.source ? 'Align the keyboard, then convert' : 'Import a video first';
  $$('.song-edit button, .song-edit input').forEach(node => { node.disabled = state.busy; });
}

function showView(view) {
  const library = view === 'library';
  $('#convert-view').hidden = library;
  $('#library-view').hidden = !library;
  $('#convert-tab').classList.toggle('active', !library);
  $('#library-tab').classList.toggle('active', library);
  $('#convert-tab').toggleAttribute('aria-current', !library);
  $('#library-tab').toggleAttribute('aria-current', library);
  if (!library) $('#convert-tab').setAttribute('aria-current', 'page');
  if (library) $('#library-tab').setAttribute('aria-current', 'page');
  if (!library) requestAnimationFrame(drawOverlay);
  if (!library && state.result) requestAnimationFrame(drawNotes);
}

function calibration() {
  return {
    left: Number($('#left-margin').value) / 100,
    right: Number($('#right-margin').value) / 100,
    line: Number($('#scan-line').value) / 100,
    firstMidi: Number($('#first-midi').value),
    lastMidi: Number($('#last-midi').value),
  };
}

function applyCalibration(value) {
  const config = { ...defaults, ...value };
  $('#left-margin').value = config.left * 100;
  $('#right-margin').value = config.right * 100;
  $('#scan-line').value = config.line * 100;
  $('#first-midi').value = config.firstMidi;
  $('#last-midi').value = config.lastMidi;
  $('#keyboard-preset').value = Object.entries(presets).find(([, range]) => range[0] === config.firstMidi && range[1] === config.lastMidi)?.[0] || 'custom';
  $('#custom-range').hidden = $('#keyboard-preset').value !== 'custom';
  updateGuides();
}

function updateGuides(event) {
  if (Number($('#right-margin').value) - Number($('#left-margin').value) < 5) {
    if (event?.target.id === 'left-margin') $('#left-margin').value = Number($('#right-margin').value) - 5;
    else $('#right-margin').value = Number($('#left-margin').value) + 5;
  }
  $('#left-value').value = `${Number($('#left-margin').value).toFixed(1).replace('.0', '')}%`;
  $('#right-value').value = `${Number($('#right-margin').value).toFixed(1).replace('.0', '')}%`;
  $('#line-value').value = `${Number($('#scan-line').value).toFixed(1).replace('.0', '')}%`;
  $('#saturation-value').value = `${$('#saturation').value}%`;
  $('#brightness-value').value = `${$('#brightness').value}%`;
  drawOverlay();
}

function keyboardLanes(config) {
  const whites = [0, 2, 4, 5, 7, 9, 11], keys = [];
  for (let pitch = config.firstMidi; pitch <= config.lastMidi; pitch++) {
    const pc = pitch % 12, whiteIndex = whites.indexOf(pc), black = whiteIndex === -1;
    const withinOctave = black ? whites.findIndex(value => value > pc) : whiteIndex + .5;
    keys.push({ pitch, black, position: Math.floor(pitch / 12) * 7 + withinOctave, size: black ? .62 : 1 });
  }
  if (!keys.length) return [];
  const low = Math.min(...keys.map(key => key.position - key.size / 2));
  const high = Math.max(...keys.map(key => key.position + key.size / 2));
  const scale = (config.right - config.left) / (high - low);
  return keys.map(key => ({ pitch: key.pitch, black: key.black, x: config.left + (key.position - low) * scale, width: key.size * scale }));
}

function sizeCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * scale);
  canvas.height = Math.round(bounds.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  return { ctx, width: bounds.width, height: bounds.height };
}

function drawOverlay() {
  if (!state.source || !state.overlay) return;
  const surface = sizeCanvas(overlay);
  if (!surface) return;
  const { ctx, width, height } = surface;
  const config = calibration();
  const left = width * config.left, right = width * config.right, line = height * config.line;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(13, 16, 23, 0.42)';
  ctx.fillRect(0, 0, left, height);
  ctx.fillRect(right, 0, width - right, height);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#c5b7ff';
  ctx.setLineDash([5, 5]);
  for (const x of [left, right]) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#72e3b6';
  ctx.lineWidth = 1.7;
  ctx.beginPath(); ctx.moveTo(left, line); ctx.lineTo(right, line); ctx.stroke();
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  for (const lane of keyboardLanes(config)) {
    const x = lane.x * width;
    ctx.fillStyle = lane.black ? '#baa7ff' : '#ffffff';
    ctx.fillRect(x - .6, line - (lane.black ? 7 : 4), 1.2, lane.black ? 14 : 8);
    if (lane.pitch % 12 === 0) {
      ctx.fillStyle = 'rgba(13,16,23,.8)';
      ctx.fillRect(x - 13, line + 13, 26, 16);
      ctx.fillStyle = '#f1f0f6';
      ctx.fillText(noteName(lane.pitch), x, line + 24);
    }
  }
  ctx.fillStyle = '#72e3b6';
  ctx.fillRect(clamp(left + 6, 4, width - 76), Math.max(2, line - 24), 65, 18);
  ctx.fillStyle = '#13291f';
  ctx.textAlign = 'left';
  ctx.fillText('SCAN LINE', clamp(left + 12, 10, width - 70), Math.max(14, line - 11));
  for (const x of [left, right]) {
    ctx.beginPath(); ctx.arc(x, line, 4, 0, Math.PI * 2); ctx.fillStyle = '#c5b7ff'; ctx.fill();
  }
}

function setSource(source) {
  if (!source || !source.sourceId || !source.url) throw new Error('The import did not return a usable video.');
  const media = new URL(source.url, document.baseURI);
  if (media.origin !== location.origin) throw new Error('The imported video must be served by the local app.');
  video.pause();
  state.source = source;
  state.result = null;
  $('#result-section').hidden = true;
  video.src = media.href;
  video.hidden = false;
  $('#video-empty').hidden = true;
  overlay.hidden = !state.overlay;
  $('#video-frame').style.aspectRatio = `${source.width || 16} / ${source.height || 9}`;
  $('#video-name').textContent = source.name || 'Imported tutorial';
  $('.video-shell').classList.add('loaded');
  $('#song-title').value = (source.name || 'Untitled piano tutorial').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 180);
  $('#song-artist').value = '';
  $('#video-duration').textContent = formatTime(source.duration);
  $('#video-seek').max = Math.max(1, source.duration || 1);
  $('#video-seek').value = 0;
  $('#video-time').textContent = '0:00';
  ['#video-play', '#video-seek', '#video-mute', '#overlay-toggle'].forEach(selector => { $(selector).disabled = false; });
  applyCalibration(source.calibration || defaults);
  $('#hand-mode').value = source.options?.handMode || 'pitch';
  $('#left-hue').value = source.options?.leftHue ?? 200;
  $('#right-hue').value = source.options?.rightHue ?? 120;
  $('#start-time').value = source.options?.startTime ?? 0;
  $('#end-time').value = source.options?.endTime ?? Math.floor((source.duration || 1) * 10) / 10;
  $('#start-time').max = source.duration || 1;
  $('#end-time').max = source.duration || 1;
  $('#saturation').value = (source.options?.saturation ?? .3) * 100;
  $('#brightness').value = (source.options?.brightness ?? .25) * 100;
  $('#detection-fps').value = source.options?.fps ?? 30;
  $('#minimum-note').value = source.options?.minNote ?? .08;
  $('#split-midi').value = source.options?.splitMidi ?? 60;
  $('#trim-silence').checked = source.options?.trim ?? true;
  updateGuides();
  updateHandSettings();
  updateAvailability();
  showNotice('Video imported. Seek to some notes and align the keyboard guides before converting.');
  showView('convert');
}

function updateHandSettings() {
  const color = $('#hand-mode').value === 'color';
  $('#color-settings').hidden = !color;
  $('#pitch-settings').hidden = color;
}

function beginBusy(title) {
  state.busy = true;
  state.job = null;
  $('#job-title').textContent = title;
  $('#job-message').textContent = 'Preparing…';
  $('#job-progress').removeAttribute('value');
  $('#job-percent').textContent = '';
  $('#cancel-job').disabled = true;
  $('#cancel-job').textContent = 'Cancel';
  $('#job-panel').hidden = false;
  $('#notice').hidden = true;
  updateAvailability();
}

function endBusy() {
  state.busy = false;
  state.job = null;
  $('#job-panel').hidden = true;
  updateAvailability();
}

async function runJob(path, body, title, completed) {
  if (state.busy || !state.local) return;
  beginBusy(title);
  try {
    const created = await request(path, { method: 'POST', body: JSON.stringify(body) });
    if (!created.jobId) throw new Error('The app did not return a task ID.');
    state.job = created.jobId;
    $('#cancel-job').disabled = false;
    for (;;) {
      const job = await request(`api/jobs/${encodeURIComponent(created.jobId)}`);
      const progress = clamp(Number(job.progress) || 0, 0, 1);
      $('#job-progress').value = progress;
      $('#job-percent').textContent = `${Math.round(progress * 100)}%`;
      $('#job-message').textContent = job.message || 'Processing…';
      if (job.status === 'completed') { await completed(job.result); break; }
      if (job.status === 'failed') throw new Error(job.error || job.message || 'The task could not be completed.');
      if (job.status === 'cancelled') { showNotice('Task cancelled. You can adjust your settings and try again.'); break; }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  } catch (error) {
    showNotice(error.message || 'Something went wrong. Please try again.', true);
  } finally { endBusy(); }
}

async function loadLibrary() {
  try {
    const response = await fetch(apiUrl(`library/manifest.json?t=${Date.now()}`), { cache: 'no-store' });
    if (!response.ok) throw new Error('The song library could not be loaded. Refresh the page to try again.');
    const manifest = await response.json();
    if (!Array.isArray(manifest.songs)) throw new Error('The library index is invalid.');
    state.songs = manifest.songs.filter(song => song && typeof song.id === 'string' && typeof song.title === 'string')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    $('#library-count').textContent = state.songs.length;
    renderLibrary();
  } catch (error) {
    showNotice(error.message, true);
    $('#song-count').textContent = 'Library unavailable';
    $('#library-loading').hidden = true;
    $('#library-list').replaceChildren();
    $('#library-empty').hidden = false;
    $('#empty-title').textContent = 'The library could not be loaded';
    $('#empty-copy').textContent = 'Check your connection and refresh the page to try again.';
    $('#empty-action').hidden = true;
  }
}

function renderLibrary() {
  const query = $('#library-search').value.trim().toLocaleLowerCase();
  const reviewedOnly = $('#reviewed-filter').checked;
  const songs = state.songs.filter(song =>
    (!reviewedOnly || song.reviewed) &&
    `${song.title} ${song.artist || ''}`.toLocaleLowerCase().includes(query));
  $('#library-loading').hidden = true;
  const list = $('#library-list');
  list.replaceChildren();
  $('#song-count').textContent = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}${songs.length !== state.songs.length ? ` of ${state.songs.length}` : ''}`;
  $('#library-empty').hidden = songs.length > 0;
  if (!songs.length) {
    const filtered = query || reviewedOnly;
    $('#empty-title').textContent = filtered ? 'No songs match this search' : 'A place for your next favourite song';
    $('#empty-copy').textContent = filtered ? 'Try another title or artist, or turn off the reviewed filter.' : state.local ? 'Convert your first tutorial and it will appear here, with a MIDI ready to download.' : 'No songs have been published yet. Add a tutorial in the local app, then publish your library.';
    $('#empty-action').hidden = Boolean(filtered);
    $('#empty-action').textContent = state.local ? 'Convert a tutorial →' : 'Set up the local app ↗';
  }
  for (const song of songs) {
    const row = el('article', 'song-row');
    const mark = el('div', 'song-icon'); mark.append(icon('music'));
    const main = el('div', 'song-main');
    const heading = el('div', 'song-heading');
    heading.append(el('h2', '', song.title));
    if (song.reviewed) heading.append(el('span', 'tag reviewed', 'Reviewed'));
    main.append(heading, el('p', 'song-artist', song.artist || 'Artist not set'));
    const meta = el('div', 'song-meta');
    const count = Number(song.noteCount);
    meta.append(el('span', '', `${Number.isFinite(count) ? count.toLocaleString() : '—'} notes`), el('span', '', '·'), el('span', '', song.handMode === 'color' ? 'Colour-based hands' : 'Pitch-based hands'));
    if (!song.reviewed) meta.append(el('span', '', '·'), el('span', '', 'Needs a listen'));
    main.append(meta);
    const actions = el('div', 'song-actions');
    actions.append(el('span', 'song-duration numeric', formatTime(song.duration)));
    const listen = button('Listen', 'button small secondary', () => playSong(song));
    listen.setAttribute('aria-label', `Listen to ${song.title}`);
    actions.append(listen);
    const download = el('a', 'button small secondary', 'Download ↓');
    try { download.href = midiUrl(song.file); download.download = `${song.title}.mid`; }
    catch { download.removeAttribute('href'); download.textContent = 'File unavailable'; }
    download.setAttribute('aria-label', `Download ${song.title} as MIDI`);
    actions.append(download);
    if (state.local) {
      const edit = button('', 'icon-button', () => { state.editing = state.editing === song.id ? null : song.id; renderLibrary(); if (state.editing) $(`#edit-title-${CSS.escape(song.id)}`)?.focus(); });
      edit.append(icon('edit'));
      edit.setAttribute('aria-label', `Edit ${song.title}`);
      edit.setAttribute('aria-expanded', String(state.editing === song.id));
      actions.append(edit);
    }
    row.append(mark, main, actions);
    list.append(row);
    if (state.local && state.editing === song.id) list.append(editForm(song));
  }
  updateAvailability();
}

function editForm(song) {
  const form = el('form', 'song-edit');
  const title = el('input'); title.type = 'text'; title.value = song.title; title.required = true; title.maxLength = 180; title.id = `edit-title-${song.id}`;
  const artist = el('input'); artist.type = 'text'; artist.value = song.artist || ''; artist.maxLength = 180; artist.id = `edit-artist-${song.id}`;
  for (const [text, input] of [['Song title', title], ['Artist', artist]]) {
    const wrap = el('div'), label = el('label', 'field-label', text); label.htmlFor = input.id; wrap.append(label, input); form.append(wrap);
  }
  const footer = el('div', 'edit-footer');
  const reviewed = el('input'); reviewed.type = 'checkbox'; reviewed.checked = Boolean(song.reviewed);
  const check = el('label', 'checkbox-label'); check.append(reviewed, document.createTextNode('I listened and reviewed this MIDI'));
  const save = el('button', 'button small primary', 'Save changes'); save.type = 'submit';
  const cancel = button('Cancel', 'button small secondary', () => { state.editing = null; renderLibrary(); });
  const remove = button('Delete song', 'text-button delete-button', () => { confirmation.hidden = false; remove.hidden = true; });
  footer.append(check, save, cancel, remove);
  const confirmation = el('div', 'delete-confirm'); confirmation.hidden = true;
  confirmation.append(el('span', '', 'Delete this MIDI from the local library? Publish again to remove it from the website.'));
  confirmation.append(button('Keep song', 'button small secondary', () => { confirmation.hidden = true; remove.hidden = false; }));
  confirmation.append(button('Delete song', 'button small secondary', async () => {
    if (state.busy) return;
    state.busy = true; updateAvailability();
    try {
      await request(`api/library/${encodeURIComponent(song.id)}`, { method: 'DELETE' });
      state.editing = null;
      if (state.result?.song.id === song.id) { state.result = null; $('#result-section').hidden = true; }
      stopAudio();
      await loadLibrary(); showNotice('Song removed from your local library. Publish to update the website.');
    } catch (error) { showNotice(error.message, true); }
    finally { state.busy = false; updateAvailability(); }
  }));
  form.append(footer, confirmation);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy) return;
    if (!title.value.trim()) { title.focus(); return; }
    state.busy = true; updateAvailability();
    try {
      await request(`api/library/${encodeURIComponent(song.id)}`, { method: 'PATCH', body: JSON.stringify({ title: title.value.trim(), artist: artist.value.trim(), reviewed: reviewed.checked }) });
      state.editing = null; await loadLibrary();
      showNotice('Song details saved locally. Publish your library to update the website.');
    } catch (error) { showNotice(error.message, true); }
    finally { state.busy = false; updateAvailability(); }
  });
  return form;
}

function showResult(result) {
  if (!result?.song || !Array.isArray(result.notes)) throw new Error('The conversion did not return a MIDI result.');
  state.result = result;
  $('#result-title').textContent = result.song.title;
  $('#result-description').textContent = `${result.notes.length.toLocaleString()} notes · ${formatTime(result.song.duration)} · Saved to your local library`;
  $('#download-result').href = midiUrl(result.song.file);
  $('#download-result').download = `${result.song.title}.mid`;
  $('#result-section').hidden = false;
  requestAnimationFrame(drawNotes);
  showNotice('MIDI saved. Listen to the result, then download it or publish it to your library.');
  $('#result-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
}

function drawNotes() {
  if (!state.result) return;
  const surface = sizeCanvas($('#notes-preview'));
  if (!surface) return;
  const { ctx, width, height } = surface;
  const notes = state.result.notes;
  ctx.clearRect(0, 0, width, height);
  if (!notes.length) {
    ctx.fillStyle = '#666078'; ctx.font = '12px "Segoe UI", sans-serif'; ctx.fillText('No notes detected. Adjust the keyboard edges and scan line.', 20, height / 2);
    return;
  }
  const lo = notes.reduce((minimum, note) => Math.min(minimum, note.pitch), 127);
  const hi = notes.reduce((maximum, note) => Math.max(maximum, note.pitch), 0);
  const end = notes.reduce((maximum, note) => Math.max(maximum, note.start + note.duration), 1);
  const left = 39, top = 18, chartWidth = width - left - 16, chartHeight = height - top - 29;
  ctx.font = '9px "Segoe UI", sans-serif';
  for (let pitch = Math.floor(lo / 12) * 12; pitch <= hi; pitch += 12) {
    const y = top + (hi - pitch) / Math.max(12, hi - lo) * chartHeight;
    if (y > height - 25) continue;
    ctx.strokeStyle = '#e4e2eb'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - 16, y); ctx.stroke();
    ctx.fillStyle = '#686176'; ctx.fillText(noteName(pitch), 10, y + 3);
  }
  for (const note of notes) {
    const x = left + note.start / end * chartWidth;
    const y = top + (hi - note.pitch) / Math.max(12, hi - lo) * chartHeight;
    ctx.fillStyle = note.hand === 'left' ? '#7771b4' : '#367b6a';
    ctx.fillRect(x, y - 1.5, Math.max(1.5, note.duration / end * chartWidth), 3);
  }
  ctx.fillStyle = '#686176';
  ctx.fillText('0:00', left, height - 9);
  ctx.textAlign = 'right'; ctx.fillText(formatTime(end), width - 16, height - 9); ctx.textAlign = 'left';
}

// A small standard MIDI reader keeps previews available on the static GitHub page.
function readMidi(buffer) {
  const bytes = new Uint8Array(buffer), data = new DataView(buffer);
  const text = position => String.fromCharCode(...bytes.slice(position, position + 4));
  if (bytes.length < 14 || text(0) !== 'MThd') throw new Error('This file is not a standard MIDI file.');
  const headerLength = data.getUint32(4), division = data.getUint16(12);
  if (division & 0x8000 || division === 0) throw new Error('This MIDI timing format is not supported by the browser preview.');
  const events = [], tempos = [{ tick: 0, value: 500000 }];
  let cursor = 8 + headerLength;
  let track = 0;
  while (cursor + 8 <= bytes.length) {
    const kind = text(cursor), length = data.getUint32(cursor + 4), end = cursor + 8 + length;
    cursor += 8;
    if (end > bytes.length) throw new Error('The MIDI file is incomplete.');
    if (kind !== 'MTrk') { cursor = end; continue; }
    let tick = 0, running = 0;
    const variable = () => {
      let result = 0;
      for (let i = 0; i < 4; i++) {
        if (cursor >= end) throw new Error('The MIDI file is incomplete.');
        const byte = bytes[cursor++]; result = (result << 7) | (byte & 127);
        if (!(byte & 128)) return result;
      }
      throw new Error('The MIDI file contains an invalid event.');
    };
    while (cursor < end) {
      tick += variable();
      let status = bytes[cursor];
      if (status & 128) { cursor++; if (status < 0xf0) running = status; }
      else { status = running; if (!status) throw new Error('The MIDI file contains an invalid running status.'); }
      if (status === 0xff) {
        const type = bytes[cursor++], count = variable();
        if (type === 0x51 && count === 3 && cursor + 3 <= end) tempos.push({ tick, value: bytes[cursor] * 65536 + bytes[cursor + 1] * 256 + bytes[cursor + 2] });
        cursor += count;
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) { const count = variable(); cursor += count; running = 0; }
      else if (status >= 0xf0) throw new Error('The MIDI file contains an unsupported event.');
      else {
        const type = status >> 4, channel = status & 15;
        const first = bytes[cursor++], second = (type === 0xc || type === 0xd) ? 0 : bytes[cursor++];
        if (type === 0x9 || type === 0x8) events.push({ tick, pitch: first, velocity: second, on: type === 0x9 && second > 0, track, channel });
      }
      if (cursor > end) throw new Error('The MIDI file is incomplete.');
    }
    cursor = end; track++;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const segments = [];
  let lastTick = 0, seconds = 0, tempo = 500000;
  for (const change of tempos) {
    seconds += (change.tick - lastTick) * tempo / division / 1000000;
    segments.push({ tick: change.tick, seconds, tempo: change.value });
    lastTick = change.tick; tempo = change.value;
  }
  const timeAt = tick => {
    let lower = 0, upper = segments.length - 1;
    while (lower < upper) {
      const mid = Math.ceil((lower + upper) / 2);
      if (segments[mid].tick <= tick) lower = mid; else upper = mid - 1;
    }
    const part = segments[lower];
    return part.seconds + (tick - part.tick) * part.tempo / division / 1000000;
  };
  events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on));
  const active = new Map(), notes = [];
  for (const event of events) {
    const key = `${event.track}:${event.channel}:${event.pitch}`;
    if (event.on) {
      if (!active.has(key)) active.set(key, []);
      active.get(key).push(event);
    } else {
      const start = active.get(key)?.shift();
      if (start) {
        const begins = timeAt(start.tick), duration = timeAt(event.tick) - begins;
        if (duration > 0 && event.pitch <= 127) notes.push({ pitch: event.pitch, start: begins, duration, velocity: start.velocity, hand: event.track === 1 ? 'left' : 'right' });
      }
    }
  }
  return notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

async function playSong(song) {
  const token = ++state.audioToken;
  stopAudio(false);
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('Your browser does not support audio previews. Download the MIDI to listen in your piano app.');
    const context = new Audio();
    state.audio = { context, timer: null };
    await context.resume();
    const response = await fetch(midiUrl(song.file));
    if (!response.ok) throw new Error('This MIDI file could not be downloaded.');
    const notes = readMidi(await response.arrayBuffer());
    if (token !== state.audioToken) { await context.close(); return; }
    startAudio(notes, song.title, context, token);
  } catch (error) {
    if (token === state.audioToken) { stopAudio(); showNotice(error.message, true); }
  }
}

async function playResult() {
  if (!state.result) return;
  const token = ++state.audioToken;
  stopAudio(false);
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('Your browser does not support audio previews. Download the MIDI to listen in your piano app.');
    const context = new Audio();
    state.audio = { context, timer: null };
    await context.resume();
    if (token !== state.audioToken) { await context.close(); return; }
    startAudio(state.result.notes, state.result.song.title, context, token);
  } catch (error) { if (token === state.audioToken) { stopAudio(); showNotice(error.message, true); } }
}

function startAudio(rawNotes, title, context, token) {
  const notes = rawNotes.filter(note => Number.isFinite(note.start) && Number.isFinite(note.duration) && note.duration > 0 && note.pitch >= 0 && note.pitch <= 127).sort((a, b) => a.start - b.start);
  if (!notes.length) throw new Error('There are no notes to preview. Try a new scan line and convert again.');
  video.pause();
  const master = context.createGain(); master.gain.value = .24; master.connect(context.destination);
  const compressor = context.createDynamicsCompressor(); compressor.connect(master);
  const origin = context.currentTime + .08;
  const end = notes.reduce((maximum, note) => Math.max(maximum, note.start + note.duration), 0);
  let index = 0;
  const schedule = () => {
    if (token !== state.audioToken) return;
    const elapsed = context.currentTime - origin;
    while (index < notes.length && notes[index].start < elapsed + .7) {
      const note = notes[index++], start = origin + note.start, duration = Math.max(.025, note.duration);
      if (start + duration < context.currentTime) continue;
      const osc = context.createOscillator(), gain = context.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
      const level = clamp((note.velocity || 90) / 127, .1, 1) * .28;
      const on = Math.max(context.currentTime, start);
      gain.gain.setValueAtTime(0, on);
      gain.gain.linearRampToValueAtTime(level, on + .006);
      gain.gain.exponentialRampToValueAtTime(Math.max(.001, level * .45), on + Math.max(.025, duration * .7));
      gain.gain.linearRampToValueAtTime(0, on + duration + .06);
      osc.connect(gain); gain.connect(compressor); osc.start(on); osc.stop(on + duration + .07);
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
    $('#audio-time').textContent = `${formatTime(elapsed)} / ${formatTime(end)}`;
    if (elapsed > end + .2) stopAudio();
  };
  $('#audio-title').textContent = title;
  $('#audio-player').hidden = false;
  document.body.classList.add('audio-active');
  const timer = setInterval(schedule, 80);
  state.audio = { context, timer };
  schedule();
}

function stopAudio(increment = true) {
  if (increment) state.audioToken++;
  if (state.audio) {
    clearInterval(state.audio.timer);
    if (state.audio.context.state !== 'closed') state.audio.context.close().catch(() => {});
  }
  state.audio = null;
  $('#audio-player').hidden = true;
  document.body.classList.remove('audio-active');
}

async function init() {
  $('#use-zen-session').checked = false;
  for (const selector of ['#first-midi', '#last-midi', '#split-midi']) {
    for (let pitch = 0; pitch <= 127; pitch++) {
      const option = el('option', '', `${noteName(pitch)} · ${pitch}`);
      option.value = pitch; $(selector).append(option);
    }
  }
  $('#split-midi').value = 60;
  applyCalibration(defaults);
  updateAvailability();
  try {
    const response = await fetch(apiUrl('api/status'), { signal: AbortSignal.timeout(3500), cache: 'no-store' });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const status = await response.json();
      state.local = status.local === true;
      if (state.local) {
        const missing = ['ffmpeg', 'ffprobe', 'ytdlp'].filter(name => !status.dependencies?.[name]);
        if (missing.length) {
          $('#dependencies').hidden = false;
          $('#dependencies').textContent = `Finish local setup: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Follow the setup instructions in the GitHub repository, then restart Fallnote.`;
        }
        if (status.publishedUrl) {
          const url = new URL(status.publishedUrl);
          if (url.protocol === 'https:') $('#published-link').href = url.href;
        }
      }
    }
  } catch { /* GitHub Pages has no local conversion API. */ }
  state.ready = true;
  $('#connection').textContent = state.local ? 'Local workspace' : 'Published library';
  $('#connection').classList.toggle('local', state.local);
  $('#library-mode').textContent = state.local ? 'Local' : 'Published';
  $('#publish-button').hidden = !state.local;
  $('#publish-explainer').hidden = !state.local;
  $('#public-explainer').hidden = state.local;
  $('#static-guide').hidden = state.local;
  if (!state.local) {
    $('.workspace').hidden = true;
    $('.format-note').hidden = true;
  }
  updateAvailability();
  showView(state.local ? 'convert' : 'library');
  await loadLibrary();
  const sourceId = new URL(location.href).searchParams.get('source');
  if (state.local && sourceId) {
    try { setSource(await request(`api/videos/${encodeURIComponent(sourceId)}`)); }
    catch (error) { showNotice(`Could not reopen this tutorial: ${error.message}`, true); }
  }
}

$('#convert-tab').addEventListener('click', () => showView('convert'));
$('#library-tab').addEventListener('click', () => showView('library'));
$('#open-library').addEventListener('click', () => showView('library'));
$('#show-setup').addEventListener('click', () => showView('convert'));
$('#empty-action').addEventListener('click', () => showView('convert'));
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; });
$('#youtube-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = $('#youtube-url').value.trim();
  if (!url || state.busy) return;
  const useZenSession = $('#use-zen-session').checked;
  $('#use-zen-session').checked = false;
  runJob('api/youtube', { url, ...(useZenSession ? { useZenSession: true } : {}) }, 'Importing your YouTube tutorial', setSource);
});
$('#upload-button').addEventListener('click', () => $('#video-file').click());
$('#video-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || state.busy || !state.local) return;
  beginBusy('Uploading your tutorial');
  $('#job-message').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  try {
    const source = await request('api/videos', {
      method: 'POST', raw: true, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file,
    });
    setSource(source);
  } catch (error) { showNotice(error.message, true); }
  finally { endBusy(); event.target.value = ''; }
});
$('#demo-button').addEventListener('click', async () => {
  if (state.busy || !state.local) return;
  beginBusy('Preparing the calibration demo');
  try { setSource(await request('api/demo', { method: 'POST', body: '{}' })); }
  catch (error) { showNotice(error.message, true); }
  finally { endBusy(); }
});
$('#cancel-job').addEventListener('click', async () => {
  if (!state.job) return;
  $('#cancel-job').disabled = true;
  $('#cancel-job').textContent = 'Cancelling…';
  try { await request(`api/jobs/${encodeURIComponent(state.job)}/cancel`, { method: 'POST', body: '{}' }); }
  catch (error) { showNotice(error.message, true); $('#cancel-job').disabled = false; $('#cancel-job').textContent = 'Cancel'; }
});
$('#convert-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!state.source || state.busy) return;
  const config = calibration();
  if (config.firstMidi >= config.lastMidi) { showNotice('The first visible note must be lower than the last visible note.', true); return; }
  const startTime = Number($('#start-time').value), endTime = Number($('#end-time').value);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) { showNotice('Set the clip end after the start time in Detection & hand settings.', true); return; }
  if (endTime > state.source.duration + .05) { showNotice('Set the clip end within the video duration in Detection & hand settings.', true); return; }
  const title = $('#song-title').value.trim();
  if (!title) { $('#song-title').focus(); return; }
  video.pause(); stopAudio();
  runJob('api/convert', {
    sourceId: state.source.sourceId, title, artist: $('#song-artist').value.trim(), calibration: config,
    options: {
      fps: Number($('#detection-fps').value), saturation: Number($('#saturation').value) / 100,
      minNote: Number($('#minimum-note').value), splitMidi: Number($('#split-midi').value),
      trim: $('#trim-silence').checked, handMode: $('#hand-mode').value,
      leftHue: Number($('#left-hue').value), rightHue: Number($('#right-hue').value),
      brightness: Number($('#brightness').value) / 100, startTime, endTime,
    },
  }, 'Reading the falling notes', async result => { showResult(result); await loadLibrary(); });
});
$('#publish-button').addEventListener('click', () => {
  runJob('api/publish', {}, 'Publishing your MIDI library', result => {
    showNotice('Library published. Your MIDI files are now in GitHub; the public page may take a minute to update.');
    if (result?.url) {
      const url = new URL(result.url);
      if (url.protocol === 'https:') $('#published-link').href = url.href;
    }
  });
});
$('#keyboard-preset').addEventListener('change', event => {
  const range = presets[event.target.value];
  $('#custom-range').hidden = Boolean(range);
  if (range) { $('#first-midi').value = range[0]; $('#last-midi').value = range[1]; }
  drawOverlay();
});
$('#reset-guides').addEventListener('click', () => applyCalibration(state.source?.calibration || defaults));
for (const selector of ['#left-margin', '#right-margin', '#scan-line', '#saturation', '#brightness', '#first-midi', '#last-midi']) $(selector).addEventListener('input', updateGuides);
$('#hand-mode').addEventListener('change', updateHandSettings);
$('#overlay-toggle').addEventListener('click', () => {
  state.overlay = !state.overlay;
  $('#overlay-toggle').textContent = state.overlay ? 'Guides on' : 'Guides off';
  $('#overlay-toggle').setAttribute('aria-pressed', String(state.overlay));
  overlay.hidden = !state.overlay;
  drawOverlay();
});
$('#video-play').addEventListener('click', () => {
  if (video.paused) { stopAudio(); video.play().catch(error => showNotice(`The browser could not play this video: ${error.message}`, true)); }
  else video.pause();
});
for (const type of ['play', 'pause']) video.addEventListener(type, () => {
  $('#video-play').replaceChildren(icon(video.paused ? 'play' : 'pause'));
  $('#video-play').setAttribute('aria-label', video.paused ? 'Play source video' : 'Pause source video');
});
video.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(video.duration)) {
    $('#video-seek').max = video.duration;
    $('#video-duration').textContent = formatTime(video.duration);
  }
  drawOverlay();
});
video.addEventListener('timeupdate', () => { $('#video-seek').value = video.currentTime; $('#video-time').textContent = formatTime(video.currentTime); });
video.addEventListener('error', () => { if (state.source) showNotice('The browser cannot preview this video. Try a video in MP4 / H.264 format.', true); });
$('#video-seek').addEventListener('input', event => { video.currentTime = Number(event.target.value); $('#video-time').textContent = formatTime(video.currentTime); });
$('#video-mute').addEventListener('click', () => {
  video.muted = !video.muted;
  $('#video-mute').replaceChildren(icon(video.muted ? 'muted' : 'volume'));
  $('#video-mute').setAttribute('aria-label', video.muted ? 'Unmute source video' : 'Mute source video');
});
let dragGuide = null;
overlay.addEventListener('pointerdown', event => {
  if (state.busy || !state.source) return;
  const rect = overlay.getBoundingClientRect(), config = calibration();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const distances = [
    ['left-margin', Math.abs(x - config.left * rect.width)],
    ['right-margin', Math.abs(x - config.right * rect.width)],
    ['scan-line', Math.abs(y - config.line * rect.height)],
  ].sort((a, b) => a[1] - b[1]);
  if (distances[0][1] < 24) { dragGuide = distances[0][0]; overlay.setPointerCapture(event.pointerId); event.preventDefault(); }
});
overlay.addEventListener('pointermove', event => {
  if (!dragGuide) return;
  const rect = overlay.getBoundingClientRect();
  const input = $(`#${dragGuide}`);
  const ratio = dragGuide === 'scan-line' ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width;
  input.value = clamp(ratio * 100, Number(input.min), Number(input.max));
  updateGuides({ target: input });
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) overlay.addEventListener(type, () => { dragGuide = null; });
$('#library-search').addEventListener('input', renderLibrary);
$('#reviewed-filter').addEventListener('change', renderLibrary);
$('#preview-result').addEventListener('click', playResult);
$('#stop-audio').addEventListener('click', () => stopAudio());
window.addEventListener('pagehide', () => stopAudio());
new ResizeObserver(() => { drawOverlay(); drawNotes(); }).observe($('#video-frame'));
new ResizeObserver(drawNotes).observe($('#notes-preview'));
init();
