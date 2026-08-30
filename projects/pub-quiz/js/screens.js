/*
 * screens.js — every screen of a running quiz.
 *
 * These are pure render functions: they take a context object built by app.js
 * and return a DOM node. Anything that needs to happen (speaking, timing,
 * scoring, navigation) is done through ctx.actions, and anything that needs
 * live updating without a re-render is registered on ctx.refs.
 */

import {
    el, svgEl, icon, ordinal, plural, fmtTime, listSentence, numberWord,
} from './dom.js';
import {
    standings, roundScore, cycleMark, fillRow, setBonus, getGame, updateGame,
    hasJoker, jokerRound, toggleJoker,
} from './state.js';
import { MELODIES } from './audio.js';
import { clipCredit, imageCredit, creditSpoils } from './media.js';

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// ---- shared bits ----

function roundChip(ctx) {
    const { game, round } = ctx;
    return el('div', { class: 'round-chip' },
        el('span', { class: 'round-chip-icon', text: round.icon }),
        el('span', { class: 'round-chip-name', text: round.name }),
        el('span', { class: 'round-chip-count', text: `Round ${game.roundIndex + 1} of ${game.roundIds.length}` }));
}

function progressDots(ctx) {
    const { round, game } = ctx;
    const dots = el('div', { class: 'dots', 'aria-hidden': 'true' });
    round.questions.forEach((_, i) => {
        dots.appendChild(el('span', {
            class: ['dot', i < game.questionIndex && 'is-done', i === game.questionIndex && 'is-now'],
        }));
    });
    return dots;
}

function difficultyChip(difficulty) {
    return el('span', { class: `chip chip-${difficulty}` },
        el('span', { class: 'pips' },
            ...[1, 2, 3].map((n) => el('span', {
                class: ['pip', n <= ({ easy: 1, medium: 2, hard: 3 }[difficulty] || 2) && 'is-on'],
            }))),
        DIFFICULTY_LABELS[difficulty] || difficulty);
}

function sourceLink(source) {
    if (!source?.url) return null;
    return el('a', {
        class: 'source-link',
        href: source.url,
        target: '_blank',
        rel: 'noopener noreferrer',
    }, icon('link', 14), source.name || 'Source');
}

// ---- round intro ----

export function renderRoundIntro(ctx) {
    const { round, game, actions } = ctx;
    const isFirst = game.roundIndex === 0;

    return el('div', { class: 'screen stage round-intro' },
        el('div', { class: 'round-intro-inner' },
            el('div', { class: 'round-number', text: `Round ${game.roundIndex + 1}` }),
            el('div', { class: 'round-glyph', text: round.icon }),
            el('h1', { class: 'round-title', text: round.name }),
            round.intro ? el('p', { class: 'round-blurb', text: round.intro }) : null,
            el('p', { class: 'round-facts' },
                el('span', { text: plural(round.questions.length, 'question') }),
                ctx.settings.timerEnabled
                    ? el('span', { text: `${ctx.settings.timerSeconds} seconds each` })
                    : el('span', { text: 'no timer' }),
                game.teams.length ? el('span', { text: plural(game.teams.length, 'team') }) : null)),

        el('div', { class: 'stage-controls' },
            !isFirst ? el('button', {
                class: 'btn btn-ghost',
                onClick: () => actions.repeatSpeech(),
            }, icon('repeat', 16), 'Read it again') : null,
            el('button', {
                class: 'btn btn-primary btn-large',
                onClick: () => actions.beginRound(),
            }, icon('play', 18), isFirst ? 'Begin' : 'Start the round')));
}

// ---- question ----

export function renderQuestion(ctx) {
    const {
        game, settings, round, question, refs,
    } = ctx;
    const revealed = game.revealed;
    const number = game.questionIndex + 1;

    const card = el('div', { class: ['question-card', revealed && 'is-revealed'] },
        el('div', { class: 'question-head' },
            el('span', { class: 'question-number', text: `Question ${number}` }),
            el('span', { class: 'question-of', text: `of ${round.questions.length}` }),
            el('div', { class: 'question-tags' },
                settings.showTopic && question.topic
                    ? el('span', { class: 'chip chip-topic', text: question.topic }) : null,
                settings.showDifficulty ? difficultyChip(question.difficulty) : null)),

        el('h1', { class: 'question-text', text: question.question }),

        question.image ? imagePanel(ctx) : null,

        question.clip ? clipPlayer(ctx) : (question.melody ? melodyPlayer(ctx) : null),

        revealed ? answerPanel(ctx) : null);

    return el('div', { class: 'screen stage question-stage' },
        el('div', { class: 'stage-top' },
            roundChip(ctx),
            settings.showProgress ? progressDots(ctx) : null),
        card,
        settings.timerEnabled && !revealed ? timerRing(ctx, refs) : null,
        questionControls(ctx));
}

