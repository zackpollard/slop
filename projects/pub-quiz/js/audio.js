/**
 * audio.js — the entire sound design of the pub quiz, synthesised at runtime.
 *
 * Zero dependencies, zero assets, zero network. Everything you hear (UI blips,
 * buzzers, applause, the four background music beds and the "name that tune"
 * melodies) is generated from oscillators and one shared noise buffer via the
 * Web Audio API.
 *
 * Design notes for whoever maintains this:
 *  - Nothing is created until unlock() is called from a real user gesture.
 *    Browsers (and iOS especially) refuse to start an AudioContext otherwise.
 *  - Every voice is a short-lived source node with an onended handler that
 *    disconnects its little chain. A 90-minute quiz makes tens of thousands of
 *    them; none of them are allowed to stick around.
 *  - Music is scheduled ahead of the audio clock (lookahead scheduler), never
 *    started from a timer callback, so it does not drift or stutter.
 *  - Every public method is a silent no-op if Web Audio is missing or the
 *    context has not been unlocked yet. Nothing in here should ever throw.
 *
 * Signal graph:
 *
 *   sfxBus ────────────────┐
 *   musicBus ─> musicDuck ─┼─> duckGain ─> masterGain ─> compressor ─> out
 *   melodyBus ─────────────┘
 *
 * Reverb is an aux per destination, never a global one: a voice's send feeds a
 * convolver whose return lands back in that voice's own bus (the sfx bus, the
 * music *layer*, the melody bus). That is the only way a fader, a crossfade or
 * stopMelody() takes the wet signal down with the dry one — a shared return
 * wired into the master would keep playing whatever you just turned off.
 */

// ---- capability detection ----

const AC = (typeof globalThis !== 'undefined' &&
    (globalThis.AudioContext || globalThis.webkitAudioContext)) || null;

// ---- tuning constants ----

const MUSIC_LOOKAHEAD = 1.6;   // seconds of music scheduled beyond the clock
const MUSIC_POLL = 260;        // ms between music scheduler wake-ups
const TICK_LOOKAHEAD = 1.0;    // seconds of countdown ticks scheduled ahead
const TICK_POLL = 200;         // ms between tick scheduler wake-ups
const DUCK_LEVEL = 0.25;       // ~ -12 dB while somebody is talking
const MELODY_DUCK = 0.12;      // the bed gets out of the way of a played tune
const RESUME_TIMEOUT = 1500;   // ms before we stop waiting on ctx.resume()
const DEFAULT_MUSIC_FADE = 1.0;
const DEFAULT_STOP_FADE = 0.8;
const NOISE_SECONDS = 2;       // length of the shared white-noise buffer

// ---- note helpers ----

const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_RE = /^([A-Ga-g])([#b]*)(-?\d+)$/;
const freqCache = new Map();

/**
 * Scientific pitch name -> frequency in Hz. "C4" is middle C, "A4" is 440 Hz.
 * Accepts sharps and flats ("F#5", "Eb4", "Bbb3"). Anything unparseable — most
 * usefully the string "rest" — returns 0, which every voice treats as silence.
 */
export function noteToFreq(name) {
    if (typeof name !== 'string') return 0;
    const cached = freqCache.get(name);
    if (cached !== undefined) return cached;
    const m = NOTE_RE.exec(name.trim());
    if (!m) {
        freqCache.set(name, 0);
        return 0;
    }
    let semis = SEMITONE[m[1].toUpperCase()];
    for (const ch of m[2]) semis += ch === '#' ? 1 : -1;
    const midi = (parseInt(m[3], 10) + 1) * 12 + semis;
    const hz = 440 * Math.pow(2, (midi - 69) / 12);
    freqCache.set(name, hz);
    return hz;
}

// ---- melodies -------------------------------------------------------------
//
// Every tune below was written before 1900 and is comfortably in the public
// domain worldwide; only the arrangement (these note lists) is ours.
//
// `notes` is a list of [pitch, beats] pairs. `pitch` is a scientific pitch name
// or 'rest'. `beats` is measured in the melody's own `bpm`, so for a tune whose
// natural unit is the quaver you simply set bpm to the quaver rate — see
// greensleeves. Add new tunes by copying the shape; nothing else needs editing.

export const MELODIES = {
    beethoven5: {
        title: "Symphony No. 5 in C minor (opening)",
        composer: "Ludwig van Beethoven",
        year: 1808,
        note: "Public domain — first published 1808.",
        bpm: 176,
        notes: [
            ['rest', 0.5], ['G4', 0.5], ['G4', 0.5], ['G4', 0.5], ['Eb4', 3], ['rest', 0.5],
            ['F4', 0.5], ['F4', 0.5], ['F4', 0.5], ['D4', 6], ['rest', 0.5], ['G4', 0.5], ['G4', 0.5],
            ['G4', 0.5], ['Eb4', 3], ['rest', 0.5], ['F4', 0.5], ['F4', 0.5], ['F4', 0.5], ['D4', 6],
        ],
    },

    odeToJoy: {
        title: "Ode to Joy (Symphony No. 9, finale theme)",
        composer: "Ludwig van Beethoven",
        year: 1824,
        note: "Public domain — first performed 1824.",
        bpm: 124,
        notes: [
            ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1], ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
            ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['E4', 1.5], ['D4', 0.5], ['D4', 2],
            ['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1], ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
            ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['D4', 1.5], ['C4', 0.5], ['C4', 2],
        ],
    },

    furElise: {
        title: "Bagatelle No. 25 in A minor, \"Für Elise\"",
        composer: "Ludwig van Beethoven",
        year: 1810,
        note: "Public domain — composed 1810, published 1867.",
        bpm: 116,
        notes: [
            ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['B4', 0.25],
            ['D5', 0.25], ['C5', 0.25], ['A4', 0.75], ['C4', 0.25], ['E4', 0.25], ['A4', 0.25],
            ['B4', 0.75], ['E4', 0.25], ['G#4', 0.25], ['B4', 0.25], ['C5', 0.75], ['E4', 0.25],
            ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['B4', 0.25],
            ['D5', 0.25], ['C5', 0.25], ['A4', 0.75], ['C4', 0.25], ['E4', 0.25], ['A4', 0.25],
            ['B4', 0.75], ['E4', 0.25], ['C5', 0.25], ['B4', 0.25], ['A4', 1.5], ['E5', 0.25],
            ['D#5', 0.25], ['E5', 0.25], ['D#5', 0.25], ['E5', 0.25], ['B4', 0.25], ['D5', 0.25],
            ['C5', 0.25], ['A4', 0.75], ['C4', 0.25], ['E4', 0.25], ['A4', 0.25], ['B4', 0.75],
            ['E4', 0.25], ['C5', 0.25], ['B4', 0.25], ['A4', 1.5],
        ],
    },

    eineKleineNachtmusik: {
        title: "Eine kleine Nachtmusik, K.525 (Allegro)",
        composer: "Wolfgang Amadeus Mozart",
        year: 1787,
        note: "Public domain — composed 1787.",
        bpm: 132,
        notes: [
            ['G4', 1], ['rest', 0.5], ['D4', 0.5], ['G4', 1], ['rest', 0.5], ['D4', 0.5], ['G4', 0.5],
            ['D4', 0.5], ['G4', 0.5], ['B4', 0.5], ['D5', 1], ['rest', 1], ['C5', 1], ['rest', 0.5],
            ['A4', 0.5], ['C5', 1], ['rest', 0.5], ['A4', 0.5], ['C5', 0.5], ['A4', 0.5], ['F#4', 0.5],
            ['A4', 0.5], ['D4', 1], ['rest', 1], ['G4', 1], ['rest', 0.5], ['D4', 0.5], ['G4', 1],
            ['rest', 0.5], ['D4', 0.5], ['G4', 0.5], ['D4', 0.5], ['G4', 0.5], ['B4', 0.5], ['D5', 2],
        ],
    },

    blueDanube: {
        title: "An der schönen blauen Donau (The Blue Danube)",
        composer: "Johann Strauss II",
        year: 1866,
        note: "Public domain — composed 1866.",
        bpm: 168,
        notes: [
            ['D4', 1], ['D4', 1], ['F#4', 1], ['A4', 1], ['A4', 2], ['A5', 0.5], ['rest', 0.5],
            ['A5', 1], ['rest', 1], ['F#5', 0.5], ['rest', 0.5], ['F#5', 1], ['rest', 1], ['D4', 1],
            ['D4', 1], ['F#4', 1], ['A4', 1], ['A4', 2], ['A5', 0.5], ['rest', 0.5], ['A5', 1],
            ['rest', 1], ['G5', 0.5], ['rest', 0.5], ['G5', 1], ['rest', 1], ['C#4', 1], ['C#4', 1],
            ['E4', 1], ['B4', 1], ['B4', 2], ['B5', 0.5], ['rest', 0.5], ['B5', 1], ['rest', 1],
            ['G5', 0.5], ['rest', 0.5], ['G5', 2],
        ],
    },

    williamTell: {
        title: "William Tell Overture (final galop)",
        composer: "Gioachino Rossini",
        year: 1829,
        note: "Public domain — first performed 1829.",
        bpm: 152,
        notes: [
            ['B4', 0.25], ['B4', 0.25], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25], ['B4', 0.5],
            ['B4', 0.25], ['B4', 0.25], ['E5', 0.5], ['F#5', 0.5], ['G#5', 0.5], ['B4', 0.25],
            ['B4', 0.25], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25], ['E5', 0.5], ['G#5', 0.25],
            ['G#5', 0.25], ['F#5', 0.5], ['D#5', 0.5], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25],
            ['B4', 0.5], ['B4', 0.25], ['B4', 0.25], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25],
            ['E5', 0.5], ['F#5', 0.5], ['G#5', 0.5], ['E5', 0.25], ['G#5', 0.25], ['B5', 1.25],
            ['A5', 0.25], ['G#5', 0.25], ['F#5', 0.25], ['E5', 0.5], ['G#5', 0.5], ['E5', 0.5],
            ['B4', 0.25], ['B4', 0.25], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25], ['B4', 0.5],
            ['B4', 0.25], ['B4', 0.25], ['E5', 0.5], ['F#5', 0.5], ['G#5', 0.5], ['B4', 0.25],
            ['B4', 0.25], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25], ['E5', 0.5], ['G#5', 0.25],
            ['G#5', 0.25], ['F#5', 0.5], ['D#5', 0.5], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25],
            ['B4', 0.5], ['B4', 0.25], ['B4', 0.25], ['B4', 0.5], ['B4', 0.25], ['B4', 0.25],
            ['E5', 0.5], ['F#5', 0.5], ['G#5', 0.5], ['E5', 0.25], ['G#5', 0.25], ['B5', 1.25],
            ['A5', 0.25], ['G#5', 0.25], ['F#5', 0.25], ['E5', 0.5], ['G#5', 0.5], ['E5', 2],
        ],
    },

    mountainKing: {
        title: "In the Hall of the Mountain King (Peer Gynt)",
        composer: "Edvard Grieg",
        year: 1875,
        note: "Public domain — composed 1875.",
        bpm: 138,
        notes: [
            ['B3', 0.5], ['C#4', 0.5], ['D4', 0.5], ['E4', 0.5], ['F#4', 0.5], ['D4', 0.5], ['F#4', 1],
            ['F4', 0.5], ['C#4', 0.5], ['F4', 1], ['E4', 0.5], ['C4', 0.5], ['E4', 1], ['B3', 0.5],
            ['C#4', 0.5], ['D4', 0.5], ['E4', 0.5], ['F#4', 0.5], ['D4', 0.5], ['F#4', 0.5],
            ['B4', 0.5], ['A4', 0.5], ['F#4', 0.5], ['D4', 0.5], ['F#4', 0.5], ['A4', 2], ['B4', 0.5],
            ['C#5', 0.5], ['D5', 0.5], ['E5', 0.5], ['F#5', 0.5], ['D5', 0.5], ['F#5', 1], ['F5', 0.5],
            ['C#5', 0.5], ['F5', 1], ['E5', 0.5], ['C5', 0.5], ['E5', 1], ['B4', 0.5], ['C#5', 0.5],
            ['D5', 0.5], ['E5', 0.5], ['F#5', 0.5], ['D5', 0.5], ['F#5', 0.5], ['B5', 0.5], ['A5', 0.5],
            ['F#5', 0.5], ['D5', 0.5], ['F#5', 0.5], ['A5', 2],
        ],
    },

    canonInD: {
        title: "Canon in D major",
        composer: "Johann Pachelbel",
        year: 1680,
        note: "Public domain — composed c.1680.",
        bpm: 112,
        notes: [
            ['F#5', 2], ['E5', 2], ['D5', 2], ['C#5', 2], ['B4', 2], ['A4', 2], ['B4', 2], ['C#5', 2],
            ['D5', 1], ['F#5', 1], ['A5', 1], ['G5', 1], ['F#5', 1], ['D5', 1], ['F#5', 1], ['E5', 1],
        ],
    },

    twinkle: {
        title: "Twinkle, Twinkle, Little Star (Ah! vous dirai-je, maman)",
        composer: "Traditional French, arr. Mozart",
        year: 1761,
        note: "Public domain — melody published 1761.",
        bpm: 132,
        notes: [
            ['C4', 1], ['C4', 1], ['G4', 1], ['G4', 1], ['A4', 1], ['A4', 1], ['G4', 2], ['F4', 1],
            ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 1], ['D4', 1], ['C4', 2], ['G4', 1], ['G4', 1],
            ['F4', 1], ['F4', 1], ['E4', 1], ['E4', 1], ['D4', 2],
        ],
    },

    greensleeves: {
        title: "Greensleeves",
        composer: "Traditional English",
        year: 1580,
        note: "Public domain — registered 1580, composer unknown.",
        bpm: 220,
        notes: [
            ['A4', 1], ['C5', 2], ['D5', 1], ['E5', 1.5], ['F5', 0.5], ['E5', 1], ['D5', 2],
            ['B4', 1], ['G4', 1.5], ['A4', 0.5], ['B4', 1], ['C5', 2], ['A4', 1], ['A4', 1.5],
            ['G#4', 0.5], ['A4', 1], ['B4', 2], ['G#4', 1], ['E4', 2], ['A4', 1], ['C5', 2],
            ['D5', 1], ['E5', 1.5], ['F5', 0.5], ['E5', 1], ['D5', 2], ['B4', 1], ['G4', 1.5],
            ['A4', 0.5], ['B4', 1], ['C5', 1.5], ['B4', 0.5], ['A4', 1], ['G#4', 1.5], ['F#4', 0.5],
            ['G#4', 1], ['A4', 3], ['A4', 2], ['rest', 1],
        ],
    },

    ruleBritannia: {
        title: "Rule, Britannia!",
        composer: "Thomas Arne",
        year: 1740,
        note: "Public domain — composed 1740.",
        bpm: 96,
        notes: [
            ['A4', 0.5], ['D5', 1], ['D5', 1], ['D5', 0.25], ['E5', 0.25], ['F#5', 0.25], ['G5', 0.25],
            ['A5', 0.5], ['D5', 0.5], ['E5', 1.5], ['F#5', 0.25], ['G5', 0.25], ['F#5', 1], ['rest', 0.5],
            ['A4', 0.5], ['D5', 0.25], ['E5', 0.25], ['D5', 0.25], ['E5', 0.25], ['F#5', 0.25],
            ['G5', 0.25], ['F#5', 0.25], ['G5', 0.25], ['A5', 0.5], ['E5', 0.5], ['F#5', 0.5],
            ['E5', 0.5], ['D5', 0.5], ['E5', 0.25], ['F#5', 0.25], ['E5', 0.5], ['D5', 0.5],
            ['C#5', 2],
        ],
    },

    swanLake: {
        title: "Swan Lake (Scene, Act II)",
        composer: "Pyotr Ilyich Tchaikovsky",
        year: 1876,
        note: "Public domain — composed 1875-76.",
        bpm: 84,
        notes: [
            ['F#5', 2], ['B4', 0.5], ['C#5', 0.5], ['D5', 0.5], ['E5', 0.5], ['F#5', 1.5], ['D5', 0.5],
            ['F#5', 1.5], ['D5', 0.5], ['F#5', 1.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5], ['G4', 0.5],
            ['D5', 0.5], ['B4', 3.5], ['rest', 0.5],
        ],
    },
};

