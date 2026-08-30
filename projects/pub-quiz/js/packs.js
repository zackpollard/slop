/*
 * packs.js — quiz pack registry, validation and normalisation.
 *
 * A "pack" is one complete quiz: metadata plus an ordered list of rounds, each
 * with an ordered list of questions. Built-in packs are ES modules under
 * ../quizzes/; users can also import their own as JSON, which is validated
 * through exactly the same path and kept in localStorage.
 *
 * The pack format is documented in projects/pub-quiz/quizzes/SCHEMA.md — keep
 * the two in step.
 */

import { storage, uid } from './dom.js';
import { normaliseClip } from './media.js';
import slopClassic01 from '../quizzes/slop-classic-01.js';

// ---- registry ----

/** Built-in packs. Add a new quiz here and it appears in the picker. */
export const BUILT_IN_PACKS = [
    slopClassic01,
];

const CUSTOM_KEY = 'pubquiz.customPacks.v1';

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const ROUND_ICON_FALLBACKS = {
    'general-knowledge': '🌍',
    general: '🌍',
    science: '🔬',
    music: '🎵',
    sport: '⚽',
    sports: '⚽',
    animals: '🐾',
    nature: '🌿',
    kids: '🧸',
    children: '🧸',
    history: '🏛️',
    geography: '🗺️',
    film: '🎬',
    tv: '📺',
    food: '🍽️',
    literature: '📚',
    art: '🎨',
    technology: '💻',
    picture: '🖼️',
    wildcard: '🃏',
};

// ---- validation ----

class Issues {
    constructor() {
        this.errors = [];
        this.warnings = [];
    }

    error(msg) { this.errors.push(msg); return false; }

    warn(msg) { this.warnings.push(msg); return true; }
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate and normalise a raw pack object (from a module or parsed JSON).
 * Never throws. Returns { ok, pack, errors, warnings }.
 * Missing optional fields are filled in with sensible defaults so the rest of
 * the app can assume a complete shape.
 */
export function validatePack(raw, { source = 'custom' } = {}) {
    const issues = new Issues();

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.error('The pack must be a JSON object.');
        return { ok: false, pack: null, ...issues };
    }

    if (!isStr(raw.name)) issues.error('Pack is missing a "name".');
    if (!Array.isArray(raw.rounds) || raw.rounds.length === 0) {
        issues.error('Pack needs a non-empty "rounds" array.');
        return { ok: false, pack: null, errors: issues.errors, warnings: issues.warnings };
    }

    const seenRoundIds = new Set();
    const rounds = raw.rounds.map((rawRound, roundIndex) => {
        const label = `Round ${roundIndex + 1}`;
        if (!rawRound || typeof rawRound !== 'object') {
            issues.error(`${label} is not an object.`);
            return null;
        }
        if (!isStr(rawRound.name)) issues.error(`${label} is missing a "name".`);

        let id = isStr(rawRound.id) ? slug(rawRound.id) : slug(rawRound.name || `round-${roundIndex + 1}`);
        while (seenRoundIds.has(id)) id = `${id}-${roundIndex + 1}`;
        seenRoundIds.add(id);

        if (!Array.isArray(rawRound.questions) || rawRound.questions.length === 0) {
            issues.error(`${label} ("${rawRound.name || id}") has no questions.`);
            return null;
        }

        const questions = rawRound.questions.map((q, qi) => {
            const qLabel = `${label} question ${qi + 1}`;
            if (!q || typeof q !== 'object') {
                issues.error(`${qLabel} is not an object.`);
                return null;
            }
            if (!isStr(q.question)) issues.error(`${qLabel} has no "question" text.`);
            if (!isStr(q.answer)) issues.error(`${qLabel} has no "answer".`);

            const difficulty = DIFFICULTIES.includes(q.difficulty) ? q.difficulty : 'medium';
            if (q.difficulty && !DIFFICULTIES.includes(q.difficulty)) {
                issues.warn(`${qLabel} has unknown difficulty "${q.difficulty}" — treated as medium.`);
            }

            const acceptable = Array.isArray(q.acceptable)
                ? q.acceptable.filter(isStr).map((a) => a.trim())
                : [];

            const source = q.source && typeof q.source === 'object'
                ? { name: String(q.source.name || 'Source'), url: String(q.source.url || '') }
                : (isStr(q.sourceUrl)
                    ? { name: String(q.sourceName || 'Source'), url: q.sourceUrl }
                    : null);

            if (!source && !q.noSource) {
                issues.warn(`${qLabel} has no source — answers should be traceable.`);
            }

            return {
                id: isStr(q.id) ? q.id : `${id}-q${qi + 1}`,
                question: String(q.question || '').trim(),
                answer: String(q.answer || '').trim(),
                acceptable,
                difficulty,
                topic: isStr(q.topic) ? q.topic.trim() : '',
                funFact: isStr(q.funFact) ? q.funFact.trim() : '',
                melody: isStr(q.melody) ? q.melody.trim() : (isStr(q.melodyKey) ? q.melodyKey.trim() : ''),
                clip: normaliseClip(q.clip),
                spokenQuestion: isStr(q.spokenQuestion) ? q.spokenQuestion.trim() : '',
                spokenAnswer: isStr(q.spokenAnswer) ? q.spokenAnswer.trim() : '',
                hint: isStr(q.hint) ? q.hint.trim() : '',
                source,
            };
        }).filter(Boolean);

        return {
            id,
            name: String(rawRound.name || id).trim(),
            icon: isStr(rawRound.icon) ? rawRound.icon : guessIcon(id, rawRound.name),
            intro: isStr(rawRound.intro) ? rawRound.intro.trim() : '',
            blurb: isStr(rawRound.blurb) ? rawRound.blurb.trim() : '',
            questions,
        };
    }).filter(Boolean);