/**
 * The picture round.
 *
 * Logos are usually flat black or a single dark colour, so they need a light
 * plate behind them or they vanish into the dark theme. Photographs fill their
 * frame instead. The attribution sits under the picture at all times — a free
 * licence is only free if you honour it — and the link back to the source
 * appears on the reveal, where it cannot hint at the answer.
 */
function imagePanel(ctx) {
    const { question, refs } = ctx;
    const image = question.image;
    const revealed = ctx.game.revealed;

    const img = el('img', {
        class: 'picture',
        src: image.src,
        alt: image.alt,
        decoding: 'async',
        onError: () => {
            frame.classList.add('is-broken');
            if (refs.pictureStatus) {
                refs.pictureStatus.textContent = 'Picture missing — read the question out instead.';
            }
        },
    });

    const frame = el('div', {
        class: ['picture-frame', `is-${image.fit}`,
            image.fit === 'contain' && `plate-${image.plate}`],
    }, img);

    const status = el('p', { class: 'picture-status' });
    refs.pictureStatus = status;

    // A credit naming the brand is withheld until the reveal; see creditSpoils.
    const spoils = creditSpoils(image, question.answer);
    const credit = spoils && !revealed ? '' : imageCredit(image);

    return el('div', { class: 'picture-panel' },
        frame,
        status,
        credit || revealed
            ? el('p', { class: 'picture-credit' },
                credit,
                revealed && image.sourceUrl
                    ? el('a', {
                        class: 'source-link',
                        href: image.sourceUrl,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                    }, icon('link', 12), 'Source')
                    : null,
                revealed && image.trademark
                    ? el('span', { class: 'picture-tm', text: 'Trademark of its owner, shown for identification.' })
                    : null)
            : null);
}

/**
 * The audio round. Deliberately anonymous: the clip is streamed straight from
 * the store's preview CDN and nothing on screen names the track, because
 * naming it would be the answer. The credit only appears on the reveal.
 */
function clipPlayer(ctx) {
    const { question, engines, actions, refs } = ctx;
    const clip = question.clip;
    const revealed = ctx.game.revealed;

    const bars = el('div', { class: 'eq', 'aria-hidden': 'true' },
        ...Array.from({ length: 7 }, (_, i) => el('span', {
            class: 'eq-bar',
            style: { animationDelay: `${i * 90}ms` },
        })));

    const fill = el('div', { class: 'clip-fill' });
    const status = el('span', { class: 'clip-status', text: 'Ready' });

    const button = el('button', {
        class: 'btn btn-melody',
        onClick: () => actions.playClip(),
    }, icon('play', 22), el('span', { text: 'Play the clip' }));

    refs.clipButton = button;
    refs.clipFill = fill;
    refs.clipStatus = status;
    refs.clipBars = bars;

    return el('div', { class: 'clip-player' },
        el('div', { class: 'clip-stage' },
            bars,
            el('div', { class: 'clip-track' }, fill)),
        el('div', { class: 'clip-controls' },
            button,
            status),
        el('p', { class: 'melody-hint', text: 'Play it as many times as you like — the clip is thirty seconds.' }),
        revealed
            ? el('p', { class: 'melody-meta' },
                clipCredit(clip),
                clip.storeUrl
                    ? el('a', {
                        class: 'source-link',
                        href: clip.storeUrl,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                    }, icon('link', 14), 'Listen in full')
                    : null)
            : null);
}

/**
 * A tune outlives the button that started it: a re-render mid-play swaps in a
 * fresh node, so the throb is cleared on whichever button is on screen when the
 * tune ends rather than on the one that was clicked.
 */
let liveMelodyButton = null;