// ---- music beds -----------------------------------------------------------
//
// Each mood is a chord loop plus a `step()` function called once per 16th note
// by the lookahead scheduler. `step` receives the voice api (pad/bass/pluck/
// bell/kick/hat/shaker/clap, all pre-routed to this layer's gain) and a context
// object { t, bar, step, beat, stepDur, def }. `t` is an absolute AudioContext
// time — schedule at `t`, never "now".

export const MOODS = {
    lobby: {
        label: 'Lobby',
        bpm: 92,
        beatsPerBar: 4,
        stepsPerBeat: 4,
        gain: 0.55,
        bars: [
            { bass: 'F2', pad: ['F3', 'A3', 'C4', 'E4'], arp: ['F4', 'A4', 'C5', 'E5'] },
            { bass: 'D2', pad: ['D3', 'F3', 'A3', 'C4'], arp: ['D4', 'F4', 'A4', 'C5'] },
            { bass: 'Bb1', pad: ['Bb2', 'D3', 'F3', 'A3'], arp: ['Bb3', 'D4', 'F4', 'A4'] },
            { bass: 'C2', pad: ['C3', 'E3', 'G3', 'Bb3'], arp: ['C4', 'E4', 'G4', 'Bb4'] },
        ],
        step(api, c) {
            const b = c.def.bars[c.bar];
            if (c.step === 0) {
                // Longer than the bar (2.61 s) so consecutive pads overlap:
                // a gap here reads as a slow swell-and-die every few seconds.
                api.pad(b.pad, c.t, c.beat * 4.6, {
                    peak: 0.05, cutoff: 1300, attack: 0.35, release: 0.9,
                });
                api.bass(b.bass, c.t, c.beat * 1.2, { peak: 0.15 });
                api.kick(c.t, { peak: 0.1 });
            }
            if (c.step === 10) api.bass(b.bass, c.t, c.beat * 0.7, { peak: 0.09 });
            if (c.step === 8) api.kick(c.t, { peak: 0.055 });
            if (c.step === 4 || c.step === 12) api.hat(c.t, { peak: 0.016 });
            if (c.step % 4 === 2) {
                const i = (((c.step - 2) / 4) + c.bar) % b.arp.length;
                api.pluck(b.arp[i], c.t, c.beat * 0.85, { peak: 0.05 });
            }
            if (c.bar === 3 && c.step === 14) {
                api.bell(b.arp[3], c.t, c.beat * 2, { peak: 0.028 });
            }
        },
    },

    think: {
        label: 'Thinking',
        bpm: 68,
        beatsPerBar: 4,
        stepsPerBeat: 4,
        gain: 0.5,
        // Deliberately almost nothing: a slow pad, a heartbeat and the odd bell.
        // This plays under sixty questions a night; it must never nag.
        // The bass sits at A2/F2/C3/G2 rather than an octave lower: below
        // ~90 Hz the loudest voice in this bed simply vanishes on a phone or a
        // pub Bluetooth speaker, so the mix balance depended on the hardware.
        bars: [
            { bass: 'A2', pad: ['A2', 'C3', 'E3', 'G3'], bell: 'E5' },
            { bass: 'F2', pad: ['F2', 'A2', 'C3', 'E3'], bell: 'C5' },
            { bass: 'C3', pad: ['C3', 'E3', 'G3', 'B3'], bell: 'G5' },
            { bass: 'G2', pad: ['G2', 'B2', 'D3', 'E3'], bell: 'D5' },
        ],
        step(api, c) {
            const b = c.def.bars[c.bar];
            if (c.step === 0) {
                // 4.9 beats against a 4-beat bar: each pad crossfades into the
                // next instead of dying inside it.
                api.pad(b.pad, c.t, c.beat * 4.9, {
                    peak: 0.04, cutoff: 820, attack: 0.9, release: 1.4,
                });
                api.bass(b.bass, c.t, c.beat * 2.4, { peak: 0.1, cutoff: 420 });
            }
            if (c.step === 8) api.bass(b.bass, c.t, c.beat * 1.5, { peak: 0.05, cutoff: 380 });
            if (c.bar % 2 === 1 && c.step === 12) {
                api.bell(b.bell, c.t, c.beat * 2.5, { peak: 0.022 });
            }
        },
    },

    interval: {
        label: 'Interval',
        bpm: 116,
        beatsPerBar: 4,
        stepsPerBeat: 4,
        gain: 0.55,
        bars: [
            {
                bass: 'G2', walk: ['G2', 'B2', 'D3', 'E3'],
                pad: ['G3', 'B3', 'D4'], arp: ['G4', 'B4', 'D5', 'B4'],
            },
            {
                bass: 'E2', walk: ['E2', 'G2', 'B2', 'D3'],
                pad: ['E3', 'G3', 'B3'], arp: ['E4', 'G4', 'B4', 'G4'],
            },
            {
                bass: 'C2', walk: ['C2', 'E2', 'G2', 'A2'],
                pad: ['C3', 'E3', 'G3'], arp: ['C4', 'E4', 'G4', 'E4'],
            },
            {
                bass: 'D2', walk: ['D2', 'F#2', 'A2', 'C3'],
                pad: ['D3', 'F#3', 'A3'], arp: ['D4', 'F#4', 'A4', 'F#4'],
            },
        ],
        step(api, c) {
            const b = c.def.bars[c.bar];
            if (c.step === 0) {
                api.pad(b.pad, c.t, c.beat * 4.4, {
                    peak: 0.038, cutoff: 1500, attack: 0.3, release: 0.8,
                });
                api.kick(c.t, { peak: 0.13 });
            }
            if (c.step === 8) api.kick(c.t, { peak: 0.09 });
            if (c.step === 4 || c.step === 12) api.clap(c.t, { peak: 0.05 });
            if (c.step % 4 === 0) {
                api.bass(b.walk[c.step / 4], c.t, c.beat * 0.55, { peak: 0.13 });
            }
            if (c.step % 2 === 0) {
                api.pluck(b.arp[(c.step / 2) % b.arp.length], c.t, c.beat * 0.45,
                    { peak: c.step % 4 === 0 ? 0.05 : 0.032 });
            }
            if (c.step % 4 === 2) api.shaker(c.t, { peak: 0.02 });
        },
    },

    tension: {
        label: 'Tension',
        bpm: 104,
        beatsPerBar: 4,
        stepsPerBeat: 4,
        gain: 0.6,
        bars: [
            { bass: 'D2', pad: ['D3', 'F3', 'A3'], hi: 'A4' },
            { bass: 'D2', pad: ['D3', 'F3', 'A3'], hi: 'A4' },
            { bass: 'Bb1', pad: ['Bb2', 'D3', 'F3'], hi: 'Bb4' },
            { bass: 'A1', pad: ['A2', 'C#3', 'E3'], hi: 'C#5' },
        ],
        step(api, c) {
            const b = c.def.bars[c.bar];
            if (c.step === 0) {
                api.pad(b.pad, c.t, c.beat * 4.5, {
                    peak: 0.045, cutoff: 700, attack: 0.5, release: 0.9,
                });
            }
            if (c.step % 2 === 0) {
                api.bass(b.bass, c.t, c.stepDur * 1.5, {
                    peak: c.step % 4 === 0 ? 0.15 : 0.09, cutoff: 320,
                });
            }
            if (c.step % 4 === 2) api.hat(c.t, { peak: 0.022 });
            if (c.step === 0 && c.bar % 2 === 0) api.kick(c.t, { peak: 0.14 });
            if (c.bar === 3 && c.step === 12) {
                api.bell(b.hi, c.t, c.beat * 1.6, { peak: 0.03 });
                api.clap(c.t, { peak: 0.045 });
            }
        },
    },
};

