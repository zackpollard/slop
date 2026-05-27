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
| `start-drive.wav` | Playful chiptune climb when navigation begins |
| `reroute.wav` | A "hmm…oh!" drop-then-rise — see note below |
| `speed-camera.wav` | Three-click camera shutter + two bright blips |
| `red-light-camera.wav` | Shutter + descending three-note fall |
| `police.wav` | Two rising siren whoops |
| `accident.wav` | Urgent alternating klaxon |
| `hazard.wav` | Two firm caution beeps |
| `traffic.wav` | Descending three-note "slowing down" motif |

> **Note on `reroute.wav`:** Waze's custom voice pack format doesn't include a
> rerouting/recalculating prompt slot (verified against the 42-file list and
> against community packs), so this sound is rendered and downloadable from
> the page but not bundled into the uploaded Waze pack. It's there to use as
> a phone notification/alert tone if you want.

## Using with Waze

Waze lets you build a **custom voice pack** by supplying one MP3 per prompt, and
plays an announcement by concatenating several of them (e.g. *"in 800 meters,
take the third exit"* = `800meters` + `Third` + `ExitRight`). To avoid three
beeps for one instruction, only the **action verbs** beep — the distance,
ordinal and connector files are shipped as a tiny silent MP3 (present so Waze
doesn't fall back to its default voice). The result is **one beep per
maneuver**, plus the loud distinct alerts for hazards.

| Source beep | Waze prompt(s) |
|-------------|----------------|
| `instruction.wav` | action verbs (`TurnLeft`, `TurnRight`, `KeepLeft`, `KeepRight`, `ExitLeft`, `ExitRight`, `Straight`, `uturn`, `Roundabout`) |
| `start-drive.wav` | trip-start prompts (`StartDrive1`–`9`) |
| `arrival.wav` | `Arrive` |
| `speed-camera.wav` | `ApproachSpeedCam` |
| `red-light-camera.wav` | `ApproachRedLightCam` |
| `police.wav` | `Police` |
| `accident.wav` | `ApproachAccident` |
| `hazard.wav` | `ApproachHazard` |
| `traffic.wav` | `ApproachTraffic` |
| _silent_ | distance prompts (`200`/`200meters`/`400`/…/`1500meters` — note `200`/`400`/`800`/`1500` double as imperial "0.1 mile" / "quarter mile" / "half mile" / "1 mile"), `AndThen`, ordinals (`First`–`Seventh`), `TickerPoints` |

### Installing a pack from a Waze link

Waze installs voice packs from a single link of the form
`https://waze.com/ul?acvp=<UUID>` — tapping it on a phone with Waze opens the app
and downloads that pack. The pack must live on Waze's own servers
(`<UUID>.tar.gz`); there is **no public web API**, so the website itself can't mint
a link. The link is created by uploading the pack to Waze, either via the in-app
recorder (mic, lower quality) or the file-upload route described below.

### Automated build + upload (CI)

The `.github/workflows/waze-pack.yml` workflow:

1. Renders the beeps to WAV by loading `index.html` in headless Chromium
   (`scripts/render-wavs.mjs`) — the page is the single source of truth for the sounds.
2. Encodes them to MP3 and maps each onto its Waze prompt filename (silent MP3
   for non-action prompts), keeping the pack under the **0.8 MB** aggregate limit
   (`scripts/build-pack.mjs`).
3. Clones the GPLv3 [waze-voicepack-links](https://github.com/pipeeeeees/waze-voicepack-links)
   uploader and runs it to mint a `https://waze.com/ul?acvp=<UUID>` install link.

What happens with the link depends on the trigger:

- **On a touching pull request** (`projects/waze-beep-sound-pack/**` or the workflow
  itself), it posts/updates a comment on the PR with the install link so you can
  install the preview pack on your phone and try it before merging. A fresh UUID is
  minted on every push.
- **On push to `main`** (i.e. after merging a touching PR) **or on
  `workflow_dispatch`** (for a manual re-mint), it commits the link to
  `projects/waze-beep-sound-pack/install-link.json` on `main` and explicitly
  triggers `deploy.yml` (pushes from `GITHUB_TOKEN` don't auto-trigger other
  workflows, which also conveniently stops this workflow from re-triggering itself
  on its own commit). The deployed site picks it up and renders the **Install on
  Waze** hero (link + QR code) at the top of the page.

It needs **no Waze account** (the uploader uses an anonymous session) and **no
secrets**. Caveats: it impersonates the Waze app via a reverse-engineered protobuf
protocol, so it likely breaks Waze's ToS and is fragile (pinned to a Waze app
version). The tool is GPLv3, so it is cloned and run at build time, never vendored
into this repo.

## Tech

Single self-contained `index.html`, no build step.
[JSZip](https://stuk.github.io/jszip/) (zip export) and
[qrcode](https://github.com/soldair/node-qrcode) (install QR) are loaded from CDN.
Everything runs client-side; the only network request beyond CDNs is a same-origin
fetch of `install-link.json` to render the install hero (gracefully hidden if absent).
The `scripts/` folder and the CI workflow are **not** part of the served site — they
exist only to build/upload the Waze pack and use Node (Playwright), ffmpeg and Python.

## Local development

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
