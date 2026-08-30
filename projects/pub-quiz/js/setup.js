/*
 * setup.js — the pre-quiz screen: choose a pack, pick rounds, name the teams,
 * set the host voice and the sound, and check it all works before anyone
 * is watching. Also exports the settings panel, which is reused as an
 * overlay mid-quiz.
 */

import {
    el, icon, clamp, plural, storage,
} from './dom.js';
import {
    allPacks, getPack, packStats, estimateMinutes, saveCustomPack, deleteCustomPack,
    isCustomPack, exportPack,
} from './packs.js';
import {
    getSettings, updateSettings, resetSettings, TEAM_COLOURS,
} from './state.js';

const DRAFT_KEY = 'pubquiz.draft.v2';

/** The setup screen's own working state, kept across re-renders and reloads. */
export const draft = {
    packId: '',
    roundIds: [],
    teams: [],
    ...(storage.get(DRAFT_KEY, {}) || {}),
};

function saveDraft() {
    storage.set(DRAFT_KEY, { packId: draft.packId, roundIds: draft.roundIds, teams: draft.teams });
}

function ensureDraft() {
    const packs = allPacks();
    if (!packs.length) return null;

    let pack = getPack(draft.packId);
    if (!pack) {
        pack = packs[0];
        draft.packId = pack.id;
        draft.roundIds = pack.rounds.map((r) => r.id);
    }

    const valid = new Set(pack.rounds.map((r) => r.id));
    draft.roundIds = draft.roundIds.filter((id) => valid.has(id));
    if (!draft.roundIds.length) draft.roundIds = pack.rounds.map((r) => r.id);

    if (!Array.isArray(draft.teams)) draft.teams = [];
    saveDraft();
    return pack;
}

// ---- the screen ----

export function renderSetup(ctx) {
    const pack = ensureDraft();
    const { actions } = ctx;

    if (!pack) {
        return el('div', { class: 'screen setup' },
            el('p', { class: 'empty', text: 'No quiz packs found. Import one to get started.' }),
            packImportControls(ctx));
    }

    const rerender = () => actions.render();

    return el('div', { class: 'screen setup' },
        heroHeader(pack),
        ctx.resumable ? resumeBanner(ctx) : null,

        section('1', 'Choose your quiz', icon('sparkle'),
            packPicker(ctx, pack, rerender),
            packImportControls(ctx)),

        section('2', 'Pick your rounds', icon('music'),
            roundPicker(pack, rerender)),

        section('3', 'Name your teams', icon('users'),
            teamEditor(rerender)),

        section('4', 'Voice, sound and timing', icon('settings'),
            renderSettingsPanel(ctx, rerender)),

        startBar(ctx, pack),
    );
}

function heroHeader(pack) {
    return el('div', { class: 'hero' },
        el('div', { class: 'hero-badge', text: 'Quiz Night' }),
        el('h1', { class: 'hero-title' },
            el('span', { text: 'The ' }),
            el('span', { class: 'accent', text: 'Pub Quiz' })),
        el('p', {
            class: 'hero-sub',
            text: 'A full quiz night in a browser tab — read aloud, timed, scored and celebrated. '
                + 'Plug it into the telly, turn the speakers up, and host.',
        }),
        el('p', { class: 'hero-pack', html: `Loaded: <strong>${pack.name}</strong>` }));
}

function resumeBanner(ctx) {
    return el('div', { class: 'banner resume-banner' },
        el('div', {},
            el('strong', { text: 'You have a quiz in progress.' }),
            el('span', { text: ` ${ctx.resumable}` })),
        el('div', { class: 'row' },
            el('button', { class: 'btn btn-primary', onClick: () => ctx.actions.resume() }, 'Resume quiz'),
            el('button', { class: 'btn btn-ghost', onClick: () => ctx.actions.discardResume() }, 'Discard')));
}

function section(number, title, iconNode, ...children) {
    return el('section', { class: 'card setup-step' },
        el('header', { class: 'step-head' },
            el('span', { class: 'step-number', text: number }),
            el('h2', { text: title }),
            el('span', { class: 'step-icon' }, iconNode)),
        el('div', { class: 'step-body' }, ...children));
}

