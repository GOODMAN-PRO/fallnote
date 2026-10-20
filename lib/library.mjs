import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeMidi } from './midi.mjs';

export function createLibrary(root) {
  const folder = join(root, 'docs', 'library');
  const manifestPath = join(folder, 'manifest.json');
  let queue = Promise.resolve();
  const exclusive = operation => {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  };
  async function read() {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.version !== 1 || !Array.isArray(manifest.songs)) throw new Error('Invalid library manifest.');
      return manifest;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, songs: [] };
      throw error;
    }
  }
  async function write(manifest) {
    await mkdir(folder, { recursive: true });
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
    await rename(temporary, manifestPath);
  }
  function text(value, fallback, limit = 180) {
    return (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim() : '').slice(0, limit) || fallback;
  }
  return {
    read, exclusive,
    save(notes, metadata) {
      return exclusive(async () => {
        if (!notes.length) throw new Error('No notes detected. Move the scan line through the solid coloured bars and check the keyboard bounds.');
        const manifest = await read();
        const id = randomUUID();
        const title = text(metadata.title, 'Untitled tutorial');
        const bytes = encodeMidi(notes, { title });
        const song = {
          id, title, artist: text(metadata.artist, ''),
          createdAt: new Date().toISOString(),
          duration: Math.max(...notes.map(note => note.start + note.duration)),
          noteCount: notes.length, file: `library/midi/${id}.mid`,
          method: 'visual', handMode: metadata.handMode || 'pitch',
          sourceName: text(metadata.sourceName, 'Video tutorial'), reviewed: false,
          pitchMin: Math.min(...notes.map(note => note.pitch)),
          pitchMax: Math.max(...notes.map(note => note.pitch))
        };
        await mkdir(join(folder, 'midi'), { recursive: true });
        await writeFile(join(folder, 'midi', `${id}.mid`), bytes, { flag: 'wx' });
        manifest.songs.unshift(song);
        try { await write(manifest); } catch (error) {
          await unlink(join(folder, 'midi', `${id}.mid`)).catch(() => {});
          throw error;
        }
        return song;
      });
    },
    update(id, changes) {
      return exclusive(async () => {
        const manifest = await read();
        const song = manifest.songs.find(item => item.id === id);
        if (!song) throw Object.assign(new Error('Song not found.'), { status: 404 });
        if ('title' in changes) song.title = text(changes.title, song.title);
        if ('artist' in changes) song.artist = text(changes.artist, '');
        if ('reviewed' in changes && typeof changes.reviewed === 'boolean') song.reviewed = changes.reviewed;
        await write(manifest);
        return song;
      });
    },
    remove(id) {
      return exclusive(async () => {
        const manifest = await read();
        const song = manifest.songs.find(item => item.id === id);
        if (!song) throw Object.assign(new Error('Song not found.'), { status: 404 });
        manifest.songs = manifest.songs.filter(item => item.id !== id);
        await write(manifest);
        await unlink(join(folder, 'midi', `${id}.mid`)).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
      });
    }
  };
}