// ---- small utilities ----

function clamp(v, lo, hi) {
    const n = typeof v === 'number' && isFinite(v) ? v : lo;
    return n < lo ? lo : (n > hi ? hi : n);
}

/** Tiny seeded PRNG — variety without depending on Math.random's mood. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---- the engine -----------------------------------------------------------

export class QuizAudio {
    #ctx = null;
    #master = null;
    #duckGain = null;
    #sfxBus = null;
    #musicBus = null;
    #melodyBus = null;
    #musicDuck = null;       // dips the bed under a "name that tune" melody
    #reverbIR = null;        // impulse response shared by every reverb unit
    #sfxReverb = null;       // send -> convolver -> return, back into sfxBus
    #reverbSend = null;      // === #sfxReverb.send: the default effects send
    #noiseBuf = null;
    #clapBuf = null;

    #active = new Set();     // live source nodes, for teardown
    #timers = new Set();     // pending setTimeout ids
    #intervals = new Set();  // pending setInterval ids (every scheduler)
    #layers = new Set();     // music layers (current + any fading out)
    #layer = null;           // the layer currently being scheduled
    #mood = null;
    #pendingMood = null;     // requested before unlock()
    #tickState = null;
    #melody = null;

    #vol = { master: 0.9, sfx: 0.9, music: 0.5 };
    #muted = false;
    #ducked = false;
    #wantRunning = false;
    #closed = false;
    #resumeQueued = false;
    #rng = mulberry32(0x51ee7);

    constructor() {
        // Deliberately empty: creating an AudioContext here would either be
        // blocked or would leave a suspended context hanging around forever.
    }

    // ---- capability / state ----

    get supported() {
        return !!AC;
    }

    get ready() {
        return !!this.#ctx && this.#ctx.state === 'running' && !this.#closed;
    }

    get muted() {
        return this.#muted;
    }

    get musicMood() {
        // A mood requested while the context was asleep is the one that will
        // actually be playing, so it outranks whatever is still audible.
        return this.#pendingMood || this.#mood || null;
    }

    get playingMelody() {
        return !!this.#melody;
    }

    /** The raw AudioContext, or null. Handy for debugging; do not rely on it. */
    get context() {
        return this.#ctx;
    }

    // ---- lifecycle ----

    /**
     * Create and/or resume the AudioContext. Must be called from inside a user
     * gesture handler at least once. Safe (and cheap) to call on every click.
     * Returns true when the context is actually running.
     */
    async unlock() {
        if (!AC || this.#closed) return false;
        try {
            if (!this.#ctx) this.#build();
            if (!this.#ctx) return false;
            this.#wantRunning = true;
            if (this.#ctx.state !== 'running') {
                // A blocked resume() can stay pending forever (Chrome's
                // autoplay policy, some Safari builds), and callers await this
                // inside a click handler: never hang on it.
                await this.#settleWithin(this.#ctx.resume(), RESUME_TIMEOUT);
                this.#silentPing();
            }
            const running = this.#ctx.state === 'running';
            if (running) this.#applyPending();
            return running;
        } catch (err) {
            console.warn('[audio] unlock failed:', err && err.message ? err.message : err);
            return false;
        }
    }

    /** Tear everything down and release the hardware. Idempotent. */
    async close() {
        if (this.#closed) return;
        this.#closed = true;
        this.#wantRunning = false;
        this.#pendingMood = null;
        try {
            this.stopTicking();
            this.stopMelody();
            for (const layer of Array.from(this.#layers)) this.#destroyLayer(layer);
        } catch (_) { /* teardown is best-effort */ }
        this.#layer = null;
        this.#mood = null;
        for (const id of this.#timers) clearTimeout(id);
        this.#timers.clear();
        // Schedulers live in here too, so nothing can outlive the object even
        // if some state machine above was bypassed.
        for (const id of this.#intervals) clearInterval(id);
        this.#intervals.clear();
        for (const src of Array.from(this.#active)) {
            try { src.onended = null; src.stop(); } catch (_) { /* already stopped */ }
            try { src.disconnect(); } catch (_) { /* already gone */ }
        }
        this.#active.clear();
        const ctx = this.#ctx;
        this.#ctx = null;
        this.#destroyReverb(this.#sfxReverb);
        this.#master = this.#duckGain = this.#sfxBus = null;
        this.#musicBus = this.#melodyBus = this.#musicDuck = null;
        this.#sfxReverb = this.#reverbSend = this.#reverbIR = null;
        this.#noiseBuf = this.#clapBuf = null;
        if (ctx) {
            try { ctx.onstatechange = null; } catch (_) { /* ignore */ }
            try { await ctx.close(); } catch (_) { /* already closed */ }
        }
    }

    // ---- mixer ----

    setMasterVolume(v) {
        this.#vol.master = clamp(v, 0, 1);
        if (!this.#muted) this.#ramp(this.#master, this.#vol.master, 0.05);
    }

    setSfxVolume(v) {
        this.#vol.sfx = clamp(v, 0, 1);
        this.#ramp(this.#sfxBus, this.#vol.sfx, 0.05);
        this.#ramp(this.#melodyBus, this.#melodyLevel(), 0.05);
    }

    /** Melodies are quiz content, so they sit a little above the effects bus. */
    #melodyLevel() {
        return this.#vol.sfx <= 0.001 ? 0 : Math.max(this.#vol.sfx, 0.35);
    }

    setMusicVolume(v) {
        this.#vol.music = clamp(v, 0, 1);
        this.#ramp(this.#musicBus, this.#vol.music, 0.08);
    }

    getVolumes() {
        return { ...this.#vol };
    }

    /** Instant but click-free mute. Levels are remembered across the toggle. */
    setMuted(muted) {
        const next = !!muted;
        if (next === this.#muted) return;
        this.#muted = next;
        this.#ramp(this.#master, next ? 0 : this.#vol.master, 0.02);
    }

    /** Dip everything by ~12 dB so the quizmaster can be heard over it. */
    duck(on) {
        const next = !!on;
        this.#ducked = next;
        this.#ramp(this.#duckGain, next ? DUCK_LEVEL : 1, next ? 0.06 : 0.25);
    }

    get ducked() {
        return this.#ducked;
    }

    // ---- one-shot sound effects ----

    /**
     * Fire a one-shot effect. Never throws, never returns a handle: sounds are
     * fire-and-forget.
     * opts: { gain: 0..2 multiplier, when: absolute ctx time, pitch: multiplier }
     */
    play(name, opts = {}) {
        if (!this.ready) {
            // Someone clicked before we were unlocked; nudge the context awake
            // for next time but stay silent now.
            if (this.#ctx && this.#wantRunning) this.#tryResume();
            return;
        }
        const t = typeof opts.when === 'number' ? Math.max(opts.when, this.#ctx.currentTime)
            : this.#ctx.currentTime + 0.005;
        try {
            this.#sfx(String(name), t, clamp(opts.gain ?? 1, 0, 3), opts);
        } catch (err) {
            console.warn('[audio] play failed:', name, err && err.message);
        }
    }

    // ---- background music ----

    /**
     * Start (or crossfade to) one of the moods in MOODS.
     * opts: { fade: seconds, restart: boolean }
     */
    startMusic(mood, opts = {}) {
        const def = MOODS[mood];
        if (!def || !AC || this.#closed) return;
        if (!this.ready) {
            this.#pendingMood = mood;
            if (this.#ctx && this.#wantRunning) this.#tryResume();
            return;
        }
        this.#pendingMood = null;
        if (this.#mood === mood && this.#layer && !opts.restart) return;

        const fade = clamp(opts.fade ?? DEFAULT_MUSIC_FADE, 0.05, 8);
        const ctx = this.#ctx;
        const now = ctx.currentTime;

        if (this.#layer) this.#fadeOutLayer(this.#layer, fade);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(def.gain, now + fade);
        gain.connect(this.#musicBus);

        const layer = {
            def,
            mood,
            gain,
            // Its own reverb, returning into this layer's gain, so a crossfade
            // or a music-volume change carries the wet signal with it.
            reverb: this.#makeReverb(gain),
            sources: new Set(),
            step: 0,
            // Start on the next 16th boundary-ish; a small offset keeps the
            // first chord from landing inside the crossfade attack.
            startTime: now + 0.08,
            timer: null,
        };
        layer.api = this.#makeApi(gain, layer);
        this.#layers.add(layer);
        this.#layer = layer;
        this.#mood = mood;

        const pump = () => {
            if (!this.#ctx || layer.timer === null) return;
            try { this.#scheduleMusic(layer); } catch (err) {
                console.warn('[audio] music scheduler stopped:', err && err.message);
                this.#fadeOutLayer(layer, 0.4);
            }
        };
        // The poll is created *before* the first pass: a pass that throws (or
        // that tears the layer down) must never leave a timer nobody holds.
        layer.timer = this.#every(MUSIC_POLL, pump);
        pump();
    }

    /** Fade the music out. opts.fade in seconds (default 0.8). */
    stopMusic(opts = {}) {
        this.#pendingMood = null;
        if (!this.#layer) {
            this.#mood = null;
            return;
        }
        const fade = clamp(opts.fade ?? DEFAULT_STOP_FADE, 0.02, 8);
        this.#fadeOutLayer(this.#layer, fade);
        this.#layer = null;
        this.#mood = null;
    }

    // ---- melodies ----

    /**
     * Play one of MELODIES and resolve when it finishes.
     * opts: { tempo: multiplier (0.5-2), gain: multiplier, transpose: semitones }
     * Resolves true if it played to the end, false if it was stopped or could
     * not start.
     */
    async playMelody(key, opts = {}) {
        const tune = MELODIES[key];
        if (!tune || !this.ready) return false;
        this.stopMelody();

        const ctx = this.#ctx;
        const tempo = clamp(opts.tempo ?? 1, 0.25, 4);
        const gainMul = clamp(opts.gain ?? 1, 0, 2);
        const shift = Math.pow(2, (opts.transpose || 0) / 12);
        const beat = 60 / (tune.bpm * tempo);

        const bus = ctx.createGain();
        bus.gain.setValueAtTime(1, ctx.currentTime);
        bus.connect(this.#melodyBus);

        const state = {
            bus,
            reverb: this.#makeReverb(bus),
            sources: new Set(),
            timer: null,
            poll: null,
            resolve: null,
            done: false,
        };
        this.#melody = state;
        // The audience has to *identify* this, and the beds are in fixed keys
        // that will not agree with it, so the music gets out of the way.
        this.#ramp(this.#musicDuck, MELODY_DUCK, 0.3);

        let t = ctx.currentTime + 0.12;
        try {
            for (const [pitch, beats] of tune.notes) {
                const dur = Math.max(0.05, beats * beat);
                const hz = noteToFreq(pitch) * shift;
                if (hz > 0) this.#melodyNote(hz, t, dur, 0.16 * gainMul, bus, state);
                t += dur;
            }
        } catch (err) {
            // Never reject: callers await this for a boolean, not a throw.
            console.warn('[audio] melody failed:', key, err && err.message);
            this.#finishMelody(state, false);
            return false;
        }
        const endsAt = t + 0.9;

        return new Promise((resolve) => {
            state.resolve = resolve;
            // Completion is driven by the *audio* clock. Wall-clock time keeps
            // running while a suspended or interrupted context is frozen, so a
            // setTimeout would resolve mid-tune and let the rest of the notes
            // play over whatever the app moved on to.
            state.poll = this.#every(100, () => {
                const c = this.#ctx;
                if (!c || this.#closed) { this.#finishMelody(state, false); return; }
                if (c.state !== 'running') { this.stopMelody(); return; }
                if (c.currentTime >= endsAt) this.#finishMelody(state, true);
            });
            // Backstop, so the promise can never hang if the clock misbehaves.
            const ms = Math.max(0, (endsAt - ctx.currentTime) * 1000) * 2 + 3000;
            state.timer = this.#after(ms, () => {
                state.timer = null;
                this.#finishMelody(state, true);
            });
        });
    }

    /** Cancel an in-flight melody. Its promise resolves with false. */
    stopMelody() {
        const state = this.#melody;
        if (!state) return;
        const ctx = this.#ctx;
        if (ctx && state.bus) {
            const now = ctx.currentTime;
            try {
                const param = state.bus.gain;
                const current = Math.max(param.value, 0.0001);
                param.cancelScheduledValues(now);
                param.setValueAtTime(current, now);
                param.linearRampToValueAtTime(0.0001, now + 0.14);
            } catch (_) { /* ignore */ }
            for (const src of state.sources) {
                try { src.stop(now + 0.16); } catch (_) { /* already done */ }
            }
        }
        this.#finishMelody(state, false);
    }

    // ---- countdown ticking ----

    /**
     * Schedule one tick per second for the final `secondsRemaining` seconds,
     * rising in pitch and volume over the last five. Replaces any previous
     * schedule.
     */
    startTicking(secondsRemaining) {
        this.stopTicking();
        const total = Math.floor(clamp(secondsRemaining, 0, 3600));
        if (!this.ready || total < 1) return;

        const ctx = this.#ctx;
        // Every tick of this countdown goes through one gain node, so a stop
        // can silence the ticks already committed to the audio clock — they
        // are short-lived sources started at absolute future times and there is
        // nothing else left to cancel once they are scheduled.
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(1, ctx.currentTime);
        gain.connect(this.#sfxBus);

        const state = {
            total,
            i: 0,
            start: ctx.currentTime + 0.06,
            gain,
            timer: null,
            done: false,
        };
        this.#tickState = state;
        // The poll is created before the first pass: when the whole countdown
        // fits inside the lookahead (n = 1 or 2) that pass finishes the
        // schedule and detaches the state, and an interval created afterwards
        // would be unreachable by stopTicking() *and* by close().
        state.timer = this.#every(TICK_POLL, () => {
            try { this.#scheduleTicks(); } catch (_) { this.stopTicking(); }
        });
        try { this.#scheduleTicks(); } catch (_) { this.stopTicking(); }
    }

    /** Stop the countdown now, including ticks already handed to the clock. */
    stopTicking() {
        const state = this.#tickState;
        if (!state) return;
        this.#tickState = null;
        state.done = true;
        this.#clearEvery(state.timer);
        state.timer = null;
        const ctx = this.#ctx;
        const gain = state.gain;
        if (!gain) return;
        if (!ctx) {
            try { gain.disconnect(); } catch (_) { /* ignore */ }
            return;
        }
        const now = ctx.currentTime;
        try {
            const param = gain.gain;
            param.cancelScheduledValues(now);
            param.setValueAtTime(Math.max(param.value, 0.0001), now);
            param.linearRampToValueAtTime(0.0001, now + 0.03);
        } catch (_) { /* a closing context; nothing to ramp */ }
        this.#after(400, () => { try { gain.disconnect(); } catch (_) { /* ignore */ } });
    }

    /**
     * The schedule ran out on its own: keep the last committed ticks audible,
     * just retire the scheduler and the gain node behind them.
     */
    #finishTicking(state) {
        if (!state || state.done) return;
        state.done = true;
        if (this.#tickState === state) this.#tickState = null;
        this.#clearEvery(state.timer);
        state.timer = null;
        const ctx = this.#ctx;
        const gain = state.gain;
        if (!gain) return;
        const lead = ctx ? Math.max(0, (state.start + state.total) - ctx.currentTime) : 0;
        this.#after((lead + 0.8) * 1000,
            () => { try { gain.disconnect(); } catch (_) { /* ignore */ } });
    }

    get ticking() {
        return !!this.#tickState;
    }

    // ---- graph construction -------------------------------------------------

    #build() {
        let ctx;
        try {
            ctx = new AC({ latencyHint: 'interactive' });
        } catch (_) {
            try { ctx = new AC(); } catch (err) {
                console.warn('[audio] no AudioContext:', err && err.message);
                return;
            }
        }
        this.#ctx = ctx;
        const now = ctx.currentTime;

        // Master chain: a gentle limiter keeps applause + fanfare + music from
        // clipping a laptop's output on a loud pub night.
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-10, now);
        comp.knee.setValueAtTime(22, now);
        comp.ratio.setValueAtTime(3.5, now);
        comp.attack.setValueAtTime(0.004, now);
        comp.release.setValueAtTime(0.22, now);
        comp.connect(ctx.destination);

        const master = ctx.createGain();
        master.gain.setValueAtTime(this.#muted ? 0.0001 : this.#vol.master, now);
        master.connect(comp);
        this.#master = master;

        const duck = ctx.createGain();
        duck.gain.setValueAtTime(this.#ducked ? DUCK_LEVEL : 1, now);
        duck.connect(master);
        this.#duckGain = duck;

        const sfx = ctx.createGain();
        sfx.gain.setValueAtTime(this.#vol.sfx, now);
        sfx.connect(duck);
        this.#sfxBus = sfx;

        // musicBus is the fader the app owns; musicDuck is ours, used to dip
        // the bed under a melody without fighting setMusicVolume().
        const musicDuck = ctx.createGain();
        musicDuck.gain.setValueAtTime(1, now);
        musicDuck.connect(duck);
        this.#musicDuck = musicDuck;

        const music = ctx.createGain();
        music.gain.setValueAtTime(this.#vol.music, now);
        music.connect(musicDuck);
        this.#musicBus = music;

        const melody = ctx.createGain();
        melody.gain.setValueAtTime(Math.max(this.#melodyLevel(), 0.0001), now);
        melody.connect(duck);
        this.#melodyBus = melody;

        this.#buildReverb();
        this.#buildBuffers();

        ctx.onstatechange = () => this.#onStateChange();
    }

    #buildReverb() {
        const ctx = this.#ctx;
        this.#reverbIR = null;
        this.#sfxReverb = null;
        this.#reverbSend = null;
        if (!ctx.createConvolver) return;
        try {
            const seconds = 1.5;
            const rate = ctx.sampleRate;
            const len = Math.floor(seconds * rate);
            const ir = ctx.createBuffer(2, len, rate);
            const rnd = mulberry32(0xbeef);
            for (let ch = 0; ch < 2; ch++) {
                const data = ir.getChannelData(ch);
                for (let i = 0; i < len; i++) {
                    const x = i / len;
                    // Slight pre-delay then a smooth exponential-ish tail.
                    const env = i < rate * 0.012 ? 0 : Math.pow(1 - x, 2.6);
                    data[i] = (rnd() * 2 - 1) * env;
                }
            }
            this.#reverbIR = ir;
            this.#sfxReverb = this.#makeReverb(this.#sfxBus);
            this.#reverbSend = this.#sfxReverb ? this.#sfxReverb.send : null;
        } catch (err) {
            this.#reverbIR = null;
            this.#sfxReverb = null;
            this.#reverbSend = null;
            console.warn('[audio] reverb unavailable:', err && err.message);
        }
    }

    /**
     * One send -> convolver -> return chain whose wet output lands back in
     * `dest`. Because the return re-enters the same node the dry signal passes
     * through, every fader and fade-out downstream of `dest` applies to the
     * reverb as well; a single global return would leak the wet copy of muted
     * music and smear crossfades. All units share one impulse response.
     */
    #makeReverb(dest) {
        const ctx = this.#ctx;
        if (!ctx || !dest || !this.#reverbIR || !ctx.createConvolver) return null;
        try {
            const conv = ctx.createConvolver();
            conv.buffer = this.#reverbIR;
            conv.normalize = true;
            const ret = ctx.createGain();
            ret.gain.setValueAtTime(0.85, ctx.currentTime);
            const send = ctx.createGain();
            send.gain.setValueAtTime(1, ctx.currentTime);
            send.connect(conv);
            conv.connect(ret);
            ret.connect(dest);
            return { send, conv, ret };
        } catch (err) {
            console.warn('[audio] reverb unavailable:', err && err.message);
            return null;
        }
    }

    #destroyReverb(unit) {
        if (!unit) return;
        for (const node of [unit.send, unit.conv, unit.ret]) {
            try { node.disconnect(); } catch (_) { /* ignore */ }
        }
    }

    #buildBuffers() {
        const ctx = this.#ctx;
        const rate = ctx.sampleRate;

        // One shared white-noise bed, looped by every noise voice.
        const len = Math.floor(NOISE_SECONDS * rate);
        const noise = ctx.createBuffer(2, len, rate);
        const rnd = mulberry32(0xc0ffee);
        for (let ch = 0; ch < 2; ch++) {
            const data = noise.getChannelData(ch);
            for (let i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
        }
        this.#noiseBuf = noise;

        // One pre-enveloped hand-clap grain, pitch-shifted per clap.
        const clapLen = Math.floor(0.1 * rate);
        const clap = ctx.createBuffer(1, clapLen, rate);
        const cd = clap.getChannelData(0);
        for (let i = 0; i < clapLen; i++) {
            const x = i / clapLen;
            const attack = Math.min(1, x / 0.004);
            cd[i] = (rnd() * 2 - 1) * attack * Math.pow(1 - x, 5.5);
        }
        this.#clapBuf = clap;
    }

    /** iOS likes to see a real (silent) buffer play before it trusts us. */
    #silentPing() {
        const ctx = this.#ctx;
        if (!ctx) return;
        try {
            const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
            src.onended = () => { try { src.disconnect(); } catch (_) { /* ignore */ } };
        } catch (_) { /* nothing to do */ }
    }

    #onStateChange() {
        const ctx = this.#ctx;
        if (!ctx || this.#closed) return;
        // Safari parks the context as 'interrupted' after a phone call or a
        // route change; Chrome may suspend a backgrounded tab.
        if (ctx.state === 'running') {
            // Back up without a fresh unlock(): honour whatever was asked for
            // while we were asleep, or the bed is silently the wrong one.
            this.#applyPending();
            return;
        }
        if (this.#wantRunning) this.#tryResume();
    }

    /** Apply anything that was requested while the context was not running. */
    #applyPending() {
        const mood = this.#pendingMood;
        if (!mood || this.#closed) return;
        this.#pendingMood = null;
        this.startMusic(mood);
    }

    #tryResume() {
        const ctx = this.#ctx;
        if (!ctx || this.#resumeQueued || this.#closed) return;
        if (ctx.state === 'running' || ctx.state === 'closed') return;
        this.#resumeQueued = true;
        let pending = null;
        try { pending = ctx.resume(); } catch (_) { pending = null; }
        // A resume() blocked by the autoplay policy can stay pending forever.
        // The latch has to clear anyway, or auto-recovery is dead for the life
        // of the page after a single blocked attempt.
        this.#settleWithin(pending, RESUME_TIMEOUT)
            .then(() => { this.#resumeQueued = false; });
    }

    /** Resolve when `promise` settles or `ms` elapses — whichever comes first. */
    #settleWithin(promise, ms) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const id = setTimeout(finish, Math.max(0, ms));
            const done = () => { clearTimeout(id); finish(); };
            Promise.resolve(promise).then(done, done);
        });
    }

    // ---- plumbing helpers ---------------------------------------------------

    #ramp(node, value, seconds) {
        if (!node || !this.#ctx) return;
        const now = this.#ctx.currentTime;
        const param = node.gain;
        try {
            // Read first: cancelScheduledValues() can otherwise snap the value
            // back to the start of an in-flight ramp and produce a click.
            const current = Math.max(param.value, 0.0001);
            param.cancelScheduledValues(now);
            param.setValueAtTime(current, now);
            param.linearRampToValueAtTime(Math.max(value, 0.0001), now + Math.max(seconds, 0.005));
        } catch (_) { /* a closing context; nothing to ramp */ }
    }

    #after(ms, fn) {
        const id = setTimeout(() => {
            this.#timers.delete(id);
            try { fn(); } catch (_) { /* best-effort */ }
        }, Math.max(0, ms));
        this.#timers.add(id);
        return id;
    }

    /** setInterval, but registered so close() is guaranteed to reach it. */
    #every(ms, fn) {
        const id = setInterval(fn, Math.max(1, ms));
        this.#intervals.add(id);
        return id;
    }

    #clearEvery(id) {
        if (id === null || id === undefined) return;
        clearInterval(id);
        this.#intervals.delete(id);
    }

    /** Register a source so it is disconnected when it ends (or on close()). */
    #track(source, nodes, layerOrState) {
        this.#active.add(source);
        if (layerOrState) layerOrState.sources.add(source);
        source.onended = () => {
            this.#active.delete(source);
            if (layerOrState) layerOrState.sources.delete(source);
            try { source.disconnect(); } catch (_) { /* ignore */ }
            for (const n of nodes) {
                try { n.disconnect(); } catch (_) { /* ignore */ }
            }
        };
    }

    // ---- primitive voices ---------------------------------------------------

    /**
     * One oscillator with an envelope, an optional filter and an optional
     * reverb send. Returns the voice's output gain node (already connected).
     */
    #tone(o) {
        const ctx = this.#ctx;
        if (!ctx) return null;
        const t = Math.max(o.t ?? ctx.currentTime, ctx.currentTime);
        const dur = Math.max(0.03, o.dur ?? 0.25);
        const peak = Math.max(0.0004, o.peak ?? 0.15);
        const attack = clamp(o.attack ?? 0.006, 0.001, dur * 0.9);
        const nyq = ctx.sampleRate * 0.5;

        const osc = ctx.createOscillator();
        osc.type = o.type || 'triangle';
        const f = clamp(o.freq || 440, 16, nyq - 200);
        osc.frequency.setValueAtTime(f, t);
        if (o.freqTo) {
            osc.frequency.exponentialRampToValueAtTime(
                clamp(o.freqTo, 16, nyq - 200), t + Math.max(0.01, o.freqTime ?? dur));
        }
        if (o.detune) osc.detune.setValueAtTime(o.detune, t);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        if (o.shape === 'pad') {
            const rel = clamp(o.release ?? 0.5, 0.02, dur * 0.7);
            g.gain.linearRampToValueAtTime(peak, t + attack);
            g.gain.setValueAtTime(peak, Math.max(t + attack, t + dur - rel));
            g.gain.linearRampToValueAtTime(0.0001, t + dur);
        } else {
            g.gain.exponentialRampToValueAtTime(peak, t + attack);
            if (o.hold) {
                g.gain.setValueAtTime(peak, t + Math.min(attack + o.hold, dur * 0.95));
            }
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        }

        const chain = [g];
        if (o.filter) {
            const flt = ctx.createBiquadFilter();
            flt.type = o.filter;
            flt.frequency.setValueAtTime(clamp(o.cutoff ?? 2000, 20, nyq - 200), t);
            if (o.cutoffTo) {
                flt.frequency.exponentialRampToValueAtTime(
                    clamp(o.cutoffTo, 20, nyq - 200), t + Math.max(0.01, o.cutoffTime ?? dur));
            }
            if (o.q != null) flt.Q.setValueAtTime(o.q, t);
            osc.connect(flt);
            flt.connect(g);
            chain.push(flt);
        } else {
            osc.connect(g);
        }

        g.connect(o.dest || this.#sfxBus);
        // The send must belong to the same bus as the dry signal, otherwise the
        // wet copy sails past every fader downstream of it.
        const revSend = o.revSend !== undefined ? o.revSend : this.#reverbSend;
        if (o.reverb && revSend) {
            const send = ctx.createGain();
            send.gain.setValueAtTime(clamp(o.reverb, 0, 1), t);
            g.connect(send);
            send.connect(revSend);
            chain.push(send);
        }

        osc.start(t);
        osc.stop(t + dur + 0.04);
        this.#track(osc, chain, o.layer);
        return g;
    }

    /** A slice of the shared noise buffer through a filter and an envelope. */
    #noise(o) {
        const ctx = this.#ctx;
        if (!ctx || !this.#noiseBuf) return null;
        const t = Math.max(o.t ?? ctx.currentTime, ctx.currentTime);
        const dur = Math.max(0.01, o.dur ?? 0.2);
        const peak = Math.max(0.0004, o.peak ?? 0.1);
        const attack = clamp(o.attack ?? 0.004, 0.0005, dur * 0.9);
        const nyq = ctx.sampleRate * 0.5;

        const src = ctx.createBufferSource();
        src.buffer = this.#noiseBuf;
        src.loop = true;
        if (o.rate) src.playbackRate.setValueAtTime(clamp(o.rate, 0.25, 4), t);

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + attack);
        if (o.hold) {
            g.gain.setValueAtTime(peak, t + Math.min(attack + o.hold, dur * 0.95));
        }
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        const chain = [g];
        let head = src;
        if (o.filter) {
            const flt = ctx.createBiquadFilter();
            flt.type = o.filter;
            flt.frequency.setValueAtTime(clamp(o.freq ?? 1000, 20, nyq - 200), t);
            if (o.freqTo) {
                flt.frequency.exponentialRampToValueAtTime(
                    clamp(o.freqTo, 20, nyq - 200), t + Math.max(0.02, o.freqTime ?? dur));
            }
            if (o.freqEnd) {
                flt.frequency.exponentialRampToValueAtTime(
                    clamp(o.freqEnd, 20, nyq - 200), t + dur);
            }
            if (o.q != null) flt.Q.setValueAtTime(o.q, t);
            head.connect(flt);
            head = flt;
            chain.push(flt);
        }
        head.connect(g);
        g.connect(o.dest || this.#sfxBus);
        const revSend = o.revSend !== undefined ? o.revSend : this.#reverbSend;
        if (o.reverb && revSend) {
            const send = ctx.createGain();
            send.gain.setValueAtTime(clamp(o.reverb, 0, 1), t);
            g.connect(send);
            send.connect(revSend);
            chain.push(send);
        }

        const offset = this.#rng() * (NOISE_SECONDS - 0.5);
        src.start(t, offset);
        src.stop(t + dur + 0.03);
        this.#track(src, chain, o.layer);
        return g;
    }

    /** Bell-ish voice: fundamental plus a mildly inharmonic partial. */
    #bell(freq, t, dur, peak, dest, opts = {}) {
        this.#tone({
            t, dur, dest, type: 'sine', freq, peak,
            attack: 0.004, filter: 'lowpass', cutoff: 6000,
            reverb: opts.reverb ?? 0.35, revSend: opts.revSend, layer: opts.layer,
        });
        this.#tone({
            t, dur: dur * 0.6, dest, type: 'sine', freq: freq * 2.76,
            peak: peak * 0.22, attack: 0.003, layer: opts.layer,
        });
        this.#tone({
            t, dur: dur * 0.85, dest, type: 'sine', freq: freq * 2,
            peak: peak * 0.3, attack: 0.004, layer: opts.layer,
        });
    }

    /** Warm plucked-synth voice used by the melodies, with a reverb tail. */
    #melodyNote(freq, t, dur, peak, dest, state) {
        const ctx = this.#ctx;
        const body = Math.max(0.08, dur * 0.94);
        // The ring has to fit the note. A flat 0.5 s tail turns Fur Elise's
        // 0.13 s semiquavers into a five-deep semitone cluster, which is
        // exactly the phrase the audience is supposed to recognise.
        const tail = Math.min(0.5, Math.max(0.12, dur * 0.8));
        const nyq = ctx.sampleRate * 0.5;
        const revSend = state && state.reverb ? state.reverb.send : null;
        const revAmt = dur < 0.2 ? 0.15 : 0.3;

        const mk = (type, mul, level, wob) => {
            // Never ramp exponentially to zero: playMelody({ gain: 0 }) is a
            // documented call and a RangeError here would strand the melody.
            const lvl = Math.max(0.0004, level);
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.setValueAtTime(clamp(freq * mul, 16, nyq - 200), t);
            if (wob) osc.detune.setValueAtTime(wob, t);

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(lvl, t + 0.012);
            g.gain.exponentialRampToValueAtTime(lvl * 0.45, t + Math.min(0.3, body));
            g.gain.exponentialRampToValueAtTime(0.0001, t + body + tail);

            const flt = ctx.createBiquadFilter();
            flt.type = 'lowpass';
            flt.frequency.setValueAtTime(clamp(freq * 6 + 900, 400, nyq - 200), t);
            flt.Q.setValueAtTime(0.7, t);

            osc.connect(flt);
            flt.connect(g);
            g.connect(dest);
            const chain = [g, flt];
            if (revSend) {
                const send = ctx.createGain();
                send.gain.setValueAtTime(revAmt, t);
                g.connect(send);
                send.connect(revSend);
                chain.push(send);
            }
            osc.start(t);
            osc.stop(t + body + tail + 0.05);
            this.#track(osc, chain, state);
        };

        mk('triangle', 1, peak, -4);
        mk('sine', 2, peak * 0.3, 5);
        mk('sine', 0.5, peak * 0.22, 0);
    }

    #finishMelody(state, completed) {
        if (!state || state.done) return;
        state.done = true;
        if (state.timer !== null) {
            clearTimeout(state.timer);
            this.#timers.delete(state.timer);
            state.timer = null;
        }
        if (state.poll !== null) {
            this.#clearEvery(state.poll);
            state.poll = null;
        }
        if (this.#melody === state) {
            this.#melody = null;
            this.#ramp(this.#musicDuck, 1, 0.6);
        }
        const bus = state.bus;
        const reverb = state.reverb;
        // Long enough for the reverb tail (1.5 s) to run out on its own.
        this.#after(1700, () => {
            this.#destroyReverb(reverb);
            try { if (bus) bus.disconnect(); } catch (_) { /* ignore */ }
        });
        if (state.resolve) {
            const resolve = state.resolve;
            state.resolve = null;
            resolve(completed);
        }
    }

    // ---- music scheduling ---------------------------------------------------

    #makeApi(dest, layer) {
        const self = this;
        // Read lazily: the layer owns its reverb, and a null unit means "no
        // reverb" rather than "fall back to the shared effects send".
        const rev = () => (layer && layer.reverb ? layer.reverb.send : null);
        return {
            dest,
            pad(notes, t, dur, o = {}) {
                for (let i = 0; i < notes.length; i++) {
                    self.#tone({
                        t, dur, dest, layer,
                        type: 'sawtooth',
                        freq: noteToFreq(notes[i]),
                        peak: (o.peak ?? 0.05) * (i === 0 ? 1 : 0.78),
                        attack: o.attack ?? 0.35,
                        release: o.release ?? 0.7,
                        shape: 'pad',
                        filter: 'lowpass',
                        cutoff: o.cutoff ?? 1200,
                        q: 0.6,
                        detune: (self.#rng() - 0.5) * 16,
                        reverb: o.reverb ?? 0.15,
                        revSend: rev(),
                    });
                }
            },
            bass(note, t, dur, o = {}) {
                self.#tone({
                    t, dur, dest, layer,
                    type: 'triangle',
                    freq: noteToFreq(note),
                    peak: o.peak ?? 0.13,
                    attack: 0.008,
                    filter: 'lowpass',
                    cutoff: o.cutoff ?? 360,
                    q: 0.7,
                });
            },
            pluck(note, t, dur, o = {}) {
                const f = noteToFreq(note);
                if (!f) return;
                self.#tone({
                    t, dur, dest, layer,
                    type: 'triangle', freq: f,
                    peak: o.peak ?? 0.05, attack: 0.004,
                    filter: 'lowpass', cutoff: o.cutoff ?? 2400, q: 0.8,
                    reverb: o.reverb ?? 0.22, revSend: rev(),
                });
                self.#tone({
                    t, dur: dur * 0.5, dest, layer,
                    type: 'sine', freq: f * 2,
                    peak: (o.peak ?? 0.05) * 0.28, attack: 0.003,
                });
            },
            bell(note, t, dur, o = {}) {
                const f = noteToFreq(note);
                if (f) {
                    self.#bell(f, t, dur, o.peak ?? 0.03, dest,
                        { layer, reverb: 0.3, revSend: rev() });
                }
            },
            kick(t, o = {}) {
                self.#tone({
                    t, dur: 0.24, dest, layer,
                    type: 'sine', freq: 132, freqTo: 44, freqTime: 0.09,
                    peak: o.peak ?? 0.12, attack: 0.004,
                    filter: 'lowpass', cutoff: 420,
                });
            },
            hat(t, o = {}) {
                self.#noise({
                    t, dur: 0.038, dest, layer,
                    peak: o.peak ?? 0.02, attack: 0.001,
                    filter: 'highpass', freq: 7200, q: 0.9,
                });
            },
            shaker(t, o = {}) {
                self.#noise({
                    t, dur: 0.07, dest, layer,
                    peak: o.peak ?? 0.02, attack: 0.012,
                    filter: 'bandpass', freq: 6200, q: 1.4,
                });
            },
            clap(t, o = {}) {
                self.#noise({
                    t, dur: 0.11, dest, layer,
                    peak: o.peak ?? 0.05, attack: 0.002,
                    filter: 'bandpass', freq: 1750, q: 1.1,
                    reverb: 0.18, revSend: rev(),
                });
            },
        };
    }

    #scheduleMusic(layer) {
        const ctx = this.#ctx;
        if (!ctx || !this.#layers.has(layer)) return;
        const def = layer.def;
        const beat = 60 / def.bpm;
        const stepDur = beat / def.stepsPerBeat;
        const stepsPerBar = def.stepsPerBeat * def.beatsPerBar;
        const totalSteps = stepsPerBar * def.bars.length;
        const now = ctx.currentTime;

        // If the tab was frozen, do not machine-gun through the backlog: jump
        // the counter forward to the present, staying on the same grid.
        const minStep = Math.ceil((now - layer.startTime) / stepDur);
        if (layer.step < minStep) layer.step = minStep;

        const horizon = now + MUSIC_LOOKAHEAD;
        let guard = 512;
        while (layer.startTime + layer.step * stepDur < horizon && guard-- > 0) {
            const t = layer.startTime + layer.step * stepDur;
            const local = ((layer.step % totalSteps) + totalSteps) % totalSteps;
            def.step(layer.api, {
                t,
                bar: Math.floor(local / stepsPerBar),
                step: local % stepsPerBar,
                beat,
                stepDur,
                def,
                absStep: layer.step,
            });
            layer.step++;
        }
    }

    #fadeOutLayer(layer, fade) {
        if (!layer || !this.#layers.has(layer)) return;
        if (layer.timer !== null) {
            this.#clearEvery(layer.timer);
            layer.timer = null;
        }
        const ctx = this.#ctx;
        if (ctx) {
            const now = ctx.currentTime;
            const param = layer.gain.gain;
            try {
                const current = Math.max(param.value, 0.0001);
                param.cancelScheduledValues(now);
                param.setValueAtTime(current, now);
                param.linearRampToValueAtTime(0.0001, now + fade);
            } catch (_) { /* ignore */ }
        }
        if (this.#layer === layer) this.#layer = null;
        this.#after((fade + 0.3) * 1000, () => this.#destroyLayer(layer));
    }

    #destroyLayer(layer) {
        if (!this.#layers.has(layer)) return;
        this.#layers.delete(layer);
        if (layer.timer !== null) {
            this.#clearEvery(layer.timer);
            layer.timer = null;
        }
        for (const src of Array.from(layer.sources)) {
            try { src.stop(); } catch (_) { /* already finished */ }
        }
        layer.sources.clear();
        this.#destroyReverb(layer.reverb);
        layer.reverb = null;
        try { layer.gain.disconnect(); } catch (_) { /* ignore */ }
        if (this.#layer === layer) {
            this.#layer = null;
            this.#mood = null;
        }
    }

    // ---- countdown scheduling ----

    #scheduleTicks() {
        const state = this.#tickState;
        const ctx = this.#ctx;
        if (!state || !ctx) return;
        const horizon = ctx.currentTime + TICK_LOOKAHEAD;
        while (state.i < state.total && state.start + state.i < horizon) {
            const remaining = state.total - state.i;
            const t = state.start + state.i;
            if (t >= ctx.currentTime - 0.05) {
                if (remaining <= 5) {
                    const urgency = (6 - remaining) / 5;         // 0.2 .. 1
                    this.#sfx('tickUrgent', t, 0.9 + urgency * 0.3, {
                        pitch: 1 + urgency * 0.25,
                        urgency,
                        dest: state.gain,
                    });
                } else {
                    this.#sfx('tick', t, 0.75, { pitch: 1, dest: state.gain });
                }
            }
            state.i++;
        }
        // Natural end: retire the scheduler but let the queued ticks ring.
        if (state.i >= state.total) this.#finishTicking(state);
    }

    // ---- the sound effects --------------------------------------------------

    #sfx(name, t, gain, opts = {}) {
        const pitch = clamp(opts.pitch ?? 1, 0.25, 4);
        const rev = this.#reverbSend ? 1 : 0;
        // Ticks are routed through the countdown's own gain node so they can be
        // silenced after they have been committed to the clock; everything else
        // goes straight to the effects bus.
        const dest = opts.dest || undefined;

        switch (name) {
            // Tiny UI tick: a wooden little "tk".
            case 'click': {
                this.#tone({
                    t, dur: 0.045, type: 'triangle', freq: 1250 * pitch,
                    peak: 0.07 * gain, attack: 0.002,
                    filter: 'bandpass', cutoff: 1400 * pitch, q: 1.2,
                });
                this.#noise({
                    t, dur: 0.012, peak: 0.035 * gain, attack: 0.001,
                    filter: 'highpass', freq: 3200,
                });
                break;
            }

            // Confirm blip: a quick rising major third with a sparkle on top.
            case 'select': {
                this.#tone({
                    t, dur: 0.16, type: 'triangle', freq: 660 * pitch, freqTo: 990 * pitch,
                    freqTime: 0.07, peak: 0.11 * gain, attack: 0.004,
                    filter: 'lowpass', cutoff: 4200, reverb: 0.12 * rev,
                });
                this.#tone({
                    t: t + 0.02, dur: 0.13, type: 'sine', freq: 1980 * pitch,
                    peak: 0.035 * gain, attack: 0.004,
                });
                break;
            }

            // Screen transition: filtered noise sweeping up then away.
            case 'whoosh': {
                this.#noise({
                    t, dur: 0.55, peak: 0.13 * gain, attack: 0.16, hold: 0.05,
                    filter: 'bandpass', freq: 260, freqTo: 5200, freqTime: 0.3,
                    freqEnd: 700, q: 1.1, reverb: 0.2 * rev,
                });
                this.#noise({
                    t: t + 0.05, dur: 0.4, peak: 0.05 * gain, attack: 0.12,
                    filter: 'highpass', freq: 900, freqTo: 4000, q: 0.7,
                });
                break;
            }

            // Round announcement: bright three-note fanfare, last note held.
            case 'roundStart': {
                const notes = ['C5', 'E5', 'G5'];
                notes.forEach((n, i) => {
                    const at = t + i * 0.115;
                    const last = i === notes.length - 1;
                    const f = noteToFreq(n) * pitch;
                    this.#tone({
                        t: at, dur: last ? 0.75 : 0.24, type: 'sawtooth', freq: f,
                        peak: 0.1 * gain, attack: 0.012,
                        filter: 'lowpass', cutoff: 1600, cutoffTo: 3600,
                        cutoffTime: 0.12, q: 1, reverb: 0.3 * rev,
                    });
                    this.#tone({
                        t: at, dur: last ? 0.7 : 0.22, type: 'triangle', freq: f * 2,
                        peak: 0.035 * gain, attack: 0.01,
                    });
                });
                this.#tone({
                    t: t + 0.23, dur: 0.8, type: 'sawtooth', freq: noteToFreq('C4') * pitch,
                    peak: 0.06 * gain, attack: 0.02,
                    filter: 'lowpass', cutoff: 900,
                });
                this.#noise({
                    t, dur: 0.3, peak: 0.05 * gain, attack: 0.14,
                    filter: 'highpass', freq: 2600, reverb: 0.3 * rev,
                });
                break;
            }

            // Question appears: a soft swell into a rising fifth.
            case 'question': {
                this.#noise({
                    t, dur: 0.32, peak: 0.045 * gain, attack: 0.2,
                    filter: 'bandpass', freq: 900, freqTo: 3200, q: 0.8,
                });
                this.#tone({
                    t: t + 0.12, dur: 0.42, type: 'triangle', freq: noteToFreq('D5') * pitch,
                    peak: 0.09 * gain, attack: 0.01,
                    filter: 'lowpass', cutoff: 3000, reverb: 0.3 * rev,
                });
                this.#tone({
                    t: t + 0.2, dur: 0.5, type: 'sine', freq: noteToFreq('A5') * pitch,
                    peak: 0.06 * gain, attack: 0.012, reverb: 0.35 * rev,
                });
                this.#tone({
                    t, dur: 0.3, type: 'sine', freq: noteToFreq('D3') * pitch,
                    peak: 0.07 * gain, attack: 0.008, filter: 'lowpass', cutoff: 400,
                });
                break;
            }

            // Clock ticks.
            case 'tick': {
                this.#tone({
                    t, dur: 0.05, type: 'sine', freq: 1500 * pitch, dest,
                    peak: 0.07 * gain, attack: 0.001,
                });
                this.#noise({
                    t, dur: 0.016, peak: 0.045 * gain, attack: 0.001, dest,
                    filter: 'bandpass', freq: 3600 * pitch, q: 2,
                });
                break;
            }

            // Roughly 300 of these an evening, so the urgency is carried by the
            // body of the tick, not by piling level into 2-5 kHz where the ear
            // is most sensitive and small speakers have their presence bump.
            case 'tickUrgent': {
                const urg = clamp(opts.urgency ?? 0, 0, 1);
                this.#tone({
                    t, dur: 0.07, type: 'triangle', freq: 1350 * pitch, dest,
                    peak: 0.07 * gain, attack: 0.001,
                    filter: 'lowpass', cutoff: 3600,
                });
                this.#tone({
                    t, dur: 0.1, type: 'sine', freq: 700 * pitch, dest,
                    peak: 0.05 * (1 + urg * 0.9) * gain, attack: 0.001,
                });
                this.#noise({
                    t, dur: 0.018, peak: 0.04 * gain, attack: 0.001, dest,
                    filter: 'bandpass', freq: 3000 * pitch, q: 1.6,
                });
                break;
            }

            // Time's up: a proper buzzer, but rolled off so it never stings.
            case 'timeUp': {
                const buzz = (at, dur) => {
                    for (const [f, level] of [[165, 1], [172, 0.8], [83, 0.7]]) {
                        this.#tone({
                            t: at, dur, type: f < 100 ? 'sine' : 'sawtooth',
                            freq: f * pitch, freqTo: f * pitch * 0.94, freqTime: dur,
                            peak: 0.16 * level * gain, attack: 0.008, hold: dur * 0.55,
                            filter: 'lowpass', cutoff: 780, q: 0.8,
                            reverb: 0.18 * rev,
                        });
                    }
                    this.#noise({
                        t: at, dur: dur * 0.6, peak: 0.03 * gain, attack: 0.01,
                        filter: 'bandpass', freq: 420, q: 1.2,
                    });
                };
                buzz(t, 0.26);
                buzz(t + 0.34, 0.55);
                break;
            }

            // Accelerating snare roll for the reveal.
            case 'drumroll': {
                const total = 1.2;
                let at = 0;
                let gap = 0.075;
                let guard = 200;
                while (at < total && guard-- > 0) {
                    const x = at / total;
                    this.#noise({
                        t: t + at, dur: 0.05, peak: (0.03 + 0.06 * x) * gain,
                        attack: 0.001, filter: 'highpass', freq: 1500, q: 0.8,
                        rate: 0.9 + this.#rng() * 0.3,
                    });
                    at += gap;
                    gap = Math.max(0.019, gap * 0.93);
                }
                this.#noise({
                    t, dur: total, peak: 0.03 * gain, attack: total * 0.8,
                    filter: 'bandpass', freq: 300, q: 0.9,
                });
                this.#noise({
                    t: t + total, dur: 0.3, peak: 0.14 * gain, attack: 0.002,
                    filter: 'highpass', freq: 1200, reverb: 0.4 * rev,
                });
                this.#tone({
                    t: t + total, dur: 0.25, type: 'sine', freq: 180,
                    freqTo: 90, freqTime: 0.12, peak: 0.1 * gain, attack: 0.003,
                });
                break;
            }

            // The answer lands: a rising major-add9 stab.
            case 'reveal': {
                const chord = ['C4', 'E4', 'G4', 'B4', 'D5'];
                chord.forEach((n, i) => {
                    const at = t + i * 0.022;
                    this.#tone({
                        t: at, dur: 0.9 - i * 0.05, type: 'sawtooth',
                        freq: noteToFreq(n) * pitch,
                        peak: 0.075 * gain, attack: 0.01,
                        filter: 'lowpass', cutoff: 500, cutoffTo: 5200, cutoffTime: 0.22,
                        q: 1.2, reverb: 0.4 * rev,
                    });
                });
                this.#tone({
                    t, dur: 0.7, type: 'sine', freq: noteToFreq('C3') * pitch,
                    peak: 0.11 * gain, attack: 0.006,
                    filter: 'lowpass', cutoff: 500,
                });
                this.#noise({
                    t, dur: 0.5, peak: 0.05 * gain, attack: 0.03,
                    filter: 'highpass', freq: 2200, freqTo: 7000, reverb: 0.4 * rev,
                });
                break;
            }

            // Correct: warm ascending two-note ding.
            case 'correct': {
                const a = noteToFreq('E5') * pitch;
                const b = noteToFreq('B5') * pitch;
                this.#bell(a, t, 0.42, 0.12 * gain, this.#sfxBus, { reverb: 0.3 * rev });
                this.#bell(b, t + 0.13, 0.85, 0.13 * gain, this.#sfxBus, { reverb: 0.42 * rev });
                this.#tone({
                    t, dur: 0.5, type: 'triangle', freq: noteToFreq('E3') * pitch,
                    peak: 0.05 * gain, attack: 0.01, filter: 'lowpass', cutoff: 700,
                });
                break;
            }

            // Wrong: a soft, friendly "nope". Never a raspberry.
            case 'wrong': {
                const a = noteToFreq('A4') * pitch;
                const b = noteToFreq('F4') * pitch;
                this.#tone({
                    t, dur: 0.22, type: 'triangle', freq: a,
                    peak: 0.1 * gain, attack: 0.012,
                    filter: 'lowpass', cutoff: 1100, q: 0.7,
                });
                this.#tone({
                    t: t + 0.16, dur: 0.5, type: 'triangle', freq: b,
                    freqTo: b * 0.97, freqTime: 0.4,
                    peak: 0.11 * gain, attack: 0.014,
                    filter: 'lowpass', cutoff: 950, q: 0.7, reverb: 0.2 * rev,
                });
                this.#tone({
                    t: t + 0.16, dur: 0.45, type: 'sine', freq: b * 0.5,
                    peak: 0.06 * gain, attack: 0.014,
                });
                break;
            }

            // Score tally blip.
            case 'points': {
                this.#tone({
                    t, dur: 0.07, type: 'square', freq: noteToFreq('B5') * pitch,
                    peak: 0.055 * gain, attack: 0.002,
                    filter: 'lowpass', cutoff: 5000,
                });
                this.#tone({
                    t: t + 0.06, dur: 0.28, type: 'square', freq: noteToFreq('E6') * pitch,
                    peak: 0.055 * gain, attack: 0.003,
                    filter: 'lowpass', cutoff: 6000, reverb: 0.22 * rev,
                });
                this.#tone({
                    t: t + 0.06, dur: 0.26, type: 'sine', freq: noteToFreq('E5') * pitch,
                    peak: 0.03 * gain, attack: 0.003,
                });
                break;
            }

            // Leaderboard: shimmering upward pentatonic run.
            case 'leaderboard': {
                const run = ['C5', 'D5', 'E5', 'G5', 'A5', 'C6', 'D6', 'E6'];
                run.forEach((n, i) => {
                    this.#bell(noteToFreq(n) * pitch, t + i * 0.072,
                        0.55 + i * 0.06, (0.055 - i * 0.003) * gain,
                        this.#sfxBus, { reverb: 0.45 * rev });
                });
                this.#noise({
                    t, dur: 0.9, peak: 0.03 * gain, attack: 0.5,
                    filter: 'bandpass', freq: 2400, freqTo: 8000, q: 0.8,
                    reverb: 0.4 * rev,
                });
                break;
            }

            // Winner fanfare: brass-ish, three stabs into a held chord.
            case 'fanfare': {
                const brass = (n, at, dur, level) => {
                    const f = noteToFreq(n) * pitch;
                    this.#tone({
                        t: at, dur, type: 'sawtooth', freq: f,
                        peak: 0.09 * level * gain, attack: 0.018,
                        filter: 'lowpass', cutoff: 1200, cutoffTo: 3200,
                        cutoffTime: Math.min(0.2, dur), q: 1.1, reverb: 0.3 * rev,
                    });
                    this.#tone({
                        t: at, dur: dur * 0.9, type: 'sawtooth', freq: f * 1.005,
                        peak: 0.05 * level * gain, attack: 0.02,
                        filter: 'lowpass', cutoff: 2200,
                    });
                };
                brass('G4', t, 0.16, 1);
                brass('G4', t + 0.19, 0.16, 1);
                brass('G4', t + 0.38, 0.16, 1);
                brass('C5', t + 0.57, 0.55, 1);
                brass('E4', t + 0.57, 0.55, 0.6);
                brass('C3', t + 0.57, 0.6, 0.7);
                brass('E5', t + 1.18, 0.22, 0.9);
                brass('F5', t + 1.4, 0.22, 0.9);
                brass('G5', t + 1.62, 1.1, 1);
                brass('C5', t + 1.62, 1.1, 0.6);
                brass('E5', t + 1.62, 1.1, 0.5);
                brass('C3', t + 1.62, 1.15, 0.8);
                this.#noise({
                    t: t + 1.62, dur: 1.3, peak: 0.05 * gain, attack: 0.02,
                    filter: 'highpass', freq: 3500, reverb: 0.5 * rev,
                });
                this.#tone({
                    t: t + 0.57, dur: 0.3, type: 'sine', freq: 90, freqTo: 55,
                    freqTime: 0.15, peak: 0.1 * gain, attack: 0.004,
                });
                break;
            }

            // A pub's worth of hands: a noise wash plus a hundred-odd grains.
            case 'applause': {
                this.#applause(t, 2.6, gain);
                break;
            }

            // Gentle low double-blip.
            case 'error': {
                for (const [i, f] of [[0, 220], [1, 196]]) {
                    this.#tone({
                        t: t + i * 0.15, dur: 0.16, type: 'triangle', freq: f * pitch,
                        peak: 0.1 * gain, attack: 0.008,
                        filter: 'lowpass', cutoff: 900, q: 0.8,
                    });
                    this.#tone({
                        t: t + i * 0.15, dur: 0.14, type: 'sine', freq: f * 2 * pitch,
                        peak: 0.035 * gain, attack: 0.008,
                    });
                }
                break;
            }

            default:
                // Unknown effect names are ignored on purpose: callers can add
                // names before the sound exists without breaking the app.
                break;
        }
    }

    #applause(t0, dur, gain) {
        const ctx = this.#ctx;
        if (!ctx || !this.#clapBuf) return;
        // The grains are scheduled against the audio clock at t0, which play()
        // lets the caller push into the future; the shared chain below is torn
        // down on a wall clock, so every delay has to carry that lead time or
        // pre-scheduled applause disconnects itself before it sounds.
        const lead = Math.max(0, t0 - ctx.currentTime);

        // Shared colouring for every grain, so a clap costs two nodes not five.
        const bus = ctx.createGain();
        bus.gain.setValueAtTime(1, t0);
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.setValueAtTime(1900, t0);
        band.Q.setValueAtTime(0.55, t0);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.setValueAtTime(700, t0);
        band.connect(hp);
        hp.connect(bus);
        bus.connect(this.#sfxBus);
        if (this.#reverbSend) {
            const send = ctx.createGain();
            send.gain.setValueAtTime(0.35, t0);
            bus.connect(send);
            send.connect(this.#reverbSend);
            this.#after((lead + dur + 1.6) * 1000, () => {
                try { send.disconnect(); } catch (_) { /* ignore */ }
            });
        }

        // A little stereo spread without a panner per grain.
        const spread = [];
        if (ctx.createStereoPanner) {
            for (const pan of [-0.55, 0, 0.55]) {
                const p = ctx.createStereoPanner();
                p.pan.setValueAtTime(pan, t0);
                p.connect(band);
                spread.push(p);
            }
        }
        const entry = () => (spread.length
            ? spread[(this.#rng() * spread.length) | 0]
            : band);

        // Density/level envelope: quick swell, full house, natural die-away.
        const shape = (x) => {
            if (x < 0.1) return 0.25 + 0.75 * (x / 0.1);
            if (x < 0.45) return 1;
            return Math.max(0, 1 - (x - 0.45) / 0.6);
        };

        // The crowd "body" — continuous filtered noise under the grains.
        this.#noise({
            t: t0, dur: dur + 0.45, peak: 0.05 * gain, attack: 0.22,
            hold: dur * 0.35, filter: 'bandpass', freq: 2000, q: 0.5,
            dest: bus,
        });

        let at = 0;
        let grains = 0;
        while (at < dur && grains < 220) {
            const x = at / dur;
            const density = shape(x);
            if (density > 0.02) {
                const src = ctx.createBufferSource();
                src.buffer = this.#clapBuf;
                src.playbackRate.setValueAtTime(0.7 + this.#rng() * 0.9, t0 + at);
                const g = ctx.createGain();
                const level = (0.05 + this.#rng() * 0.1) * density * gain;
                g.gain.setValueAtTime(level, t0 + at);
                src.connect(g);
                g.connect(entry());
                src.start(t0 + at);
                src.stop(t0 + at + 0.12);
                this.#track(src, [g]);
                grains++;
            }
            at += 0.011 + (1 - density) * 0.05 + this.#rng() * 0.012;
        }

        this.#after((lead + dur + 1.9) * 1000, () => {
            for (const p of spread) { try { p.disconnect(); } catch (_) { /* ignore */ } }
            try { band.disconnect(); } catch (_) { /* ignore */ }
            try { hp.disconnect(); } catch (_) { /* ignore */ }
            try { bus.disconnect(); } catch (_) { /* ignore */ }
        });
    }
}

export default QuizAudio;
