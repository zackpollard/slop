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

Waze lets you build a **custom voice pack** (one clip per spoken prompt). Assign
`instruction.wav` to every navigation prompt for a beeps-only experience, and use
`arrival.wav` for the arrival prompt. Waze's report-alert chimes (camera, police,
etc.) can't be replaced inside the app — use those alert sounds as phone/app alert
tones instead.

### Installing a pack from a Waze link

Waze installs voice packs from a single link of the form
`https://waze.com/ul?acvp=<UUID>` — tapping it on a phone with Waze opens the app
and downloads that pack. The pack must live on Waze's own servers
(`<UUID>.tar.gz`) and there is **no public web API** to upload one, so this site
can't generate a link directly. You mint the link through Waze itself, either:

1. **In-app recorder** — record a custom voice, then use Waze's *Share* button to
   get the `acvp` link (records via mic, so lower quality).
2. **File upload (best quality)** — supply MP3s named to Waze's exact prompt list,
   total **under 0.8 MB**, uploaded via the community tooling (Android emulator with
   file-system access); Waze returns the shareable `acvp` link.

Filename list and upload guides:
[github.com/pipeeeeees/waze-voicepack-links](https://github.com/pipeeeeees/waze-voicepack-links).

## Tech

Single self-contained `index.html`, no build step. [JSZip](https://stuk.github.io/jszip/)
is loaded from a CDN for the zip export. Everything runs client-side; nothing is uploaded.

## Local development

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
