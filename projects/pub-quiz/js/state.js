/*
 * state.js — the quiz's single source of truth.
 *
 * Two stores, both persisted to localStorage:
 *   settings — host preferences (voice, volumes, timer) that outlive a quiz
 *   game     — the quiz in progress, so a refresh or a closed lid never loses
 *              the scores halfway through round four
 *
 * Nothing here touches the DOM.
 */

import { storage, uid, clamp } from './dom.js';

const SETTINGS_KEY = 'pubquiz.settings.v2';
const GAME_KEY = 'pubquiz.game.v2';

// ---- settings ----

export const DEFAULT_SETTINGS = {
    // Timing
    timerEnabled: true,
    timerSeconds: 30,
    autoAdvance: false,
    autoAdvanceSeconds: 8,
    dramaticReveal: true,       // drum roll before every answer
    // The pub way: ask all ten, then read the answers out while sheets are
    // swapped. Turn this off to reveal each answer as you go instead.
    answersAtEndOfRound: true,
    intervalAfterRound: 3,      // 0 = no half-time break
    intervalMinutes: 10,

    // Host voice
    speechEnabled: true,
    speechVoiceId: '',
    speechRate: 1,
    speechPitch: 1,
    speechVolume: 1,
    readIntros: true,
    readQuestions: true,
    readAnswers: true,
    readFunFacts: true,
    readScores: true,
    repeatQuestion: true,       // read the question a second time

    // Sound
    audioEnabled: true,
    masterVolume: 0.85,
    musicVolume: 0.35,
    sfxVolume: 0.7,
    musicEnabled: true,
    clipVolume: 0.9,            // the name-that-tune clips

    // Presentation
    bigScreen: false,           // oversized type for a TV
    showDifficulty: true,
    showTopic: true,
    showProgress: true,
    confetti: true,

    // Scoring
    pointsPerCorrect: 1,
    jokersEnabled: true,        // each team may double one round's score
};

let settings = { ...DEFAULT_SETTINGS, ...(storage.get(SETTINGS_KEY, {}) || {}) };

export function getSettings() {
    return settings;
}

export function updateSettings(patch) {
    settings = { ...settings, ...patch };
    settings.timerSeconds = clamp(Math.round(settings.timerSeconds) || 30, 5, 300);
    settings.autoAdvanceSeconds = clamp(Math.round(settings.autoAdvanceSeconds) || 8, 2, 60);
    settings.intervalMinutes = clamp(Math.round(settings.intervalMinutes) || 10, 1, 60);
    settings.pointsPerCorrect = clamp(Math.round(settings.pointsPerCorrect) || 1, 1, 10);
    storage.set(SETTINGS_KEY, settings);
    emit();
    return settings;
}

export function resetSettings() {
    settings = { ...DEFAULT_SETTINGS };
    storage.set(SETTINGS_KEY, settings);
    emit();
}

// ---- team colours ----

export const TEAM_COLOURS = [
    '#c4a24e', '#4a9e6e', '#5b8fd6', '#c45e4e', '#a97bd6',
    '#d68f4a', '#4ac2c2', '#d65e9e', '#8fbf4a', '#8a8fd6',
];

// ---- game ----

/**
 * phase: 'setup' | 'roundIntro' | 'question' | 'answers' | 'marking'
 *      | 'leaderboard' | 'interval' | 'tiebreak' | 'results'
 */
function emptyGame() {
    return {
        id: uid('game'),
        packId: '',
        packName: '',
        roundIds: [],
        teams: [],
        marks: {},          // marks[roundId][teamId] = [null | 0 | 1, ...]
        bonus: {},          // bonus[roundId][teamId] = number
        jokers: {},         // jokers[teamId] = roundId — that round scores double
        history: [],        // [{ roundId, standings: [{teamId, total}] }]
        phase: 'setup',
        roundIndex: 0,
        questionIndex: 0,
        revealed: false,
        answerIndex: 0,     // how many of the round's answers have been read out
        askedIntervalAfter: null,
        tiebreak: null,     // { teamIds, guesses: {teamId: number}, winnerId }
        tiebreakPoints: {}, // teamId -> 1, kept out of the rounds so a joker cannot double it
        intervalEndsAt: null,
        startedAt: null,
        finishedAt: null,
    };
}

let game = storage.get(GAME_KEY, null) || emptyGame();
if (!game.marks || typeof game.marks !== 'object') game = emptyGame();
if (!game.jokers || typeof game.jokers !== 'object') game.jokers = {};
if (typeof game.answerIndex !== 'number') game.answerIndex = 0;
if (!game.tiebreakPoints || typeof game.tiebreakPoints !== 'object') game.tiebreakPoints = {};

const listeners = new Set();