// ---- pack picking ----

function packPicker(ctx, current, rerender) {
    const grid = el('div', { class: 'pack-grid' });

    for (const pack of allPacks()) {
        const stats = packStats(pack);
        const selected = pack.id === current.id;
        grid.appendChild(el('button', {
            class: ['pack-card', selected && 'is-selected'],
            'aria-pressed': String(selected),
            onClick: () => {
                draft.packId = pack.id;
                draft.roundIds = pack.rounds.map((r) => r.id);
                saveDraft();
                ctx.engines.audio.play('select');
                rerender();
            },
        },
        el('div', { class: 'pack-card-top' },
            el('h3', { text: pack.name }),
            isCustomPack(pack.id) ? el('span', { class: 'chip chip-small', text: 'yours' }) : null),
        pack.description ? el('p', { class: 'pack-desc', text: pack.description }) : null,
        el('div', { class: 'pack-stats' },
            el('span', { text: plural(stats.rounds, 'round') }),
            el('span', { text: plural(stats.questions, 'question') }),
            stats.withSources === stats.questions
                ? el('span', { class: 'verified', text: '✓ all sourced' })
                : el('span', { text: `${stats.withSources}/${stats.questions} sourced` }),
            stats.hasTiebreaker ? el('span', { text: 'tie-breaker' }) : null),
        el('div', { class: 'pack-meta' },
            pack.author ? el('span', { text: pack.author }) : null,
            pack.createdOn ? el('span', { text: pack.createdOn }) : null)));
    }

    return grid;
}

function packImportControls(ctx) {
    const status = el('p', { class: 'import-status' });

    const fileInput = el('input', {
        type: 'file',
        accept: '.json,application/json',
        class: 'visually-hidden',
        onChange: async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const result = saveCustomPack(JSON.parse(await file.text()));
                showResult(result);
            } catch (err) {
                status.className = 'import-status is-error';
                status.textContent = `Could not read that file: ${err.message}`;
            }
            e.target.value = '';
        },
    });

    function showResult(result) {
        if (result.ok) {
            draft.packId = result.pack.id;
            draft.roundIds = result.pack.rounds.map((r) => r.id);
            saveDraft();
            ctx.engines.audio.play('correct');
            ctx.actions.render();
        } else {
            status.className = 'import-status is-error';
            status.textContent = `That pack has problems: ${result.errors.slice(0, 3).join(' ')}`;
            ctx.engines.audio.play('error');
        }
    }

    const paste = el('textarea', {
        class: 'json-paste',
        rows: '3',
        placeholder: '…or paste quiz pack JSON here and press Import',
    });

    const currentPack = getPack(draft.packId);

    return el('div', { class: 'pack-tools' },
        el('div', { class: 'row wrap' },
            el('button', { class: 'btn btn-ghost', onClick: () => fileInput.click() },
                icon('upload'), 'Import a pack'),
            el('button', {
                class: 'btn btn-ghost',
                onClick: () => {
                    const pack = getPack(draft.packId);
                    if (!pack) return;
                    downloadText(`${pack.id}.json`, exportPack(pack));
                },
            }, icon('download'), 'Export this pack'),
            currentPack && isCustomPack(currentPack.id)
                ? el('button', {
                    class: 'btn btn-ghost btn-danger',
                    onClick: () => {
                        if (!confirm(`Delete "${currentPack.name}"? This only removes your imported copy.`)) return;
                        deleteCustomPack(currentPack.id);
                        draft.packId = '';
                        saveDraft();
                        ctx.actions.render();
                    },
                }, icon('trash'), 'Delete')
                : null,
            fileInput),
        el('details', { class: 'paste-details' },
            el('summary', { text: 'Paste JSON instead' }),
            paste,
            el('button', {
                class: 'btn btn-ghost',
                onClick: () => {
                    try {
                        showResult(saveCustomPack(JSON.parse(paste.value)));
                    } catch (err) {
                        status.className = 'import-status is-error';
                        status.textContent = `That is not valid JSON: ${err.message}`;
                    }
                },
            }, 'Import pasted JSON')),
        status,
        el('p', { class: 'hint' },
            'Write your own quiz by exporting this one, editing the JSON, and importing it back. ',
            el('span', { text: 'The format is documented in quizzes/SCHEMA.md.' })));
}

