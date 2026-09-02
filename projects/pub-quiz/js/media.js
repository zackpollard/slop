/*
 * media.js — the audio and picture rounds.
 *
 * Plays a short clip of a real recording for "name that tune" questions.
 * Clips are STREAMED, never downloaded or re-hosted: an iTunes clip is the
 * thirty-second preview that Apple serves for the track, fetched from Apple at
 * the moment it plays. A quiz pack stores only the track's id and its preview
 * URL, and the URL is refreshed from Apple's lookup API if it has gone stale.
 *
 * Two things this deliberately does NOT do:
 *   - It never routes the clip through the Web Audio graph. A media element
 *     feeding an AudioContext needs CORS headers on the media itself, and the
 *     preview CDN does not send them. Volume and fades are done on the element.
 *   - It never shows the track's name before the reveal. The whole question is
 *     "what is this?", so the player is deliberately anonymous.
 *
 * Everything degrades: a dead link, a blocked network or an unsupported codec
 * resolves as a failure the host can see, and never throws into the quiz flow.
 *
 * Pictures work the other way round: they are freely-licensed files committed
 * to the repo, so a picture round needs no internet at all. What they do need
 * is attribution, which the pack carries and the screen renders.
 */

// The storefront matters. Apple's catalogue is licensed territory by territory,
// so a track id that resolves in one country returns resultCount: 0 in another —
// silently, with a 200. Six of this pack's twenty clips are missing from the
// default (US) storefront and present in GB. This is a British quiz, so ask GB.
const STOREFRONT = 'GB';
const LOOKUP_URL = `https://itunes.apple.com/lookup?country=${STOREFRONT}&id=`;
const SEARCH_URL = `https://itunes.apple.com/search?country=${STOREFRONT}&`;

const FADE_IN = 0.25;      // seconds
const FADE_OUT = 0.6;
const LOAD_TIMEOUT = 12000;

// ---- clip descriptions ----

/**
 * Normalise a pack's clip object. Returns null when the question has no clip.
 * Shapes:
 *   { source: 'itunes', trackId, previewUrl, artist, title, year, storeUrl }
 *   { source: 'url',    src, credit }
 * Both accept optional { start, seconds }.
 */
export function normaliseClip(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const start = Number.isFinite(raw.start) ? Math.max(0, raw.start) : 0;
    const seconds = Number.isFinite(raw.seconds) && raw.seconds > 0 ? raw.seconds : 0;

    if (raw.source === 'url' || (!raw.source && raw.src)) {
        if (typeof raw.src !== 'string' || !raw.src.trim()) return null;
        return {
            source: 'url',
            src: raw.src.trim(),
            reverse: raw.reverse === true,
            credit: typeof raw.credit === 'string' ? raw.credit : '',
            artist: typeof raw.artist === 'string' ? raw.artist : '',
            title: typeof raw.title === 'string' ? raw.title : '',
            year: Number.isFinite(raw.year) ? raw.year : 0,
            storeUrl: '',
            start,
            seconds,
        };
    }

    const trackId = Number(raw.trackId);
    const previewUrl = typeof raw.previewUrl === 'string' ? raw.previewUrl.trim() : '';
    if (!Number.isFinite(trackId) && !previewUrl) return null;

    return {
        source: 'itunes',
        trackId: Number.isFinite(trackId) ? trackId : 0,
        previewUrl,
        reverse: raw.reverse === true,
        artist: typeof raw.artist === 'string' ? raw.artist : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        year: Number.isFinite(raw.year) ? raw.year : 0,
        storeUrl: typeof raw.storeUrl === 'string' ? raw.storeUrl : '',
        credit: '',
        start,
        seconds,
    };
}

/**
 * Normalise a picture-round image. Returns null when the question has no image.
 *
 *   { src, alt, credit, license, licenseUrl, sourceUrl, fit }
 *
 * `src` is a path inside the project. Name the files opaquely — q01.png, not
 * ferrari.png — because the path is visible in the page source and a guessable
 * filename hands the answer to anyone who opens the inspector.
 */