export function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function emit() {
    for (const fn of listeners) {
        try {
            fn(game, settings);
        } catch (err) {
            console.warn('[pub-quiz] listener failed', err);
        }
    }
}

export function getGame() {
    return game;
}

/** Mutate the game through a callback, then persist and notify. */
export function updateGame(mutator) {
    const result = mutator(game);
    if (result && typeof result === 'object') game = result;
    storage.set(GAME_KEY, game);
    emit();
    return game;
}

export function resetGame() {
    game = emptyGame();
    storage.remove(GAME_KEY);
    emit();
    return game;
}

/** True if there is a quiz worth offering to resume. */
export function hasResumableGame() {
    return Boolean(
        game
        && game.phase !== 'setup'
        && game.phase !== 'results'
        && game.packId
        && game.roundIds.length,
    );
}

export function startGame({ pack, roundIds, teams }) {
    game = emptyGame();
    game.packId = pack.id;
    game.packName = pack.name;
    game.roundIds = roundIds.slice();
    game.teams = teams.map((t, i) => ({
        id: t.id || uid('team'),
        name: t.name,
        colour: t.colour || TEAM_COLOURS[i % TEAM_COLOURS.length],
    }));
    game.startedAt = Date.now();
    game.phase = 'roundIntro';

    for (const roundId of game.roundIds) {
        const round = pack.rounds.find((r) => r.id === roundId);
        game.marks[roundId] = {};
        game.bonus[roundId] = {};
        for (const team of game.teams) {
            game.marks[roundId][team.id] = new Array(round ? round.questions.length : 0).fill(null);
            game.bonus[roundId][team.id] = 0;
        }
    }

    storage.set(GAME_KEY, game);
    emit();
    return game;
}

// ---- teams ----

export function addTeamMidGame(name, pack) {
    updateGame((g) => {
        const team = {
            id: uid('team'),
            name,
            colour: TEAM_COLOURS[g.teams.length % TEAM_COLOURS.length],
        };
        g.teams.push(team);
        for (const roundId of g.roundIds) {
            const round = pack.rounds.find((r) => r.id === roundId);
            g.marks[roundId] = g.marks[roundId] || {};
            g.bonus[roundId] = g.bonus[roundId] || {};
            g.marks[roundId][team.id] = new Array(round ? round.questions.length : 0).fill(null);
            g.bonus[roundId][team.id] = 0;
        }
    });
}

export function removeTeamMidGame(teamId) {
    updateGame((g) => {
        g.teams = g.teams.filter((t) => t.id !== teamId);
        for (const roundId of Object.keys(g.marks)) {
            delete g.marks[roundId][teamId];
            delete g.bonus[roundId]?.[teamId];
        }
    });
}

// ---- marking ----

export function setMark(roundId, teamId, questionIndex, value) {
    updateGame((g) => {
        g.marks[roundId] = g.marks[roundId] || {};
        const row = g.marks[roundId][teamId] || [];
        row[questionIndex] = value;
        g.marks[roundId][teamId] = row;
    });
}

export function cycleMark(roundId, teamId, questionIndex) {
    const current = game.marks?.[roundId]?.[teamId]?.[questionIndex] ?? null;
    const next = current === null ? 1 : (current === 1 ? 0 : null);
    setMark(roundId, teamId, questionIndex, next);
    return next;
}

export function fillRow(roundId, teamId, value, length) {
    updateGame((g) => {
        g.marks[roundId] = g.marks[roundId] || {};
        g.marks[roundId][teamId] = new Array(length).fill(value);
    });
}

export function setBonus(roundId, teamId, points) {
    updateGame((g) => {
        g.bonus[roundId] = g.bonus[roundId] || {};
        g.bonus[roundId][teamId] = Number(points) || 0;
    });
}

/**
 * Resize the stored marks to the pack as it stands now. A round edited and
 * re-imported mid-quiz can be shorter than the one the game was started with,
 * and roundScore counts every 1 in the row it finds — including the ones for
 * questions nobody will be asked.
 */
export function reconcileMarks(pack) {
    if (!pack || pack.id !== game.packId) return game;

    return updateGame((g) => {
        for (const roundId of g.roundIds) {
            const round = pack.rounds.find((r) => r.id === roundId);
            if (!round) continue;

            const { length } = round.questions;
            const rows = g.marks[roundId] || (g.marks[roundId] = {});
            for (const team of g.teams) {
                const row = rows[team.id] || [];
                if (row.length === length) continue;
                rows[team.id] = Array.from({ length }, (_, i) => row[i] ?? null);
            }
        }
    });
}

// ---- scoring ----