function melodyPlayer(ctx) {
    const { question, engines, actions } = ctx;
    const meta = MELODIES[question.melody] || null;
    const { roundIndex, questionIndex } = ctx.game;

    const button = el('button', {
        class: ['btn btn-melody', engines.audio.playingMelody && 'is-playing'],
        onClick: async () => {
            // The tune plays itself once when the question comes up. Clicking
            // over the top of that would cut it off and — because the clock is
            // waiting on that first play to finish — start the countdown early.
            if (engines.audio.playingMelody) return;

            // Only hold the clock if it was actually running: on the first play
            // it has not started yet, and blindly resuming afterwards would set
            // it going while the host is still talking.
            const wasRunning = ctx.timer.running;
            if (wasRunning) actions.pauseTimer(true);

            await engines.audio.unlock();
            liveMelodyButton?.classList.add('is-playing');
            try {
                await engines.audio.playMelody(question.melody);
            } finally {
                liveMelodyButton?.classList.remove('is-playing');
            }

            // The tune can finish long after the host has moved on; restarting
            // the clock then would run a countdown against a question that is
            // no longer on screen, tick-tock and all.
            const live = getGame();
            const stillHere = live.phase === 'question' && !live.revealed
                && live.roundIndex === roundIndex && live.questionIndex === questionIndex;
            if (wasRunning && stillHere) actions.pauseTimer(false);
        },
    }, icon('music', 22), el('span', { text: 'Play the tune' }));

    liveMelodyButton = button;

    return el('div', { class: 'melody-player' },
        button,
        el('p', { class: 'melody-hint', text: 'Listen carefully — you can hear it as many times as you like.' }),
        ctx.game.revealed && meta
            ? el('p', { class: 'melody-meta', text: `${meta.title} — ${meta.composer}, ${meta.year}` })
            : null);
}

function timerRing(ctx, refs) {
    const total = ctx.settings.timerSeconds;
    const circumference = 2 * Math.PI * 54;

    const ringProgress = svgEl('circle', {
        class: 'ring-progress',
        cx: 60, cy: 60, r: 54,
        'stroke-dasharray': circumference,
        'stroke-dashoffset': 0,
    });

    const svg = svgEl('svg', { viewBox: '0 0 120 120', class: 'ring', 'aria-hidden': 'true' },
        svgEl('circle', { class: 'ring-track', cx: 60, cy: 60, r: 54 }),
        ringProgress);

    const text = el('div', { class: 'timer-text', text: fmtTime(ctx.timer.remaining ?? total) });

    refs.ring = ringProgress;
    refs.ringCircumference = circumference;
    refs.timerText = text;

    return el('div', { class: 'timer', id: 'timer' },
        svg,
        text,
        timerToggle(ctx));
}

function timerToggle(ctx) {
    const button = el('button', {
        class: 'timer-toggle',
        'aria-label': 'Pause or resume the timer',
        onClick: () => ctx.actions.toggleTimer(),
    });
    ctx.refs.timerToggle = button;
    return button;
}

function answerPanel(ctx) {
    const { question } = ctx;
    return el('div', { class: 'answer-panel' },
        el('div', { class: 'answer-label', text: 'The answer is' }),
        el('div', { class: 'answer-text', text: question.answer }),
        question.acceptable.length
            ? el('div', { class: 'answer-accept', text: `Also accept: ${listSentence(question.acceptable)}` })
            : null,
        question.funFact
            ? el('p', { class: 'fun-fact' }, el('span', { class: 'fun-fact-icon', text: '💡' }), question.funFact)
            : null,
        sourceLink(question.source));
}

/**
 * The pause/resume button and the little toggle on the ring both describe the
 * clock, which starts *after* this screen is drawn — so they are handed to the
 * controller through refs and relabelled as the clock changes, rather than
 * being frozen at render time.
 */
function pauseButton(ctx) {
    const button = el('button', {
        class: 'btn btn-ghost',
        onClick: () => ctx.actions.toggleTimer(),
    });
    ctx.refs.pauseButton = button;
    return button;
}

function questionControls(ctx) {
    const { game, round, actions, settings } = ctx;
    const revealed = game.revealed;
    const isLast = game.questionIndex >= round.questions.length - 1;

    return el('div', { class: 'stage-controls' },
        el('button', {
            class: 'btn btn-ghost',
            disabled: game.questionIndex === 0 && !revealed,
            onClick: () => actions.previous(),
        }, icon('prev', 16), 'Back'),

        !revealed
            ? el('button', {
                class: 'btn btn-ghost',
                onClick: () => actions.repeatSpeech(),
            }, icon('repeat', 16), 'Read it again')
            : null,

        !revealed && settings.timerEnabled ? pauseButton(ctx) : null,

        revealed
            ? el('button', {
                class: 'btn btn-primary btn-large',
                onClick: () => actions.next(),
            }, isLast ? 'Finish the round' : 'Next question', icon('next', 18))
            : el('button', {
                class: 'btn btn-primary btn-large',
                onClick: () => actions.reveal(),
            }, icon('eye', 18), 'Reveal the answer'));
}

