import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { publishLibrary } from '../lib/publish.mjs';

const repository = 'owner/fallnote';
const publishedUrl = 'https://owner.github.io/fallnote/';
const remote = `https://github.com/${repository}.git`;
const revision = '1234567890abcdef1234567890abcdef12345678';
// A complete format-0 MIDI: middle C for 480 ticks, followed by end-of-track.
const alpha = Buffer.from('4d546864000000060000000101e04d54726b0000000d00903c5a8360803c0000ff2f00', 'hex');
const beta = Buffer.from(alpha);
beta[25] = 64;
beta[30] = 64;

async function fixture(t, { songs } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fallnote-publish-'));
  t.after(async () => {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('fallnote-publish-'));
    await rm(target, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs', 'library', 'midi'), { recursive: true });
  const manifest = {
    version: 1,
    songs: songs ?? [
      { id: 'alpha', title: 'Alpha', file: 'library/midi/alpha.mid', duration: 0.5, noteCount: 1 },
      { id: 'beta', title: 'Beta', file: 'library/midi/beta.mid', duration: 0.5, noteCount: 1 }
    ]
  };
  await writeFile(join(root, 'docs', 'library', 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'docs', 'library', 'midi', 'alpha.mid'), alpha);
  await writeFile(join(root, 'docs', 'library', 'midi', 'beta.mid'), beta);
  return { root, manifest };
}

function harness({ manifest, origin = remote, branch = 'main', historyPaths = '', netPaths = '', stagedPaths = 'docs/library/manifest.json\ndocs/library/midi/alpha.mid\n', pushError, respond } = {}) {
  const commands = [];
  const requests = [];
  const waits = [];
  let clock = 0;
  const runCommand = async (command, args, options) => {
    assert.equal(command, 'git', 'publisher must only invoke git');
    commands.push({ args: [...args], options });
    let stdout = '';
    if (args[0] === 'remote' && args.includes('get-url')) stdout = `${origin}\n`;
    else if ((args[0] === 'branch' && args.includes('--show-current')) || (args[0] === 'rev-parse' && args.includes('--abbrev-ref'))) stdout = `${branch}\n`;
    else if (args[0] === 'log') stdout = historyPaths;
    else if (args[0] === 'diff') stdout = args.includes('--cached') ? stagedPaths : netPaths;
    else if (args[0] === 'rev-parse') stdout = `${revision}\n`;
    else if (args[0] === 'push' && pushError) throw pushError;
    else assert.ok(['fetch', 'add', 'commit', 'push'].includes(args[0]), `unexpected git command: ${args.join(' ')}`);
    return { stdout, stderr: '' };
  };
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push({ url, options });
    assert.ok(commands.some(({ args }) => args[0] === 'push'), 'HTTP verification must follow the Git push');
    assert.deepEqual(commands.at(-1).args, ['rev-parse', 'HEAD']);
    assert.equal(url.origin, 'https://owner.github.io');
    assert.ok(url.search.length > 1, 'published content must be fetched with a cache buster');
    if (respond) return respond(url, { round: waits.length, requests });
    if (url.pathname === '/fallnote/library/manifest.json') return Response.json(manifest);
    if (url.pathname === '/fallnote/library/midi/alpha.mid') return new Response(alpha);
    if (url.pathname === '/fallnote/library/midi/beta.mid') return new Response(beta);
    assert.fail(`unexpected published path: ${url.pathname}`);
  };
  return {
    commands, requests, waits,
    options: {
      repository, publishedUrl, runCommand, fetchImpl,
      timeoutMs: 30, pollMs: 10, now: () => clock,
      wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; }
    }
  };
}

const called = (mock, command) => mock.commands.filter(({ args }) => args[0] === command);

test('publishes only after the live manifest and every referenced MIDI match local bytes', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, historyPaths: 'docs/library/manifest.json\0\0docs/library/midi/alpha.mid\0' });
  const result = await publishLibrary({ root: files.root, ...mock.options });
  assert.equal(result.status, 'published');
  assert.equal(result.url, publishedUrl);
  assert.equal(mock.waits.length, 0);
  assert.deepEqual(new Set(mock.requests.map(({ url }) => url.pathname)), new Set([
    '/fallnote/library/manifest.json', '/fallnote/library/midi/alpha.mid', '/fallnote/library/midi/beta.mid'
  ]));
  assert.equal(called(mock, 'push').length, 1);
  assert.equal(called(mock, 'commit').length, 1);
  const commit = called(mock, 'commit')[0].args;
  assert.ok(commit.includes('--only'), 'unrelated staged changes must not be committed');
  assert.deepEqual(commit.slice(commit.indexOf('--') + 1), ['docs/library']);
  assert.deepEqual(called(mock, 'add')[0].args, ['add', '--', 'docs/library']);
  assert.deepEqual(called(mock, 'fetch')[0].args, ['fetch', 'origin', 'main']);
  assert.deepEqual(called(mock, 'push')[0].args, ['push', 'origin', 'main']);
  assert.ok(mock.commands.every(({ options }) => options.cwd === files.root));
  assert.deepEqual(called(mock, 'log')[0].args, ['log', '--format=', '--name-only', '-z', '-m', 'origin/main..HEAD']);
  const stagedCheck = called(mock, 'diff').find(({ args }) => args.includes('--cached'));
  assert.deepEqual(stagedCheck.args, ['diff', '--cached', '--name-only', '--', 'docs/library']);
});

