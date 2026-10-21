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

1. Open the **local PC app**. Automatic conversion is on by default: paste a complete YouTube video link to import, align and convert it. You can also use Enter or the import button. Use a tutorial with a fixed digital keyboard, coloured key presses and matching piano audio. The public GitHub page links to the PC converter and hosts the finished downloads.
2. Fallnote detects the keyboard edges, visible key range, hand colours and tutorial time range. It checks the octave against the audio and can read white and black keys at separate heights to avoid obscured notes. If it cannot confirm the alignment, it loads the video for manual adjustment and does not convert or publish it automatically.
3. Listen to the result. For manual control, turn off automatic conversion before importing, seek to visible notes, align the keyboard edges and scan line, and choose the visible note range. The first and last notes must be white keys. Choose approximate hand splitting by pitch, or map the two hand colours. Moving the scan-line slider replaces an automatic two-height scan with a manual single line.
4. **Publish to my VR library** is on by default. After conversion, Fallnote saves the MIDI on your PC, publishes the library to GitHub, and checks that the public download is live. Wait for **Ready in your VR library** before switching your PC off. Publishing includes song titles, artist labels, source names and MIDI files; original videos stay on your PC. Turn this option off to keep this conversion local until the next time you publish the library. If publishing fails, the MIDI stays saved and **Publish library** retries without reconverting.
5. Download a `.mid` from the published page and import it directly in Pianogram on your headset. The library's **Kiss of Death - Easy Piano** file has been confirmed to display notes through this route. New conversions still need their own playback and note-accuracy checks.

The PC is needed for conversion and publishing. Once the website says the song is ready, the GitHub Pages downloads remain available with the PC switched off. Renaming or removing a local song still needs **Publish library** to update the public website.

If YouTube asks you to sign in, the optional Zen checkbox permits using your Zen YouTube session for that import only. It resets after each request. Without that explicit selection, Fallnote does not read browser cookies. Pasting a link never silently grants browser-session access. Local MP4 uploads remain available for manual conversion.

The built-in **calibration exercise** is an original, generated test clip containing chords, black keys, long notes and repeated notes. Its known note sequence is used to check the complete video-to-MIDI path.

## What the converter can recover

This version uses deterministic computer vision and audio analysis, not a trained AI model. It reads coloured bars or key presses at calibrated scan heights and translates their position and duration into notes. Audio helps establish the octave; note timing and duration still come from the video. It writes standard Type 1 MIDI with separate Left Hand and Right Hand tracks and an acoustic piano program.

- Timing is sampled at 24, 30 or 60 frames per second; gaps shorter than one sample can merge repeated notes.
- Colour mapping can preserve hands when the tutorial gives each hand a consistent colour. Pitch splitting is an approximation.
- Fixed velocity is used; note-bar visuals cannot reliably recover actual playing dynamics, sustain pedal or fingering.
- The MIDI tempo is 120 BPM with an explicit 4/4 time signature as a time reference; original note timing is preserved in seconds. Musical meter/tempo estimation is not performed. Explicit meter fixed a confirmed Pianogram import that played audio but showed no notes.
- Glows, particles, white bars, moving keyboards, perspective views and cropped notes can reduce accuracy. Use the time range to exclude intros and end screens, and the brightness threshold to exclude dim backgrounds. Review the output before practice.
- Tutorials are limited to 20 minutes and uploads to 750 MB.

## Publish your own library

This checkout targets `GOODMAN-PRO/fallnote`. For your own copy, set `FALLNOTE_REPOSITORY=your-account/your-repository`, use that repository as Git remote `origin`, and work on `main`.

Configure GitHub Pages to deploy from **main /docs**. The app commits and pushes `docs/library` after conversion (unless automatic publishing is turned off), or when you click **Publish library**. It never puts GitHub tokens into the browser and refuses to push unrelated unpublished app commits. A rejected Git push is shown as an error; reconcile remote changes before retrying. A successful push alone is labelled as updating until the public manifest and MIDI bytes match. If that check times out, publishing is pending, not verified ready.

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
- `lib/autocalibrate.mjs`: keyboard geometry, hand colours, audio octave check and confidence gate
- `lib/midi.mjs`: MIDI writer
- `lib/video.mjs`: video import, decoding, demo renderer
- `server.mjs`: loopback API and static server
- `.local/`: ignored videos and local logs

No audio or video is published. The library manifest is written atomically and changes are serialized. Conversions and downloads support cancellation; an in-progress Git publish finishes rather than cancelling halfway.