// ---- marking ----

/**
 * Mark cells are repainted where they stand: the grid is an internal scroller
 * the host works in for minutes at a time, and a re-render would throw them
 * back to the top-left, next to somebody else's row.
 */
function paintMark(button, value) {
    button.className = ['mark-cell', value === 1 && 'is-right', value === 0 && 'is-wrong']
        .filter(Boolean).join(' ');
    button.textContent = value === 1 ? '✓' : (value === 0 ? '✗' : '');
}

export function renderMarking(ctx) {
    const { game, round, actions } = ctx;
    const roundId = round.id;
    const questionCount = round.questions.length;

    const table = el('table', { class: 'mark-table' });
    const head = el('tr', {},
        el('th', { class: 'sticky-col', text: 'Team' }),
        ...round.questions.map((q, i) => el('th', {
            class: 'mark-col',
            title: `${q.question} — ${q.answer}`,
        }, String(i + 1))),
        el('th', { class: 'bonus-col', text: 'Bonus' }),
        ctx.settings.jokersEnabled ? el('th', { class: 'joker-col', text: 'Joker' }) : null,
        el('th', { class: 'total-col', text: 'Round' }));
    table.appendChild(el('thead', {}, head));

    const body = el('tbody');
    for (const team of game.teams) {
        const totalCell = el('td', { class: 'total-col', text: String(roundScore(roundId, team.id)) });

        const refresh = () => {
            totalCell.textContent = String(roundScore(roundId, team.id));
            ctx.refs.markSummary?.();
        };

        const cellButtons = [];
        const cells = round.questions.map((_, i) => {
            const value = game.marks[roundId]?.[team.id]?.[i] ?? null;
            const button = el('button', {
                class: ['mark-cell', value === 1 && 'is-right', value === 0 && 'is-wrong'],
                'aria-label': `Question ${i + 1} for ${team.name}`,
                onClick: () => {
                    const next = cycleMark(roundId, team.id, i);
                    paintMark(button, next);
                    ctx.engines.audio.play(next === 1 ? 'correct' : 'click');
                    refresh();
                },
                text: value === 1 ? '✓' : (value === 0 ? '✗' : ''),
            });
            cellButtons.push(button);
            return el('td', { class: 'mark-col' }, button);
        });

        const setRow = (value) => {
            fillRow(roundId, team.id, value, questionCount);
            cellButtons.forEach((button) => paintMark(button, value));
            ctx.engines.audio.play(value === 1 ? 'correct' : 'click');
            refresh();
        };

        body.appendChild(el('tr', {},
            el('th', { class: 'sticky-col team-cell' },
                el('span', { class: 'team-dot', style: { background: team.colour } }),
                el('span', { class: 'team-name', text: team.name }),
                el('span', { class: 'quick' },
                    el('button', {
                        class: 'quick-btn', title: 'Mark all correct',
                        'aria-label': `Mark every question correct for ${team.name}`,
                        onClick: () => setRow(1),
                    }, '✓'),
                    el('button', {
                        class: 'quick-btn', title: 'Clear the row',
                        'aria-label': `Clear every mark for ${team.name}`,
                        onClick: () => setRow(null),
                    }, '–'))),
            ...cells,
            el('td', { class: 'bonus-col' },
                el('input', {
                    type: 'number', class: 'input input-bonus', value: String(game.bonus[roundId]?.[team.id] ?? 0),
                    min: '-10', max: '20',
                    'aria-label': `Bonus points for ${team.name}`,
                    onChange: (e) => { setBonus(roundId, team.id, e.target.value); refresh(); },
                })),
            ctx.settings.jokersEnabled ? el('td', { class: 'joker-col' }, jokerButton(ctx, roundId, team, refresh)) : null,
            totalCell));
    }
    table.appendChild(body);

    const answerKey = el('details', { class: 'answer-key' },
        el('summary', {}, `Answer key for ${round.name}`),
        el('ol', { class: 'key-list' },
            ...round.questions.map((q) => el('li', {},
                el('span', { class: 'key-q', text: q.question }),
                el('span', { class: 'key-a', text: q.answer }),
                q.acceptable.length ? el('span', { class: 'key-alt', text: `or ${listSentence(q.acceptable)}` }) : null))));

    return el('div', { class: 'screen marking' },
        el('header', { class: 'screen-head' },
            el('h1', {}, 'Marking · ', el('span', { class: 'accent', text: round.name })),
            el('p', { class: 'screen-sub', text: 'Tap a box to cycle it: correct, wrong, blank. Swap sheets between teams and be ruthless.' })),
        el('div', { class: 'table-wrap' }, table),
        answerKey,
        el('div', { class: 'stage-controls' },
            el('button', { class: 'btn btn-ghost', onClick: () => actions.backToQuestions() },
                icon('prev', 16), 'Back to the questions'),
            el('button', { class: 'btn btn-primary btn-large', onClick: () => actions.confirmMarks() },
                icon('check', 18), 'Scores are in')));
}

