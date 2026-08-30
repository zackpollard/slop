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

const LOOKUP_URL = 'https://itunes.apple.com/lookup?id=';
const SEARCH_URL = 'https://itunes.apple.com/search?';

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
    return clip.source === 'url' ? `url:${clip.src}` : `itunes:${clip.trackId || clip.previewUrl}`;
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
export class ClipPlayer {
    #elements = new Map();       // clipKey -> HTMLAudioElement
    #current = null;             // { clip, element, token }
    #token = 0;
    #volume = 1;
    #fadeRaf = 0;
    #stopTimer = 0;
    #listeners = new Set();
    #stopCallbacks = new Map();  // token -> resolve the pending play() as 'stopped'

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

        const element = existing || new Audio();
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
