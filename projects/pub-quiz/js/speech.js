// speech.js — the quizmaster's voice.
//
// A defensive wrapper around window.speechSynthesis built for a live pub quiz:
// one laptop, a Bluetooth speaker, 60-90 minutes, hundreds of utterances.
//
// The Web Speech API is riddled with browser bugs, so every one of them is
// handled here rather than in the app:
//   * Chrome returns an empty voice list until 'voiceschanged' fires
//   * Chrome silently stops speaking after ~15 seconds (pause/resume keep-alive)
//   * 'end' never fires in some situations (watchdog timeout per utterance)
//   * cancel() fires 'error' with 'interrupted'/'canceled' (resolved, not thrown)
//   * an utterance queued too soon after cancel() is silently dropped (restart gap)
//   * some browsers require a user gesture before the first utterance
//
// Nothing here ever throws out of a public method and speak() never rejects:
// the quiz must keep running even if speech is broken or unavailable.
//
// Zero dependencies. No network. No DOM required.

// ---- ranges & defaults ----

const RATE_MIN = 0.5;
const RATE_MAX = 2;
const PITCH_MIN = 0;
const PITCH_MAX = 2;
const VOLUME_MIN = 0;
const VOLUME_MAX = 1;

const DEFAULTS = {
  rate: 1,
  pitch: 1,
  volume: 1,
  enabled: true,
  voiceId: null,
  lang: 'en-GB',
  // how long init() will wait for the voice list before giving up
  voiceTimeout: 3000,
  // pause()/resume() ping interval — must be comfortably under Chrome's ~15s cutoff
  keepAliveMs: 8000,
  // minimum quiet time between cancel() and the next speak(), or Chrome eats it
  restartGap: 110,
  // if 'start' has not fired after this long, try the utterance once more
  startGuardMs: 1400,
  // watchdog padding
  watchdogFactor: 1.8,
  watchdogPadMs: 2500,
  watchdogMinMs: 3000,
  watchdogMaxMs: 300000,
  // how many times a watchdog may be extended while the engine still claims to speak
  watchdogExtensions: 3,
  // longest a user pause may hold a speak() promise before it is given back as
  // 'cancelled' — the quiz must never be left waiting on a forgotten pause
  pauseMaxMs: 60000,
};

// how often the watchdog re-checks itself while the quizmaster holds a pause
const PAUSE_TICK_MS = 1000;

const SAMPLE_TEXT =
  'Right then, ladies and gentlemen. Round one, question one. Pens at the ready.';

// ---- environment sniffing (used only to decide which workarounds to apply) ----

const UA = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
const IS_SAFARI = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(UA);
const IS_CHROMIUM = /chrome|chromium|crios|edg/i.test(UA) && !IS_SAFARI;
// Every iOS browser is WebKit underneath — Chrome (CriOS), Edge (EdgiOS) and
// Firefox (FxiOS) all drive Safari's speech engine, which has no ~15s cutoff and
// misbehaves under the pause/resume ping. Android Chrome does not have the
// desktop cutoff either and stutters under the ping. So: desktop Chromium only.
const IS_IOS =
  /iPad|iPhone|iPod|CriOS|FxiOS|EdgiOS/i.test(UA) ||
  (/Macintosh/i.test(UA) &&
    typeof navigator !== 'undefined' &&
    Number(navigator.maxTouchPoints) > 1);
const IS_ANDROID = /android/i.test(UA);
const IS_DESKTOP_CHROMIUM = IS_CHROMIUM && !IS_SAFARI && !IS_IOS && !IS_ANDROID;

// ---- small utilities ----

/**
 * Clamp into [min, max]. A non-numeric value falls back to `fallback` (the
 * current setting, or the documented default) rather than to `min`: a missing
 * or null persisted setting must never silently mute or slow the quizmaster.
 */
const clamp = (n, min, max, fallback = min) => {
  // null and '' are "no opinion", not zero — Number(null) === 0 would otherwise
  // read a JSON `"volume": null` as a muted quizmaster.
  const v = n === null || n === undefined || n === '' ? NaN : Number(n);
  if (!Number.isFinite(v)) {
    const f = Number(fallback);
    if (!Number.isFinite(f)) return min;
    return f < min ? min : f > max ? max : f;
  }
  return v < min ? min : v > max ? max : v;
};

const now = () => Date.now();

const noop = () => {};

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unicode property escapes are widely supported but built lazily behind a guard
// so an exotic engine cannot take the whole module down at parse time.
let EMOJI_RE = null;
let LETTER_NUM_CLASS = '\\w';
try {
  EMOJI_RE = new RegExp('[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\uFE0F\\u200D]', 'gu');
  // eslint-disable-next-line no-new
  new RegExp('[\\p{L}\\p{N}]', 'u');
  LETTER_NUM_CLASS = '\\p{L}\\p{N}';
} catch {
  EMOJI_RE = null;
  LETTER_NUM_CLASS = '\\w';
}
const LEX_FLAGS = LETTER_NUM_CLASS === '\\w' ? 'gi' : 'giu';

// ---- ordinals ----

const ONES_ORDINAL = [
  '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
  'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
];
const TENS_CARDINAL = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const TENS_ORDINAL = ['', '', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];

