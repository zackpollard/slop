/*
 * formats.js — the scoring maths for the phone rounds.
 *
 * Everything in here is a pure function: numbers in, numbers out. No DOM, no
 * network, no game state. That is deliberate. These rules decide who wins, they
 * run live in front of a room, and they are the one part of the phone layer you
 * should be able to read start to finish the night before and satisfy yourself
 * about. Nothing here can be affected by a dropped connection.
 *
 * The three formats share one property: the answer is ABSOLUTE. A gesture has no
 * spelling, so there is nothing to match, interpret or adjudicate. Scoring is
 * arithmetic on two values and it cannot be argued with.
 *
 * Each scorer returns a FRACTION of the question's value, 0..1, which the caller
 * multiplies by questionValue(). That keeps difficulty weighting, jokers and
 * bonuses working exactly as they do for a written round.
 */

/** The round formats that put something on a phone. */
export const PHONE_FORMATS = ['dial', 'climb', 'nobody-else'];

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

// ---------------------------------------------------------------- The Dial --

/*
 * A number, narrowed by clues. Lock early for a bigger multiplier, or wait for
 * the scale to tighten and take less. The tension is entirely in WHEN you lock,
 * which is the thing paper cannot record.
 */

/** Default multiplier ladder: locking before any clue is worth three times. */
export const DIAL_MULTIPLIERS = [3, 2, 1.5, 1];

/*
 * How close counts, as a fraction of the scale's full range. Deliberately
 * generous at the top end: the round should reward being in the right area,
 * because a question nobody can pin exactly still separates a good guess from
 * a wild one.
 */
export const DIAL_BANDS = [
    { within: 0.01, credit: 1 },
    { within: 0.03, credit: 0.7 },
    { within: 0.08, credit: 0.4 },
    { within: 0.15, credit: 0.2 },
];

/**
 * The multiplier a team gets for locking after `cluesSeen` clues.
 * Past the end of the ladder the last rung repeats, so a pack with more clues
 * than multipliers degrades quietly instead of scoring zero.
 */
export function dialMultiplier(cluesSeen, ladder = DIAL_MULTIPLIERS) {
    if (!ladder.length) return 1;
    const i = Math.max(0, Math.floor(cluesSeen || 0));
    return ladder[Math.min(i, ladder.length - 1)];
}

/**
 * Score one Dial question.
 *
 * @param {object} question  { answer, min, max, clues?, multipliers? }
 * @param {object} entry     { value, cluesSeen } — what the phone locked in
 * @returns {{ credit:number, multiplier:number, fraction:number, distance:number, band:number }}
 *          `fraction` is what the caller multiplies by questionValue().
 *
 * A team that never locked (no entry, or a non-numeric value) scores nothing —
 * but says so as band -1, so a host screen can show "no answer" rather than
 * "miles out", which are different things to a player.
 */
export function scoreDial(question, entry) {
    const answer = Number(question?.answer);
    const min = Number(question?.min);
    const max = Number(question?.max);
    const range = Math.abs(max - min);

    const multiplier = dialMultiplier(entry?.cluesSeen, question?.multipliers || DIAL_MULTIPLIERS);
    const blank = { credit: 0, multiplier, fraction: 0, distance: Infinity, band: -1 };

    if (!isNum(answer) || !isNum(entry?.value)) return blank;
    // A pack without a usable scale cannot produce a fair distance band, so it
    // scores nothing rather than dividing by zero and paying everybody.
    if (!isNum(range) || range <= 0) return blank;

    const distance = Math.abs(entry.value - answer);
    const off = distance / range;

    let credit = 0;
    let band = DIAL_BANDS.length;
    for (let i = 0; i < DIAL_BANDS.length; i += 1) {
        if (off <= DIAL_BANDS[i].within) { credit = DIAL_BANDS[i].credit; band = i; break; }
    }

    return {
        credit,
        multiplier,
        // The multiplier can push a single question past its face value. That is
        // the point of locking early, and it is capped by the ladder, not here.
        fraction: round2(credit * multiplier),
        distance,
        band: credit > 0 ? band : DIAL_BANDS.length,
    };
}