function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- rounds ----

function roundPicker(pack, rerender) {
    const list = el('div', { class: 'round-list' });

    const ordered = [
        ...draft.roundIds.map((id) => pack.rounds.find((r) => r.id === id)).filter(Boolean),
        ...pack.rounds.filter((r) => !draft.roundIds.includes(r.id)),
    ];

    ordered.forEach((round, index) => {
        const on = draft.roundIds.includes(round.id);
        list.appendChild(el('div', { class: ['round-row', on && 'is-on'] },
            el('label', { class: 'round-main' },
                el('input', {
                    type: 'checkbox',
                    checked: on,
                    onChange: (e) => {
                        if (e.target.checked) {
                            if (!draft.roundIds.includes(round.id)) draft.roundIds.splice(index, 0, round.id);
                        } else {
                            draft.roundIds = draft.roundIds.filter((id) => id !== round.id);
                        }
                        saveDraft();
                        rerender();
                    },
                }),
                el('span', { class: 'round-icon', text: round.icon }),
                el('span', { class: 'round-name', text: round.name }),
                el('span', { class: 'round-count', text: plural(round.questions.length, 'question') })),
            el('div', { class: 'round-move' },
                el('button', {
                    class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${round.name} up`,
                    disabled: !on || draft.roundIds.indexOf(round.id) <= 0,
                    onClick: () => { moveRound(round.id, -1); rerender(); },
                }, '↑'),
                el('button', {
                    class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${round.name} down`,
                    disabled: !on || draft.roundIds.indexOf(round.id) >= draft.roundIds.length - 1,
                    onClick: () => { moveRound(round.id, 1); rerender(); },
                }, '↓'))));
    });

    return list;
}

function moveRound(id, delta) {
    const from = draft.roundIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= draft.roundIds.length) return;
    draft.roundIds.splice(to, 0, draft.roundIds.splice(from, 1)[0]);
    saveDraft();
}

// ---- teams ----

function teamEditor(rerender) {
    const wrap = el('div', { class: 'team-editor' });
    const list = el('div', { class: 'team-list' });

    draft.teams.forEach((team, index) => {
        list.appendChild(el('div', { class: 'team-row' },
            el('button', {
                class: 'team-swatch',
                style: { background: team.colour },
                title: 'Change colour',
                'aria-label': `Change colour for ${team.name || 'this team'}`,
                onClick: () => {
                    const at = TEAM_COLOURS.indexOf(team.colour);
                    team.colour = TEAM_COLOURS[(at + 1) % TEAM_COLOURS.length];
                    saveDraft();
                    rerender();
                },
            }),
            el('input', {
                class: 'input team-name',
                value: team.name,
                maxlength: '30',
                placeholder: `Team ${index + 1}`,
                onInput: (e) => { team.name = e.target.value; saveDraft(); },
                onKeydown: (e) => {
                    if (e.key === 'Enter') { addTeam(); rerender(); }
                },
            }),
            el('button', {
                class: 'icon-btn', title: 'Remove team', 'aria-label': `Remove ${team.name || 'team'}`,
                onClick: () => { draft.teams.splice(index, 1); saveDraft(); rerender(); },
            }, icon('trash', 16))));
    });

    function addTeam(name) {
        draft.teams.push({
            id: `team-${Date.now()}-${draft.teams.length}`,
            name: name || suggestTeamName(draft.teams.length),
            colour: TEAM_COLOURS[draft.teams.length % TEAM_COLOURS.length],
        });
        saveDraft();
    }

    wrap.appendChild(list);
    wrap.appendChild(el('div', { class: 'row wrap' },
        el('button', {
            class: 'btn btn-ghost',
            onClick: () => { addTeam(); rerender(); },
        }, icon('plus', 16), 'Add a team'),
        el('button', {
            class: 'btn btn-ghost',
            onClick: () => { for (let i = 0; i < 4; i++) addTeam(); rerender(); },
        }, 'Add four'),
        draft.teams.length
            ? el('button', {
                class: 'btn btn-ghost',
                onClick: () => { draft.teams = []; saveDraft(); rerender(); },
            }, 'Clear')
            : null));

    wrap.appendChild(el('p', { class: 'hint' },
        draft.teams.length
            ? `${plural(draft.teams.length, 'team')} — you will mark their answers on screen after each round.`
            : 'No teams? That is fine — the quiz will run as a presentation and you can score on paper.'));

    return wrap;
}

