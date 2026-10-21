import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationPresentation, safePublishedUrl } from '../docs/publication.mjs';

const site = 'https://goodman-pro.github.io/fallnote/';

test('only published reports ready and stops offering a publication retry', () => {
  const view = publicationPresentation({ status: 'published', url: site }, site);
  assert.equal(view.status, 'published');
  assert.match(view.title, /Ready in your VR library/);
  assert.match(view.notice, /library is online/);
  assert.equal(view.url, site);
  assert.equal(view.retry, false);
  assert.equal(view.error, '');
});

test('pending keeps the library link but offers Check publication without claiming live delivery', () => {
  const view = publicationPresentation({ status: 'pending', url: site }, site);
  assert.equal(view.status, 'pending');
  assert.equal(view.url, site);
  assert.equal(view.retry, true);
  assert.equal(view.retryLabel, 'Check publication');
  assert.doesNotMatch(view.title, /ready|online/i);
  assert.match(view.message, /not confirmed online yet/);
  assert.match(view.notice, /not confirmed online yet/);
});

test('failed retains diagnostic and local files, with Publish library and no public result link', () => {
  const error = 'git push was rejected';
  const view = publicationPresentation({ status: 'failed', url: site, error }, site);
  assert.equal(view.status, 'failed');
  assert.match(view.message, /saved on this PC/);
  assert.equal(view.url, null);
  assert.equal(view.retry, true);
  assert.equal(view.retryLabel, 'Publish library');
  assert.equal(view.error, error);
});

test('local is explicitly unpublished and offers Publish library', () => {
  const view = publicationPresentation({ status: 'local', url: site }, site);
  assert.equal(view.url, null);
  assert.equal(view.retry, true);
  assert.equal(view.retryLabel, 'Publish library');
  assert.match(view.message, /has not been published/);
  assert.doesNotMatch(view.title, /ready|online/i);
});

test('missing and unknown statuses never infer live publication from a URL or success message', () => {
  for (const publication of [undefined, null, {}, { url: site }, { status: 'success', url: site }, { status: 'pushed', url: site, message: 'Published successfully' }]) {
    const view = publicationPresentation(publication, site);
    assert.equal(view.status, 'local');
    assert.equal(view.url, null);
    assert.equal(view.retry, true);
    assert.doesNotMatch(view.title, /ready|online/i);
  }
});

test('publication links match the configured HTTPS library and discard query or fragment', () => {
  assert.equal(safePublishedUrl(site, site), site);
  assert.equal(safePublishedUrl(site.slice(0, -1), site), site);
  assert.equal(safePublishedUrl(site + '?version=123#library', site), site);
  assert.equal(safePublishedUrl(site, site + '?version=456#ignored'), site);
});

test('credentials, other origins, non-HTTPS schemes and unrelated paths cannot become publication links', () => {
  const rejected = [
    'http://goodman-pro.github.io/fallnote/',
    'javascript:alert(1)',
    'https://user:secret@goodman-pro.github.io/fallnote/',
    'https://goodman-pro.github.io.evil.test/fallnote/',
    'https://example.com/fallnote/',
    'https://goodman-pro.github.io:8443/fallnote/',
    'https://goodman-pro.github.io/other/',
    'https://goodman-pro.github.io/fallnote-extra/',
    'https://goodman-pro.github.io/fallnote/../other/',
    'https://goodman-pro.github.io/fallnote/library/midi/file.mid',
    'not a URL',
  ];
  for (const url of rejected) {
    assert.equal(safePublishedUrl(url, site), null, url);
    assert.equal(publicationPresentation({ status: 'published', url }, site).url, null, url);
    assert.equal(publicationPresentation({ status: 'pending', url }, site).url, null, url);
  }
});

test('a bad configured library URL also fails closed', () => {
  for (const configuredUrl of ['http://goodman-pro.github.io/fallnote/', 'https://user:secret@goodman-pro.github.io/fallnote/', '', undefined]) {
    assert.equal(safePublishedUrl(site, configuredUrl), null);
  }
});
