// Turn the rendered WAVs into a Waze-ready voice pack: encode each beep to MP3
// and copy it onto every matching Waze prompt filename. Output is a single
// directory of correctly-named .mp3 files, ready to drop into the
// waze-voicepack-links uploader's input_packs/<name>/.
//
// Usage: node build-pack.mjs <wav-dir> <output-pack-dir>

import { execFileSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

const wavDir = resolve(process.argv[2] || "./_wavs");
const outDir = resolve(process.argv[3] || "./_pack");

// Map each source beep onto the Waze prompt filenames it should cover.
// The full valid list lives in the uploader's valid_waze_filenames.txt.
const MAP = {
  "instruction.wav": [
    "200", "200meters", "400", "400meters", "800", "800meters",
    "1000meters", "1500", "1500meters", "AndThen",
    "ExitLeft", "ExitRight", "KeepLeft", "KeepRight",
    "Roundabout", "Straight", "TurnLeft", "TurnRight", "uturn",
    "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh",
    "StartDrive1", "StartDrive2", "StartDrive3", "StartDrive4", "StartDrive5",
    "StartDrive6", "StartDrive7", "StartDrive8", "StartDrive9",
    "TickerPoints",
  ],
  "arrival.wav": ["Arrive"],
  "speed-camera.wav": ["ApproachSpeedCam"],
  "red-light-camera.wav": ["ApproachRedLightCam"],
  "accident.wav": ["ApproachAccident"],
  "hazard.wav": ["ApproachHazard"],
  "traffic.wav": ["ApproachTraffic"],
  "police.wav": ["Police"],
};

const tmp = outDir + "_src";
rmSync(outDir, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(tmp, { recursive: true });

let total = 0;
for (const [wav, names] of Object.entries(MAP)) {
  const src = join(wavDir, wav);
  const mp3 = join(tmp, wav.replace(/\.wav$/, ".mp3"));
  // Mono, modest sample rate / bitrate — these are short beeps, so this keeps
  // the whole pack comfortably under Waze's 0.8 MB aggregate limit.
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "22050", "-b:a", "48k", mp3],
    { stdio: "inherit" }
  );
  for (const name of names) {
    copyFileSync(mp3, join(outDir, name + ".mp3"));
    total++;
  }
}

rmSync(tmp, { recursive: true, force: true });
console.log(`built ${total} prompt file(s) in ${outDir}`);