const TEAM_NAME_IDEAS = [
    'The Quizzly Bears', 'Universally Challenged', 'Agatha Quiztie', 'Les Quizerables',
    'Quizzee Rascal', 'Tequila Mockingbird', 'The Wright Answers', 'Sofa King Good',
    'E=MC Hammer', 'Norfolk and Chance', 'Beer Pressure', 'The Scunthorpe Problem',
];

function suggestTeamName(index) {
    return TEAM_NAME_IDEAS[index % TEAM_NAME_IDEAS.length];
}

// ---- settings panel (also used mid-quiz) ----

export function renderSettingsPanel(ctx, rerender = () => {}) {
    const s = getSettings();
    const { engines } = ctx;

    const set = (patch, redraw = false) => {
        updateSettings(patch);
        applySettingsToEngines(ctx);
        if (redraw) rerender();
    };

    return el('div', { class: 'settings-panel' },

        group('The host voice', [
            toggle('Speak everything aloud', s.speechEnabled, (v) => set({ speechEnabled: v }, true),
                engines.speech.supported ? '' : 'Your browser has no speech synthesis — this will stay silent.'),
            voiceSelect(ctx, set),
            slider('Speed', s.speechRate, 0.6, 1.6, 0.05, (v) => set({ speechRate: v }), (v) => `${v.toFixed(2)}×`),
            slider('Pitch', s.speechPitch, 0.5, 1.5, 0.05, (v) => set({ speechPitch: v }), (v) => v.toFixed(2)),
            el('div', { class: 'row wrap' },
                el('button', {
                    class: 'btn btn-ghost',
                    onClick: async () => {
                        await engines.audio.unlock();
                        engines.speech.cancel();
                        engines.speech.speak(
                            'Good evening, and welcome to the quiz. Fingers on buzzers, phones in pockets. '
                            + 'Here is your first question.',
                            { interrupt: true },
                        );
                    },
                }, icon('speech', 16), 'Test the voice'),
                el('div', { class: 'checkline' },
                    check('Round intros', s.readIntros, (v) => set({ readIntros: v })),
                    check('Questions', s.readQuestions, (v) => set({ readQuestions: v })),
                    check('Read twice', s.repeatQuestion, (v) => set({ repeatQuestion: v })),
                    check('Answers', s.readAnswers, (v) => set({ readAnswers: v })),
                    check('Fun facts', s.readFunFacts, (v) => set({ readFunFacts: v })),
                    check('Scores', s.readScores, (v) => set({ readScores: v })))),
        ]),

        group('Sound', [
            toggle('Sound effects and music', s.audioEnabled, (v) => set({ audioEnabled: v }, true)),
            slider('Master volume', s.masterVolume, 0, 1, 0.05, (v) => set({ masterVolume: v }), pct),
            slider('Effects', s.sfxVolume, 0, 1, 0.05, (v) => set({ sfxVolume: v }), pct),
            slider('Music bed', s.musicVolume, 0, 1, 0.05, (v) => set({ musicVolume: v }), pct),
            toggle('Play music under the questions', s.musicEnabled, (v) => set({ musicEnabled: v })),
            el('div', { class: 'row wrap sound-test' },
                soundTest(ctx, 'roundStart', 'Round sting'),
                soundTest(ctx, 'correct', 'Correct'),
                soundTest(ctx, 'timeUp', 'Time up'),
                soundTest(ctx, 'drumroll', 'Drum roll'),
                soundTest(ctx, 'fanfare', 'Fanfare'),
                soundTest(ctx, 'applause', 'Applause'),
                el('button', {
                    class: 'btn btn-ghost btn-small',
                    onClick: async () => {
                        await engines.audio.unlock();
                        engines.audio.playMelody('odeToJoy');
                    },
                }, icon('music', 14), 'A tune')),
        ]),

        group('Timing', [
            toggle('Countdown timer on each question', s.timerEnabled, (v) => set({ timerEnabled: v }, true)),
            slider('Seconds to answer', s.timerSeconds, 5, 120, 5, (v) => set({ timerSeconds: v }), (v) => `${v}s`),
            toggle('Drum roll before every answer', s.dramaticReveal, (v) => set({ dramaticReveal: v })),
            toggle('Run the quiz hands-free', s.autoAdvance, (v) => set({ autoAdvance: v }, true),
                'Reveals the answer and moves on by itself. Great for a big screen, nerve-racking for a host.'),
            s.autoAdvance
                ? slider('Pause on each answer', s.autoAdvanceSeconds, 3, 30, 1,
                    (v) => set({ autoAdvanceSeconds: v }), (v) => `${v}s`)
                : null,
            numberField('Half-time break after round', s.intervalAfterRound, 0, 12,
                (v) => set({ intervalAfterRound: v }, true), '0 for no break'),
            s.intervalAfterRound
                ? numberField('Break length in minutes', s.intervalMinutes, 1, 60, (v) => set({ intervalMinutes: v }))
                : null,
        ]),

        group('The big screen', [
            toggle('Extra-large type', s.bigScreen, (v) => { set({ bigScreen: v }); applyBigScreen(); }),
            toggle('Show the topic on each question', s.showTopic, (v) => set({ showTopic: v })),
            toggle('Show how hard each question is', s.showDifficulty, (v) => set({ showDifficulty: v })),
            toggle('Confetti on the big moments', s.confetti, (v) => set({ confetti: v })),
            numberField('Points per correct answer', s.pointsPerCorrect, 1, 10, (v) => set({ pointsPerCorrect: v })),
            toggle('Jokers', s.jokersEnabled, (v) => set({ jokersEnabled: v }),
                'Each team may play one joker across the night to double that round.'),
            el('button', {
                class: 'btn btn-ghost btn-small',
                onClick: () => {
                    if (!confirm('Reset every setting back to the defaults?')) return;
                    resetSettings();
                    applySettingsToEngines(ctx);
                    applyBigScreen();
                    rerender();
                },
            }, 'Reset all settings'),
        ]),
    );
}

