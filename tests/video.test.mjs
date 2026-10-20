import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { youtubeUrl, zenSessionForVideo, downloadVideo, convertVideo, DEMO_CALIBRATION } from '../lib/video.mjs';

const VIDEO_ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
let root;
let spawnGuard;
let fixtureIndex = 0;

test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'fallnote-video-test-'));
  // Every tested branch must reject before a downloader or decoder can start.
  spawnGuard = mock.method(childProcess, 'spawn', () => {
    throw new Error('Unexpected external process in video validation tests');
  });
  syncBuiltinESMExports();
});

test.after(async () => {
  const spawned = spawnGuard?.mock.callCount() || 0;
  spawnGuard?.mock.restore();
  syncBuiltinESMExports();
  if (root) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('fallnote-video-test-'));
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(spawned, 0, 'Validation must finish before any subprocess starts');
});

async function fixture(ini) {
  const roaming = join(root, `roaming-${++fixtureIndex}`);
  const zen = join(roaming, 'zen');
  await mkdir(zen, { recursive: true });
  if (ini !== undefined) await writeFile(join(zen, 'profiles.ini'), ini);
  return { roaming, zen };
}

async function fakeProfile(zen, name = 'Profiles/default') {
  const profile = join(zen, name);
  await mkdir(profile, { recursive: true });
  // Empty fixture only: these tests never open a real browser database.
  await writeFile(join(profile, 'cookies.sqlite'), '');
  return profile;
}

test('canonicalizes supported YouTube links to one video without propagating extra parameters', () => {
  for (const input of [
    CANONICAL,
    `https://youtube.com/watch?v=${VIDEO_ID}&list=ignored&index=2`,
    `https://m.youtube.com/watch?v=${VIDEO_ID}#fragment`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}&t=30`,
    `https://youtu.be/${VIDEO_ID}?si=tracking`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://www.youtube.com/live/${VIDEO_ID}`,
    `https://www.youtube.com:443/watch?v=${VIDEO_ID}`
  ]) {
    assert.equal(youtubeUrl(input), CANONICAL, input);
  }
});

test('rejects SSRF targets, deceptive domains, userinfo, non-HTTPS schemes and non-video URLs', () => {
  for (const input of [
    undefined, null, '', 'not a URL',
    `http://www.youtube.com/watch?v=${VIDEO_ID}`,
    `ftp://www.youtube.com/watch?v=${VIDEO_ID}`,
    'file:///C:/private.txt',
    `https://127.0.0.1/watch?v=${VIDEO_ID}`,
    `https://[::1]/watch?v=${VIDEO_ID}`,
    `https://169.254.169.254/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com.evil.example/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com@evil.example/watch?v=${VIDEO_ID}`,
    `https://user@www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://user:password@www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com:8443/watch?v=${VIDEO_ID}`,
    `https://www.youtube.com./watch?v=${VIDEO_ID}`,
    'https://www.youtube.com/playlist?list=PLfixture',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=longerthan11characters',
    `https://www.youtube.com/channel/${VIDEO_ID}`
  ]) assert.throws(() => youtubeUrl(input), /YouTube|https|individual/);
});

test('selects the installed default Zen profile using fake profiles and canonicalizes its video scope', async () => {
  const { roaming, zen } = await fixture([
    '[Profile0]', 'Name=Fallback', 'IsRelative=1', 'Path=Profiles/fallback', 'Default=1',
    '[InstallFixture]', 'Default=Profiles/installed', 'Locked=1'
  ].join('\r\n'));
  await fakeProfile(zen, 'Profiles/fallback');
  const profile = await fakeProfile(zen, 'Profiles/installed');
  const session = await zenSessionForVideo(`https://youtu.be/${VIDEO_ID}?t=10`, roaming);
  assert.deepEqual(session, { browser: 'firefox', profile, videoUrl: CANONICAL });
  assert.equal(await readFile(join(profile, 'cookies.sqlite'), 'utf8'), '');
});

test('uses an explicitly marked fallback profile when no install default exists', async () => {
  const { roaming, zen } = await fixture([
    '[General]', 'StartWithLastProfile=1',
    '[Profile0]', 'Path=Profiles/not-default', 'Default=0',
    '[Profile1]', 'Name=Fixture', 'IsRelative=1', 'Path=Profiles/default', 'Default=1'
  ].join('\n'));
  await fakeProfile(zen, 'Profiles/not-default');
  const profile = await fakeProfile(zen);
  assert.deepEqual(await zenSessionForVideo(CANONICAL, roaming), {
    browser: 'firefox', profile, videoUrl: CANONICAL
  });
});

