/*
 * sheets.js — everything that ends up on paper: team answer sheets, the host's
 * answer key, and the final score sheet. Printing is done by dropping a node
 * into #print-root and letting the print stylesheet hide the rest of the app.
 */

import { el, ordinal, fmtPoints } from './dom.js';
import { standings, roundScore, questionValue } from './state.js';

function sheetHeader(title, subtitle) {
    return el('header', { class: 'sheet-head' },
        el('h1', { text: title }),
        subtitle ? el('p', { text: subtitle }) : null);
}

/** One answer sheet per team (or a couple of blank ones when there are no teams). */
export function buildAnswerSheets(pack, roundIds, teams) {
    const rounds = roundIds.map((id) => pack.rounds.find((r) => r.id === id)).filter(Boolean);
    const names = teams.length ? teams.map((t) => t.name) : ['', ''];
    const wrap = el('div', { class: 'sheets' });

    for (const name of names) {
        const roundBlocks = rounds.map((round, roundIndex) => {
            const lines = round.questions.map(() => el('li', {}, el('span', { class: 'sheet-rule' })));
            return el('section', { class: 'sheet-round' },
                el('h2', {},
                    `${roundIndex + 1}. ${round.name}`,
                    el('span', { class: 'sheet-joker', text: 'joker ☐' })),
                el('ol', { class: 'sheet-lines' }, lines));
        });

        wrap.appendChild(el('article', { class: 'sheet' },
            sheetHeader(pack.name, 'Answer sheet'),
            el('div', { class: 'sheet-team' },
                el('span', { text: 'Team:' }),
                el('span', { class: 'sheet-rule', text: name })),
            el('div', { class: 'sheet-rounds' }, roundBlocks),
            el('footer', { class: 'sheet-foot' },
                el('span', { text: 'Total:' }),
                el('span', { class: 'sheet-box' }))));
    }

    return wrap;
}

/** The host's copy: every question with its answer and where it came from. */
export function buildAnswerKey(pack, roundIds) {
    const rounds = roundIds.map((id) => pack.rounds.find((r) => r.id === id)).filter(Boolean);

    const roundBlocks = rounds.map((round, roundIndex) => {
        const lines = round.questions.map((q, qi) => el('li', { class: q.image ? 'has-picture' : '' },
            // A thumbnail on the host's key so they can tell at a glance which
            // picture is on the screen behind them.
            q.image ? el('img', { class: 'key-thumb', src: q.image.src, alt: '' }) : null,
            el('span', { class: 'key-question', text: q.question }),
            el('strong', { class: 'key-answer', text: q.answer }),
            q.acceptable.length ? el('span', { class: 'key-alt', text: ` (or ${q.acceptable.join(', ')})` }) : null,
            q.source?.url ? el('span', { class: 'key-source', text: ` — ${q.source.name}` }) : null,
            el('span', { class: 'key-worth', text: ` [${fmtPoints(questionValue(round.id, qi))}]` })));

        return el('section', { class: 'sheet-round' },
            el('h2', {}, `Round ${roundIndex + 1}: ${round.name}`),
            el('ol', { class: 'key-lines' }, lines));
    });

    const tiebreaker = pack.tiebreaker
        ? el('section', { class: 'sheet-round' },
            el('h2', {}, 'Tie-breaker'),
            el('p', {}, pack.tiebreaker.question, ' — ',
                el('strong', {
                    text: `${pack.tiebreaker.answer}${pack.tiebreaker.unit ? ` ${pack.tiebreaker.unit}` : ''}`,
                })))
        : null;

    return el('div', { class: 'sheets' },
        el('article', { class: 'sheet sheet-key' },
            sheetHeader(pack.name, "Host's answer key — keep this one to yourself"),
            roundBlocks,
            tiebreaker));
}

/** The result of the night, ready to pin behind the bar. */
export function buildResultsSheet(pack, game) {
    const rows = standings();
    const rounds = game.roundIds.map((id) => pack.rounds.find((r) => r.id === id)).filter(Boolean);

    const table = el('table', { class: 'sheet-table' },
        el('thead', {}, el('tr', {},
            el('th', { text: 'Pos' }),
            el('th', { class: 'left', text: 'Team' }),
            ...rounds.map((r) => el('th', { text: r.name })),
            el('th', { text: 'Total' }))),
        el('tbody', {}, ...rows.map((row) => el('tr', {},
            el('td', { text: ordinal(row.position) }),
            el('td', { class: 'left', text: row.team.name }),
            ...rounds.map((r) => el('td', { text: fmtPoints(roundScore(r.id, row.team.id)) })),
            el('td', { text: fmtPoints(row.total) })))));

    const date = game.startedAt ? new Date(game.startedAt).toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }) : '';

    return el('div', { class: 'sheets' },
        el('article', { class: 'sheet' },
            sheetHeader(pack.name, `Final scores${date ? ` — ${date}` : ''}`),
            rows.length ? table : el('p', { text: 'No teams played.' }),
            rows.length
                ? el('p', { class: 'sheet-winner' },
                    `Winner: ${rows.filter((r) => r.position === 1).map((r) => r.team.name).join(' & ')} `
                    + `with ${fmtPoints(rows[0].total)} points.`)
                : null));
}

/** Drop a node into the print root, print it, then clean up. */
export function printNode(node) {
    const root = document.getElementById('print-root');
    if (!root) return;
    root.replaceChildren(node);
    document.body.classList.add('is-printing');

    const cleanup = () => {
        document.body.classList.remove('is-printing');
        root.replaceChildren();
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    // Give the browser a frame to lay the sheets out before opening the dialog.
    requestAnimationFrame(() => {
        window.print();
        // Safari does not always fire afterprint.
        setTimeout(cleanup, 2000);
    });
}
