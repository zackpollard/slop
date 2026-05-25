# waze-beep-sound-pack

A beeps-only Waze sound pack. One short attention beep for every turn instruction
(so it grabs your attention without reading the maneuver aloud), plus distinct,
deliberately loud alert sounds for speed cameras, red-light cameras, police,
crashes, hazards and heavy traffic that stay recognisable over music.

All sounds are synthesised live in the browser with the Web Audio API — the
preview is byte-for-byte what you download. Files export as 16-bit mono WAV,
either individually or as a single `waze-beeps.zip` pack.

## Sounds

| File | Purpose |
|------|---------|
| `instruction.wav` | Generic short beep for every navigation prompt |
| `arrival.wav` | "You have arrived" chime |
| `speed-camera.wav` | Three-click camera shutter + two bright blips |
| `red-light-camera.wav` | Shutter + descending three-note fall |
| `police.wav` | Two rising siren whoops |
| `accident.wav` | Urgent alternating klaxon |
| `hazard.wav` | Two firm caution beeps |
| `traffic.wav` | Descending three-note "slowing down" motif |

## Using with Waze

Waze lets you build a **custom voice pack** by supplying one MP3 per prompt. A pack
covers both navigation *and* the hazard warnings, so every sound here maps to a real
Waze prompt:

| Source beep | Waze prompt(s) |
|-------------|----------------|
| `instruction.wav` | all turns, exits, distances, ordinals, `StartDrive1`–`9`, `TickerPoints` |
| `arrival.wav` | `Arrive` |
| `speed-camera.wav` | `ApproachSpeedCam` |
| `red-light-camera.wav` | `ApproachRedLightCam` |
| `police.wav` | `Police` |
| `accident.wav` | `ApproachAccident` |
| `hazard.wav` | `ApproachHazard` |
| `traffic.wav` | `ApproachTraffic` |

### Installing a pack from a Waze link

Waze installs voice packs from a single link of the form
`https://waze.com/ul?acvp=<UUID>` — tapping it on a phone with Waze opens the app
and downloads that pack. The pack must live on Waze's own servers
(`<UUID>.tar.gz`); there is **no public web API**, so the website itself can't mint
a link. The link is created by uploading the pack to Waze, either via the in-app
recorder (mic, lower quality) or the file-upload route described below.

### Automated build + upload (CI)

The `.github/workflows/waze-pack.yml` workflow mints a link end-to-end:

1. Renders the beeps to WAV by loading `index.html` in headless Chromium
   (`scripts/render-wavs.mjs`) — the page is the single source of truth for the sounds.
2. Encodes them to MP3 and copies each onto its Waze prompt filename, keeping the
   pack under the **0.8 MB** aggregate limit (`scripts/build-pack.mjs`).
3. Clones the GPLv3 [waze-voicepack-links](https://github.com/pipeeeeees/waze-voicepack-links)
   uploader and runs it, printing the `https://waze.com/ul?acvp=<UUID>` install link
   in the run summary.

It needs **no Waze account** (the uploader uses an anonymous session) and **no
secrets**. Caveats: it impersonates the Waze app via a reverse-engineered protobuf
protocol, so it likely breaks Waze's ToS and is fragile (pinned to a Waze app
version). The tool is GPLv3, so it is cloned and run at build time, never vendored
into this repo. Currently triggered on push for iteration; intended to become
`workflow_dispatch`-only once stable. You only need to run it once per pack.

## Tech

Single self-contained `index.html`, no build step. [JSZip](https://stuk.github.io/jszip/)
is loaded from a CDN for the zip export. Everything runs client-side; nothing is uploaded.
The `scripts/` folder and the CI workflow are **not** part of the served site — they
exist only to build/upload the Waze pack and use Node (Playwright), ffmpeg and Python.

## Local development

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