function jokerButton(ctx, roundId, team, refresh) {
    const playedHere = hasJoker(roundId, team.id);
    const playedElsewhere = jokerRound(team.id) && !playedHere;
    const otherRound = playedElsewhere
        ? ctx.pack.rounds.find((r) => r.id === jokerRound(team.id))
        : null;
    const label = (played) => (played
        ? `Joker played for ${team.name} — activate to take it back`
        : `Play the joker for ${team.name}`);

    // A joker belongs to one team's row, so it restyles itself rather than
    // redrawing the grid out from under the host.
    const button = el('button', {
        class: ['joker-btn', playedHere && 'is-played'],
        disabled: Boolean(playedElsewhere),
        title: playedElsewhere
            ? `Joker already played on ${otherRound ? otherRound.name : 'another round'}`
            : 'Double this round for this team',
        'aria-label': playedElsewhere
            ? `Joker unavailable for ${team.name} — already played on ${otherRound ? otherRound.name : 'another round'}`
            : label(playedHere),
        onClick: () => {
            const on = toggleJoker(roundId, team.id);
            ctx.engines.audio.play(on ? 'points' : 'click');
            button.className = ['joker-btn', on && 'is-played'].filter(Boolean).join(' ');
            button.textContent = on ? '★ ×2' : '☆';
            button.setAttribute('aria-label', label(on));
            refresh();
        },
    }, playedHere ? '★ ×2' : (playedElsewhere ? '–' : '☆'));
    return button;
}

// ---- leaderboard ----

export function renderLeaderboard(ctx) {
    const { game, round, actions } = ctx;
    const rows = standings(game.roundIndex);
    const max = Math.max(1, ...rows.map((r) => r.total));
    const isLastRound = game.roundIndex >= game.roundIds.length - 1;

    const board = el('div', { class: 'board' });
    rows.forEach((row, index) => {
        const bar = el('div', {
            class: 'board-bar',
            style: { width: '0%', background: row.team.colour },
        });
        // animate in after paint
        requestAnimationFrame(() => requestAnimationFrame(() => {
            bar.style.width = `${Math.max(6, (row.total / max) * 100)}%`;
        }));

        board.appendChild(el('div', {
            class: ['board-row', row.position === 1 && 'is-leader'],
            style: { animationDelay: `${index * 70}ms` },
        },
        el('div', { class: 'board-pos', text: ordinal(row.position) }),
        el('div', { class: 'board-main' },
            el('div', { class: 'board-name' },
                el('span', { text: row.team.name }),
                movementBadge(row.movement)),
            el('div', { class: 'board-track' }, bar)),
        el('div', { class: 'board-score' },
            el('span', { class: 'board-total', text: String(row.total) }),
            el('span', {
                class: ['board-round', hasJoker(game.roundIds[game.roundIndex], row.team.id) && 'is-joker'],
                text: `+${row.roundTotal}${hasJoker(game.roundIds[game.roundIndex], row.team.id) ? ' ★' : ''}`,
            }))));
    });

    return el('div', { class: 'screen leaderboard' },
        el('header', { class: 'screen-head' },
            el('div', { class: 'round-chip-standalone' }, round.icon, ` ${round.name}`),
            el('h1', {}, 'The ', el('span', { class: 'accent', text: 'scores' }), ' on the doors'),
            el('p', { class: 'screen-sub', text: leaderboardSubtitle(rows, game) })),
        board,
        el('div', { class: 'stage-controls' },
            el('button', { class: 'btn btn-ghost', onClick: () => actions.render() }, icon('repeat', 16), 'Redraw'),
            el('button', { class: 'btn btn-ghost', onClick: () => actions.backToMarking() }, 'Fix the marks'),
            el('button', { class: 'btn btn-primary btn-large', onClick: () => actions.afterLeaderboard() },
                isLastRound ? 'To the final scores' : 'Next round', icon('next', 18))));
}