    if (!rounds.length) issues.error('No usable rounds in this pack.');

    const counts = new Set(rounds.map((r) => r.questions.length));
    if (counts.size > 1) {
        issues.warn(`Rounds have differing question counts (${[...counts].join(', ')}) — that is allowed, just uncommon.`);
    }

    const tiebreaker = normaliseTiebreaker(raw.tiebreaker, issues);

    const pack = {
        id: isStr(raw.id) ? slug(raw.id) : uid('pack'),
        name: String(raw.name || 'Untitled quiz').trim(),
        description: isStr(raw.description) ? raw.description.trim() : '',
        author: isStr(raw.author) ? raw.author.trim() : '',
        createdOn: isStr(raw.createdOn) ? raw.createdOn.trim() : '',
        version: Number.isFinite(raw.version) ? raw.version : 1,
        tags: Array.isArray(raw.tags) ? raw.tags.filter(isStr) : [],
        source,
        rounds,
        tiebreaker,
    };

    return { ok: issues.errors.length === 0, pack, errors: issues.errors, warnings: issues.warnings };
}

function normaliseTiebreaker(raw, issues) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isStr(raw.question) || raw.answer === undefined || raw.answer === null) {
        issues.warn('Tie-breaker ignored: it needs a "question" and a numeric "answer".');
        return null;
    }
    const answer = Number(raw.answer);
    if (!Number.isFinite(answer)) {
        issues.warn('Tie-breaker ignored: "answer" must be a number (closest wins).');
        return null;
    }
    return {
        question: String(raw.question).trim(),
        answer,
        unit: isStr(raw.unit) ? raw.unit.trim() : '',
        funFact: isStr(raw.funFact) ? raw.funFact.trim() : '',
        source: raw.source && typeof raw.source === 'object'
            ? { name: String(raw.source.name || 'Source'), url: String(raw.source.url || '') }
            : null,
    };
}

function slug(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'pack';
}

function guessIcon(id, name) {
    const haystack = `${id} ${name || ''}`.toLowerCase();
    for (const [key, glyph] of Object.entries(ROUND_ICON_FALLBACKS)) {
        if (haystack.includes(key)) return glyph;
    }
    return '❓';
}

// ---- library ----

let cache = null;
let builtInIdCache = null;

/**
 * The ids the built-in packs occupy. getPack() answers with the first match and
 * built-ins are listed first, so a custom pack sharing an id would be stored and
 * shown in the picker but never actually loaded.
 */
function builtInIds() {
    if (!builtInIdCache) {
        builtInIdCache = new Set(
            BUILT_IN_PACKS
                .map((raw) => validatePack(raw, { source: 'built-in' }))
                .filter((r) => r.ok)
                .map((r) => r.pack.id),
        );
    }
    return builtInIdCache;
}

