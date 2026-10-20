# Fallnote

Turn coloured falling-note piano tutorials into MIDI, then publish your saved songs to a GitHub Pages library.

**[Open the MIDI library](https://goodman-pro.github.io/fallnote/)**

## Run on Windows

Install [Node.js 22 or newer](https://nodejs.org/), [FFmpeg](https://ffmpeg.org/download.html), [yt-dlp](https://github.com/yt-dlp/yt-dlp), and [Git](https://git-scm.com/). Publishing also needs [GitHub CLI](https://cli.github.com/) signed in with `gh auth login`.

Clone this repository, then double-click **Start-Fallnote.cmd**, or run:

```sh
npm start
```

Open `http://127.0.0.1:8788`. There are no npm packages to install. The converter runs on your PC; GitHub Pages hosts the library and MIDI downloads.

## Convert a tutorial

1. Paste a YouTube link and load the video. Use a tutorial with a fixed, visible keyboard and solid coloured falling bars. If YouTube asks you to sign in, the optional Zen checkbox permits using your Zen YouTube session for that import only. It resets after each request. Without that explicit selection, Fallnote does not read browser cookies. Local MP4 uploads are available as a fallback.
2. Seek to a part with visible notes. Choose the visible keyboard range, align its left and right edges, and put the scan line just above the keys where solid bars pass. The first and last selected notes must be white keys.
3. Set a song title. Choose approximate hand splitting by pitch, or map the two bar colours to hands. Convert and listen to the result.
4. The MIDI is saved in your local library. Mark it reviewed after checking it, then choose **Publish library** to send the library to GitHub. Publishing includes song titles, artist labels, source names and MIDI files. Original videos stay on your PC.
5. Download a `.mid` from the published page on your computer, then use [Pianogram's website](https://pianogram.io/) to upload it to your account. Pianogram's [official listing](https://www.meta.com/experiences/pianogram/24123760907208210/) supports MIDI uploads from the web. Actual import and playback in a headset must be checked there.

The built-in **calibration exercise** is an original, generated test clip containing chords, black keys, long notes and repeated notes. Its known note sequence is used to check the complete video-to-MIDI path.

## What the converter can recover

This version uses deterministic computer vision, not a trained AI model. It reads coloured bars at a calibrated scan line and translates their position and duration into notes. It writes standard Type 1 MIDI with separate Left Hand and Right Hand tracks and an acoustic piano program.

- Timing is sampled at 24, 30 or 60 frames per second; gaps shorter than one sample can merge repeated notes.
- Colour mapping can preserve hands when the tutorial gives each hand a consistent colour. Pitch splitting is an approximation.
- Fixed velocity is used; note-bar visuals cannot reliably recover actual playing dynamics, sustain pedal or fingering.
- The MIDI tempo is 120 BPM as a time reference; original note timing is preserved in seconds. Musical beat/tempo estimation is not performed.
- Glows, particles, white bars, moving keyboards, perspective views and cropped notes can reduce accuracy. Use the time range to exclude intros and end screens, and the brightness threshold to exclude dim backgrounds. Review the output before practice.
- Tutorials are limited to 20 minutes and uploads to 750 MB.

## Publish your own library

This checkout targets `GOODMAN-PRO/fallnote`. For your own copy, set `FALLNOTE_REPOSITORY=your-account/your-repository`, use that repository as Git remote `origin`, and work on `main`.

Configure GitHub Pages to deploy from **main /docs**. The app commits and pushes `docs/library` when you click Publish library. It never puts GitHub tokens into the browser. A rejected Git push is shown as an error; reconcile remote changes before retrying.

If using a fork, update the static repository links in `docs/index.html` and `docs/app.mjs` as well. Do not expose the local server through a public tunnel.

## Development

```sh
npm test
npm run check
node scripts/verify-demo.mjs
node scripts/verify-preview.mjs
```

- `docs/`: static browser app and published library
- `lib/vision.mjs`: calibrated RGB/HSV note detector
- `lib/midi.mjs`: MIDI writer
- `lib/video.mjs`: video import, decoding, demo renderer
- `server.mjs`: loopback API and static server
- `.local/`: ignored videos and local logs

No audio or video is published. The library manifest is written atomically and changes are serialized. Conversions and downloads support cancellation; an in-progress Git publish finishes rather than cancelling halfway.