const pct = (v) => `${Math.round(v * 100)}%`;

function group(title, children) {
    return el('div', { class: 'settings-group' },
        el('h3', { class: 'settings-title', text: title }),
        el('div', { class: 'settings-body' }, ...children.filter(Boolean)));
}

function toggle(label, value, onChange, hint) {
    return el('label', { class: 'switch-row' },
        el('input', { type: 'checkbox', checked: value, onChange: (e) => onChange(e.target.checked) }),
        el('span', { class: 'switch' }),
        el('span', { class: 'switch-label' },
            el('span', { text: label }),
            hint ? el('small', { text: hint }) : null));
}

function check(label, value, onChange) {
    return el('label', { class: 'mini-check' },
        el('input', { type: 'checkbox', checked: value, onChange: (e) => onChange(e.target.checked) }),
        el('span', { text: label }));
}

function slider(label, value, min, max, step, onChange, format = String) {
    const out = el('output', { class: 'slider-value', text: format(value) });
    return el('label', { class: 'slider-row' },
        el('span', { class: 'slider-label', text: label }),
        el('input', {
            type: 'range', min, max, step, value,
            onInput: (e) => {
                const v = Number(e.target.value);
                out.textContent = format(v);
                onChange(v);
            },
        }),
        out);
}

function numberField(label, value, min, max, onChange, hint) {
    return el('label', { class: 'number-row' },
        el('span', { class: 'slider-label' },
            el('span', { text: label }),
            hint ? el('small', { text: ` ${hint}` }) : null),
        el('input', {
            type: 'number', class: 'input input-number', min, max, value,
            onChange: (e) => onChange(clamp(Number(e.target.value) || 0, min, max)),
        }));
}