test('verifyFile checks the new MIDI and provides its public download URL', async (t) => {
  const files = await fixture(t);
  const mock = harness(files);
  const result = await publishLibrary({ root: files.root, verifyFile: 'library/midi/alpha.mid', ...mock.options });
  assert.equal(result.status, 'published');
  assert.equal(result.downloadUrl, `${publishedUrl}library/midi/alpha.mid`);
  assert.ok(mock.requests.some(({ url }) => url.pathname.endsWith('/alpha.mid')));
  assert.ok(!mock.requests.some(({ url }) => url.pathname.endsWith('/beta.mid')));
});

test('automatic publication verifies every hand download for the newly saved song', async t => {
  const song = { id: 'alpha', title: 'Alpha', file: 'library/midi/alpha.mid',
    handFiles: { both: 'library/midi/alpha-hands.mid', left: 'library/midi/alpha-left.mid', right: 'library/midi/alpha-right.mid' } };
  const files = await fixture(t, { songs: [song] });
  for (const file of Object.values(song.handFiles)) await writeFile(join(files.root, 'docs', file), beta);
  const mock = harness({ ...files, respond: url => url.pathname.endsWith('/manifest.json') ? Response.json(files.manifest) :
    new Response(url.pathname.endsWith('/alpha.mid') ? alpha : beta) });
  const result = await publishLibrary({ root: files.root, verifyFile: song.file, ...mock.options });
  assert.equal(result.status, 'published');
  for (const file of [song.file, ...Object.values(song.handFiles)]) {
    assert.ok(mock.requests.some(({ url }) => url.pathname === '/fallnote/' + file), file);
  }
});

test('a missing hand download prevents a ready-in-VR result even when the master is live', async t => {
  const song = { id: 'alpha', title: 'Alpha', file: 'library/midi/alpha.mid', handFiles: { both: 'library/midi/beta.mid', left: 'library/midi/alpha-left.mid' } };
  const files = await fixture(t, { songs: [song] });
  await writeFile(join(files.root, 'docs', song.handFiles.left), beta);
  const mock = harness({ ...files, respond: url => url.pathname.endsWith('/manifest.json') ? Response.json(files.manifest) :
    url.pathname.endsWith('/alpha-left.mid') ? new Response('', { status: 404 }) : new Response(url.pathname.endsWith('/alpha.mid') ? alpha : beta) });
  const result = await publishLibrary({ root: files.root, verifyFile: song.file, ...mock.options, timeoutMs: 0 });
  assert.equal(result.status, 'pending');
});

test('unsafe or malformed hand download paths fail before git or public requests', async t => {
  for (const handFiles of [{ both: '../outside.mid' }, { both: 'library/midi/alpha.mid', left: 'https://example.com/private.mid' },
    { both: 'library/midi/alpha.mid', right: 'library/midi/../../private.mid' }, { left: 'library/midi/alpha.mid' },
    { both: 'library/midi/alpha.mid', unexpected: 'library/midi/beta.mid' }]) {
    const files = await fixture(t, { songs: [{ id: 'alpha', file: 'library/midi/alpha.mid', handFiles }] });
    const mock = harness(files);
    await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), /invalid MIDI file path/);
    assert.equal(mock.commands.length, 0);
    assert.equal(mock.requests.length, 0);
  }
});

test('waits through a stale manifest and then different MIDI bytes before reporting published', async (t) => {
  const files = await fixture(t);
  const wrongMidi = Buffer.from(alpha);
  wrongMidi[25] = 65;
  const mock = harness({
    ...files,
    respond(url, { round }) {
      if (url.pathname.endsWith('/manifest.json')) return Response.json(round === 0 ? { version: 1, songs: [] } : files.manifest);
      return new Response(round === 1 ? wrongMidi : alpha);
    }
  });
  const result = await publishLibrary({ root: files.root, verifyFile: 'library/midi/alpha.mid', ...mock.options });
  assert.equal(result.status, 'published');
  assert.ok(mock.waits.length >= 2);
  assert.ok(mock.requests.filter(({ url }) => url.pathname.endsWith('/manifest.json')).length >= 3);
});

test('a pushed library whose Pages URLs remain 404 returns pending, never published', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, respond: () => new Response('Not found', { status: 404 }) });
  const result = await publishLibrary({ root: files.root, ...mock.options });
  assert.equal(result.status, 'pending');
  assert.equal(result.url, publishedUrl);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
  assert.equal(called(mock, 'push').length, 1);
  assert.ok(mock.waits.length > 0);
});

