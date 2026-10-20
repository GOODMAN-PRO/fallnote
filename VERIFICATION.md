# Verification

Checked on 20 October 2026.

- `npm test`: 47 passing tests. Covers MIDI event timing and structure, piano geometry, note detection, brightness, repetitions, local HTTP security, file ranges, library persistence, request validation, scoped Zen profile selection using isolated fake profiles, and YouTube error classification with exact-URL retry binding.
- `npm run check`: server and browser JavaScript syntax passes.
- `node scripts/verify-demo.mjs`: generated H.264 tutorial decodes into all 14 expected notes, with matching pitches, hands, onset times and durations within frame tolerance. Output is a valid Type 1 MIDI file.
- Browser: demo import, conversion progress, the 14-note result, library listing, source calibration restoration and Web Audio preview controls exercised. The Publish library button successfully committed a metadata update and pushed it to GitHub.
- GitHub Pages deployed successfully. The published song download returns the same 7,439 MIDI bytes as the local file (SHA-256 `7c4141b0f4b9d719246b0461366437dbc0489aacb50294d1015643801ed5ab94`).
- Supplied YouTube tutorial: downloaded after explicit one-video Zen-session permission. Converted the first 104 seconds using a 60 FPS sample rate, calibrated cyan/green colours and a brightness threshold. Result: 861 notes, 101.33 seconds, separate hand tracks. Excluded the unrelated end screen.
- Second tutorial (`cStbWxTQTJo`): imported successfully after separate explicit permission to use Zen for that video. Its 171-second preview reloads through the local source link. This second source has not been converted or published.

The real tutorial is not compared to an authoritative MIDI score. Its library entry remains unreviewed. Pianogram import and headset playback are not tested; the app's official listing supports uploading MIDI from the web.

Original video and authentication data are not part of the published library.
