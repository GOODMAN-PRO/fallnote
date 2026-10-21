export function safePublishedUrl(value, configuredUrl) {
  try {
    const expected = new URL(configuredUrl);
    const candidate = new URL(value);
    if (expected.protocol !== 'https:' || candidate.protocol !== 'https:' ||
        expected.username || expected.password || candidate.username || candidate.password ||
        candidate.origin !== expected.origin ||
        candidate.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) return null;
    expected.search = '';
    expected.hash = '';
    return expected.href;
  } catch { return null; }
}

/** Only the server's verified published state means the new files are online. */
export function publicationPresentation(publication, configuredUrl) {
  const status = ['published', 'pending', 'failed', 'local'].includes(publication?.status) ? publication.status : 'local';
  const states = {
    published: {
      title: 'Ready in your VR library',
      message: 'Open your library in the headset browser and download the MIDI. Published files stay available when this PC is off.',
      notice: 'Your VR library is online. You can download its MIDI files with this PC off.',
    },
    pending: {
      title: 'Saved here; website updating',
      message: 'GitHub accepted the library, but the new files are not confirmed online yet. Wait a moment, then check publication.',
      notice: 'Saved on this PC. GitHub is updating the website; the new MIDI is not confirmed online yet.',
    },
    failed: {
      title: 'Saved here; publishing failed',
      message: 'Your MIDI is saved on this PC. Publishing did not complete; retry to get the latest changes into your VR library.',
      notice: 'Your files are saved on this PC. Publishing failed, so the latest changes are not ready in VR yet.',
    },
    local: {
      title: 'Saved on this PC',
      message: 'This MIDI has not been published to your VR library. Use Publish library when you want to download it from your headset.',
      notice: 'MIDI saved on this PC. Publish the library to make it available in VR.',
    },
  };
  return {
    status, ...states[status],
    url: (status === 'published' || status === 'pending') ? safePublishedUrl(publication?.url, configuredUrl) : null,
    retry: status !== 'published',
    retryLabel: status === 'pending' ? 'Check publication' : 'Publish library',
    error: status === 'failed' && typeof publication?.error === 'string' ? publication.error : '',
  };
}