export function normaliseImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const src = typeof raw.src === 'string' ? raw.src.trim() : '';
    if (!src) return null;

    return {
        src,
        // Deliberately generic by default: alt text is read by screen readers
        // and must not give the answer away before the reveal.
        alt: typeof raw.alt === 'string' && raw.alt.trim() ? raw.alt.trim() : 'Picture question',
        credit: typeof raw.credit === 'string' ? raw.credit.trim() : '',
        license: typeof raw.license === 'string' ? raw.license.trim() : '',
        licenseUrl: typeof raw.licenseUrl === 'string' ? raw.licenseUrl.trim() : '',
        sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : '',
        // 'contain' keeps a logo whole; 'cover' fills the frame with a photo.
        fit: raw.fit === 'cover' ? 'cover' : 'contain',
        // A contained image sits on a plate so dark marks do not vanish into
        // the dark theme. A pale mark needs the opposite.
        plate: raw.plate === 'dark' ? 'dark' : 'light',
        trademark: Boolean(raw.trademark),
    };
}

/** The attribution line a free licence obliges us to show. */
export function imageCredit(image) {
    if (!image) return '';
    return [image.credit, image.license].filter(Boolean).join(' · ');
}

/**
 * Would showing the credit hand over the answer?
 *
 * Commons records the author of a corporate logo as the company itself, so the
 * attribution line under a logo question reads "Adidas" — which is the answer,
 * in small print, before anyone has guessed. Those cases are public domain and
 * carry no attribution duty, so the credit is held back until the reveal. A
 * photographer's name never spoils anything, so a CC BY photo keeps its credit
 * on screen throughout, as its licence requires.
 */
export function creditSpoils(image, answer) {
    if (!image || !answer) return false;
    const haystack = `${image.credit} ${image.license}`.toLowerCase();
    return String(answer)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4)
        .some((word) => haystack.includes(word));
}

/**
 * Warm a round's images. Browsers cache by URL, so simply constructing an
 * Image with the src is enough to have it decoded before the question lands.
 */
export function preloadImages(images) {
    if (typeof Image !== 'function') return;
    for (const image of images.filter(Boolean)) {
        try {
            const element = new Image();
            element.decoding = 'async';
            element.src = image.src;
        } catch {
            /* a failed preload just means it loads late */
        }
    }
}

/** A stable cache key for a clip. */
export function clipKey(clip) {
    if (!clip) return '';
    const base = clip.source === 'url' ? `url:${clip.src}` : `itunes:${clip.trackId || clip.previewUrl}`;
    // A reversed clip is a different sound from the same track played forwards,
    // and the two are cached separately.
    return clip.reverse ? `${base}:rev` : base;
}

/** What the host sees on the reveal — never before it. */
export function clipCredit(clip) {
    if (!clip) return '';
    const bits = [];
    if (clip.artist) bits.push(clip.artist);
    if (clip.title) bits.push(`“${clip.title}”`);
    const line = bits.join(' — ');
    return clip.year ? `${line} (${clip.year})` : line;
}

// ---- looking tracks up ----

/** Ask Apple for a track's current preview URL. Returns '' on any failure. */
export async function refreshPreviewUrl(trackId) {
    if (!trackId) return '';
    try {
        const response = await fetch(`${LOOKUP_URL}${encodeURIComponent(trackId)}`);
        if (!response.ok) return '';
        const data = await response.json();
        return data?.results?.[0]?.previewUrl || '';
    } catch {
        return '';
    }
}

/**
 * Search for tracks — used by the pack-authoring helper so someone writing a
 * quiz can find a song without leaving the page.
 */
export async function searchTracks(term, { limit = 8, country = 'GB' } = {}) {
    if (!term || !term.trim()) return [];
    const query = new URLSearchParams({
        term: term.trim(), entity: 'song', limit: String(limit), country,
    });
    try {
        const response = await fetch(`${SEARCH_URL}${query}`);
        if (!response.ok) return [];
        const data = await response.json();
        return (data?.results || []).map((r) => ({
            trackId: r.trackId,
            title: r.trackName,
            artist: r.artistName,
            album: r.collectionName,
            year: r.releaseDate ? Number(String(r.releaseDate).slice(0, 4)) : 0,
            previewUrl: r.previewUrl || '',
            storeUrl: r.trackViewUrl || '',
            artwork: r.artworkUrl100 || '',
        })).filter((r) => r.previewUrl);
    } catch {
        return [];
    }
}

// ---- the player ----

/**
 * Plays one clip at a time. Reuses preloaded elements so a question does not
 * open with the room listening to a buffering spinner.
 */