// --------------------------------------------------------------- The Climb --

/*
 * Eight rungs, each higher or lower than the last. Every correct call doubles
 * the pile; one wrong call loses the lot. You may bank at any moment, and
 * nobody else knows you have until it lands — which is the whole reason this
 * cannot be played out loud.
 */

export const CLIMB_STAKE = 1;   // what you carry onto the first rung
export const CLIMB_CAP = 16;    // ceiling, so one lucky run cannot decide the night

/** The pile a team is carrying after `correct` correct rungs. */
export function climbPile(correct, { stake = CLIMB_STAKE, cap = CLIMB_CAP } = {}) {
    if (!(correct > 0)) return stake;
    return Math.min(cap, stake * (2 ** correct));
}

/**
 * Score one Climb ladder.
 *
 * @param {object} question { rungs: [{ label, value }, ...] }
 * @param {object} entry    { calls: ['up'|'down', ...], bankedAfter: number|null }
 *                          `bankedAfter` is how many calls they had made when
 *                          they banked; null means they were still climbing.
 * @param {object} opts     { stake, cap }
 * @returns {{ correct:number, pile:number, banked:boolean, bust:boolean, fraction:number }}
 *
 * Calls are compared against consecutive rung values. Equal values are treated
 * as neither up nor down and end the ladder without busting — a pack should not
 * contain them, but a tie must not silently punish a team.
 */
export function scoreClimb(question, entry, opts = {}) {
    const rungs = Array.isArray(question?.rungs) ? question.rungs : [];
    const calls = Array.isArray(entry?.calls) ? entry.calls : [];
    const bankedAfter = isNum(entry?.bankedAfter) ? entry.bankedAfter : null;
    const cap = isNum(opts.cap) ? opts.cap : CLIMB_CAP;
    const stake = isNum(opts.stake) ? opts.stake : CLIMB_STAKE;

    // Only calls made before banking count. A queued message arriving after the
    // bank must not be able to extend a ladder that is already settled.
    const live = bankedAfter === null ? calls : calls.slice(0, bankedAfter);

    let correct = 0;
    let bust = false;
    for (let i = 0; i < live.length; i += 1) {
        const from = Number(rungs[i]?.value);
        const to = Number(rungs[i + 1]?.value);
        if (!isNum(from) || !isNum(to)) break;
        if (from === to) break;
        const truth = to > from ? 'up' : 'down';
        if (live[i] !== truth) { bust = true; break; }
        correct += 1;
    }

    const banked = bankedAfter !== null && !bust;
    const pile = bust ? 0 : climbPile(correct, { stake, cap });

    return {
        correct,
        pile,
        banked,
        bust,
        // A ladder is worth its pile relative to the cap, so a maxed-out climb is
        // one whole question and a bust is nothing. Keeps a Climb round's total
        // in the same order as any other round rather than swamping the night.
        fraction: round2(clamp01(pile / cap)),
    };
}

// ------------------------------------------------------------ Nobody Else --

/*
 * Pick a few from a board — but anything two tables both pick is void for both.
 * The skill is modelling the other sofa, not knowing more, which is the flattest
 * thing across a wide age range. It cannot be played aloud, because saying your
 * picks is giving them away.
 */

/**
 * Score a whole Nobody Else board at once — it has to be scored for every team
 * together, because a pick's value depends on what the other tables chose.
 *
 * @param {object} question  { tiles: [{ label, correct }], pick: number }
 * @param {object} entries   { [teamId]: { picks: [tileIndex, ...] } }
 * @returns {{ byTeam: object, voided: number[] }}
 *          byTeam[teamId] = { hits, voided, misses, fraction }
 *
 * No penalty for a wrong pick. The void rule already prices caution, and a
 * penalty would punish exactly the brave obscure guess the round exists to buy.
 */
