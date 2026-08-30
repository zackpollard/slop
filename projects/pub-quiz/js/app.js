/*
 * app.js — the quizmaster.
 *
 * Owns the three engines (sound, voice, celebration), the running clock, the
 * keyboard, and the state machine that walks a quiz from "welcome to the quiz"
 * all the way to the fanfare. Screens are rendered by screens.js and setup.js;
 * everything they can *do* comes through the `actions` object below.
 *
 * Async flow note: every step that awaits speech or sound takes a copy of
 * `seq`, and bails out if the host has moved on in the meantime. That is what
 * stops a rapid double-click leaving two voices talking over each other.
 */

import { QuizAudio } from './audio.js';
import { QuizSpeech } from './speech.js';
import { Celebrate } from './celebrate.js';
import { ClipPlayer } from './media.js';
import * as State from './state.js';
import { getPack, allPacks } from './packs.js';
import {
    renderSetup, renderSettingsPanel, applySettingsToEngines, applyBigScreen,
    draft, draftTeams,
} from './setup.js';
import {
    renderRoundIntro, renderQuestion, renderMarking, renderLeaderboard,
    renderInterval, renderTiebreak, renderResults, script,
} from './screens.js';
import {
    buildAnswerSheets, buildAnswerKey, buildResultsSheet, printNode,
} from './sheets.js';
import {
    el, icon, mount, $, fmtTime, sleep, plural,
} from './dom.js';

// ---- engines ----

const engines = {
    audio: new QuizAudio(),
    speech: new QuizSpeech(),
    celebrate: new Celebrate(document.getElementById('confetti')),
    clips: new ClipPlayer(),
};

// ---- module state ----

let seq = 0;                    // async generation token
let offeringResume = false;     // a saved quiz is waiting; show setup until the host chooses
let revealing = false;          // a reveal is between its drum roll and its answer
let lastPhaseChangeAt = 0;      // when the screen on the wall went up
let lastScreenKey = '';         // and what it was, so a redraw is not re-announced
let refs = {};                  // live DOM references handed out by the screens
let overlayCloser = null;

const timer = {
    mode: null,                 // 'question' | 'interval'
    total: 0,
    remaining: 0,
    running: false,
    deadline: 0,
    handle: 0,
    onEnd: null,
    tickingArmed: false,
};

// ---- helpers ----

const settings = () => State.getSettings();
const game = () => State.getGame();

function activePack() {
    const g = game();
    return getPack(g.packId) || getPack(draft.packId) || allPacks()[0] || null;
}

function currentRound(pack = activePack()) {
    const g = game();
    if (!pack || !g.roundIds.length) return null;
    return pack.rounds.find((r) => r.id === g.roundIds[g.roundIndex]) || null;
}

function currentQuestion(round = currentRound()) {
    return round ? round.questions[game().questionIndex] || null : null;
}

function buildCtx() {
    const pack = activePack();
    const round = currentRound(pack);
    return {
        game: game(),
        settings: settings(),
        pack,
        round,
        question: currentQuestion(round),
        actions,
        engines,
        refs,
        timer,
        resumable: resumeLabel(),
    };
}

function resumeLabel() {
    if (!State.hasResumableGame()) return '';
    const g = game();
    const pack = getPack(g.packId);
    const round = pack?.rounds.find((r) => r.id === g.roundIds[g.roundIndex]);
    return `${g.packName || 'A quiz'} — round ${g.roundIndex + 1}${round ? ` (${round.name})` : ''}, `
        + `question ${g.questionIndex + 1}.`;
}

/** Speak, ducking the music underneath, and only if the host wants it read. */
async function say(text, { enabled = true, interrupt = true } = {}) {
    if (!text || !enabled || !settings().speechEnabled) return 'skipped';
    engines.audio.duck(true);
    try {
        return await engines.speech.speak(text, { interrupt });
    } finally {
        engines.audio.duck(false);
    }
}

// ---- the clock ----

function startTimer(seconds, { mode = 'question', onEnd = null } = {}) {
    stopTimer();
    timer.mode = mode;
    timer.total = seconds;
    timer.remaining = seconds;
    timer.running = true;
    timer.deadline = performance.now() + seconds * 1000;
    timer.onEnd = onEnd;
    timer.tickingArmed = false;
    timer.handle = setInterval(tick, 100);
    updateTimerUI();
}

function stopTimer() {
    if (timer.handle) clearInterval(timer.handle);
    timer.handle = 0;
    timer.running = false;
    engines.audio.stopTicking();
    timer.tickingArmed = false;
}

function pauseTimer() {
    if (!timer.running) return;
    timer.remaining = Math.max(0, (timer.deadline - performance.now()) / 1000);
    stopTimer();
    updateTimerUI();
}

function resumeTimer() {
    if (timer.running || timer.remaining <= 0 || !timer.mode) return;
    timer.running = true;
    timer.deadline = performance.now() + timer.remaining * 1000;
    timer.handle = setInterval(tick, 100);
    armTicking();
    updateTimerUI();
}

