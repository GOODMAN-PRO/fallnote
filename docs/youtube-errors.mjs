/** Describe the final failure, rather than a warning earlier in yt-dlp output. */
export function youtubeErrorPresentation(diagnostic, usedZenSession = false) {
  const details = String(diagnostic || 'The import failed without a diagnostic.');
  const errors = [...details.matchAll(/\bERROR:\s*/gi)];
  const finalError = errors.length ? details.slice(errors.at(-1).index + errors.at(-1)[0].length) : details;
  const normalized = finalError.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const signInRequired = /\bsign[\s-]*in (?:to|before|required)|\blog[\s-]*in (?:to|before|required)|confirm (?:that )?you(?:'re| are) not a bot|authentication (?:is )?required/i.test(normalized);
  if (signInRequired) {
    return {
      kind: 'sign-in',
      message: usedZenSession
        ? 'YouTube rejected the signed-in attempt for this video.'
        : 'YouTube requires a sign-in check before this video can be imported.',
      advice: usedZenSession
        ? 'Open this video in Zen and check that you can watch it while signed in. You can retry with Zen or upload a video file; signing in does not guarantee YouTube will accept the import.'
        : 'Retry using your YouTube sign-in in Zen, or upload a video file.',
      offerZenRetry: true,
      details,
    };
  }
  if (/\b(?:HTTP(?:\s+Error)?\s*403|403\s*:\s*Forbidden)\b/i.test(normalized)) {
    return {
      kind: 'forbidden',
      message: usedZenSession
        ? 'YouTube rejected the signed-in download for this video.'
        : 'YouTube refused this video download (403).',
      advice: usedZenSession
        ? 'Check that this video plays while signed in to YouTube in Zen. You can try again or upload a video file; YouTube may still reject the download.'
        : 'You can try your YouTube sign-in in Zen for this video, or upload a video file. A signed-in retry may still be blocked.',
      offerZenRetry: true,
      details,
    };
  }
  let message = 'This YouTube video could not be imported. Check the details below, or upload a video file.';
  if (/\b(?:private video|video unavailable|video is unavailable|video has been removed|video has been deleted)\b/i.test(normalized)) {
    message = 'This video is unavailable to the importer. Check the link, or upload a video file.';
  } else if (/\b(?:429|too many requests|rate.limit)/i.test(normalized)) {
    message = 'YouTube is limiting requests. Wait before retrying, or upload a video file.';
  } else if (/\b(?:timed? out|timeout|ENOTFOUND|ECONNRESET|network is unreachable|unable to download webpage)\b/i.test(normalized)) {
    message = 'The import could not connect to YouTube. Check your connection and retry, or upload a video file.';
  } else if (/\bZen\b.*(?:profile|cookies|install)|(?:profile|cookies).*\bZen\b/i.test(normalized)) {
    message = 'Fallnote could not use your Zen sign-in. Open Zen, sign in to YouTube, then choose the sign-in option for a new attempt.';
  }
  return { kind: 'other', message, advice: '', offerZenRetry: false, details };
}

/** A retry must match the literal failed URL and an ordinary YouTube URL. */
export function youtubeRetryRequest(failedUrl, currentUrl) {
  if (typeof failedUrl !== 'string' || !failedUrl || failedUrl !== String(currentUrl).trim()) return null;
  try {
    const url = new URL(failedUrl);
    const host = url.hostname.toLowerCase();
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        !(host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be')) return null;
    return { url: failedUrl, useZenSession: true };
  } catch { return null; }
}