export function scoreNobodyElse(question, entries) {
    const tiles = Array.isArray(question?.tiles) ? question.tiles : [];
    const pick = isNum(question?.pick) && question.pick > 0 ? question.pick : 3;
    const teamIds = Object.keys(entries || {});

    // Count the tables on each tile. A team that somehow submitted the same tile
    // twice must not void itself, so each team's picks are de-duplicated first.
    const cleaned = {};
    const takenBy = new Map();
    for (const teamId of teamIds) {
        const raw = Array.isArray(entries[teamId]?.picks) ? entries[teamId].picks : [];
        const picks = [...new Set(raw.filter((i) => isNum(i) && i >= 0 && i < tiles.length))].slice(0, pick);
        cleaned[teamId] = picks;
        for (const i of picks) takenBy.set(i, (takenBy.get(i) || 0) + 1);
    }

    const voided = [...takenBy.entries()].filter(([, n]) => n > 1).map(([i]) => i);
    const byTeam = {};
    for (const teamId of teamIds) {
        let hits = 0;
        let void_ = 0;
        let misses = 0;
        for (const i of cleaned[teamId]) {
            if ((takenBy.get(i) || 0) > 1) void_ += 1;
            else if (tiles[i]?.correct) hits += 1;
            else misses += 1;
        }
        byTeam[teamId] = {
            hits,
            voided: void_,
            misses,
            fraction: round2(clamp01(hits / pick)),
        };
    }

    return { byTeam, voided: voided.sort((a, b) => a - b) };
}

// ------------------------------------------------------------- validation --

/**
 * Check one phone-round question is playable, returning a list of problems.
 * The pack validator calls this; a round that fails is rejected at import
 * rather than at 8pm.
 */
export function validateFormatQuestion(format, q, label) {
    const problems = [];
    const bad = (m) => problems.push(`${label} ${m}`);

    if (format === 'dial') {
        if (!isNum(Number(q.answer))) bad('needs a numeric "answer".');
        if (!isNum(Number(q.min)) || !isNum(Number(q.max))) bad('needs numeric "min" and "max" for the scale.');
        else if (Number(q.max) <= Number(q.min)) bad('has a "max" that is not above its "min".');
        else if (isNum(Number(q.answer))
            && (Number(q.answer) < Number(q.min) || Number(q.answer) > Number(q.max))) {
            bad('has an "answer" outside its own scale, so nobody could reach it.');
        }
        if (q.clues && !Array.isArray(q.clues)) bad('has "clues" that are not a list.');
    }

    if (format === 'climb') {
        const rungs = q.rungs;
        if (!Array.isArray(rungs) || rungs.length < 2) bad('needs at least two "rungs".');
        else {
            rungs.forEach((r, i) => {
                if (!isNum(Number(r?.value))) bad(`rung ${i + 1} has no numeric "value".`);
                if (typeof r?.label !== 'string' || !r.label.trim()) bad(`rung ${i + 1} has no "label".`);
            });
            for (let i = 1; i < rungs.length; i += 1) {
                if (Number(rungs[i]?.value) === Number(rungs[i - 1]?.value)) {
                    bad(`rungs ${i} and ${i + 1} are equal, so neither up nor down is right.`);
                }
            }
        }
    }

    if (format === 'nobody-else') {
        const tiles = q.tiles;
        const pick = q.pick;
        if (!Array.isArray(tiles) || tiles.length < 4) bad('needs at least four "tiles".');
        else {
            const correct = tiles.filter((t) => t && t.correct).length;
            if (!correct) bad('has no correct tiles.');
            if (correct === tiles.length) bad('has no wrong tiles, so every pick scores.');
            tiles.forEach((t, i) => {
                if (typeof t?.label !== 'string' || !t.label.trim()) bad(`tile ${i + 1} has no "label".`);
            });
            if (isNum(pick) && correct < pick) {
                bad(`asks for ${pick} picks but only has ${correct} correct tiles.`);
            }
        }
        if (pick !== undefined && (!isNum(pick) || pick < 1)) bad('has a "pick" that is not a positive number.');
    }

    return problems;
}