export function roundScore(roundId, teamId) {
    const row = game.marks?.[roundId]?.[teamId] || [];
    const correct = row.filter((v) => v === 1).length;
    const bonus = game.bonus?.[roundId]?.[teamId] || 0;
    const base = correct * settings.pointsPerCorrect + bonus;
    return hasJoker(roundId, teamId) ? base * 2 : base;
}

// ---- jokers ----
// The pub-quiz classic: a team may play their joker on one round of the night
// and have it score double. Once played it cannot be moved to another round.

export function hasJoker(roundId, teamId) {
    return Boolean(settings.jokersEnabled) && game.jokers?.[teamId] === roundId;
}

export function jokerRound(teamId) {
    return game.jokers?.[teamId] || null;
}

/** Play, move or take back a team's joker on this round. */
export function toggleJoker(roundId, teamId) {
    updateGame((g) => {
        g.jokers = g.jokers || {};
        if (g.jokers[teamId] === roundId) delete g.jokers[teamId];
        else g.jokers[teamId] = roundId;
    });
    return game.jokers[teamId] === roundId;
}

export function totalScore(teamId, upToRoundIndex = Infinity) {
    const rounds = game.roundIds
        .slice(0, upToRoundIndex + 1)
        .reduce((sum, roundId) => sum + roundScore(roundId, teamId), 0);

    // The tie-break decider only counts once every round has been played.
    const decided = upToRoundIndex >= game.roundIds.length - 1;
    return rounds + (decided ? (game.tiebreakPoints?.[teamId] || 0) : 0);
}

/**
 * Hand the tie-break winner the point that settles it. Assignment rather than
 * increment, so a host who walks back through the tie-break cannot award twice.
 */
export function awardTiebreakPoint(teamId) {
    updateGame((g) => {
        g.tiebreakPoints = teamId ? { [teamId]: 1 } : {};
    });
}

/**
 * Standings sorted by total, with ties sharing a position.
 * Returns [{ team, total, roundTotal, position, movement }]
 * movement compares against the snapshot stored for the previous round.
 */
export function standings(upToRoundIndex = Infinity) {
    const roundId = game.roundIds[Math.min(upToRoundIndex, game.roundIds.length - 1)];
    const rows = game.teams.map((team) => ({
        team,
        total: totalScore(team.id, upToRoundIndex),
        roundTotal: roundId ? roundScore(roundId, team.id) : 0,
    }));

    rows.sort((a, b) => b.total - a.total || a.team.name.localeCompare(b.team.name));

    let position = 0;
    let lastTotal = null;
    rows.forEach((row, index) => {
        if (row.total !== lastTotal) {
            position = index + 1;
            lastTotal = row.total;
        }
        row.position = position;
    });

    // The leaderboard snapshots this round before it renders, so the newest
    // history entry is usually the very round being shown: skip back past it.
    const history = game.history || [];
    let prevIndex = history.length - 1;
    while (prevIndex >= 0 && history[prevIndex].roundId === roundId) prevIndex--;
    const previous = history[prevIndex];
    const prevPositions = new Map(
        (previous?.standings || []).map((s) => [s.teamId, s.position]),
    );
    for (const row of rows) {
        const before = prevPositions.get(row.team.id);
        row.movement = before === undefined ? 0 : before - row.position;
    }

    return rows;
}

export function snapshotStandings(roundIndex) {
    updateGame((g) => {
        const rows = standings(roundIndex).map((r) => ({
            teamId: r.team.id,
            position: r.position,
            total: r.total,
        }));
        g.history.push({ roundId: g.roundIds[roundIndex], standings: rows });
    });
}

export function leaders() {
    const rows = standings();
    return rows.filter((r) => r.position === 1);
}

export function isTied() {
    return leaders().length > 1;
}

// ---- navigation ----

export function setPhase(phase, patch = {}) {
    updateGame((g) => {
        g.phase = phase;
        Object.assign(g, patch);
    });
}

export function currentRoundId() {
    return game.roundIds[game.roundIndex];
}

// ---- export ----

/** Round names and team names are free text, so every cell is quoted. */
const csvCell = (value) => `"${String(value).replace(/"/g, '""')}"`;

export function scoresAsCsv(pack) {
    const rounds = game.roundIds.map((id) => pack.rounds.find((r) => r.id === id)).filter(Boolean);
    const header = ['Team', ...rounds.map((r) => r.name), 'Total'];
    const lines = [header.map(csvCell).join(',')];

    for (const row of standings()) {
        const cells = [
            row.team.name,
            ...rounds.map((r) => `${roundScore(r.id, row.team.id)}${hasJoker(r.id, row.team.id) ? ' (joker)' : ''}`),
            row.total,
        ];
        lines.push(cells.map(csvCell).join(','));
    }
    return lines.join('\n');
}