function movementBadge(movement) {
    if (!movement) return null;
    const up = movement > 0;
    return el('span', {
        class: ['move', up ? 'move-up' : 'move-down'],
        title: `${up ? 'Up' : 'Down'} ${Math.abs(movement)}`,
    }, `${up ? '▲' : '▼'}${Math.abs(movement)}`);
}

function leaderboardSubtitle(rows, game) {
    if (!rows.length) return 'No teams — score it on paper.';
    const leaders = rows.filter((r) => r.position === 1);
    const remaining = game.roundIds.length - game.roundIndex - 1;
    const tail = remaining > 0 ? ` ${plural(remaining, 'round')} still to play.` : ' That is the last of the questions.';
    if (leaders.length > 1) {
        return `${listSentence(leaders.map((l) => l.team.name))} are tied at the top on ${plural(leaders[0].total, 'point')}.${tail}`;
    }
    const gap = leaders[0].total - (rows[1]?.total ?? leaders[0].total);
    if (rows.length === 1) return `${leaders[0].team.name} on ${plural(leaders[0].total, 'point')}.${tail}`;
    return gap === 0
        ? `${leaders[0].team.name} lead on ${plural(leaders[0].total, 'point')}.${tail}`
        : `${leaders[0].team.name} lead on ${plural(leaders[0].total, 'point')}, ${plural(gap, 'point')} clear.${tail}`;
}

// ---- interval ----

export function renderInterval(ctx) {
    const { actions, refs, settings, game } = ctx;
    // The clock is shared with the question timer, and after a reload it is a
    // dead zero belonging to nothing — only trust it once it is ours.
    const seconds = ctx.timer.mode === 'interval' && ctx.timer.remaining > 0
        ? ctx.timer.remaining
        : settings.intervalMinutes * 60;
    const text = el('div', { class: 'interval-clock', text: fmtTime(seconds) });
    refs.intervalText = text;

    // The host chooses which round the break follows, so it is only half time
    // when it genuinely lands in the middle.
    const midpoint = game.roundIds.length > 0 && (game.roundIndex + 1) * 2 === game.roundIds.length;

    return el('div', { class: 'screen stage interval' },
        el('div', { class: 'interval-inner' },
            el('div', { class: 'interval-glyph' }, icon('coffee', 64)),
            el('h1', { class: 'interval-title', text: midpoint ? 'Half time' : 'The break' }),
            el('p', { class: 'interval-sub', text: 'Get a drink in, compare notes, accuse each other of cheating.' }),
            text,
            el('p', { class: 'interval-standings', text: intervalStandingsLine(ctx) })),
        el('div', { class: 'stage-controls' },
            el('button', { class: 'btn btn-ghost', onClick: () => actions.addIntervalTime(60) }, '+1 minute'),
            el('button', { class: 'btn btn-primary btn-large', onClick: () => actions.endInterval() },
                icon('play', 18), 'Back to the quiz')));
}

function intervalStandingsLine(ctx) {
    const rows = standings(ctx.game.roundIndex);
    if (!rows.length) return '';
    return rows.slice(0, 3).map((r) => `${ordinal(r.position)} ${r.team.name} (${r.total})`).join(' · ');
}

// ---- tie-break ----