test('a correct manifest with persistently wrong MIDI content still returns pending', async (t) => {
  const files = await fixture(t);
  const mock = harness({
    ...files,
    respond: (url) => url.pathname.endsWith('/manifest.json') ? Response.json(files.manifest) : new Response(beta)
  });
  const result = await publishLibrary({ root: files.root, verifyFile: 'library/midi/alpha.mid', ...mock.options });
  assert.equal(result.status, 'pending');
  assert.ok(mock.waits.length > 0);
});

test('manual publishing verifies later MIDI files even when the first file is correct', async (t) => {
  const files = await fixture(t);
  const mock = harness({
    ...files,
    respond: (url) => url.pathname.endsWith('/manifest.json') ? Response.json(files.manifest) : new Response(alpha)
  });
  const result = await publishLibrary({ root: files.root, ...mock.options });
  assert.equal(result.status, 'pending');
  assert.ok(mock.requests.some(({ url }) => url.pathname.endsWith('/beta.mid')));
});

test('zero verification timeout performs one live check and returns pending without sleeping', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, respond: () => new Response('Not found', { status: 404 }) });
  const result = await publishLibrary({ root: files.root, ...mock.options, timeoutMs: 0 });
  assert.equal(result.status, 'pending');
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.waits.length, 0);
});

test('git push failure is an error and never starts HTTP verification', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, pushError: new Error('push rejected: permission denied') });
  await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), /push rejected|permission denied/i);
  assert.equal(mock.requests.length, 0);
});

test('a different origin repository prevents publishing and HTTP verification', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, origin: 'https://github.com/another-owner/fallnote.git' });
  await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), /remote|origin|repository/i);
  assert.equal(called(mock, 'push').length, 0);
  assert.equal(called(mock, 'commit').length, 0);
  assert.equal(called(mock, 'fetch').length, 0);
  assert.equal(mock.requests.length, 0);
});

test('a branch other than main prevents publishing', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, branch: 'feature/unreviewed' });
  await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), /branch|main/i);
  assert.equal(called(mock, 'push').length, 0);
  assert.equal(mock.requests.length, 0);
});

test('committed changes outside the library prevent an otherwise valid library push', async (t) => {
  const files = await fixture(t);
  const mock = harness({
    ...files,
    historyPaths: 'docs/library/manifest.json\0lib/midi.mjs\0',
    netPaths: 'docs/library/manifest.json\nlib/midi.mjs\n'
  });
  await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), /library|outside|commit|unrelated|unpublished/i);
  assert.equal(called(mock, 'push').length, 0);
  assert.equal(called(mock, 'commit').length, 0);
  assert.equal(mock.requests.length, 0);
});

test('an unrelated add-and-revert commit history is blocked even when its net diff is empty', async (t) => {
  const files = await fixture(t);
  const mock = harness({
    ...files,
    // The two commits cancel in the working tree but would both be pushed.
    historyPaths: 'docs/library/manifest.json\0lib/temporary-debug.mjs\0\0lib/temporary-debug.mjs\0',
    netPaths: ''
  });
  await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), /library|outside|commit|unrelated|unpublished/i);
  assert.equal(called(mock, 'log').length, 1);
  assert.equal(called(mock, 'add').length, 0);
  assert.equal(called(mock, 'commit').length, 0);
  assert.equal(called(mock, 'push').length, 0);
  assert.equal(mock.requests.length, 0);
});

test('an unchanged library skips an empty commit but still verifies the published bytes', async (t) => {
  const files = await fixture(t);
  const mock = harness({ ...files, stagedPaths: '' });
  const result = await publishLibrary({ root: files.root, ...mock.options });
  assert.equal(result.status, 'published');
  assert.equal(called(mock, 'commit').length, 0);
  assert.ok(mock.requests.length >= 3);
});

test('unsafe manifest paths are rejected before any outside read, git command, or HTTP request', async (t) => {
  for (const file of ['../outside-does-not-exist.mid', 'library/midi/../../outside-does-not-exist.mid', '/outside.mid', 'https://example.com/outside.mid', 'library\\midi\\alpha.mid']) {
    await t.test(file, async (child) => {
      const files = await fixture(child, { songs: [{ id: 'unsafe', title: 'Unsafe', file }] });
      const mock = harness(files);
      await assert.rejects(publishLibrary({ root: files.root, ...mock.options }), (error) => {
        assert.notEqual(error.code, 'ENOENT', 'path must be rejected before attempting to read the nonexistent outside target');
        assert.match(error.message, /path|file|library|invalid|unsafe|allowed/i);
        return true;
      });
      assert.equal(mock.commands.length, 0);
      assert.equal(mock.requests.length, 0);
    });
  }
});

test('an unsafe verifyFile is rejected before any outside read or publishing', async (t) => {
  const files = await fixture(t);
  const mock = harness(files);
  await assert.rejects(publishLibrary({ root: files.root, verifyFile: '../outside-does-not-exist.mid', ...mock.options }), (error) => {
    assert.notEqual(error.code, 'ENOENT');
    assert.match(error.message, /path|file|library|invalid|unsafe|allowed/i);
    return true;
  });
  assert.equal(called(mock, 'push').length, 0);
  assert.equal(mock.requests.length, 0);
});
