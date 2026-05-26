// Turn the rendered WAVs into a Waze-ready voice pack: encode each beep to MP3
// and copy it onto every matching Waze prompt filename. Output is a single
// directory of correctly-named .mp3 files, ready to drop into the
// waze-voicepack-links uploader's input_packs/<name>/.
//
// Why most prompts get silence (the SILENT mapping below):
// Waze plays a single announcement by concatenating several prompt files
// (e.g. "in 800 meters take the third exit" = 800meters + Third + ExitRight).
// If every file beeps, you hear three rapid beeps for one instruction, which
// is what the first revision of this pack did. So only the action verbs
// (TurnLeft, ExitRight, etc.) beep; the distance/ordinal/connector files are
// shipped as a tiny silent MP3 — present in the pack so Waze doesn't fall
// back to its default voice, but inaudible so each maneuver gets one beep.
//
// Usage: node build-pack.mjs <wav-dir> <output-pack-dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

const wavDir = resolve(process.argv[2] || "./_wavs");
const outDir = resolve(process.argv[3] || "./_pack");

// Source key meaning "generate a silent MP3 here" — there's no silent.wav from
// the page; we synthesise it with ffmpeg's anullsrc filter.
const SILENT = "__silent__";

const MAP = {
  // Action verbs — these beep, exactly once per maneuver.
  "instruction.wav": [
    "TurnLeft", "TurnRight", "KeepLeft", "KeepRight",
    "ExitLeft", "ExitRight", "Straight", "uturn",
  ],
  "arrival.wav": ["Arrive"],
  "speed-camera.wav": ["ApproachSpeedCam"],
  "red-light-camera.wav": ["ApproachRedLightCam"],
  "accident.wav": ["ApproachAccident"],
  "hazard.wav": ["ApproachHazard"],
  "traffic.wav": ["ApproachTraffic"],
  "police.wav": ["Police"],
  // Silent files: distances, roundabout/ordinal connectors, drive-start chimes,
  // points ticker. Present so Waze doesn't speak them, inaudible so a
  // multi-file announcement only beeps once on the action verb.
  [SILENT]: [
    "200", "200meters", "400", "400meters", "800", "800meters",
    "1000meters", "1500", "1500meters",
    "AndThen", "Roundabout",
    "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh",
    "StartDrive1", "StartDrive2", "StartDrive3", "StartDrive4", "StartDrive5",
    "StartDrive6", "StartDrive7", "StartDrive8", "StartDrive9",
    "TickerPoints",
  ],
};

const tmp = outDir + "_src";
rmSync(outDir, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(tmp, { recursive: true });

function encode(source) {
  const stem = source === SILENT ? "silent" : source.replace(/\.wav$/, "");
  const mp3 = join(tmp, stem + ".mp3");
  // Mono, modest sample rate / bitrate — short clips, well under Waze's
  // 0.8 MB aggregate cap even copied across the full prompt list.
  const args = source === SILENT
    ? ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
       "-t", "0.1", "-ac", "1", "-b:a", "48k", mp3]
    : ["-y", "-loglevel", "error", "-i", join(wavDir, source),
       "-ac", "1", "-ar", "22050", "-b:a", "48k", mp3];
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  return mp3;
}

let total = 0;
for (const [source, names] of Object.entries(MAP)) {
  const mp3 = encode(source);
  for (const name of names) {
    copyFileSync(mp3, join(outDir, name + ".mp3"));
    total++;
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`built ${total} prompt file(s) in ${outDir}`);