export function renderTiebreak(ctx) {
    const { game, pack, actions } = ctx;
    const tb = pack.tiebreaker;
    const tied = game.tiebreak?.teamIds || [];
    const teams = game.teams.filter((t) => tied.includes(t.id));
    const resolved = Boolean(game.tiebreak?.winnerId);

    const inputs = new Map();

    return el('div', { class: 'screen stage tiebreak' },
        el('div', { class: 'tiebreak-inner' },
            el('div', { class: 'tiebreak-flash', text: 'Tie-break!' }),
            el('h1', { class: 'question-text', text: tb.question }),
            el('p', { class: 'tiebreak-rule', text: `Closest guess wins${tb.unit ? ` — answer in ${tb.unit}` : ''}. No conferring.` }),

            el('div', { class: 'tiebreak-entries' },
                ...teams.map((team) => {
                    const guess = game.tiebreak?.guesses?.[team.id];
                    const input = el('input', {
                        type: 'number', class: 'input tiebreak-input',
                        value: guess ?? '', placeholder: '0', disabled: resolved,
                        // Held in the game so a re-render — the host reaching
                        // for the mute button, say — does not lose guesses that
                        // have already been read out to the room.
                        onInput: (e) => updateGame((g) => {
                            if (g.tiebreak) g.tiebreak.guesses[team.id] = e.target.value;
                        }),
                    });
                    inputs.set(team.id, input);
                    return el('label', { class: 'tiebreak-entry' },
                        el('span', { class: 'team-dot', style: { background: team.colour } }),
                        el('span', { class: 'tiebreak-team', text: team.name }),
                        input,
                        resolved && guess !== undefined
                            ? el('span', {
                                class: 'tiebreak-delta',
                                text: `out by ${Math.abs(Number(guess) - tb.answer).toLocaleString('en-GB')}`,
                            })
                            : null);
                })),

            resolved
                ? el('div', { class: 'answer-panel' },
                    el('div', { class: 'answer-label', text: 'The answer was' }),
                    el('div', { class: 'answer-text', text: `${tb.answer.toLocaleString('en-GB')}${tb.unit ? ` ${tb.unit}` : ''}` }),
                    tb.funFact ? el('p', { class: 'fun-fact' }, el('span', { class: 'fun-fact-icon', text: '💡' }), tb.funFact) : null,
                    sourceLink(tb.source))
                : null),

        el('div', { class: 'stage-controls' },
            resolved
                ? el('button', { class: 'btn btn-primary btn-large', onClick: () => actions.showResults() },
                    icon('trophy', 18), 'Crown the winners')
                : el('button', {
                    class: 'btn btn-primary btn-large',
                    onClick: () => {
                        const guesses = {};
                        for (const [teamId, input] of inputs) {
                            const value = Number(input.value);
                            if (Number.isFinite(value) && input.value !== '') guesses[teamId] = value;
                        }
                        actions.resolveTiebreak(guesses);
                    },
                }, icon('eye', 18), 'Lock them in and reveal')));
}

// ---- results ----

export function renderResults(ctx) {
    const { actions } = ctx;
    const rows = standings();
    const podium = rows.slice(0, 3);
    const leaders = rows.filter((r) => r.position === 1);

    const podiumOrder = [podium[1], podium[0], podium[2]].filter(Boolean);

    return el('div', { class: 'screen results' },
        el('header', { class: 'screen-head' },
            el('div', { class: 'results-badge' }, icon('trophy', 22), 'Final scores'),
            el('h1', { class: 'results-title' },
                leaders.length > 1
                    ? el('span', {},
                        el('span', { class: 'accent', text: listSentence(leaders.map((l) => l.team.name)) }),
                        ' share the quiz')
                    : leaders.length
                        ? el('span', {}, el('span', { class: 'accent', text: leaders[0].team.name }), ' win the quiz')
                        : 'That is your lot')),

        podium.length
            ? el('div', { class: 'podium' },
                ...podiumOrder.map((row) => el('div', {
                    class: ['podium-slot', `podium-${row.position}`],
                },
                el('div', { class: 'podium-name', text: row.team.name }),
                el('div', {
                    class: 'podium-block',
                    style: { background: `linear-gradient(180deg, ${row.team.colour}, ${row.team.colour}66)` },
                },
                el('span', { class: 'podium-pos', text: ordinal(row.position) }),
                el('span', { class: 'podium-score', text: String(row.total) })))))
            : null,

        rows.length ? fullTable(ctx, rows) : el('p', { class: 'empty', text: 'No teams were playing — hope the questions were good.' }),

        el('div', { class: 'stage-controls wrap' },
            el('button', { class: 'btn btn-ghost', onClick: () => actions.printSheets() }, icon('print', 16), 'Print the results'),
            el('button', { class: 'btn btn-ghost', onClick: () => actions.exportCsv() }, icon('download', 16), 'Download scores'),
            el('button', { class: 'btn btn-ghost', onClick: () => actions.celebrateAgain() }, icon('sparkle', 16), 'Again!'),
            el('button', { class: 'btn btn-primary btn-large', onClick: () => actions.newQuiz() }, icon('home', 18), 'New quiz')));
}