function soundTest(ctx, name, label) {
    return el('button', {
        class: 'btn btn-ghost btn-small',
        onClick: async () => {
            await ctx.engines.audio.unlock();
            ctx.engines.audio.play(name);
        },
    }, label);
}

function voiceSelect(ctx, set) {
    const { speech } = ctx.engines;
    const voices = speech.listVoices ? speech.listVoices({ englishOnly: false }) : [];
    const s = getSettings();

    const select = el('select', {
        class: 'input',
        onChange: (e) => {
            set({ speechVoiceId: e.target.value });
            speech.setVoice(e.target.value);
            speech.speak('This is how I will read the questions tonight.', { interrupt: true });
        },
    });

    if (!voices.length) {
        select.appendChild(el('option', { value: '', text: 'System default voice' }));
        select.disabled = true;
    } else {
        select.appendChild(el('option', { value: '', text: 'Best available (recommended)' }));
        const british = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('en-gb'));
        const otherEnglish = voices.filter((v) => (v.lang || '').toLowerCase().startsWith('en')
            && !(v.lang || '').toLowerCase().startsWith('en-gb'));
        const rest = voices.filter((v) => !(v.lang || '').toLowerCase().startsWith('en'));

        for (const [label, list] of [['British English', british], ['Other English', otherEnglish], ['Everything else', rest]]) {
            if (!list.length) continue;
            const group = el('optgroup', { label });
            for (const v of list) {
                group.appendChild(el('option', {
                    value: v.id,
                    selected: v.id === s.speechVoiceId,
                    text: `${v.name}${v.lang ? ` — ${v.lang}` : ''}`,
                }));
            }
            select.appendChild(group);
        }
    }

    return el('label', { class: 'field' },
        el('span', { class: 'slider-label', text: 'Voice' }),
        select);
}

// ---- applying settings ----

export function applySettingsToEngines(ctx) {
    const s = getSettings();
    const { audio, speech } = ctx.engines;

    audio.setMasterVolume(s.masterVolume);
    audio.setSfxVolume(s.sfxVolume);
    audio.setMusicVolume(s.musicEnabled ? s.musicVolume : 0);
    audio.setMuted(!s.audioEnabled);

    speech.setEnabled(s.speechEnabled);
    speech.setRate(s.speechRate);
    speech.setPitch(s.speechPitch);
    speech.setVolume(s.speechVolume);
    if (s.speechVoiceId) speech.setVoice(s.speechVoiceId);
}

export function applyBigScreen() {
    document.body.classList.toggle('big-screen', getSettings().bigScreen);
}

// ---- start bar ----

function startBar(ctx, pack) {
    const s = getSettings();
    const minutes = estimateMinutes(pack, draft.roundIds, s.timerEnabled ? s.timerSeconds : 20);
    const questions = pack.rounds
        .filter((r) => draft.roundIds.includes(r.id))
        .reduce((n, r) => n + r.questions.length, 0);

    return el('div', { class: 'start-bar' },
        el('div', { class: 'start-summary' },
            el('strong', { text: `${plural(draft.roundIds.length, 'round')}, ${plural(questions, 'question')}` }),
            el('span', { text: ` · about ${minutes} minutes · ${draft.teams.length ? plural(draft.teams.length, 'team') : 'no teams'}` })),
        el('div', { class: 'row wrap' },
            el('button', {
                class: 'btn btn-ghost',
                onClick: () => ctx.actions.printSheets(),
            }, icon('print', 16), 'Print answer sheets'),
            el('button', {
                class: 'btn btn-primary btn-large',
                disabled: !draft.roundIds.length,
                onClick: () => ctx.actions.start(),
            }, icon('play', 18), 'Start the quiz')));
}

export function draftTeams() {
    return draft.teams
        .map((t, i) => ({ ...t, name: (t.name || '').trim() || `Team ${i + 1}` }));
}
