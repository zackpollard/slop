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

## Tech

Single self-contained `index.html`, no build step. [JSZip](https://stuk.github.io/jszip/)
is loaded from a CDN for the zip export. Everything runs client-side; nothing is uploaded.

## Local development

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