function fullTable(ctx, rows) {
    const rounds = ctx.game.roundIds
        .map((id) => ctx.pack.rounds.find((r) => r.id === id))
        .filter(Boolean);

    const table = el('table', { class: 'results-table' });
    table.appendChild(el('thead', {}, el('tr', {},
        el('th', { text: '' }),
        el('th', { class: 'left', text: 'Team' }),
        ...rounds.map((r) => el('th', { title: r.name },
            el('span', { 'aria-hidden': 'true', text: r.icon }),
            el('span', { class: 'visually-hidden', text: r.name }))),
        el('th', { text: 'Total' }))));

    const body = el('tbody');
    for (const row of rows) {
        body.appendChild(el('tr', { class: row.position === 1 ? 'is-winner' : '' },
            el('td', { class: 'pos', text: ordinal(row.position) }),
            el('td', { class: 'left' },
                el('span', { class: 'team-dot', style: { background: row.team.colour } }),
                row.team.name),
            ...rounds.map((r) => el('td', {
                class: hasJoker(r.id, row.team.id) ? 'is-joker' : '',
                title: hasJoker(r.id, row.team.id) ? 'Joker played — doubled' : '',
                text: `${roundScore(r.id, row.team.id)}${hasJoker(r.id, row.team.id) ? '★' : ''}`,
            })),
            el('td', { class: 'total', text: String(row.total) })));
    }
    table.appendChild(body);

    return el('div', { class: 'table-wrap' }, table);
}

// ---- spoken copy ----

/** The words the host actually says, kept next to the screens they belong to. */
export const script = {
    roundIntro(round, index, total) {
        const parts = [`Round ${numberWord(index + 1)}.`, `${round.name}.`];
        if (round.intro) parts.push(round.intro);
        if (index + 1 === total) parts.push('This is the last round, so no pressure.');
        return parts.join(' ');
    },

    question(question, index) {
        return `Question ${numberWord(index + 1)}. ${question.spokenQuestion || question.question}`;
    },

    timeUp() {
        return 'Time is up. Pens down please.';
    },

    answer(question) {
        const answer = question.spokenAnswer || question.answer;
        const parts = [`The answer is ${answer}.`];
        if (question.acceptable?.length) {
            parts.push(`We would also have accepted ${listSentence(question.acceptable)}.`);
        }
        return parts.join(' ');
    },

    funFact(question) {
        return question.funFact || '';
    },

    standings(rows, roundsRemaining) {
        if (!rows.length) return '';
        const leaders = rows.filter((r) => r.position === 1);
        const parts = [];
        if (leaders.length > 1) {
            parts.push(`It is all square at the top. ${listSentence(leaders.map((l) => l.team.name))} are tied on ${plural(leaders[0].total, 'point')}.`);
        } else {
            parts.push(`In the lead, with ${plural(leaders[0].total, 'point')}, ${leaders[0].team.name}.`);
            const second = rows.find((r) => r.position !== 1);
            if (second) {
                const gap = leaders[0].total - second.total;
                parts.push(`${second.team.name} are ${gap === 1 ? 'a point' : `${gap} points`} behind.`);
            }
        }
        if (roundsRemaining > 0) {
            parts.push(roundsRemaining === 1 ? 'One round to go.' : `${roundsRemaining} rounds still to play.`);
        }
        return parts.join(' ');
    },

    winner(rows) {
        if (!rows.length) return 'That is the end of the quiz. Thank you all for playing.';
        const winners = rows.filter((r) => r.position === 1);
        if (winners.length > 1) {
            return `We have a dead heat. ${listSentence(winners.map((w) => w.team.name))} finish level on ${plural(winners[0].total, 'point')}.`;
        }
        const parts = [
            'Ladies and gentlemen, your winners tonight,',
            `with ${plural(winners[0].total, 'point')},`,
            `${winners[0].team.name}!`,
        ];
        const runnerUp = rows.find((r) => r.position !== 1);
        if (runnerUp) parts.push(`In second place, ${runnerUp.team.name} on ${runnerUp.total}.`);
        parts.push('Thank you all for playing, and mind how you go.');
        return parts.join(' ');
    },

    interval(minutes, roundsDone, roundsTotal) {
        // The break sits wherever the host put it: claim half time only when it
        // really is the middle, and fall back to that wording when the caller
        // cannot say where we are.
        const midpoint = !roundsDone || roundsDone * 2 === roundsTotal;
        const opener = midpoint ? 'That is the half way point.' : `That is the end of round ${roundsDone}.`;
        return `${opener} We will break for ${plural(minutes, 'minute')}. Get yourselves a drink, and no looking anything up.`;
    },

    tiebreak(tb) {
        return `We cannot separate them, so it goes to a tie break. Closest guess wins. ${tb.question}`;
    },

    tiebreakResult(tb, winnerName, guess) {
        return `The answer was ${tb.answer.toLocaleString('en-GB')}${tb.unit ? ` ${tb.unit}` : ''}. `
            + `${winnerName} guessed ${Number(guess).toLocaleString('en-GB')}, and take it.`;
    },
};
