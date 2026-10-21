export function youtubeVideo(input) {
  if (typeof input !== 'string') return null;
  const original = input.trim();
  if (!original || /\s/.test(original)) return null;
  try {
    const url = new URL(original);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const id = host === 'youtu.be' ? segments[0] : url.pathname === '/watch' ? url.searchParams.get('v') :
      ['shorts', 'embed', 'live'].includes(segments[0]) ? segments[1] : null;
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? { url: original, id } : null;
  } catch { return null; }
}

export function youtubeRequest({ url, automatic = true, publish = true, useZenSession = false }) {
  const video = youtubeVideo(url);
  if (!video) return null;
  return {
    path: automatic ? 'api/auto-convert' : 'api/youtube',
    body: { url: video.url, useZenSession: useZenSession === true, ...(automatic ? { publish: publish === true } : {}) },
  };
}

export function retryYoutubeRequest(failure, currentUrl, publish = failure?.publish) {
  if (!failure || failure.url !== String(currentUrl).trim()) return null;
  return youtubeRequest({ ...failure, publish: failure.publish === true && publish === true, useZenSession: true });
}

/** Holds no queue: finishing a task never starts another request. */
export function createYoutubeRunGate() {
  let active = false, lastAutomaticId = null;
  return {
    claim(request, trigger = 'submit') {
      const video = youtubeVideo(request?.body?.url);
      const automatic = request?.path === 'api/auto-convert';
      if (!video || active || (trigger === 'paste' && (!automatic || lastAutomaticId === video.id))) return false;
      active = true;
      if (automatic) lastAutomaticId = video.id;
      return true;
    },
    finish() { active = false; },
  };
}

export function scanRows(calibration, lineEdited = false) {
  if (lineEdited) return {};
  const rows = {};
  for (const key of ['whiteLine', 'blackLine']) {
    if (Number.isFinite(calibration?.[key]) && calibration[key] >= 0 && calibration[key] <= 1) rows[key] = calibration[key];
  }
  return rows;
}
