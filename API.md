# Fallnote implementation contract

Node ES modules, no runtime npm dependencies.

## Owner boundaries

Root owns server.mjs, lib/video.mjs, lib/library.mjs, package.json, README, scripts and deployment.
UI agent owns docs/index.html, docs/style.css, docs/app.mjs, docs/favicon.svg.
Engine agent owns lib/vision.mjs, lib/midi.mjs, tests/vision.test.mjs, tests/midi.test.mjs.

## Public site

Static files in docs/. GitHub Pages serves the read-only published library. Local Node serves the same files plus API. Use relative URL paths for all static files, including library/manifest.json. It contains {version:1,songs:[]}. Song MIDI file paths are root-relative-to-app, e.g. library/midi/UUID.mid.

## API (same origin, local only)

GET /api/status -> {local:true,dependencies:{ffmpeg:boolean,ffprobe:boolean,ytdlp:boolean,github:boolean},repository:"GOODMAN-PRO/fallnote",publishedUrl:"https://goodman-pro.github.io/fallnote/",version:"1.0.0"}

POST /api/videos with raw file body, Content-Type application/octet-stream, X-Filename encodeURIComponent(filename). -> video object {sourceId,name,url:"/media/UUID.mp4",duration,width,height}.

POST /api/youtube JSON {url,useZenSession?:true} -> {jobId}. Browser session access requires the user to explicitly select the one-video checkbox; default is disabled and consent is never persisted. GET /api/jobs/:id -> {id,type,status:"running"|"completed"|"failed"|"cancelled",progress:0..1,message,result?,error?}. Completed YouTube result is video object.

POST /api/convert JSON {sourceId,title,artist,calibration:{left:0..1,right:0..1,line:0..1,firstMidi:21,lastMidi:108},options:{fps:30,saturation:0.3,brightness:0.25,minNote:0.08,splitMidi:60,trim:true,handMode:"pitch"|"color",leftHue:200,rightHue:120,startTime:0,endTime:video.duration}} -> {jobId}. Completed conversion result {song,notes:[{pitch,start,duration,velocity,hand:"left"|"right"}]}. Song saved locally automatically.

POST /api/jobs/:id/cancel JSON {} -> {ok:true}.

GET /library/manifest.json -> {version:1,songs:[{id,title,artist,createdAt,duration,noteCount,file,method:"visual",handMode,sourceName,reviewed:false}]}.

POST /api/publish JSON {} -> {jobId}; completion {url}. Publishes saved library files with git to the configured repository. No GitHub credentials enter the browser.

DELETE /api/library/:id -> {ok:true} local removal; publish again to remove from public.

PATCH /api/library/:id JSON {title?,artist?,reviewed?} -> {song}.

POST /api/demo JSON {} -> video object. Generates a clearly labelled synthetic calibration exercise video with known chords, repeated notes, black keys and two hand colours. For end-to-end checks.

All writes require application/json except video upload; server verifies Host/Origin same-origin. Failed requests return {error} and a non-2xx code. Local uploads stay in ignored .local/; only MIDI+metadata publish. Poll jobs every ~800ms. Never expose tokens or implement GitHub login in browser.

## Engine API

vision.mjs exports:
- keyboardLanes({left,right,firstMidi,lastMidi}) -> [{pitch,x,width,black}] with normalized x/width, piano white-key geometry.
- createDetector({width,height,fps,calibration,options}) -> {pushFrame(rgbUint8Array,timeSeconds),finish(endSeconds): notes[]}. Use RGB24. Handle hues/low saturation, minNote, gaps, pitch split or calibrated hue split, trim leading silence if requested. Keep original event times until finish. All numeric inputs validate in constructor. Note durations seconds, velocity 90 default. Frame detections at calibrated line with narrow horizontal lane samples; avoid false adjacent lane detections with black key neighbor awareness.

midi.mjs exports:
- encodeMidi(notes,{title,tempo=120}={}) -> Uint8Array, standard MIDI type 1, PPQ480, conductor and two named hand tracks, piano program, real time through tempo.
- validateNotes(notes) -> normalized/validated notes, throw on invalid.

## UI

Brand seed: oklch(0.5 0.16 280), white background, dark readable text, restrained accent. Product UI with compact header, tabs Convert/Library, substantial video workbench and an adjacent control panel. Static GitHub mode opens Library and explains conversion runs via local app, offering repository setup link. Local mode offers uploads and URL. Calibration controls for first/last MIDI (named presets 88 A0-C8, 61 C2-C7, 76 E1-G7), left/right margins and strike line. Overlay canvas lines and note markers over video; changes update overlay. Preview seek slider. Clearly explain adjusting scan line just above keyboard, where flat note bars pass (away from glow/particles). Provide demo button for a functional first run. Conversion progress/cancel, editable song title/artist, MIDI download, Web Audio note preview (cancelable), searchable library and publish status with error messages. Responsive and accessible. Don't claim "AI model" or guaranteed transcription; this uses visual note detection.
