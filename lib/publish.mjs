import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from './process.mjs';
import { songFiles } from './library-files.mjs';

/** Publish only the library, then verify the files actually served to the headset. */
export async function publishLibrary({
  root, repository, publishedUrl, progress = () => {}, verifyFile,
  runCommand = run, fetchImpl = fetch, wait = delay,
  timeoutMs = 180000, pollMs = 3000, now = Date.now,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository.');
  const expectedUrl = `https://${repository.split('/')[0].toLowerCase()}.github.io/${repository.split('/')[1]}/`;
  if (publishedUrl !== expectedUrl) throw new Error('The published URL does not match this library.');
  const manifest = JSON.parse(await readFile(join(root, 'docs', 'library', 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.songs)) {
    throw new Error('The library index contains an invalid MIDI file path.');
  }
  const groups = manifest.songs.map(songFiles);
  const selected = verifyFile === undefined ? null : groups.find(files => files.includes(verifyFile));
  if (verifyFile !== undefined && !selected) {
    throw new Error('The MIDI to publish is not in this library.');
  }
  const files = [...new Set(selected || groups.flat())];
  const expectedFiles = await Promise.all(files.map(async file => ({ file, bytes: await readFile(join(root, 'docs', file)) })));
  const git = (args, options = {}) => runCommand('git', args, { cwd: root, timeout: 120000, ...options });
  progress(0.05, 'Checking the GitHub library…');
  const { stdout: remote } = await git(['remote', 'get-url', 'origin']);
  if (![`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`]
    .includes(remote.trim())) throw new Error('The Git remote does not match this library. Check FALLNOTE_REPOSITORY.');
  const { stdout: branch } = await git(['branch', '--show-current']);
  if (branch.trim() !== 'main') throw new Error('Switch this app repository to main before publishing.');
  await git(['fetch', 'origin', 'main']);
  // Check every commit (including merges), so an unrelated change followed by a
  // revert cannot send its earlier contents merely because a song was converted.
  const { stdout: aheadFiles } = await git(['log', '--format=', '--name-only', '-z', '-m', 'origin/main..HEAD']);
  if (aheadFiles.split('\0').map(file => file.trim()).filter(Boolean).some(file => !file.startsWith('docs/library/'))) {
    throw new Error('There are unpublished app changes. Publish those changes separately, then retry the MIDI library.');
  }
  await git(['add', '--', 'docs/library']);
  const { stdout: changes } = await git(['diff', '--cached', '--name-only', '--', 'docs/library']);
  if (changes.trim()) await git(['commit', '-m', 'Update MIDI library', '--only', '--', 'docs/library']);
  progress(0.25, 'Sending your MIDI library to GitHub…');
  await git(['push', 'origin', 'main']);
  const { stdout: revision } = await git(['rev-parse', 'HEAD']);
  const expectedManifest = JSON.stringify(manifest);
  const started = now();
  let attempt = 0;
  do {
    const check = `${revision.trim()}-${attempt++}`;
    const publicUrl = file => {
      const url = new URL(file, publishedUrl);
      url.searchParams.set('verify', check);
      return url;
    };
    try {
      progress(Math.min(0.95, 0.45 + 0.5 * (now() - started) / Math.max(1, timeoutMs)), 'Waiting for the download to appear on your VR website…');
      const response = await fetchImpl(publicUrl('library/manifest.json'), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (response.ok && JSON.stringify(await response.json()) === expectedManifest) {
        let allMatch = true;
        for (const { file, bytes } of expectedFiles) {
          const download = await fetchImpl(publicUrl(file), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
          if (!download.ok || !Buffer.from(await download.arrayBuffer()).equals(bytes)) { allMatch = false; break; }
        }
        if (allMatch) {
          progress(1, 'Ready to download on your headset.');
          return {
            status: 'published', url: publishedUrl,
            ...(verifyFile ? { downloadUrl: new URL(verifyFile, publishedUrl).href } : {}),
            message: 'Your MIDI library is live. You can download it in VR with this PC switched off.',
          };
        }
      }
    } catch { /* A publishing delay or temporary network failure is not a lost MIDI. */ }
    if (now() - started >= timeoutMs) break;
    await wait(Math.min(pollMs, Math.max(0, timeoutMs - (now() - started))));
  } while (now() - started <= timeoutMs);
  return { status: 'pending', url: publishedUrl, message: 'Saved to GitHub. The public download is still updating; retry Publish library to check again.' };
}