/**
 * An audio element that plays its source BACKWARDS.
 *
 * The streaming <audio> path cannot do this: you cannot ask a media element for
 * negative playback. So a reversed clip takes the other route — fetch the whole
 * preview, decode it, flip every sample, and play the result through the Web
 * Audio graph. Apple serves the previews with `access-control-allow-origin: *`,
 * which is what makes decodeAudioData possible at all.
 *
 * It deliberately presents the same small slice of the HTMLAudioElement
 * interface that ClipPlayer already drives — volume, currentTime, duration,
 * play, pause, load, and the four events — so the player's timing, fading and
 * stop logic work on it unchanged.
 */
class ReversedAudio {
    #getContext;
    #buffer = null;
    #source = null;
    #gain = null;
    #listeners = new Map();
    #startedAt = 0;      // context time when the current run began
    #offset = 0;         // where in the buffer that run began
    #playing = false;
    #ticker = 0;
    #volume = 1;
    #loading = null;

    readyState = 0;
    preload = 'auto';
    dataset = { failed: 'false' };
    #src = '';

    constructor(getContext) {
        this.#getContext = getContext;
    }

    get src() { return this.#src; }

    set src(value) {
        if (value === this.#src) return;
        this.#src = value;
        this.#buffer = null;
        this.#loading = null;
        this.readyState = 0;
    }

    get duration() { return this.#buffer ? this.#buffer.duration : 0; }

    get volume() { return this.#volume; }

    set volume(value) {
        this.#volume = Math.min(1, Math.max(0, Number(value) || 0));
        if (this.#gain) {
            // setValueAtTime rather than a ramp: ClipPlayer already runs its own
            // fade on a rAF loop, and two curves fighting sounds like a wobble.
            try {
                this.#gain.gain.setValueAtTime(this.#volume, this.#gain.context.currentTime);
            } catch {
                /* a closed context is not worth throwing over */
            }
        }
    }

    get currentTime() {
        if (!this.#buffer) return 0;
        if (!this.#playing) return this.#offset;
        const ctx = this.#getContext();
        if (!ctx) return this.#offset;
        return Math.min(this.duration, this.#offset + (ctx.currentTime - this.#startedAt));
    }

    set currentTime(value) {
        this.#offset = Math.min(this.duration, Math.max(0, Number(value) || 0));
    }

    addEventListener(type, handler) {
        if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
        this.#listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
        this.#listeners.get(type)?.delete(handler);
    }

    #fire(type) {
        for (const handler of Array.from(this.#listeners.get(type) || [])) {
            try {
                handler({ type, target: this });
            } catch {
                /* a listener throwing must not take the quiz down */
            }
        }
    }

    /** Fetch, decode and reverse. Idempotent; concurrent calls share one fetch. */
    load() {
        if (this.#buffer) { this.readyState = 4; return; }
        if (this.#loading) return;

        const ctx = this.#getContext();
        if (!ctx || !this.#src) { this.#fire('error'); return; }

        this.#loading = (async () => {
            const response = await fetch(this.#src, { mode: 'cors' });
            if (!response.ok) throw new Error(`preview fetch failed: ${response.status}`);
            const bytes = await response.arrayBuffer();
            // decodeAudioData is callback-style in older Safari; the promise
            // form is wrapped so both shapes settle the same way.
            const decoded = await new Promise((resolve, reject) => {
                const maybe = ctx.decodeAudioData(bytes, resolve, reject);
                if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
            });
            for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
                decoded.getChannelData(channel).reverse();
            }
            this.#buffer = decoded;
            this.readyState = 4;
            this.#fire('loadeddata');
            this.#fire('canplaythrough');
        })().catch(() => {
            this.#loading = null;
            this.readyState = 0;
            this.#fire('error');
        });
    }

    async play() {
        if (!this.#buffer) {
            this.load();
            await this.#loading;
        }
        const ctx = this.#getContext();
        if (!this.#buffer || !ctx) throw new Error('reversed clip unavailable');

        this.#stopSource();

        this.#gain = ctx.createGain();
        this.#gain.gain.setValueAtTime(this.#volume, ctx.currentTime);
        this.#gain.connect(ctx.destination);

        this.#source = ctx.createBufferSource();
        this.#source.buffer = this.#buffer;
        this.#source.connect(this.#gain);
        this.#source.onended = () => {
            // pause() detaches this handler first, so reaching here means the
            // buffer genuinely ran out rather than us stopping it.
            this.#playing = false;
            this.#offset = this.duration;
            this.#stopTicker();
            this.#fire('ended');
        };

        this.#startedAt = ctx.currentTime;
        this.#source.start(0, Math.min(this.#offset, Math.max(0, this.duration - 0.01)));
        this.#playing = true;
        this.#startTicker();
    }

    pause() {
        const at = this.currentTime;
        this.#stopSource();
        this.#offset = at;
        this.#playing = false;
        this.#stopTicker();
    }

    #stopSource() {
        if (this.#source) {
            this.#source.onended = null;
            try { this.#source.stop(); } catch { /* already stopped */ }
            try { this.#source.disconnect(); } catch { /* ignore */ }
            this.#source = null;
        }
        if (this.#gain) {
            try { this.#gain.disconnect(); } catch { /* ignore */ }
            this.#gain = null;
        }
    }

    // ClipPlayer watches progress through 'timeupdate', which a media element
    // fires on its own. Nothing fires it for us, so we do.
    #startTicker() {
        this.#stopTicker();
        this.#ticker = setInterval(() => this.#fire('timeupdate'), 200);
    }

    #stopTicker() {
        clearInterval(this.#ticker);
        this.#ticker = 0;
    }
}

export class ClipPlayer {
    #elements = new Map();       // clipKey -> HTMLAudioElement
    #current = null;             // { clip, element, token }
    #token = 0;
    #volume = 1;
    #fadeRaf = 0;
    #stopTimer = 0;
    #listeners = new Set();
    #stopCallbacks = new Map();  // token -> resolve the pending play() as 'stopped'
    #getContext = () => null;    // supplied by the app; only reversed clips need it

    /**
     * Give the player access to the app's AudioContext, for reversed clips.
     * It is passed in rather than created here so that reversed playback rides
     * on the context the user's first gesture already unlocked — iOS will not
     * start a second one on its own.
     */
    useAudioContext(getContext) {
        if (typeof getContext === 'function') this.#getContext = getContext;
    }

    get supported() {
        return typeof Audio === 'function';
    }

    get playing() {
        return Boolean(this.#current);
    }

    get currentClip() {
        return this.#current?.clip || null;
    }

    /** Subscribe to { playing, progress, duration, clip }. Returns unsubscribe. */
    onChange(callback) {
        if (typeof callback !== 'function') return () => {};
        this.#listeners.add(callback);
        return () => this.#listeners.delete(callback);
    }

    #emit(extra = {}) {
        const element = this.#current?.element;
        const payload = {
            playing: this.playing,
            clip: this.#current?.clip || null,
            progress: element ? element.currentTime : 0,
            duration: element && Number.isFinite(element.duration) ? element.duration : 0,
            ...extra,
        };
        for (const callback of Array.from(this.#listeners)) {
            try {
                callback(payload);
            } catch {
                /* a broken listener must not stop the music */
            }
        }
    }

    setVolume(value) {
        this.#volume = Math.min(1, Math.max(0, Number(value) || 0));
        const element = this.#current?.element;
        if (element) element.volume = this.#volume;
    }

    /**
     * Get an element ready to play, refreshing a stale preview URL if needed.
     * Resolves to the element, or null if the clip cannot be played.
     */
    async prepare(clip) {
        if (!this.supported || !clip) return null;

        const key = clipKey(clip);
        const existing = this.#elements.get(key);
        if (existing && existing.dataset.failed !== 'true') return existing;

        let src = clip.source === 'url' ? clip.src : clip.previewUrl;

        const element = existing
            || (clip.reverse ? new ReversedAudio(this.#getContext) : new Audio());
        element.preload = 'auto';
        element.volume = this.#volume;
        element.dataset.failed = 'false';
        this.#elements.set(key, element);

        if (src) {
            element.src = src;
            const ok = await this.#waitReady(element);
            if (ok) return element;
        }

        // The preview link has rotted, or there was never one. Ask Apple again.
        if (clip.source === 'itunes' && clip.trackId) {
            const fresh = await refreshPreviewUrl(clip.trackId);
            if (fresh && fresh !== src) {
                clip.previewUrl = fresh;
                element.src = fresh;
                if (await this.#waitReady(element)) return element;
            }
        }

        element.dataset.failed = 'true';
        return null;
    }

    /** Warm the cache for a round's worth of clips, quietly and in the background. */
    preload(clips) {
        if (!this.supported) return;
        for (const clip of clips.filter(Boolean)) {
            // Deliberately not awaited: a failure here just means the clip loads
            // late, and prepare() will try again (and refresh) when it is played.
            this.prepare(clip).catch(() => {});
        }
    }

    #waitReady(element) {
        return new Promise((resolve) => {
            if (element.readyState >= 3) { resolve(true); return; }

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                element.removeEventListener('canplaythrough', onReady);
                element.removeEventListener('loadeddata', onReady);
                element.removeEventListener('error', onError);
                resolve(value);
            };
            const onReady = () => finish(true);
            const onError = () => finish(false);
            // A clip that is slow but arriving is still usable — we start it and
            // let the browser buffer, rather than declaring it dead.
            const timer = setTimeout(() => finish(element.readyState >= 2), LOAD_TIMEOUT);

            element.addEventListener('canplaythrough', onReady);
            element.addEventListener('loadeddata', onReady);
            element.addEventListener('error', onError);
            try {
                element.load();
            } catch {
                finish(false);
            }
        });
    }

    /**
     * Play a clip through to its end.
     * Resolves 'ended' | 'stopped' | 'unavailable'. Never rejects.
     */
    async play(clip) {
        if (!this.supported || !clip) return 'unavailable';

        this.stop();
        const token = ++this.#token;

        const element = await this.prepare(clip);
        if (!element || token !== this.#token) return element ? 'stopped' : 'unavailable';

        this.#current = { clip, element, token };
        // Tell the UI as soon as we are committed, not after the element has
        // actually started: otherwise there is a window where the player
        // reports itself as playing but the screen still says "Ready".
        this.#emit();

        try {
            element.currentTime = clip.start || 0;
        } catch {
            /* seeking before metadata lands is not fatal */
        }

        element.volume = 0;
        try {
            await element.play();
        } catch {
            // Autoplay was refused, or the codec is unsupported.
            this.#current = null;
            this.#emit();
            return 'unavailable';
        }
        if (token !== this.#token) return 'stopped';

        this.#fadeTo(element, this.#volume, FADE_IN);
        this.#emit();

        return new Promise((resolve) => {
            const finish = (outcome) => {
                if (token !== this.#token && outcome === 'ended') return;
                cleanup();
                if (this.#current?.token === token) {
                    this.#current = null;
                    this.#emit();
                }
                resolve(outcome);
            };

            const onEnded = () => finish('ended');
            const onError = () => finish('unavailable');
            const onTime = () => {
                this.#emit();
                const limit = clip.seconds ? (clip.start || 0) + clip.seconds : 0;
                if (limit && element.currentTime >= limit) {
                    this.#fadeOutAndStop(element, () => finish('ended'));
                }
            };

            const cleanup = () => {
                clearTimeout(this.#stopTimer);
                element.removeEventListener('ended', onEnded);
                element.removeEventListener('error', onError);
                element.removeEventListener('timeupdate', onTime);
                this.#stopCallbacks.delete(token);
            };

            this.#stopCallbacks.set(token, () => finish('stopped'));
            element.addEventListener('ended', onEnded);
            element.addEventListener('error', onError);
            element.addEventListener('timeupdate', onTime);
        });
    }

    /** Stop whatever is playing. A pending play() resolves as 'stopped'. */
    stop() {
        this.#token += 1;
        clearTimeout(this.#stopTimer);
        cancelAnimationFrame(this.#fadeRaf);

        const current = this.#current;
        this.#current = null;

        if (current) {
            const { element } = current;
            this.#fadeOutAndStop(element, null);
            const callback = this.#stopCallbacks.get(current.token);
            if (callback) callback();
        }
        this.#emit();
    }

    #fadeOutAndStop(element, done) {
        this.#fadeTo(element, 0, FADE_OUT, () => {
            try {
                element.pause();
                element.currentTime = 0;
            } catch {
                /* ignore */
            }
            element.volume = this.#volume;
            if (done) done();
        });
    }

    #fadeTo(element, target, seconds, done) {
        cancelAnimationFrame(this.#fadeRaf);
        const from = element.volume;
        const started = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - started) / (seconds * 1000));
            element.volume = Math.min(1, Math.max(0, from + (target - from) * t));
            if (t < 1) this.#fadeRaf = requestAnimationFrame(step);
            else if (done) done();
        };
        this.#fadeRaf = requestAnimationFrame(step);
    }

    /** Drop every cached element. */
    dispose() {
        this.stop();
        for (const element of this.#elements.values()) {
            try {
                element.pause();
                element.removeAttribute('src');
                element.load();
            } catch {
                /* ignore */
            }
        }
        this.#elements.clear();
        this.#listeners.clear();
    }
}