function armTicking() {
    if (timer.mode !== 'question') return;
    if (timer.remaining <= 10.5 && timer.remaining > 0 && !timer.tickingArmed) {
        timer.tickingArmed = true;
        engines.audio.startTicking(Math.ceil(timer.remaining));
    }
}

function tick() {
    timer.remaining = Math.max(0, (timer.deadline - performance.now()) / 1000);
    armTicking();
    updateTimerUI();

    if (timer.remaining <= 0) {
        const done = timer.onEnd;
        stopTimer();
        timer.mode = null;
        if (done) done();
    }
}

function updateTimerUI() {
    if (refs.timerText) refs.timerText.textContent = fmtTime(timer.remaining);
    if (refs.intervalText) refs.intervalText.textContent = fmtTime(timer.remaining);

    if (refs.ring && timer.total > 0) {
        const fraction = Math.max(0, Math.min(1, timer.remaining / timer.total));
        refs.ring.style.strokeDashoffset = String(refs.ringCircumference * (1 - fraction));
    }

    // The clock starts after the screen is drawn, so relabel its controls here
    // rather than leaving them frozen on whatever state they rendered with.
    if (refs.pauseButton) {
        refs.pauseButton.replaceChildren(
            icon(timer.running ? 'pause' : 'play', 16),
            document.createTextNode(timer.running ? 'Pause' : 'Resume'),
        );
    }
    if (refs.timerToggle) {
        refs.timerToggle.replaceChildren(icon(timer.running ? 'pause' : 'play', 16));
    }

    const holder = document.getElementById('timer');
    if (holder) {
        holder.classList.toggle('is-urgent', timer.remaining <= 10 && timer.remaining > 5);
        holder.classList.toggle('is-critical', timer.remaining <= 5);
        holder.classList.toggle('is-paused', !timer.running && timer.remaining > 0);
    }
}

/**
 * The clock is module state, and nothing in the app watches the settings, so a
 * host who reaches for the timer switch mid-question has to be obeyed by hand.
 */
function syncTimerToSettings() {
    // Only the question clock answers to this switch. Half time has its own
    // clock, and stopping that because the host turned question timing off
    // would strand the room staring at a frozen 0:00.
    if (timer.mode === 'interval' || game().phase === 'interval') return;

    const live = game().phase === 'question' && !game().revealed;
    if (!settings().timerEnabled) {
        stopTimer();
        timer.mode = null;      // a null mode is what stops resumeTimer() reviving it
        timer.remaining = 0;
    } else if (live && !timer.running && timer.remaining <= 0) {
        const token = ++seq;
        startTimer(settings().timerSeconds, { mode: 'question', onEnd: () => onTimeUp(token) });
    }
}

function reportClipFailure() {
    if (refs.clipStatus) {
        refs.clipStatus.textContent = 'Clip unavailable — check the connection';
        refs.clipStatus.classList.add('is-error');
    }
    engines.audio.play('error');
}

/** Keep the clip player's bar, label and equaliser in step with playback. */
function syncClipUI({ playing, progress, duration }) {
    if (refs.clipFill) {
        refs.clipFill.style.width = duration > 0 ? `${Math.min(100, (progress / duration) * 100)}%` : '0%';
    }
    if (refs.clipStatus && !refs.clipStatus.classList.contains('is-error')) {
        refs.clipStatus.textContent = playing
            ? `${Math.floor(progress)}s of ${Math.round(duration) || 30}s`
            : 'Ready';
    }
    if (refs.clipBars) refs.clipBars.classList.toggle('is-playing', playing);
    if (refs.clipButton) {
        refs.clipButton.replaceChildren(
            icon(playing ? 'pause' : 'play', 22),
            el('span', { text: playing ? 'Stop the clip' : 'Play the clip' }),
        );
    }
    document.body.classList.toggle('is-clip-playing', playing);
}

// ---- rendering ----

/**
 * A polite live region, kept outside #app because mount() empties that on every
 * redraw. Built here rather than in the markup so it cannot go missing.
 */
