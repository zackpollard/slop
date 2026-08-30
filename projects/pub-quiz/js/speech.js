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
};

const SAMPLE_TEXT =
  'Right then, ladies and gentlemen. Round one, question one. Pens at the ready.';

// ---- environment sniffing (used only to decide which workarounds to apply) ----

const UA = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
const IS_SAFARI = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(UA);
const IS_CHROMIUM = /chrome|chromium|crios|edg/i.test(UA) && !IS_SAFARI;

// ---- small utilities ----

const clamp = (n, min, max) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
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

  // settings
  #rate;
  #pitch;
  #volume;
  #enabled;

  // state
  #initPromise = null;
  #initialised = false;
  #primed = false;
  #gestureBlocked = false;
  #userPaused = false;
  #destroyed = false;

  // queue / current utterance
  #queue = [];
  #active = null;
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

  // pronunciation overrides
  #lexicon = new Map();

  constructor(opts = {}) {
    this.#opts = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };

    this.#rate = clamp(this.#opts.rate, RATE_MIN, RATE_MAX);
    this.#pitch = clamp(this.#opts.pitch, PITCH_MIN, PITCH_MAX);
    this.#volume = clamp(this.#opts.volume, VOLUME_MIN, VOLUME_MAX);
    this.#enabled = this.#opts.enabled !== false;
    this.#voiceId = this.#opts.voiceId ?? null;
    this.#autoVoice = !this.#voiceId;

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
      let timeout = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (this.#voicePoll) {
          clearInterval(this.#voicePoll);
          this.#voicePoll = null;
        }
        this.#initialised = true;
        this.#refreshVoices();
        this.#emit();
        resolve(this);
      };

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
      timeout = setTimeout(finish, Math.max(250, Number(this.#opts.voiceTimeout) || 3000));
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
    if (!list.length && this.#descriptors.length) return; // transient empty list; keep what we have

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

    // Re-resolve the selection against the new list.
    if (this.#voiceId && !byId.has(this.#voiceId)) {
      const match = descriptors.find((d) => d.name === this.#voiceId || d.id.startsWith(`${this.#voiceId}#`));
      this.#voiceId = match ? match.id : null;
      if (!match) this.#autoVoice = true;
    }
    if (this.#autoVoice || !this.#voiceId) {
      const best = this.#pickDefault();
      this.#voiceId = best ? best.id : null;
      this.#autoVoice = true;
    }
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
      this.#autoVoice = true;
      const best = this.#pickDefault();
      this.#voiceId = best ? best.id : null;
    } else if (this.#byId.has(id)) {
      this.#autoVoice = false;
      this.#voiceId = id;
    } else {
      // Tolerate a saved name or a stale URI from another machine.
      const match =
        this.#descriptors.find((d) => d.id === id) ||
        this.#descriptors.find((d) => d.name === id) ||
        this.#descriptors.find((d) => d.id.startsWith(`${id}#`));
      if (match) {
        this.#autoVoice = false;
        this.#voiceId = match.id;
      } else if (!this.#initialised) {
        // Voices may not be loaded yet — remember the request and resolve later.
        this.#autoVoice = false;
        this.#voiceId = id;
      } else {
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

  setRate(r) {
    this.#rate = clamp(r, RATE_MIN, RATE_MAX);
    return this.#rate;
  }

  setPitch(p) {
    this.#pitch = clamp(p, PITCH_MIN, PITCH_MAX);
    return this.#pitch;
  }

  setVolume(v) {
    this.#volume = clamp(v, VOLUME_MIN, VOLUME_MAX);
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
    if ('rate' in settings) this.setRate(settings.rate);
    if ('pitch' in settings) this.setPitch(settings.pitch);
    if ('volume' in settings) this.setVolume(settings.volume);
    if ('enabled' in settings) this.setEnabled(settings.enabled);
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

  get speaking() {
    return !!this.#active || this.#queue.length > 0;
  }

  get paused() {
    return this.#userPaused;
  }

  /** Rough spoken duration in ms — handy for timing slides against the voice. */
  estimate(text, rate = this.#rate) {
    const chars = String(text || '').length;
    const r = clamp(rate, RATE_MIN, RATE_MAX);
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
      rate: clamp(options.rate ?? this.#rate, RATE_MIN, RATE_MAX),
      pitch: clamp(options.pitch ?? this.#pitch, PITCH_MIN, PITCH_MAX),
      volume: clamp(options.volume ?? this.#volume, VOLUME_MIN, VOLUME_MAX),
      lang: options.lang || null,
      delay: Math.max(0, Number(options.delay) || 0),
      done: false,
      utterance: null,
      started: false,
      retried: false,
      watchdog: null,
      startGuard: null,
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

      const pause = Math.max(0, Number(part.pause) || 0);
      if (pause > 0) {
        if (generation === null) generation = this.#cancelGen;
        const completed = await this.#sleep(pause);
        if (!completed || this.#cancelGen !== generation) return 'cancelled';
      }
    }

    return result;
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

  pause() {
    if (!this.#supported) return;
    this.#userPaused = true;
    this.#safe(() => this.#synth.pause());
    this.#emit();
  }

  resume() {
    if (!this.#supported) return;
    this.#userPaused = false;
    this.#safe(() => this.#synth.resume());
    this.#emit();
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
    this.#listeners.clear();
    if (this.#voicePoll) {
      clearInterval(this.#voicePoll);
      this.#voicePoll = null;
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
        await this.#runJob(job);
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
    const sinceCancel = now() - this.#lastCancelAt;
    if (sinceCancel < this.#opts.restartGap) {
      const completed = await this.#sleep(this.#opts.restartGap - sinceCancel);
      if (!completed || job.done || this.#cancelGen !== generation) {
        job.settle('cancelled');
        return;
      }
    }

    this.#beginUtterance(job);
    await job.promise;
  }

  #beginUtterance(job) {
    if (job.done) return;

    const utterance = this.#makeUtterance(job);
    if (!utterance) {
      job.settle('error');
      return;
    }

    this.#active = job;
    this.#userPaused = false;

    try {
      // A paused engine silently swallows everything queued behind it.
      if (this.#synth.paused) this.#synth.resume();
      this.#synth.speak(utterance);
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
    const budget = clamp(
      this.estimate(job.text, job.rate) * this.#opts.watchdogFactor + this.#opts.watchdogPadMs,
      this.#opts.watchdogMinMs,
      this.#opts.watchdogMaxMs,
    );
    const fire = () => {
      job.watchdog = null;
      if (job.done) return;

      // Paused by the quizmaster: hold the watchdog off rather than cut them short.
      if (this.#userPaused) {
        job.watchdog = setTimeout(fire, Math.min(budget, 5000));
        return;
      }

      // Still genuinely speaking? Give it a little more rope, but bounded.
      let stillSpeaking = false;
      this.#safe(() => {
        stillSpeaking = !!(this.#synth.speaking || this.#synth.pending);
      });
      if (stillSpeaking && job.extensions < this.#opts.watchdogExtensions) {
        job.extensions += 1;
        job.watchdog = setTimeout(fire, Math.max(1500, budget / 2));
        return;
      }

      // 'end' is never coming. Settle FIRST — settling detaches the handlers, so
      // the 'interrupted' error our own cancel() raises cannot overwrite the
      // result with 'cancelled' — then clear the wedged engine.
      job.settle('ended');
      this.#lastCancelAt = now();
      this.#safe(() => this.#synth.cancel());
    };
    job.watchdog = setTimeout(fire, budget);
  }

  #armStartGuard(job) {
    job.startGuard = setTimeout(() => {
      job.startGuard = null;
      if (job.done || job.started) return;
      let busy = false;
      this.#safe(() => {
        busy = !!(this.#synth.speaking || this.#synth.pending);
      });
      if (busy) return; // it is going to start, just slowly

      if (!job.retried) {
        // Known Chrome behaviour: the utterance was silently dropped. One retry,
        // with a fresh utterance — re-speaking a used one upsets some engines.
        job.retried = true;
        this.#safe(() => this.#synth.cancel());
        this.#safe(() => this.#synth.resume());
        const retry = this.#makeUtterance(job);
        if (!retry) {
          job.settle('error');
          return;
        }
        try {
          this.#synth.speak(retry);
        } catch {
          job.settle('error');
          return;
        }
        this.#armStartGuard(job);
        return;
      }
      job.settle('error');
    }, this.#opts.startGuardMs);
  }

  #clearJobTimers(job) {
    if (job.watchdog) {
      clearTimeout(job.watchdog);
      job.watchdog = null;
    }
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
    this.#stopKeepAlive();

    if (active || queued.length) this.#lastCancelAt = now();

    if (this.#supported && (active || queued.length)) {
      this.#safe(() => {
        // cancel() while paused wedges the engine in Chrome — resume first.
        if (this.#synth.paused) this.#synth.resume();
      });
      this.#safe(() => this.#synth.cancel());
    }
    this.#userPaused = false;

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
    // Only Chromium suffers the 15-second cutoff; pause/resume pings upset Safari.
    if (!IS_CHROMIUM || IS_SAFARI) return;
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
    for (const [symbol, word] of CURRENCY) {
      const re = new RegExp(
        `${symbol.source}\\s?(\\d[\\d,]*(?:\\.\\d+)?)(\\s?(?:million|billion|trillion|thousand|bn|m|k))?`,
        'gi',
      );
      out = out.replace(re, (_m, num, magnitude) => `${num}${magnitude || ''} ${word}`);
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
    out = out.replace(/\b(\d{1,4})\s?-\s?(\d{1,4})\b(?!\s?-\s?\d)/g, '$1 to $2');

    // --- ordinals: "1st" -> "first", "21st" -> "twenty-first" ---
    out = out.replace(/\b(\d{1,3})(st|nd|rd|th)\b/gi, (match, digits) => {
      const word = ordinalWord(Number(digits));
      return word || match;
    });

    // --- abbreviations common in quiz copy ---
    out = out
      .replace(/\bMt\.\s*/g, 'Mount ')
      .replace(/\bSt\.\s+(?=[A-Z])/g, 'Saint ')
      .replace(/\bSt\./g, 'Street')
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
      .replace(/\bJr\./g, 'Junior')
      .replace(/\bSr\./g, 'Senior')
      .replace(/\bAve\./g, 'Avenue')
      .replace(/\bRd\./g, 'Road')
      .replace(/\bBlvd\./g, 'Boulevard')
      .replace(/\bno\.\s*(?=\d)/gi, 'number ')
      .replace(/\bvs\b\.?/gi, 'versus')
      .replace(/\betc\./gi, 'etcetera')
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