test('reports missing Zen configuration, default selection and cookie files without scanning', async () => {
  await assert.rejects(zenSessionForVideo(CANONICAL, null), /Windows only/);
  const absent = await fixture();
  await assert.rejects(zenSessionForVideo(CANONICAL, absent.roaming), /Zen was not found/);
  const noDefault = await fixture('[Profile0]\nPath=Profiles/default\nDefault=0\n');
  await fakeProfile(noDefault.zen);
  await assert.rejects(zenSessionForVideo(CANONICAL, noDefault.roaming), /No default Zen profile/);
  const missingProfile = await fixture('[InstallFixture]\nDefault=Profiles/missing\n');
  await assert.rejects(zenSessionForVideo(CANONICAL, missingProfile.roaming), /no sign-in cookies|profile/i);
  const missingCookies = await fixture('[Profile0]\nPath=Profiles/default\nDefault=1\n');
  await mkdir(join(missingCookies.zen, 'Profiles', 'default'), { recursive: true });
  await assert.rejects(zenSessionForVideo(CANONICAL, missingCookies.roaming), /no.*sign-in cookies/i);
});

test('refuses relative traversal and absolute defaults outside the fake Zen root', async () => {
  const outside = join(root, 'outside-profile');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'cookies.sqlite'), '');
  for (const absolute of [false, true]) {
    const { roaming, zen } = await fixture();
    const selected = absolute ? outside : relative(zen, outside);
    await writeFile(join(zen, 'profiles.ini'), `[InstallFixture]\nDefault=${selected}\n`);
    await assert.rejects(zenSessionForVideo(CANONICAL, roaming), /outside.*standard folder/i);
  }
  const sameRoot = await fixture('[InstallFixture]\nDefault=.\n');
  await writeFile(join(sameRoot.zen, 'cookies.sqlite'), '');
  await assert.rejects(zenSessionForVideo(CANONICAL, sameRoot.roaming), /outside.*standard folder/i);
});

test('refuses a profile junction that resolves outside the fake Zen root', async () => {
  const { roaming, zen } = await fixture('[InstallFixture]\nDefault=Profiles/linked\n');
  const outside = join(root, 'junction-target');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'cookies.sqlite'), '');
  await mkdir(join(zen, 'Profiles'), { recursive: true });
  await symlink(outside, join(zen, 'Profiles', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(zenSessionForVideo(CANONICAL, roaming), /outside.*standard folder|no usable local sign-in cookies/i);
});

test('requires cookies.sqlite to be a regular file rather than a directory', async () => {
  const { roaming, zen } = await fixture('[InstallFixture]\nDefault=Profiles/default\n');
  await mkdir(join(zen, 'Profiles', 'default', 'cookies.sqlite'), { recursive: true });
  await assert.rejects(zenSessionForVideo(CANONICAL, roaming), /cookies|regular file/i);
});

test('rejects cookie authorization for another video or browser before creating output or spawning', async () => {
  const media = join(root, 'never-created-media');
  const fakeAbsolute = join(root, 'fake-authorized-profile');
  const validShape = { browser: 'firefox', profile: fakeAbsolute, videoUrl: CANONICAL };
  for (const browserSession of [
    { ...validShape, videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' },
    { ...validShape, videoUrl: `https://youtu.be/${VIDEO_ID}` },
    { ...validShape, browser: 'chrome' },
    { ...validShape, profile: 'relative/profile' },
    { ...validShape, profile: '' },
    { ...validShape, profile: `${fakeAbsolute}\nother-profile` },
    { ...validShape, profile: `${fakeAbsolute}\rprofile` },
    { ...validShape, profile: `${fakeAbsolute}\0` },
    { ...validShape, profile: null },
    {}
  ]) {
    await assert.rejects(downloadVideo(media, CANONICAL, {
      signal: new AbortController().signal,
      progress() { assert.fail('Invalid permission cannot report download progress'); },
      browserSession
    }), /Browser permission must specify this exact video/);
  }
  await assert.rejects(stat(media), { code: 'ENOENT' });
  assert.equal(spawnGuard.mock.callCount(), 0);
});

test('rejects invalid clip bounds and frame rates before opening a video or decoder', async () => {
  const video = { path: join(root, 'never-created-video.mp4'), duration: 10, width: 640, height: 360 };
  const context = { signal: new AbortController().signal, progress() { assert.fail('Invalid clips cannot report decoding progress'); } };
  for (const options of [
    { startTime: -1 },
    { endTime: 10.1 },
    { startTime: 5, endTime: 5 },
    { startTime: 8, endTime: 2 },
    { startTime: Infinity },
    { endTime: Infinity },
    { startTime: NaN },
    { endTime: NaN },
    { startTime: 'invalid' },
    { endTime: 'invalid' }
  ]) {
    await assert.rejects(convertVideo(video, DEMO_CALIBRATION, options, context), /start and end time/);
  }
  await assert.rejects(convertVideo(video, DEMO_CALIBRATION, { fps: 120 }, context), /24, 30 or 60/);
  assert.equal(spawnGuard.mock.callCount(), 0);
});