function liveRegion() {
    let node = document.getElementById('live');
    if (!node) {
        node = el('div', { id: 'live', class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(node);
    }
    return node;
}

function screenKey(ctx) {
    if (offeringResume) return 'setup';
    const g = ctx.game;
    return [g.phase, g.roundIndex, g.questionIndex, g.revealed].join(':');
}

function screenMessage(ctx) {
    const g = ctx.game;
    if (offeringResume) return '';
    if (g.phase === 'question' && ctx.question) {
        return g.revealed
            ? `The answer is ${ctx.question.answer}.`
            : `Question ${g.questionIndex + 1} of ${ctx.round.questions.length}. ${ctx.question.question}`;
    }
    if (g.phase === 'roundIntro' && ctx.round) {
        return `${ctx.round.name}. Round ${g.roundIndex + 1} of ${g.roundIds.length}.`;
    }
    return '';
}

/**
 * The whole screen is rebuilt for every change, which tells a screen reader
 * nothing and drops focus on the floor. Narrate the new screen and hand it the
 * focus — but only when the screen really changed, so muting the voice halfway
 * through marking does not move the host.
 */
function settleScreen(host, ctx) {
    const key = screenKey(ctx);
    if (key === lastScreenKey) return;
    lastScreenKey = key;

    const message = screenMessage(ctx);
    const live = liveRegion();
    // Clearing first is what makes an identical string announce a second time.
    live.textContent = '';
    if (message) requestAnimationFrame(() => { live.textContent = message; });

    if (overlayCloser) return;
    const heading = host.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    // Nobody can tab to a heading, so the only focus it ever gets is this one —
    // and a gold ring round the question is not what the pub wants on the telly.
    heading.style.outline = 'none';
    heading.focus({ preventScroll: true });
}

function render() {
    refs = {};
    const ctx = buildCtx();
    const host = $('#app');
    if (!host) return;

    lastPhaseChangeAt = performance.now();

    let screen;
    if (offeringResume) {
        mount(host, renderSetup(ctx));
        renderTopbar(ctx);
        document.body.dataset.phase = 'setup';
        settleScreen(host, ctx);
        return;
    }

    switch (ctx.game.phase) {
        case 'roundIntro': screen = ctx.round ? renderRoundIntro(ctx) : renderSetup(ctx); break;
        case 'question': screen = ctx.question ? renderQuestion(ctx) : renderSetup(ctx); break;
        case 'marking': screen = ctx.round ? renderMarking(ctx) : renderSetup(ctx); break;
        case 'leaderboard': screen = ctx.round ? renderLeaderboard(ctx) : renderSetup(ctx); break;
        case 'interval': screen = renderInterval(ctx); break;
        case 'tiebreak': screen = ctx.pack?.tiebreaker ? renderTiebreak(ctx) : renderResults(ctx); break;
        case 'results': screen = renderResults(ctx); break;
        default: screen = renderSetup(ctx);
    }

    mount(host, screen);
    renderTopbar(ctx);
    updateTimerUI();
    document.body.dataset.phase = ctx.game.phase;
    settleScreen(host, ctx);
}

function renderTopbar(ctx) {
    const bar = $('#topbar');
    if (!bar) return;
    const s = ctx.settings;
    const inQuiz = ctx.game.phase !== 'setup' && !offeringResume;

    const position = inQuiz && ctx.round
        ? `${ctx.round.icon} ${ctx.round.name} · ${ctx.game.phase === 'question'
            ? `Q${ctx.game.questionIndex + 1}/${ctx.round.questions.length}`
            : `Round ${ctx.game.roundIndex + 1}/${ctx.game.roundIds.length}`}`
        : '';

    mount(bar,
        el('div', { class: 'topbar-left' },
            el('button', {
                class: 'brand',
                title: inQuiz ? 'Back to the setup screen' : 'The Pub Quiz',
                onClick: () => (inQuiz ? actions.confirmQuit() : window.scrollTo({ top: 0, behavior: 'smooth' })),
            }, el('span', { class: 'brand-mark', text: '?' }), el('span', { class: 'brand-name', text: 'Pub Quiz' })),
            position ? el('span', { class: 'topbar-position', text: position }) : null),

        el('div', { class: 'topbar-right' },
            el('span', { class: 'speaking-dot', id: 'speaking-dot', title: 'The host is speaking' }),
            toolButton(s.speechEnabled ? 'speech' : 'speechOff', s.speechEnabled ? 'Mute the voice (V)' : 'Unmute the voice (V)',
                () => actions.toggleSpeech(), s.speechEnabled),
            toolButton(s.audioEnabled ? 'volume' : 'mute', s.audioEnabled ? 'Mute the sound (M)' : 'Unmute the sound (M)',
                () => actions.toggleAudio(), s.audioEnabled),
            toolButton('settings', 'Settings (S)', () => actions.openSettings()),
            toolButton('expand', 'Full screen (F)', () => actions.toggleFullscreen()),
            toolButton('keyboard', 'Keyboard shortcuts (?)', () => actions.openHelp()),
            inQuiz ? el('button', { class: 'btn btn-ghost btn-small', onClick: () => actions.confirmQuit() }, 'End quiz') : null));
}

function toolButton(iconName, title, onClick, active = true) {
    return el('button', {
        class: ['tool-btn', !active && 'is-off'],
        title,
        'aria-label': title,
        onClick,
    }, icon(iconName, 18));
}

// ---- overlays ----

function openOverlay(title, content, { wide = false } = {}) {
    closeOverlay();
    const root = $('#overlay-root');
    if (!root) return;

    const panel = el('div', { class: ['overlay-panel', wide && 'is-wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('header', { class: 'overlay-head' },
            el('h2', { text: title }),
            el('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => closeOverlay() }, icon('cross', 18))),
        el('div', { class: 'overlay-body' }, content));

    const scrim = el('div', { class: 'overlay-scrim', onClick: () => closeOverlay() });
    panel.addEventListener('keydown', trapTab);

    const opener = document.activeElement;
    const openerLabel = opener instanceof HTMLElement ? opener.getAttribute('aria-label') : null;

    mount(root, scrim, panel);
    root.hidden = false;
    // aria-modal only promises the page behind is gone; inert makes it so for
    // the keyboard and the mouse too.
    setBackgroundInert(true);
    panel.querySelector('button')?.focus();

    overlayCloser = () => {
        root.hidden = true;
        mount(root);
        setBackgroundInert(false);
        overlayCloser = null;
        // A redraw behind the panel may have replaced the button that opened it.
        const back = opener?.isConnected
            ? opener
            : (openerLabel && $(`#topbar [aria-label="${openerLabel}"]`));
        if (back instanceof HTMLElement) back.focus();
    };
}

function setBackgroundInert(on) {
    for (const id of ['topbar', 'app']) {
        const node = document.getElementById(id);
        if (node) node.inert = on;
    }
}

/** Keep Tab inside the dialog: the quiz behind the scrim is not reachable. */
function trapTab(event) {
    if (event.key !== 'Tab') return;
    const panel = event.currentTarget;
    const stops = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled && node.getClientRects().length);
    if (!stops.length) return;

    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
    if (document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
}

function closeOverlay() {
    if (overlayCloser) overlayCloser();
}

// ---- flow ----

async function runQuestion({ speakIt = true } = {}) {
    const token = ++seq;
    stopTimer();
    timer.mode = null;
    timer.remaining = settings().timerEnabled ? settings().timerSeconds : 0;
    timer.total = settings().timerSeconds;

    State.setPhase('question', { revealed: false });
    render();

    const question = currentQuestion();
    if (!question) return;

    // No music bed under a music question — the clip IS the question.
    const isAudioQuestion = Boolean(question.clip || question.melody);

    engines.audio.play('question');
    if (settings().musicEnabled && !isAudioQuestion) engines.audio.startMusic('think');

    if (speakIt) {
        await say(script.question(question, game().questionIndex), { enabled: settings().readQuestions });
        if (token !== seq) return;

        if (settings().repeatQuestion && settings().readQuestions) {
            await sleep(500);
            if (token !== seq) return;
            await say(question.spokenQuestion || question.question, { enabled: true });
            if (token !== seq) return;
        }
    }

    if (question.clip) {
        engines.audio.stopMusic({ fade: 0.3 });
        const outcome = await engines.clips.play(question.clip);
        if (token !== seq) return;
        if (outcome === 'unavailable') reportClipFailure();
    } else if (question.melody) {
        await engines.audio.unlock();
        await engines.audio.playMelody(question.melody);
        if (token !== seq) return;
    }

    if (settings().timerEnabled) {
        startTimer(settings().timerSeconds, { mode: 'question', onEnd: () => onTimeUp(token) });
    }
}

async function onTimeUp(token) {
    if (token !== seq) return;
    engines.audio.play('timeUp');
    if (settings().confetti) engines.celebrate.pulse('#c45e4e');
    await say(script.timeUp(), { enabled: settings().readQuestions });
    if (token !== seq) return;

    if (settings().autoAdvance) {
        await sleep(1200);
        if (token === seq) actions.reveal();
    }
}

async function revealAnswer() {
    const token = ++seq;
    const question = currentQuestion();
    if (!question) return;

    // The drum roll runs for over a second with the reveal button still on
    // screen and `revealed` still false, so hold the door shut ourselves until
    // the state catches up.
    revealing = true;
    try {
        stopTimer();
        timer.mode = null;
        engines.clips.stop();
        engines.audio.stopMusic({ fade: 0.6 });

        if (settings().dramaticReveal) {
            engines.audio.play('drumroll');
            await sleep(1100);
            if (token !== seq) return;
        }

        engines.audio.play('reveal');
        State.setPhase('question', { revealed: true });
        render();
    } finally {
        revealing = false;
    }

    if (settings().confetti) engines.celebrate.sparkle();

    await say(script.answer(question), { enabled: settings().readAnswers });
    if (token !== seq) return;

    if (question.funFact && settings().readFunFacts) {
        await say(question.funFact, { interrupt: false });
        if (token !== seq) return;
    }

    if (settings().autoAdvance) {
        await sleep(settings().autoAdvanceSeconds * 1000);
        if (token === seq) actions.next();
    }
}

async function startRound() {
    const token = ++seq;
    const round = currentRound();
    if (!round) return;

    State.setPhase('roundIntro');
    render();
    engines.audio.play('roundStart');
    if (settings().musicEnabled) engines.audio.startMusic('lobby');

    await say(script.roundIntro(round, game().roundIndex, game().roundIds.length),
        { enabled: settings().readIntros });
    if (token !== seq) return;

    if (settings().autoAdvance) {
        await sleep(1200);
        if (token === seq) actions.beginRound();
    }
}

async function finishRound() {
    const token = ++seq;
    stopTimer();
    engines.audio.stopMusic({ fade: 0.8 });

    if (!game().teams.length) {
        // No teams: skip marking and the leaderboard entirely.
        actions.afterLeaderboard();
        return;
    }

    State.setPhase('marking');
    render();
    engines.audio.play('whoosh');
    await say('That is the end of the round. Swap your sheets with the table next to you.',
        { enabled: settings().readScores });
    if (token !== seq) return;
}

async function showLeaderboard() {
    const token = ++seq;
    State.setPhase('leaderboard');
    render();
    // This round's snapshot is the baseline the NEXT board's movement arrows
    // measure against, so it is only taken once this board has been drawn.
    State.snapshotStandings(game().roundIndex);

    engines.audio.play('leaderboard');
    if (settings().musicEnabled) engines.audio.startMusic('lobby');
    if (settings().confetti) engines.celebrate.burst({ count: 60, origin: { x: 0.5, y: 0.3 } });

    const rows = State.standings(game().roundIndex);
    const remaining = game().roundIds.length - game().roundIndex - 1;
    await say(script.standings(rows, remaining), { enabled: settings().readScores });
    if (token !== seq) return;
}

function intervalTimeUp() {
    engines.audio.play('roundStart');
    say('Right, that is time. Back to your seats please.', { enabled: settings().readScores });
}

/**
 * The break is the one stretch of the night the host walks away from, so its
 * deadline is written into the game as well: a lid closed over half time comes
 * back to the break the room was actually given, not a fresh one.
 */
function armIntervalTimer(seconds) {
    State.updateGame((gm) => { gm.intervalEndsAt = Date.now() + seconds * 1000; });
    startTimer(seconds, { mode: 'interval', onEnd: intervalTimeUp });
}

async function startInterval() {
    const token = ++seq;
    State.setPhase('interval');
    render();
    engines.audio.startMusic('interval');
    armIntervalTimer(settings().intervalMinutes * 60);
    await say(
        script.interval(settings().intervalMinutes, game().roundIndex + 1, game().roundIds.length),
        { enabled: settings().readIntros },
    );
    if (token !== seq) return;
}

async function startTiebreak() {
    const token = ++seq;
    const pack = activePack();
    const tied = State.leaders().map((r) => r.team.id);

    State.updateGame((g) => {
        g.tiebreak = { teamIds: tied, guesses: {}, winnerId: null };
        g.phase = 'tiebreak';
    });
    render();

    engines.audio.play('whoosh');
    engines.audio.startMusic('tension');
    await say(script.tiebreak(pack.tiebreaker), { enabled: settings().readIntros });
    if (token !== seq) return;
}

async function showResults() {
    const token = ++seq;
    stopTimer();
    State.updateGame((g) => {
        g.phase = 'results';
        g.finishedAt = Date.now();
    });
    render();

    engines.audio.stopMusic({ fade: 0.5 });
    engines.audio.play('drumroll');
    await sleep(1300);
    if (token !== seq) return;

    engines.audio.play('fanfare');
    if (settings().confetti) engines.celebrate.cannons();
    await sleep(1400);
    if (token !== seq) return;

    engines.audio.play('applause');
    await say(script.winner(State.standings()), { enabled: settings().readScores });
}

// ---- actions ----

const actions = {
    render,

    async start() {
        const pack = getPack(draft.packId) || allPacks()[0];
        if (!pack) return;
        offeringResume = false;

        await engines.audio.unlock();
        applySettingsToEngines({ engines });

        State.startGame({ pack, roundIds: draft.roundIds, teams: draftTeams() });
        engines.audio.play('whoosh');

        const token = ++seq;
        State.setPhase('roundIntro');
        render();
        if (settings().musicEnabled) engines.audio.startMusic('lobby');

        await say(
            `Good evening, and welcome to ${pack.name}. `
            + `${plural(game().roundIds.length, 'round')}, `
            + `${plural(game().roundIds.reduce((n, id) => n + (pack.rounds.find((r) => r.id === id)?.questions.length || 0), 0), 'question')}, `
            + 'and no phones. Let us begin.',
            { enabled: settings().readIntros },
        );
        if (token !== seq) return;
        await startRound();
    },

    async resume() {
        offeringResume = false;
        await engines.audio.unlock();
        applySettingsToEngines({ engines });
        const g = game();

        if (g.phase === 'question' && !g.revealed) {
            runQuestion({ speakIt: false });
            return;
        }

        render();
        if (g.phase === 'interval') {
            const left = g.intervalEndsAt
                ? Math.max(0, (g.intervalEndsAt - Date.now()) / 1000)
                : settings().intervalMinutes * 60;
            if (settings().musicEnabled) engines.audio.startMusic('interval');
            // A break that ran out while the tab was shut stays at 0:00, and the
            // host adds a minute if the room is still at the bar.
            if (left > 0.5) armIntervalTimer(left);
        }
    },

    discardResume() {
        offeringResume = false;
        State.resetGame();
        render();
    },

    beginRound() {
        State.updateGame((gm) => { gm.questionIndex = 0; gm.revealed = false; });
        // Warm the round's clips so a question does not open on a buffering bar.
        const round = currentRound();
        if (round) engines.clips.preload(round.questions.map((q) => q.clip).filter(Boolean));
        runQuestion();
    },

    reveal() {
        if (revealing || game().revealed) return;
        revealAnswer();
    },

    next() {
        const round = currentRound();
        if (!round) return;
        const g = game();

        if (!g.revealed) { actions.reveal(); return; }

        if (g.questionIndex >= round.questions.length - 1) {
            finishRound();
            return;
        }
        State.updateGame((gm) => { gm.questionIndex += 1; gm.revealed = false; });
        runQuestion();
    },

    previous() {
        const g = game();
        if (g.revealed) {
            seq += 1;
            const token = seq;
            engines.speech.cancel();
            engines.clips.stop();
            State.setPhase('question', { revealed: false });
            if (settings().timerEnabled) {
                // The reveal retired the clock and its onEnd belongs to a
                // generation this step has just invalidated. Put both back,
                // paused, or the ring returns under a Resume button that does
                // nothing and a clock that would expire in silence.
                timer.mode = 'question';
                timer.total = settings().timerSeconds;
                if (timer.remaining <= 0) timer.remaining = settings().timerSeconds;
                timer.onEnd = () => onTimeUp(token);
            }
            render();
            return;
        }
        if (g.questionIndex === 0) return;
        seq += 1;
        engines.speech.cancel();
        engines.clips.stop();
        State.updateGame((gm) => { gm.questionIndex -= 1; gm.revealed = true; });
        stopTimer();
        // The previous question is shown revealed, which draws no ring: leave no
        // clock behind that P could start with nothing on screen to explain it.
        timer.mode = null;
        timer.remaining = 0;
        render();
    },

    repeatSpeech() {
        const g = game();
        const round = currentRound();
        if (g.phase === 'roundIntro' && round) {
            say(script.roundIntro(round, g.roundIndex, g.roundIds.length));
            return;
        }
        const question = currentQuestion(round);
        if (!question) return;
        say(g.revealed ? script.answer(question) : (question.spokenQuestion || question.question));
    },

    toggleTimer() {
        if (timer.running) {
            pauseTimer();
            engines.audio.play('click');
        } else if (timer.remaining > 0 && timer.mode && !game().revealed) {
            resumeTimer();
            engines.audio.play('click');
        } else if (settings().timerEnabled && game().phase === 'question' && !game().revealed) {
            // Either the clock ran out, or it has not been armed yet because the
            // host is still being read the question. Both cases start a fresh
            // generation — which abandons whatever runQuestion was still going
            // to do — so cut the preamble off cleanly rather than leaving the
            // voice talking over a clock that has already started.
            const token = ++seq;
            engines.speech.cancel();
            engines.clips.stop();
            engines.audio.stopMelody();
            startTimer(settings().timerSeconds, { mode: 'question', onEnd: () => onTimeUp(token) });
        }
        render();
    },

    /** Play (or stop) the clip on an audio question, holding the clock meanwhile. */
    async playClip() {
        const question = currentQuestion();
        if (!question?.clip) return;

        if (engines.clips.playing) {
            engines.clips.stop();
            return;
        }

        // Only hold the clock if it is actually running: on the automatic first
        // play it has not started yet, and resuming afterwards would set it off
        // while the host is still talking.
        const wasRunning = timer.running;
        if (wasRunning) pauseTimer();

        engines.audio.stopMusic({ fade: 0.3 });
        const outcome = await engines.clips.play(question.clip);
        if (outcome === 'unavailable') reportClipFailure();

        if (wasRunning) resumeTimer();
    },

    /** Used by the melody player so the clock does not run while a tune plays. */
    pauseTimer(shouldPause) {
        if (shouldPause) pauseTimer();
        else resumeTimer();
    },

    backToQuestions() {
        State.updateGame((gm) => {
            gm.questionIndex = Math.max(0, (currentRound()?.questions.length || 1) - 1);
            gm.revealed = true;
        });
        State.setPhase('question');
        render();
    },

    confirmMarks() {
        engines.audio.play('points');
        showLeaderboard();
    },

    backToMarking() {
        State.updateGame((gm) => {
            if (gm.history.length && gm.history[gm.history.length - 1].roundId === gm.roundIds[gm.roundIndex]) {
                gm.history.pop();
            }
            gm.phase = 'marking';
        });
        render();
    },

    afterLeaderboard() {
        const g = game();
        const isLast = g.roundIndex >= g.roundIds.length - 1;

        if (isLast) {
            const pack = activePack();
            if (State.isTied() && pack?.tiebreaker && g.teams.length > 1) startTiebreak();
            else showResults();
            return;
        }

        const justFinished = g.roundIndex + 1;
        if (settings().intervalAfterRound === justFinished && g.askedIntervalAfter !== justFinished) {
            State.updateGame((gm) => { gm.askedIntervalAfter = justFinished; });
            startInterval();
            return;
        }

        State.updateGame((gm) => {
            gm.roundIndex += 1;
            gm.questionIndex = 0;
            gm.revealed = false;
        });
        startRound();
    },

    addIntervalTime(seconds) {
        // tick() drops the mode when the break runs out, and a quiz resumed into
        // half time never had one: there is not always a clock left to nudge.
        const left = timer.mode === 'interval' ? timer.remaining : 0;
        armIntervalTimer(left + seconds);
        engines.audio.play('click');
    },

    endInterval() {
        stopTimer();
        timer.mode = null;
        State.updateGame((gm) => {
            gm.roundIndex += 1;
            gm.questionIndex = 0;
            gm.revealed = false;
            gm.intervalEndsAt = null;
        });
        startRound();
    },

    async resolveTiebreak(guesses) {
        const token = ++seq;
        const pack = activePack();
        const tb = pack.tiebreaker;

        let winnerId = null;
        let best = Infinity;
        for (const [teamId, guess] of Object.entries(guesses)) {
            const distance = Math.abs(Number(guess) - tb.answer);
            if (distance < best) { best = distance; winnerId = teamId; }
        }
        if (!winnerId) {
            // No usable guess came in. Make a noise about it rather than sitting
            // there doing nothing at the most public moment of the night.
            engines.audio.play('error');
            return;
        }

        State.updateGame((gm) => {
            gm.tiebreak = { ...gm.tiebreak, guesses, winnerId };
        });

        engines.audio.play('drumroll');
        await sleep(1100);
        if (token !== seq) return;

        engines.audio.play('reveal');
        render();

        const winner = game().teams.find((t) => t.id === winnerId);
        await say(script.tiebreakResult(tb, winner?.name || 'nobody', guesses[winnerId]),
            { enabled: settings().readScores });
    },

    showResults() {
        // The tie-break winner takes the trophy: give them a single decisive point.
        const g = game();
        // Awarded outside the rounds: as a round bonus it would be doubled by a
        // joker played on the final round, which is not what winning a
        // tie-break is worth.
        if (g.tiebreak?.winnerId) State.awardTiebreakPoint(g.tiebreak.winnerId);
        showResults();
    },

    celebrateAgain() {
        const token = seq;
        engines.audio.play('fanfare');
        if (settings().confetti) engines.celebrate.cannons();
        setTimeout(() => { if (token === seq) engines.audio.play('applause'); }, 900);
    },

    exportCsv() {
        const pack = activePack();
        if (!pack) return;
        const csv = State.scoresAsCsv(pack);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: `${pack.id}-scores.csv` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    printSheets() {
        const pack = activePack();
        if (!pack) return;
        const g = game();
        const inProgress = g.phase !== 'setup' && g.roundIds.length;
        const roundIds = inProgress ? g.roundIds : draft.roundIds;
        const teams = inProgress ? g.teams : draftTeams();

        const choose = el('div', { class: 'print-choices' },
            el('p', { text: 'What would you like on paper?' }),
            el('div', { class: 'row wrap' },
                el('button', {
                    class: 'btn btn-primary',
                    onClick: () => { closeOverlay(); printNode(buildAnswerSheets(pack, roundIds, teams)); },
                }, icon('print', 16), 'Team answer sheets'),
                el('button', {
                    class: 'btn btn-ghost',
                    onClick: () => { closeOverlay(); printNode(buildAnswerKey(pack, roundIds)); },
                }, icon('print', 16), "Host's answer key"),
                g.phase === 'results'
                    ? el('button', {
                        class: 'btn btn-ghost',
                        onClick: () => { closeOverlay(); printNode(buildResultsSheet(pack, g)); },
                    }, icon('print', 16), 'Final scores')
                    : null));

        openOverlay('Print', choose);
    },

    newQuiz() {
        offeringResume = false;
        seq += 1;
        engines.speech.cancel();
        engines.clips.stop();
        engines.audio.stopMusic({ fade: 0.4 });
        engines.celebrate.stop();
        stopTimer();
        State.resetGame();
        render();
        window.scrollTo({ top: 0 });
    },

    confirmQuit() {
        if (game().phase === 'setup') return;
        if (!confirm('End this quiz and go back to the setup screen? The scores will be lost.')) return;
        actions.newQuiz();
    },

    toggleSpeech() {
        const on = !settings().speechEnabled;
        State.updateSettings({ speechEnabled: on });
        engines.speech.setEnabled(on);
        if (!on) engines.speech.cancel();
        render();
    },

    toggleAudio() {
        const on = !settings().audioEnabled;
        State.updateSettings({ audioEnabled: on });
        engines.audio.setMuted(!on);
        render();
    },

    openSettings() {
        const ctx = buildCtx();
        openOverlay('Settings', renderSettingsPanel(ctx, rerenderSettings), { wide: true });
    },

    openHelp() {
        openOverlay('Keyboard shortcuts', helpContent());
    },

    async toggleFullscreen() {
        try {
            if (document.fullscreenElement) await document.exitFullscreen();
            else await document.documentElement.requestFullscreen();
        } catch { /* the browser said no; nothing we can do */ }
    },
};

/**
 * Settings that redraw rebuild the whole panel, so hold the host's place in it,
 * and reconcile the screen behind — nothing else is listening for the change.
 */
function rerenderSettings() {
    const controls = 'input, select, button, textarea';
    const body = $('#overlay-root .overlay-body');
    const scroll = body ? body.scrollTop : 0;
    const index = body ? [...body.querySelectorAll(controls)].indexOf(document.activeElement) : -1;

    syncTimerToSettings();
    render();
    actions.openSettings();

    const next = $('#overlay-root .overlay-body');
    if (!next) return;
    next.scrollTop = scroll;
    if (index >= 0) [...next.querySelectorAll(controls)][index]?.focus();
}

function helpContent() {
    const rows = [
        ['Space or →', 'Do the obvious thing: begin, reveal, next'],
        ['←', 'Go back a question'],
        ['R', 'Read the question again'],
        ['P', 'Pause or resume the timer'],
        ['V', 'Mute or unmute the host voice'],
        ['M', 'Mute or unmute the sound'],
        ['F', 'Full screen'],
        ['S', 'Settings'],
        ['Esc', 'Stop the voice talking, or close this'],
        ['?', 'This list'],
    ];

    return el('div', { class: 'shortcuts' },
        el('table', {}, el('tbody', {},
            ...rows.map(([key, what]) => el('tr', {},
                el('td', {}, el('kbd', { text: key })),
                el('td', { text: what }))))),
        el('p', { class: 'hint' },
            'Tip: put this on the big screen with F, and keep a laptop or phone in front of you for the marking.'));
}

// ---- keyboard ----

function onKeydown(event) {
    const target = event.target;
    const typing = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
            || target.isContentEditable);

    if (event.key === 'Escape') {
        if (overlayCloser) closeOverlay();
        else engines.speech.cancel();
        return;
    }
    // Nothing below wants repeating, and a leaned-on Space walks the quiz
    // through several screens at the operating system's key-repeat rate.
    if (event.repeat) return;
    // An open dialog owns the keyboard: no shortcut fires through the scrim.
    if (overlayCloser || typing || event.metaKey || event.ctrlKey || event.altKey) return;

    // Behind the resume banner the saved game still says 'question', but the
    // host is looking at the setup page: obey the screen, not the state.
    const phase = offeringResume ? 'setup' : game().phase;
    const key = event.key.toLowerCase();

    if (key === ' ' || event.key === 'ArrowRight' || event.key === 'Enter') {
        if (phase === 'setup') return;
        // Space and Enter are how the browser presses whatever the host has
        // focused — a mark cell, the answer key, a topbar tool. Only ArrowRight
        // unambiguously means "get on with it".
        if (event.key !== 'ArrowRight' && target instanceof HTMLElement
            && target.closest('button, a[href], summary, [role="button"]')) return;
        event.preventDefault();
        // A press this soon after a new screen is a double-tap, not a decision,
        // and half time is a one-way door: it is offered exactly once.
        if (performance.now() - lastPhaseChangeAt < 350) return;
        primaryAction();
        return;
    }

    switch (key) {
        case 'arrowleft':
            if (phase === 'question') { event.preventDefault(); actions.previous(); }
            break;
        case 'r': if (phase === 'question' || phase === 'roundIntro') actions.repeatSpeech(); break;
        case 'p': if (phase === 'question') actions.toggleTimer(); break;
        case 'v': actions.toggleSpeech(); break;
        case 'm': actions.toggleAudio(); break;
        case 'f': actions.toggleFullscreen(); break;
        case 's': actions.openSettings(); break;
        case '?': actions.openHelp(); break;
        default: break;
    }
}

function primaryAction() {
    switch (game().phase) {
        case 'roundIntro': actions.beginRound(); break;
        case 'question': actions.next(); break;
        case 'marking': actions.confirmMarks(); break;
        case 'leaderboard': actions.afterLeaderboard(); break;
        case 'interval': actions.endInterval(); break;
        default: break;
    }
}

// ---- boot ----

async function boot() {
    applyBigScreen();

    // A saved quiz does not barge straight back onto the screen: the host gets
    // the setup page with a resume banner, so they can check the sound first.
    offeringResume = State.hasResumableGame();

    // A saved game may have been written against an older version of its pack.
    if (offeringResume) State.reconcileMarks(activePack());

    // If they do resume onto a live question, give the clock a sensible face so
    // the host can just press play rather than staring at a dead 0:00.
    const resumed = game();
    if (resumed.phase === 'question' && !resumed.revealed && settings().timerEnabled) {
        timer.total = settings().timerSeconds;
        timer.remaining = settings().timerSeconds;
        timer.mode = 'question';
    }

    engines.clips.onChange(syncClipUI);

    engines.speech.onChange(({ speaking }) => {
        document.body.classList.toggle('is-speaking', Boolean(speaking));
    });

    render();

    // Wire the host's controls FIRST. Voice discovery is the one part of this
    // app that talks to a famously flaky browser API, and nothing about the
    // keyboard, the mouse or the sound should wait on it.
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', () => engines.celebrate.resize());
    window.addEventListener('beforeprint', () => engines.celebrate.stop());

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && timer.running && game().phase === 'question') pauseTimer();
    });

    // First gesture anywhere unlocks the audio context.
    const unlock = () => {
        engines.audio.unlock();
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    applySettingsToEngines({ engines });

    // Now go and find the voices, with our own belt-and-braces timeout on top
    // of the engine's, so a browser that never answers cannot hold up the app.
    await Promise.race([engines.speech.init(), sleep(4000)]);
    applySettingsToEngines({ engines });
    if (settings().speechVoiceId) engines.speech.setVoice(settings().speechVoiceId);

    // The voice list arrives late in some browsers; redraw the picker once it does.
    if (game().phase === 'setup' || offeringResume) render();
}

boot();

// Handy for debugging a live quiz from the console.
window.pubQuiz = { engines, actions, State, buildCtx };