/** Spoken ordinal for 1-100, or null when we would rather leave the digits alone. */
function ordinalWord(n) {
  if (!Number.isInteger(n) || n < 1 || n > 100) return null;
  if (n === 100) return 'hundredth';
  if (n < 20) return ONES_ORDINAL[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (ones === 0) return TENS_ORDINAL[tens];
  return `${TENS_CARDINAL[tens]}-${ONES_ORDINAL[ones]}`;
}

// ---- voice quality ranking ----
// This is a British pub quiz: en-GB wins, then the rest of the English-speaking
// world, then everything else. Known-good named voices and cloud (non-local)
// voices are boosted because they sound markedly better; novelty and eSpeak-class
// voices are pushed to the bottom of the picker.

const NAME_SCORES = [
  [/google\s+uk\s+english/i, 45],
  [/\bsonia\b/i, 40],
  [/\bryan\b/i, 36],
  [/\bdaniel\b/i, 34],
  [/\blibby\b/i, 30],
  [/\bserena\b/i, 30],
  [/\bkate\b/i, 26],
  [/\bstephanie\b|\bmaisie\b|\bthomas\b/i, 20],
  [/\barthur\b|\bmartha\b|\boliver\b|\bhazel\b|\bgeorge\b/i, 18],
  [/\b(neural|natural|online|enhanced|premium|siri)\b/i, 22],
  [/\bgoogle\b/i, 15],
  [/\bmicrosoft\b/i, 10],
  [/\bcompact\b/i, -25],
  [/espeak|festival|\bpico\b|\bflite\b|\bmbrola\b/i, -60],
  [
    /novelty|whisper|bells|bad news|good news|bubbles|cellos|zarvox|trinoids|boing|jester|organ|superstar|wobble|albert|bahh|deranged|hysterical|pipe organ|junior|kathy|princess|ralph|fred/i,
    -80,
  ],
];

function scoreVoice(v) {
  const name = String(v?.name || '');
  const lang = String(v?.lang || '').replace(/_/g, '-').toLowerCase();
  let score = 0;

  if (lang.startsWith('en-gb') || lang.startsWith('en-uk')) score += 100;
  else if (lang.startsWith('en-ie')) score += 70;
  else if (lang.startsWith('en-au') || lang.startsWith('en-nz') || lang.startsWith('en-za')) score += 60;
  else if (lang === 'en' || lang.startsWith('en-')) score += 50;
  else score -= 200;

  for (const [re, bonus] of NAME_SCORES) {
    if (re.test(name)) score += bonus;
  }

  if (v?.localService === false) score += 25;
  if (v?.default) score += 5;

  return score;
}

function isEnglish(descriptor) {
  const lang = String(descriptor?.lang || '').toLowerCase();
  return lang === 'en' || lang.startsWith('en-') || lang.startsWith('en_');
}

// ---- the class ----

export class QuizSpeech {
  // configuration
  #opts;
  #synth = null;
  #supported = false;

  // voices
  #descriptors = [];           // public { id, name, lang, local, quality, isDefault }
  #byId = new Map();           // id -> { voice, descriptor }
  #voiceId = null;
  #autoVoice = true;
  #requestedVoiceId = null;    // explicit choice, kept until a real list disowns it

  // settings
  #rate;
  #pitch;
  #volume;
  #enabled;

  // state
  #initPromise = null;
  #initialised = false;
  #primed = false;
  #everSpoke = false;          // an utterance has been handed to the engine at least once
  #gestureBlocked = false;
  #userPaused = false;
  #pausedAt = 0;
  #destroyed = false;

  // queue / current utterance
  #queue = [];
  #active = null;              // utterance currently with the engine
  #current = null;             // job being run, including its delay / restart gap
  #sequences = 0;              // speakSequence() calls in flight
  #pumping = false;
  #cancelGen = 0;
  #lastCancelAt = 0;
  #sleeps = new Set();
  #keepAliveTimer = null;

  // listeners
  #listeners = new Set();
  #suppressEmit = 0;
  #lastSignature = null;
  #voicesChangedHandler = null;
  #voicePoll = null;
  #voiceTimer = null;
  #initFinish = null;

  // pronunciation overrides
  #lexicon = new Map();

  constructor(opts = {}) {
    this.#opts = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };

    this.#rate = clamp(this.#opts.rate, RATE_MIN, RATE_MAX, DEFAULTS.rate);
    this.#pitch = clamp(this.#opts.pitch, PITCH_MIN, PITCH_MAX, DEFAULTS.pitch);
    this.#volume = clamp(this.#opts.volume, VOLUME_MIN, VOLUME_MAX, DEFAULTS.volume);
    this.#enabled = this.#opts.enabled !== false;
    this.#requestedVoiceId = this.#opts.voiceId ?? null;
    this.#voiceId = this.#requestedVoiceId;
    this.#autoVoice = !this.#requestedVoiceId;

    try {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      const Utter = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null;
      if (synth && typeof synth.speak === 'function' && typeof Utter === 'function') {
        this.#synth = synth;
        this.#supported = true;
      }
    } catch {
      this.#synth = null;
      this.#supported = false;
    }

    if (this.#opts.lexicon) this.setLexicon(this.#opts.lexicon);

    // A leftover queue from a previous page-load state (Chrome keeps the engine
    // alive across soft navigations) would swallow our first utterance.
    this.#safe(() => {
      if (this.#synth && (this.#synth.speaking || this.#synth.pending)) this.#synth.cancel();
    });
  }

  // ---- capability ----

  get supported() {
    return this.#supported;
  }

  get initialised() {
    return this.#initialised;
  }

  /** True until an utterance has actually started; some browsers need a click first. */
  get needsGesture() {
    return this.#supported && !this.#primed;
  }

  get primed() {
    return this.#primed;
  }

  /** True when a speak() attempt was explicitly refused for want of a user gesture. */
  get gestureBlocked() {
    return this.#gestureBlocked;
  }

  // ---- init ----

  /**
   * Resolve once the voice list is populated, or after ~3s, whichever is first.
   * Idempotent, never rejects. Resolves with the instance for easy chaining.
   */
  async init() {
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = new Promise((resolve) => {
      if (!this.#supported || this.#destroyed) {
        this.#initialised = true;
        resolve(this);
        return;
      }

      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        this.#initFinish = null;
        // Both handles live on the instance so destroy() can clear them: a stray
        // 3s timeout must not wake a destroyed instance.
        if (this.#voiceTimer) {
          clearTimeout(this.#voiceTimer);
          this.#voiceTimer = null;
        }
        if (this.#voicePoll) {
          clearInterval(this.#voicePoll);
          this.#voicePoll = null;
        }
        this.#initialised = true;
        if (!this.#destroyed) {
          this.#refreshVoices();
          this.#emit();
        }
        resolve(this);
      };
      // destroy() calls this so an awaited init() can never hang.
      this.#initFinish = finish;

      // Persistent listener: Chrome and Edge add cloud voices well after startup.
      this.#voicesChangedHandler = () => {
        this.#refreshVoices();
        if (!settled && this.#descriptors.length) finish();
        else this.#emit();
      };
      this.#safe(() => {
        if (typeof this.#synth.addEventListener === 'function') {
          this.#synth.addEventListener('voiceschanged', this.#voicesChangedHandler);
        } else {
          this.#synth.onvoiceschanged = this.#voicesChangedHandler;
        }
      });

      // Already there? (Firefox, Safari, and Chrome on a warm engine.)
      this.#refreshVoices();
      if (this.#descriptors.length) {
        finish();
        return;
      }

      // Polling fallback: 'voiceschanged' does not fire at all in some builds.
      this.#voicePoll = setInterval(() => {
        this.#refreshVoices();
        if (this.#descriptors.length) finish();
      }, 200);

      // Hard timeout so init() can never hang the app.
      this.#voiceTimer = setTimeout(
        finish,
        Math.max(250, Number(this.#opts.voiceTimeout) || DEFAULTS.voiceTimeout),
      );
    });

    return this.#initPromise;
  }

  // ---- voices ----

  #refreshVoices() {
    if (!this.#supported) return;
    let list = [];
    this.#safe(() => {
      const raw = this.#synth.getVoices();
      if (Array.isArray(raw)) list = raw;
      else if (raw && typeof raw.length === 'number') list = Array.prototype.slice.call(raw);
    });
    // An empty list teaches us nothing. Chrome returns [] until 'voiceschanged'
    // fires, and re-resolving a selection against nothing would throw away the
    // host's saved voice before the real list has even arrived.
    if (!list.length) return;

    const byId = new Map();
    const descriptors = [];
    const seen = new Set();

    list.forEach((v, i) => {
      if (!v || typeof v.name !== 'string') return;
      let id = v.voiceURI || `${v.name}|${v.lang}`;
      if (seen.has(id)) {
        // Duplicate voiceURIs happen (notably Chrome on Linux); keep both addressable.
        const dupKey = `${id}#${i}`;
        if (seen.has(dupKey)) return;
        id = dupKey;
      }
      seen.add(id);
      const descriptor = Object.freeze({
        id,
        name: v.name,
        lang: String(v.lang || '').replace(/_/g, '-'),
        local: v.localService !== false,
        quality: scoreVoice(v),
        isDefault: v.default === true,
      });
      descriptors.push(descriptor);
      byId.set(id, { voice: v, descriptor });
    });

    descriptors.sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name));

    this.#descriptors = descriptors;
    this.#byId = byId;

    // Re-resolve an explicit request (a saved voiceURI, or a name carried over
    // from another machine) against the new list. The request survives every
    // refresh until a real, non-empty list has been seen without it.
    if (this.#requestedVoiceId) {
      const match = this.#resolveDescriptor(this.#requestedVoiceId);
      if (match) {
        this.#voiceId = match.id;
        this.#autoVoice = false;
      } else {
        this.#requestedVoiceId = null;
        this.#voiceId = null;
        this.#autoVoice = true;
      }
    }

    if (this.#autoVoice || !this.#voiceId || !byId.has(this.#voiceId)) {
      // Chrome fires 'voiceschanged' again when cloud voices land, sometimes
      // mid-quiz. Once we have actually spoken, keep the voice the quiz started
      // with rather than swapping quizmaster between questions.
      const keep = this.#everSpoke && this.#voiceId && byId.has(this.#voiceId);
      if (!keep) {
        const best = this.#pickDefault();
        this.#voiceId = best ? best.id : null;
      }
      this.#autoVoice = !this.#requestedVoiceId;
    }
  }

  /** Find a descriptor by voiceURI, by name, or by a de-duplicated `id#n`. */
  #resolveDescriptor(id) {
    if (id == null || id === '') return null;
    const direct = this.#byId.get(id);
    if (direct) return direct.descriptor;
    return (
      this.#descriptors.find((d) => d.id === id) ||
      this.#descriptors.find((d) => d.name === id) ||
      this.#descriptors.find((d) => d.id.startsWith(`${id}#`)) ||
      null
    );
  }

  #pickDefault() {
    if (!this.#descriptors.length) return null;
    const english = this.#descriptors.filter(isEnglish);
    return (english.length ? english : this.#descriptors)[0] || null;
  }

  /** All known voices, best first. */
  get voices() {
    return this.#descriptors.slice();
  }

  /** Voices for a picker. English only by default; falls back to everything if empty. */
  listVoices({ englishOnly = true } = {}) {
    if (!englishOnly) return this.#descriptors.slice();
    const english = this.#descriptors.filter(isEnglish);
    return (english.length ? english : this.#descriptors).slice();
  }

  /**
   * Select a voice by id (voiceURI). Unknown / null id falls back to the best
   * available default. Returns the descriptor actually in use (or null).
   */
  setVoice(id) {
    const previous = this.#voiceId;
    if (id == null || id === '' || id === 'auto' || id === 'default') {
      this.#requestedVoiceId = null;
      this.#autoVoice = true;
      const best = this.#pickDefault();
      this.#voiceId = best ? best.id : null;
    } else {
      // Tolerate a saved name or a stale URI from another machine.
      const match = this.#resolveDescriptor(id);
      if (match) {
        this.#requestedVoiceId = id;
        this.#autoVoice = false;
        this.#voiceId = match.id;
      } else if (!this.#initialised || !this.#descriptors.length) {
        // Voices may not be loaded yet — remember the request; every
        // #refreshVoices() re-attempts it against the list that arrives.
        this.#requestedVoiceId = id;
        this.#autoVoice = false;
        this.#voiceId = id;
      } else {
        // Genuinely unknown against a real voice list: fall back to the default.
        this.#requestedVoiceId = null;
        this.#autoVoice = true;
        const best = this.#pickDefault();
        this.#voiceId = best ? best.id : null;
      }
    }
    if (this.#voiceId !== previous) this.#emit();
    return this.voice;
  }

  /** Current voice descriptor, or null. */
  get voice() {
    if (!this.#voiceId) return null;
    return this.#byId.get(this.#voiceId)?.descriptor || null;
  }

  #currentVoiceObject() {
    if (!this.#voiceId) return null;
    return this.#byId.get(this.#voiceId)?.voice || null;
  }

  // ---- settings ----

  // A junk / missing value leaves the current setting alone rather than pinning
  // it to the minimum (which for volume means a silent quizmaster).
  setRate(r) {
    this.#rate = clamp(r, RATE_MIN, RATE_MAX, this.#rate);
    return this.#rate;
  }

  setPitch(p) {
    this.#pitch = clamp(p, PITCH_MIN, PITCH_MAX, this.#pitch);
    return this.#pitch;
  }

  setVolume(v) {
    this.#volume = clamp(v, VOLUME_MIN, VOLUME_MAX, this.#volume);
    return this.#volume;
  }

  get rate() {
    return this.#rate;
  }

  get pitch() {
    return this.#pitch;
  }

  get volume() {
    return this.#volume;
  }

  get settings() {
    return {
      voiceId: this.#voiceId,
      rate: this.#rate,
      pitch: this.#pitch,
      volume: this.#volume,
      enabled: this.#enabled,
    };
  }

  /** Restore a settings object previously read from `settings`. */
  applySettings(settings = {}) {
    if (!settings || typeof settings !== 'object') return this.settings;
    // A key that round-tripped through JSON as null, or a save file that predates
    // a setting, means "no opinion" — not "zero".
    const has = (key) => settings[key] !== undefined && settings[key] !== null;
    if (has('rate')) this.setRate(settings.rate);
    if (has('pitch')) this.setPitch(settings.pitch);
    if (has('volume')) this.setVolume(settings.volume);
    if (has('enabled')) this.setEnabled(settings.enabled);
    if ('voiceId' in settings) this.setVoice(settings.voiceId);
    return this.settings;
  }

  setEnabled(on) {
    const next = !!on;
    if (next === this.#enabled) return this.#enabled;
    this.#enabled = next;
    if (!next) this.cancel();
    else this.#emit();
    return this.#enabled;
  }

  get enabled() {
    return this.#enabled;
  }

  // ---- pronunciation ----

  /**
   * Pronunciation overrides applied before every other clean-time rewrite,
   * e.g. { 'Ke$ha': 'Kesha', 'Hyundai': 'Hyun-day' }. Replaces the whole map.
   */
  setLexicon(map) {
    const next = new Map();
    const entries = map instanceof Map ? map.entries() : Object.entries(map || {});
    for (const [key, value] of entries) {
      const k = String(key ?? '').trim();
      if (!k) continue;
      next.set(k, String(value ?? ''));
    }
    this.#lexicon = next;
    QuizSpeech.#sharedLexicon = next;
    return this.lexicon;
  }

  get lexicon() {
    return Object.fromEntries(this.#lexicon);
  }

  /** Instance-level clean: applies this instance's lexicon, then the static rules. */
  clean(text) {
    return QuizSpeech.clean(text, this.#lexicon);
  }

  // ---- speaking ----

  /**
   * True for the whole of a delivery, not just while the engine has audio:
   * a job's `delay`, the post-cancel restart gap, a pause gate and the gaps
   * between the parts of a speakSequence all count. Callers wire this straight
   * to an "is speaking" indicator, so it must not flicker between parts.
   */
  get speaking() {
    return !!this.#active || !!this.#current || this.#queue.length > 0 || this.#sequences > 0;
  }

  get paused() {
    return this.#userPaused;
  }

  /** Rough spoken duration in ms — handy for timing slides against the voice. */
  estimate(text, rate = this.#rate) {
    const chars = String(text || '').length;
    const r = clamp(rate, RATE_MIN, RATE_MAX, this.#rate);
    return 600 + (chars / (12 * r)) * 1000;
  }

  /**
   * Speak some text.
   * @param {string} text
   * @param {{ interrupt?: boolean, rate?: number, pitch?: number, volume?: number,
   *           delay?: number, clean?: boolean, lang?: string }} [opts]
   * @returns {Promise<'ended'|'cancelled'|'skipped'|'error'>} never rejects.
   */
  speak(text, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const interrupt = options.interrupt !== false;

    let resolveJob = noop;
    const promise = new Promise((resolve) => {
      resolveJob = resolve;
    });

    const job = {
      text: options.clean === false ? String(text ?? '') : this.clean(text),
      rate: clamp(options.rate ?? this.#rate, RATE_MIN, RATE_MAX, this.#rate),
      pitch: clamp(options.pitch ?? this.#pitch, PITCH_MIN, PITCH_MAX, this.#pitch),
      volume: clamp(options.volume ?? this.#volume, VOLUME_MIN, VOLUME_MAX, this.#volume),
      lang: options.lang || null,
      delay: Math.max(0, Number(options.delay) || 0),
      done: false,
      utterance: null,
      started: false,
      retried: false,
      watchdog: null,
      watchdogFire: null,
      deadline: 0,
      startGuard: null,
      startChecks: 0,
      extensions: 0,
      promise,
      settle: (result) => {
        if (job.done) return;
        job.done = true;
        this.#clearJobTimers(job);
        if (this.#active === job) {
          this.#active = null;
          this.#stopKeepAlive();
        }
        try {
          resolveJob(result);
        } catch {
          /* a resolve callback can never fail, but never say never */
        }
        this.#emit();
      },
    };

    if (!this.#supported || !this.#enabled || this.#destroyed || !job.text) {
      job.settle('skipped');
      return promise;
    }

    if (interrupt) this.#flush('cancelled');
    this.#queue.push(job);
    this.#pump();
    return promise;
  }

  /**
   * Speak an array of parts in order. Each part is a string, or
   * { text, pause } where `pause` is a gap in ms after that part.
   * Stops early (resolving 'cancelled') if anything cancels the queue.
   */
  async speakSequence(parts, opts = {}) {
    if (!Array.isArray(parts) || !parts.length) return 'skipped';
    const options = opts && typeof opts === 'object' ? opts : {};
    const interruptFirst = options.interrupt !== false;

    // Count the sequence as "speaking" for its whole run, gaps included, so the
    // indicator does not strobe between parts. Only while we can actually speak:
    // a sequence against a disabled engine must not claim the floor.
    const tracked = this.#supported && this.#enabled && !this.#destroyed;
    if (tracked) this.#sequences += 1;

    try {
      let result = 'skipped';
      let first = true;

      // Sampled after the first utterance, never before: a speak() with
      // interrupt:true bumps the cancel generation itself, and mistaking our own
      // interrupt for a cancellation would abandon the sequence after part one.
      let generation = null;

      for (const raw of parts) {
        if (this.#destroyed) return 'cancelled';
        if (generation !== null && this.#cancelGen !== generation) return 'cancelled';
        const part = typeof raw === 'string' ? { text: raw } : raw || {};
        const text = part.text ?? '';

        if (String(text).trim()) {
          const outcome = await this.speak(text, {
            rate: part.rate ?? options.rate,
            pitch: part.pitch ?? options.pitch,
            volume: part.volume ?? options.volume,
            lang: part.lang ?? options.lang,
            clean: part.clean ?? options.clean,
            delay: part.delay ?? 0,
            interrupt: first && interruptFirst,
          });
          first = false;
          generation = this.#cancelGen;
          if (outcome === 'cancelled') return 'cancelled';
          if (outcome === 'error') result = 'error';
          else if (outcome === 'ended' && result !== 'error') result = 'ended';
        }

        // With speech off every part resolves 'skipped' instantly; sitting out
        // the pauses as well would stall the caller through the whole dead air.
        const pause = this.#enabled && this.#supported ? Math.max(0, Number(part.pause) || 0) : 0;
        if (pause > 0) {
          if (generation === null) generation = this.#cancelGen;
          const completed = await this.#sleep(pause);
          if (!completed || this.#cancelGen !== generation) return 'cancelled';
        }
      }

      return result;
    } finally {
      if (tracked) {
        this.#sequences -= 1;
        this.#emit();
      }
    }
  }

  /** Speak a sample line — for the settings screen / voice picker. */
  async test(text) {
    await this.init();
    return this.speak(text || SAMPLE_TEXT, { interrupt: true });
  }

  /**
   * Unlock audio from inside a click handler on browsers that demand a gesture.
   * Speaks a silent utterance; safe to call repeatedly.
   */
  async prime() {
    if (!this.#supported || this.#primed) return this.#primed;
    await this.init();
    await this.speak('ready', { volume: 0, interrupt: true, clean: false });
    return this.#primed;
  }

  /** Stop everything immediately. All pending promises resolve 'cancelled'. */
  cancel() {
    this.#flush('cancelled');
  }

  /**
   * Hold everything. Valid between utterances too: a pause pressed during a
   * sequence gap, a delay or the restart gap holds the *next* part rather than
   * being thrown away. Nothing starts again until resume() or cancel().
   */
  pause() {
    if (!this.#supported) return;
    if (!this.#userPaused) this.#pausedAt = now();
    this.#userPaused = true;
    this.#safe(() => this.#synth.pause());
    // Put the active watchdog on the pause cadence so `pauseMaxMs` is honoured
    // even when the utterance had minutes of budget left. Firing early costs
    // nothing: the watchdog sleeps again for whatever the deadline still owes.
    const job = this.#active;
    if (job && !job.done && typeof job.watchdogFire === 'function') {
      if (job.watchdog) clearTimeout(job.watchdog);
      job.watchdog = setTimeout(job.watchdogFire, PAUSE_TICK_MS);
    }
    this.#emit();
  }

  resume() {
    if (!this.#supported) return;
    this.#userPaused = false;
    this.#pausedAt = 0;
    this.#safe(() => this.#synth.resume());
    this.#emit();
  }

  /**
   * True once a pause has been held so long that the quiz cannot still be
   * waiting on it — the promises are handed back rather than wedged forever.
   */
  #pauseExpired() {
    if (!this.#userPaused || !this.#pausedAt) return false;
    const ceiling = Number(this.#opts.pauseMaxMs);
    if (!Number.isFinite(ceiling) || ceiling <= 0) return false;
    return now() - this.#pausedAt >= ceiling;
  }

  // ---- change notification ----

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(cb) {
    if (typeof cb !== 'function') return noop;
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit() {
    if (this.#suppressEmit > 0) return;
    const payload = {
      speaking: this.speaking,
      voiceId: this.#voiceId,
      enabled: this.#enabled,
      paused: this.#userPaused,
      supported: this.#supported,
      needsGesture: this.needsGesture,
      voiceCount: this.#descriptors.length,
    };
    // Hundreds of utterances a session: only wake listeners on a real change.
    const signature = `${payload.speaking}|${payload.voiceId}|${payload.enabled}|` +
      `${payload.paused}|${payload.supported}|${payload.needsGesture}|${payload.voiceCount}`;
    if (signature === this.#lastSignature) return;
    this.#lastSignature = signature;

    for (const cb of Array.from(this.#listeners)) {
      try {
        cb(payload);
      } catch (err) {
        console.warn('[speech] listener threw', err);
      }
    }
  }

  /** Drop every listener and timer. Safe to call more than once. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#flush('cancelled');
    // Release anyone awaiting init() and clear its timers in one go; finish()
    // owns both handles and no-ops on a destroyed instance.
    const finishInit = this.#initFinish;
    this.#initFinish = null;
    if (finishInit) this.#safe(finishInit);
    this.#listeners.clear();
    if (this.#voicePoll) {
      clearInterval(this.#voicePoll);
      this.#voicePoll = null;
    }
    if (this.#voiceTimer) {
      clearTimeout(this.#voiceTimer);
      this.#voiceTimer = null;
    }
    this.#safe(() => {
      if (!this.#voicesChangedHandler) return;
      if (typeof this.#synth?.removeEventListener === 'function') {
        this.#synth.removeEventListener('voiceschanged', this.#voicesChangedHandler);
      } else if (this.#synth) {
        this.#synth.onvoiceschanged = null;
      }
    });
    this.#voicesChangedHandler = null;
  }

  // ---- queue engine ----

  async #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length && !this.#destroyed) {
        const job = this.#queue.shift();
        // Held for the whole run — delay, restart gap and pause gate included —
        // so `speaking` never reads false with a job in flight.
        this.#current = job;
        try {
          await this.#runJob(job);
        } finally {
          if (this.#current === job) this.#current = null;
        }
      }
    } catch (err) {
      console.warn('[speech] queue error', err);
    } finally {
      this.#pumping = false;
      this.#emit();
    }
  }

  async #runJob(job) {
    if (job.done) return;
    if (!this.#supported || !this.#enabled || this.#destroyed) {
      job.settle('skipped');
      return;
    }

    const generation = this.#cancelGen;

    if (job.delay > 0) {
      const completed = await this.#sleep(job.delay);
      if (!completed || job.done || this.#cancelGen !== generation) {
        job.settle('cancelled');
        return;
      }
    }

    // Chrome drops an utterance queued immediately after cancel().
    if (!(await this.#awaitRestartGap(job, generation))) {
      job.settle('cancelled');
      return;
    }

    // The quizmaster may have pressed pause during the delay or the gap above.
    // Hold the job rather than starting it and losing their intent.
    if (!(await this.#awaitResume(job, generation))) {
      job.settle('cancelled');
      return;
    }

    this.#beginUtterance(job);
    await job.promise;
  }

  /** Wait out the quiet period Chrome needs after a cancel(). */
  async #awaitRestartGap(job, generation) {
    const gap = Math.max(0, Number(this.#opts.restartGap) || 0);
    const sinceCancel = now() - this.#lastCancelAt;
    if (sinceCancel >= gap) return true;
    const completed = await this.#sleep(gap - sinceCancel);
    return completed && !job.done && this.#cancelGen === generation && !this.#destroyed;
  }

  /**
   * Block while the quizmaster holds a pause. Resolves false if the job is
   * cancelled meanwhile, or if the pause outlives `pauseMaxMs` — a promise the
   * caller is still awaiting must always come back.
   */
  async #awaitResume(job, generation) {
    while (this.#userPaused && !this.#destroyed) {
      if (job.done || this.#cancelGen !== generation) return false;
      if (this.#pauseExpired()) return false;
      const completed = await this.#sleep(120);
      if (!completed) return false;
    }
    return !job.done && this.#cancelGen === generation && !this.#destroyed;
  }

  #beginUtterance(job) {
    if (job.done) return;

    const utterance = this.#makeUtterance(job);
    if (!utterance) {
      job.settle('error');
      return;
    }

    this.#active = job;

    try {
      // A paused engine silently swallows everything queued behind it — but a
      // pause the quizmaster asked for is honoured by the gate in #runJob, and
      // must not be cleared here. This only unwedges a stale engine pause.
      if (!this.#userPaused && this.#synth.paused) this.#synth.resume();
      this.#synth.speak(utterance);
      this.#everSpoke = true;
    } catch (err) {
      console.warn('[speech] speak() threw', err);
      job.settle('error');
      return;
    }

    this.#armWatchdog(job);
    this.#armStartGuard(job);
    this.#startKeepAlive();
    this.#emit();
  }

  /**
   * Build and wire one utterance. Handlers ignore events belonging to a
   * superseded utterance, so a retry can never settle the job twice.
   */
  #makeUtterance(job) {
    let utterance;
    try {
      utterance = new window.SpeechSynthesisUtterance(job.text);
    } catch (err) {
      console.warn('[speech] could not build utterance', err);
      return null;
    }

    const voiceObject = this.#currentVoiceObject();
    utterance.rate = job.rate;
    utterance.pitch = job.pitch;
    utterance.volume = job.volume;
    if (voiceObject) {
      this.#safe(() => {
        utterance.voice = voiceObject;
      });
    }
    // Some engines ignore `voice` unless `lang` agrees with it.
    const lang = job.lang || voiceObject?.lang || this.#opts.lang;
    if (lang) {
      this.#safe(() => {
        utterance.lang = lang;
      });
    }

    const mine = () => !job.done && job.utterance === utterance;

    utterance.onstart = () => {
      if (!mine()) return;
      job.started = true;
      this.#primed = true;
      this.#gestureBlocked = false;
      if (job.startGuard) {
        clearTimeout(job.startGuard);
        job.startGuard = null;
      }
      this.#emit();
    };

    utterance.onend = () => {
      if (!mine()) return;
      this.#primed = true;
      job.settle('ended');
    };

    utterance.onerror = (event) => {
      if (!mine()) return;
      const reason = String(event?.error || '').toLowerCase();
      if (reason === 'interrupted' || reason === 'canceled' || reason === 'cancelled') {
        // cancel() reports itself as an error in Chrome and Safari. Not an error.
        job.settle('cancelled');
        return;
      }
      if (reason === 'not-allowed') {
        this.#gestureBlocked = true;
        this.#primed = false;
        job.settle('error');
        this.#emit();
        return;
      }
      if (reason && reason !== 'synthesis-failed' && reason !== 'audio-busy') {
        console.warn(`[speech] utterance error: ${reason}`);
      }
      job.settle('error');
    };

    job.utterance = utterance;
    return utterance;
  }

  #armWatchdog(job) {
    if (job.watchdog) {
      clearTimeout(job.watchdog);
      job.watchdog = null;
    }
    const budget = clamp(
      this.estimate(job.text, job.rate) * this.#opts.watchdogFactor + this.#opts.watchdogPadMs,
      this.#opts.watchdogMinMs,
      this.#opts.watchdogMaxMs,
    );
    // A wall-clock deadline rather than a bare timer, so the timer can be woken
    // early (by pause()) without shortening the utterance's real budget.
    job.deadline = now() + budget;
    const fire = () => {
      job.watchdog = null;
      if (job.done) return;

      // Paused by the quizmaster: the clock stops rather than cutting them
      // short — but not forever. Past `pauseMaxMs` the promise is handed back,
      // because a caller left pending never runs its `finally` (the app's audio
      // ducking, its UI state) and one press of Pause would spoil the night.
      if (this.#userPaused) {
        if (!this.#pauseExpired()) {
          job.deadline += PAUSE_TICK_MS;
          job.watchdog = setTimeout(fire, PAUSE_TICK_MS);
          return;
        }
        // Settle first: settling detaches the handlers, so the 'interrupted'
        // error our own cancel() raises cannot overwrite the result.
        job.settle('cancelled');
        this.#lastCancelAt = now();
        this.#safe(() => {
          if (this.#synth.paused) this.#synth.resume();
        });
        this.#safe(() => this.#synth.cancel());
        return;
      }

      // Woken before the real deadline (a pause tick, or pause() nudging us):
      // go back to sleep for what is left.
      const remaining = job.deadline - now();
      if (remaining > 20) {
        job.watchdog = setTimeout(fire, remaining);
        return;
      }

      // Still genuinely speaking? Give it a little more rope, but bounded.
      let stillSpeaking = false;
      this.#safe(() => {
        stillSpeaking = !!(this.#synth.speaking || this.#synth.pending);
      });
      if (stillSpeaking && job.extensions < this.#opts.watchdogExtensions) {
        job.extensions += 1;
        const extra = Math.max(1500, budget / 2);
        job.deadline = now() + extra;
        job.watchdog = setTimeout(fire, extra);
        return;
      }

      // 'end' is never coming. Settle FIRST — settling detaches the handlers, so
      // the 'interrupted' error our own cancel() raises cannot overwrite the
      // result with 'cancelled' — then clear the wedged engine.
      job.settle('ended');
      this.#lastCancelAt = now();
      this.#safe(() => this.#synth.cancel());
    };
    job.watchdogFire = fire;
    job.watchdog = setTimeout(fire, budget);
  }

  /**
   * How long to wait for 'start' before assuming the engine ate the utterance.
   * Cloud voices — exactly the ones scoreVoice() ranks highest — can take a good
   * while to return their first audio over pub wifi, so give them longer.
   */
  #startGuardBudget() {
    const base = Math.max(300, Number(this.#opts.startGuardMs) || DEFAULTS.startGuardMs);
    const descriptor = this.voice;
    return descriptor && descriptor.local === false ? base * 2 : base;
  }

  #armStartGuard(job) {
    if (job.startGuard) {
      clearTimeout(job.startGuard);
      job.startGuard = null;
    }
    job.startGuard = setTimeout(() => {
      job.startGuard = null;
      if (job.done || job.started) return;
      let busy = false;
      this.#safe(() => {
        busy = !!(this.#synth.speaking || this.#synth.pending);
      });
      if (busy) {
        // It is going to start, just slowly. Keep watching (bounded) rather than
        // dropping the detection for good; the watchdog is the final backstop.
        if (job.startChecks < 3) {
          job.startChecks += 1;
          this.#armStartGuard(job);
        }
        return;
      }

      if (!job.retried) {
        // Known Chrome behaviour: the utterance was silently dropped. One retry,
        // with a fresh utterance — re-speaking a used one upsets some engines.
        job.retried = true;
        this.#retryUtterance(job);
        return;
      }
      job.settle('error');
    }, this.#startGuardBudget());
  }

  /**
   * Re-speak a job the engine silently dropped. Must respect the restart gap
   * like every other path: an utterance queued in the same tick as the cancel()
   * is dropped for exactly the same reason as the first one was.
   */
  async #retryUtterance(job) {
    const generation = this.#cancelGen;

    // Deliberately no cancel() here. The start guard already established that
    // the engine is neither speaking nor pending, so there is nothing to clear —
    // and a cancel() would open a fresh quiet period, which is precisely what
    // swallowed the first attempt. Only a stale engine pause needs unwedging.
    this.#safe(() => {
      if (!this.#userPaused && this.#synth.paused) this.#synth.resume();
    });

    // Still honour any quiet period already running from an earlier cancel().
    if (!(await this.#awaitRestartGap(job, generation))) return;
    if (!(await this.#awaitResume(job, generation))) return;
    if (this.#active !== job) return;

    const retry = this.#makeUtterance(job);
    if (!retry) {
      job.settle('error');
      return;
    }
    try {
      this.#synth.speak(retry);
      this.#everSpoke = true;
    } catch (err) {
      console.warn('[speech] retry speak() threw', err);
      job.settle('error');
      return;
    }
    // The retry cost us a start-guard period plus the gap; give the watchdog a
    // fresh budget so it does not cut the utterance off early.
    this.#armWatchdog(job);
    this.#armStartGuard(job);
  }

  #clearJobTimers(job) {
    if (job.watchdog) {
      clearTimeout(job.watchdog);
      job.watchdog = null;
    }
    job.watchdogFire = null;
    if (job.startGuard) {
      clearTimeout(job.startGuard);
      job.startGuard = null;
    }
    if (job.utterance) {
      job.utterance.onstart = null;
      job.utterance.onend = null;
      job.utterance.onerror = null;
    }
  }

  /** Cancel the active utterance and everything queued behind it. */
  #flush(result) {
    this.#cancelGen += 1;
    this.#abortSleeps();

    const queued = this.#queue;
    this.#queue = [];
    const active = this.#active;
    this.#active = null;
    this.#current = null;
    this.#stopKeepAlive();

    // Reach the engine whenever it could still be holding audio — not just when
    // the wrapper believes something is active. A job the start guard or the
    // watchdog has already given up on is still queued inside the engine, and if
    // cancel() is skipped here it plays out over whatever comes next, unstoppably.
    if (this.#supported && (active || queued.length || this.#everSpoke)) {
      this.#safe(() => {
        // cancel() while paused wedges the engine in Chrome — resume first.
        if (this.#synth.paused) this.#synth.resume();
      });
      this.#safe(() => this.#synth.cancel());
      this.#lastCancelAt = now();
    }
    this.#userPaused = false;
    this.#pausedAt = 0;

    this.#suppressEmit += 1;
    try {
      if (active) active.settle(result);
      for (const job of queued) job.settle(result);
    } finally {
      this.#suppressEmit -= 1;
    }

    this.#emit();
  }

  // ---- Chrome ~15s keep-alive ----

  #startKeepAlive() {
    if (this.#keepAliveTimer || !this.#supported) return;
    // Only desktop Chromium suffers the 15-second cutoff. The pause/resume ping
    // upsets WebKit (which is every browser on iOS, Chrome and Edge included)
    // and makes Android Chrome stutter or restart mid-word.
    if (!IS_DESKTOP_CHROMIUM) return;
    this.#keepAliveTimer = setInterval(() => {
      if (!this.#active || this.#userPaused) return;
      this.#safe(() => {
        if (!this.#synth.speaking) return;
        this.#synth.pause();
        this.#synth.resume();
      });
    }, Math.max(2000, Number(this.#opts.keepAliveMs) || DEFAULTS.keepAliveMs));
  }

  #stopKeepAlive() {
    if (!this.#keepAliveTimer) return;
    clearInterval(this.#keepAliveTimer);
    this.#keepAliveTimer = null;
  }

  // ---- cancellable sleep ----

  #sleep(ms) {
    return new Promise((resolve) => {
      if (!(ms > 0)) {
        resolve(true);
        return;
      }
      const entry = { resolve, id: 0 };
      entry.id = setTimeout(() => {
        this.#sleeps.delete(entry);
        resolve(true);
      }, ms);
      this.#sleeps.add(entry);
    });
  }

  #abortSleeps() {
    for (const entry of Array.from(this.#sleeps)) {
      clearTimeout(entry.id);
      try {
        entry.resolve(false);
      } catch {
        /* ignore */
      }
    }
    this.#sleeps.clear();
  }

  // ---- misc ----

  #safe(fn) {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  }

  // ---- text normalisation ----

  static #sharedLexicon = new Map();

  /**
   * Normalise text for a speech synthesiser. Conservative by design: it should
   * never mangle ordinary words.
   *
   * @param {string} text
   * @param {Map<string,string>|Object} [lexicon] pronunciation overrides; defaults
   *        to the map given to the most recent setLexicon() call.
   * @returns {string}
   */
  static clean(text, lexicon) {
    if (text == null) return '';
    let out = typeof text === 'string' ? text : String(text);
    if (!out.trim()) return '';

    // --- HTML entities and stray tags (quiz packs are often authored as HTML) ---
    out = out
      .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, ' and ')
      .replace(/&(?:quot|ldquo|rdquo);/gi, '"')
      .replace(/&(?:apos|lsquo|rsquo|#39);/gi, "'")
      .replace(/&(?:lt|gt);/gi, ' ')
      .replace(/&(?:mdash|ndash);/gi, ', ')
      .replace(/&hellip;/gi, '...');

    // --- invisible junk and emoji (engines read these aloud or choke on them) ---
    out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    out = out.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    if (EMOJI_RE) out = out.replace(EMOJI_RE, ' ');

    // --- pronunciation overrides, before anything else rewrites the text ---
    const lex = QuizSpeech.#resolveLexicon(lexicon);
    if (lex.size) {
      const keys = Array.from(lex.keys()).sort((a, b) => b.length - a.length);
      for (const key of keys) {
        const value = lex.get(key);
        const re = new RegExp(
          `(^|[^${LETTER_NUM_CLASS}])(${escapeRe(key)})(?![${LETTER_NUM_CLASS}])`,
          LEX_FLAGS,
        );
        out = out.replace(re, (_m, before) => `${before}${value}`);
      }
    }

    // --- typography ---
    out = out
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”„]/g, '"')
      .replace(/…/g, '...')
      .replace(/\s+[–—―]+\s+/g, ', ')                // a spaced dash is a spoken pause
      .replace(/[–—―]/g, '-')
      .replace(/ /g, ' ');

    // --- markdown ---
    out = out
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')      // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')       // links
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')            // headings
      .replace(/^\s{0,3}>\s?/gm, '')                 // block quotes
      .replace(/^\s{0,3}[-*+]\s+/gm, '')             // bullets
      .replace(/```[a-z]*\n?/gi, ' ')                // fences
      .replace(/[*`~]/g, '')                         // stray emphasis marks
      .replace(/_+/g, ' ');                          // underscores read as "underscore"

    // --- currency: "£5" -> "5 pounds", "$3 million" -> "3 million dollars" ---
    const CURRENCY = [
      [/£/g, 'pounds'],
      [/\$/g, 'dollars'],
      [/€/g, 'euros'],
      [/¥/g, 'yen'],
    ];
    // "£5m" must not come out as "five em pounds".
    const MAGNITUDES = { bn: 'billion', b: 'billion', m: 'million', k: 'thousand' };
    for (const [symbol, word] of CURRENCY) {
      const re = new RegExp(
        `${symbol.source}\\s?(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:million|billion|trillion|thousand|bn|m|k))?(?![A-Za-z])`,
        'gi',
      );
      out = out.replace(re, (_m, num, magnitude) => {
        const raw = String(magnitude || '').trim().toLowerCase();
        const expanded = raw ? MAGNITUDES[raw] || raw : '';
        return expanded ? `${num} ${expanded} ${word}` : `${num} ${word}`;
      });
      // A bare symbol only counts outside a word: "Ke$ha" must survive for the lexicon.
      out = out.replace(
        new RegExp(`(^|[^A-Za-z0-9])${symbol.source}(?![A-Za-z0-9])`, 'g'),
        (_m, before) => `${before} ${word} `,
      );
    }

    // --- symbols ---
    out = out
      .replace(/\s*&\s*/g, ' and ')
      .replace(/(\d)\s?%/g, '$1 percent')
      .replace(/%/g, ' percent ')
      .replace(/\b([A-G])#/g, '$1 sharp')     // "C# minor", and the language too
      .replace(/#\s?(?=\d)/g, 'number ')
      .replace(/#/g, ' ')
      .replace(/(\d)\s?°\s?([CF])\b/g, '$1 degrees $2')
      .replace(/°/g, ' degrees ')
      .replace(/(\d)\s?½/g, '$1 and a half')
      .replace(/(\d)\s?¼/g, '$1 and a quarter')
      .replace(/(\d)\s?¾/g, '$1 and three quarters')
      .replace(/½/g, ' a half ')
      .replace(/¼/g, ' a quarter ')
      .replace(/¾/g, ' three quarters ');

    // --- numeric ranges: "1914-18" -> "1914 to 18" ---
    // Unspaced only. A spaced hyphen between numbers is at least as likely to be
    // arithmetic ("What is 100 - 45?") as a range, and reading a subtraction as
    // "100 to 45" gives the room the wrong question.
    out = out.replace(/\b(\d{1,4})-(\d{1,4})\b(?!\s?-\s?\d)/g, '$1 to $2');

    // --- ordinals: "1st" -> "first", "21st" -> "twenty-first" ---
    out = out.replace(/\b(\d{1,3})(st|nd|rd|th)\b/gi, (match, digits) => {
      const word = ordinalWord(Number(digits));
      return word || match;
    });

    // --- abbreviations common in quiz copy ---
    // An expansion must not eat a full stop that is also ending the sentence:
    // "recorded at Abbey Rd. Which one came next?" needs the pause after "Road",
    // or the voice runs the answer straight into the next question.
    // A capitalised word after the stop only means a new sentence if it is a
    // plausible opener — quiz copy is formulaic ("…Abbey Rd. Which one came
    // next?") — whereas "Wall St. Crash" is a single name carrying on.
    const OPENER =
      /^\s+["'“([]?(Which|What|Who|Whose|Whom|Where|When|Why|How|Name|Give|Complete|According|In|On|At|By|For|From|If|Is|Are|Was|Were|Do|Does|Did|Can|Could|Would|Should|Will|The|A|An|It|He|She|They|We|You|Your|My|Our|This|That|These|Those|There|His|Her|Their|Its|One|Two|Three|Both|Each|All|Every|Some|Most|Many|Another|After|Before|During|Since|Until|To|But|And|Or|So|Now|Then|Also|However|True|False|Question|Round|Answer|Bonus)\b/;
    const sentenceFollows = (input, end) => {
      const after = input.slice(end);
      return !after.trim() || OPENER.test(after);
    };
    const expand = (re, word) => {
      out = out.replace(re, (match, ...rest) => {
        const input = String(rest[rest.length - 1]);
        const offset = Number(rest[rest.length - 2]);
        return sentenceFollows(input, offset + match.length) ? `${word}.` : word;
      });
    };

    // "St." is a street far more often than a saint in quiz copy, and the tell is
    // what comes *before* it: a capitalised word makes it the tail of a name
    // ("Wall St.", "Baker St."), otherwise it is a title ("St. Petersburg").
    out = out.replace(/\bSt\./g, (match, offset, input) => {
      const before = input.slice(Math.max(0, offset - 48), offset);
      const partOfName = /(^|[\s(“"'])[A-Z][A-Za-z'’-]*\s+$/.test(before);
      const after = input.slice(offset + match.length);
      if (!partOfName && !OPENER.test(after) && /^\s+["'“([]?[A-Z]/.test(after)) return 'Saint';
      return sentenceFollows(input, offset + match.length) ? 'Street.' : 'Street';
    });

    expand(/\bRd\./g, 'Road');
    expand(/\bAve\./g, 'Avenue');
    expand(/\bBlvd\./g, 'Boulevard');
    expand(/\bJr\./g, 'Junior');
    expand(/\bSr\./g, 'Senior');
    expand(/\betc\./gi, 'etcetera');

    out = out
      .replace(/\bMt\.\s*/g, 'Mount ')
      .replace(/\bDr\.\s+(?=[A-Z])/g, 'Doctor ')
      .replace(/\bDr\./g, 'Drive')
      .replace(/\bMr\./g, 'Mister')
      .replace(/\bMrs\./g, 'Missus')
      .replace(/\bMs\./g, 'Miz')
      .replace(/\bProf\./g, 'Professor')
      .replace(/\bSgt\./g, 'Sergeant')
      .replace(/\bCapt\./g, 'Captain')
      .replace(/\bGen\.\s+(?=[A-Z])/g, 'General ')
      .replace(/\bRev\.\s+(?=[A-Z])/g, 'Reverend ')
      .replace(/\bno\.\s*(?=\d)/gi, 'number ')
      .replace(/\bvs\b\.?/gi, 'versus')
      .replace(/\be\.g\./gi, 'for example')
      .replace(/\bi\.e\./gi, 'that is')
      .replace(/\bapprox\./gi, 'approximately')
      .replace(/\bfeat\./gi, 'featuring')
      .replace(/\ba\.k\.a\.|\baka\b/gi, 'also known as');

    // --- whitespace and punctuation tidy-up ---
    out = out
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/([,;:])\1+/g, '$1')
      .replace(/\.{4,}/g, '...')
      .replace(/([!?])\1+/g, '$1')
      .trim();

    if (!out) return '';

    // --- sentence-final punctuation so the voice does not run on ---
    // A trailing "?" is left in place: it is what gives question intonation.
    if (!/[.!?]["'’)\]]*$/.test(out)) {
      out = out.replace(/[,;:\s-]+$/, '');
      if (!out) return '';
      out += '.';
    }

    return out;
  }

  static #resolveLexicon(lexicon) {
    if (lexicon instanceof Map) return lexicon;
    if (lexicon && typeof lexicon === 'object') return new Map(Object.entries(lexicon));
    return QuizSpeech.#sharedLexicon;
  }

  /** The sample line used by test(). */
  static get SAMPLE() {
    return SAMPLE_TEXT;
  }
}

export default QuizSpeech;