/** An id close to `wanted` that no other pack has claimed. */
function freeCustomId(wanted, taken) {
    let candidate = `${wanted}-yours`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${wanted}-yours-${n}`;
    return candidate;
}

/** Imported packs, renaming any that was stored before built-in ids were reserved. */
function storedCustomPacks() {
    const stored = storage.get(CUSTOM_KEY, []);
    const taken = new Set([...builtInIds(), ...stored.map((p) => slug(p.id || ''))]);
    let renamed = false;

    for (const p of stored) {
        const id = slug(p.id || '');
        if (!builtInIds().has(id)) continue;
        p.id = freeCustomId(id, taken);
        taken.add(p.id);
        renamed = true;
    }

    if (renamed) storage.set(CUSTOM_KEY, stored);
    return stored;
}

/** All packs available to the host: built-ins plus imported ones. */
export function allPacks({ refresh = false } = {}) {
    if (cache && !refresh) return cache;

    const packs = [];
    for (const raw of BUILT_IN_PACKS) {
        const { ok, pack, errors } = validatePack(raw, { source: 'built-in' });
        if (ok) packs.push(pack);
        else console.warn('[pub-quiz] built-in pack failed validation', raw?.name, errors);
    }
    for (const raw of storedCustomPacks()) {
        const { ok, pack } = validatePack(raw, { source: 'custom' });
        if (ok) packs.push(pack);
    }

    cache = packs;
    return packs;
}

export function getPack(id) {
    return allPacks().find((p) => p.id === id) || null;
}

export function saveCustomPack(rawPack) {
    const result = validatePack(rawPack, { source: 'custom' });
    if (!result.ok) return result;

    const stored = storage.get(CUSTOM_KEY, []);

    // A pack exported from the app carries the built-in's id, and hosts are told
    // to edit that export and import it back — so give the copy an id of its own
    // rather than one the built-in would keep winning.
    if (builtInIds().has(result.pack.id)) {
        const taken = new Set([...builtInIds(), ...stored.map((p) => slug(p.id || ''))]);
        const fresh = freeCustomId(result.pack.id, taken);
        result.warnings.unshift(`"${result.pack.id}" is a built-in pack id — your copy was saved as "${fresh}".`);
        result.pack.id = fresh;
    }

    const kept = stored.filter((p) => slug(p.id || '') !== result.pack.id);
    kept.push({ ...rawPack, id: result.pack.id });

    if (!storage.set(CUSTOM_KEY, kept)) {
        return {
            ok: false,
            pack: null,
            errors: ["Could not save the pack — this browser's storage is full or disabled."],
            warnings: result.warnings,
        };
    }

    cache = null;
    return result;
}

export function deleteCustomPack(id) {
    storage.set(CUSTOM_KEY, storage.get(CUSTOM_KEY, []).filter((p) => slug(p.id || '') !== id));
    cache = null;
}

export function isCustomPack(id) {
    return storage.get(CUSTOM_KEY, []).some((p) => slug(p.id || '') === id);
}

/** Serialise a pack back to the on-disk JSON shape, ready to edit and re-import. */
export function exportPack(pack) {
    return JSON.stringify({
        id: pack.id,
        name: pack.name,
        description: pack.description,
        author: pack.author,
        createdOn: pack.createdOn,
        version: pack.version,
        tags: pack.tags,
        rounds: pack.rounds.map((r) => ({
            id: r.id,
            name: r.name,
            icon: r.icon,
            intro: r.intro,
            ...(r.blurb ? { blurb: r.blurb } : {}),
            questions: r.questions.map((q) => ({
                question: q.question,
                answer: q.answer,
                acceptable: q.acceptable,
                difficulty: q.difficulty,
                topic: q.topic,
                funFact: q.funFact,
                ...(q.melody ? { melody: q.melody } : {}),
                ...(q.spokenQuestion ? { spokenQuestion: q.spokenQuestion } : {}),
                ...(q.spokenAnswer ? { spokenAnswer: q.spokenAnswer } : {}),
                ...(q.hint ? { hint: q.hint } : {}),
                ...(q.clip ? { clip: q.clip } : {}),
                ...(q.source ? { source: q.source } : {}),
            })),
        })),
        ...(pack.tiebreaker ? { tiebreaker: pack.tiebreaker } : {}),
    }, null, 2);
}

// ---- stats ----

export function packStats(pack) {
    const questions = pack.rounds.flatMap((r) => r.questions);
    const byDifficulty = { easy: 0, medium: 0, hard: 0 };
    for (const q of questions) byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
    return {
        rounds: pack.rounds.length,
        questions: questions.length,
        byDifficulty,
        withSources: questions.filter((q) => q.source?.url).length,
        withMelody: questions.filter((q) => q.melody).length,
        withClips: questions.filter((q) => q.clip).length,
        streamedClips: questions.filter((q) => q.clip && q.clip.source === 'itunes').length,
        hasTiebreaker: Boolean(pack.tiebreaker),
    };
}

/** Rough runtime estimate in minutes for the setup screen. */
export function estimateMinutes(pack, roundIds, secondsPerQuestion) {
    const rounds = pack.rounds.filter((r) => roundIds.includes(r.id));
    const questions = rounds.reduce((n, r) => n + r.questions.length, 0);
    // question read + thinking time + reveal + fun fact, then marking per round
    const perQuestion = 12 + secondsPerQuestion + 10;
    const perRound = 90;
    return Math.max(1, Math.round((questions * perQuestion + rounds.length * perRound) / 60));
}
