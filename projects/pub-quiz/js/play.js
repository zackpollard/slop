/*
 * play.js — the phone.
 *
 * Renders what the host sends and reports what a thumb did. It holds no quiz
 * content and never decides anything: no scoring, no correctness, no advancing.
 * See PHONES.md for the message contract.
 *
 * Three widgets, one per format. Each is built for a thumb on a phone held in
 * one hand at arm's length in a dim living room, which is why everything here
 * is enormous and there is never more than one decision on screen.
 */

const $ = (id) => document.getElementById(id);
const stage = $('stage');

/*
 * Local DOM helpers rather than an import from the quiz app. The point of this
 * page is that it carries none of the app, so it does not borrow from it either
 * — these are five lines and the independence is worth more.
 */
function el(tag, className, kids) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof kids === 'string') node.textContent = kids;
    else if (Array.isArray(kids)) node.append(...kids.filter(Boolean));
    return node;
}

function btn(label, onClick) {
    const b = el('button', 'nudge', label);
    b.addEventListener('click', onClick);
    return b;
}

/** Group the digits, because a bare six-figure number is unreadable at a glance. */
function formatNumber(n) {
    const rounded = Math.round(n * 10) / 10;
    return Number.isInteger(rounded)
        ? rounded.toLocaleString('en-GB')
        : rounded.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

let lobby = null;
let teams = [];
let myTeam = null;
let live = null;      // last view message
let seq = 0;          // increases per submission; the host drops replays

// ---- chrome ----

function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function show(name) {
    for (const id of ['join', 'team', 'play']) $(`screen-${id}`).hidden = (id !== name);
}

function setConn(state) {
    const el = $('conn');
    el.dataset.state = state;
    el.textContent = state === 'connected' ? 'on' : (state === 'reconnected' ? 'on' : 'off');
}

/** Keep the screen awake — a phone that sleeps mid-round loses the table its turn. */
async function keepAwake() {
    try {
        if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch { /* not fatal, and refused on plenty of browsers */ }
}

// ---- talking to the host ----

function send(payload) {
    try { lobby?.sendToHost(payload); } catch { /* queued by SlopNet, or gone */ }
}

function commit(value) {
    if (!live || !live.open) return;
    seq += 1;
    send({ t: 'commit', roundId: live.roundId, qi: live.qi, seq, value });
}

// ---- the widgets ----

const widgets = {
    /*
     * The Dial. One puck the height of the screen; the number is the biggest
     * thing on it. LOCK carries the multiplier so the decision — take less now
     * or wait for the scale to tighten — is never hidden in a menu.
     */
    dial(view) {
        const min = Number(view.min);
        const max = Number(view.max);
        const start = Number.isFinite(view.value) ? view.value : (min + max) / 2;
        let value = start;

        const readout = el('div', 'dial-readout');
        const unit = view.unit ? el('span', 'dial-unit', view.unit) : null;
        const track = el('div', 'dial-track');
        const fill = el('div', 'dial-fill');
        const puck = el('div', 'dial-puck');
        track.append(fill, puck);

        const clues = el('ul', 'clues');
        for (const c of view.clues || []) clues.append(el('li', '', c));

        const lock = el('button', 'btn btn-lock');
        const paint = () => {
            const pct = (value - min) / (max - min);
            fill.style.width = `${pct * 100}%`;
            puck.style.left = `${pct * 100}%`;
            readout.textContent = formatNumber(value);
            lock.textContent = view.locked ? 'Locked in' : `Lock it — ×${view.multiplier}`;
            lock.disabled = !!view.locked;
        };

        const move = (clientX) => {
            const r = track.getBoundingClientRect();
            const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
            // Whole numbers unless the scale is genuinely small, so nobody is
            // fighting a decimal point with their thumb.
            const raw = min + pct * (max - min);
            value = (max - min) > 50 ? Math.round(raw) : Math.round(raw * 10) / 10;
            paint();
        };

        let dragging = false;
        const down = (e) => { dragging = true; track.setPointerCapture?.(e.pointerId); move(e.clientX); };
        const drag = (e) => { if (dragging) { e.preventDefault(); move(e.clientX); } };
        const up = () => { dragging = false; };
        track.addEventListener('pointerdown', down);
        track.addEventListener('pointermove', drag);
        track.addEventListener('pointerup', up);
        track.addEventListener('pointercancel', up);

        // Nudges, because a slider alone is miserable for a precise number and
        // impossible for anyone whose hands are not steady.
        const step = Math.max(1, Math.round((max - min) / 100));
        const nudge = (by) => { value = Math.min(max, Math.max(min, value + by)); paint(); };

        lock.addEventListener('click', () => { commit({ value, cluesSeen: view.cluesSeen }); });

        paint();
        return el('div', 'w-dial', [
            el('p', 'prompt', view.label || ''),
            el('div', 'dial-value', [readout, unit].filter(Boolean)),
            track,
            el('div', 'nudges', [
                btn('−−', () => nudge(-step * 10)), btn('−', () => nudge(-step)),
                btn('+', () => nudge(step)), btn('++', () => nudge(step * 10)),
            ]),
            clues.children.length ? el('p', 'clues-label', 'What we know so far') : null,
            clues.children.length ? clues : null,
            lock,
        ].filter(Boolean));
    },

    /*
     * The Climb. The screen is two enormous halves. Banking is a deliberate
     * slide rather than a tap, because banking by accident would be the worst
     * possible way to lose a round.
     */
    climb(view) {
        if (view.done) {
            return el('div', 'w-climb done', [
                el('p', 'prompt', 'Sit tight'),
                el('p', 'pile', view.pile != null ? `Carrying ${view.pile}` : ''),
            ]);
        }
        const higher = el('button', 'half half-up', 'HIGHER');
        const lower = el('button', 'half half-down', 'LOWER');
        higher.addEventListener('click', () => commit({ call: 'up' }));
        lower.addEventListener('click', () => commit({ call: 'down' }));

        const bank = el('input', 'bank-slide');
        bank.type = 'range'; bank.min = '0'; bank.max = '100'; bank.value = '0';
        bank.setAttribute('aria-label', 'Slide to bank');
        bank.addEventListener('change', () => {
            if (Number(bank.value) > 80) commit({ bank: true });
            bank.value = '0';
        });

        return el('div', 'w-climb', [
            el('p', 'prompt', view.current?.label || ''),
            el('p', 'versus', 'is it higher or lower than'),
            el('p', 'prompt next', view.next?.label || ''),
            el('div', 'halves', [higher, lower]),
            el('div', 'bank', [
                el('span', 'pile', `Carrying ${view.pile}`),
                view.canBank ? bank : el('span', 'bank-hint', 'Nothing to bank yet'),
                view.canBank ? el('span', 'bank-hint', 'slide to bank') : null,
            ].filter(Boolean)),
            el('p', 'step', `Rung ${view.step} of ${view.total}`),
        ]);
    },

    /*
     * Nobody Else. A board of fat tiles. Nothing is confirmed or denied while
     * the clock runs — the phone shows only what this table has chosen.
     */
    'nobody-else'(view) {
        const picked = new Set(view.picked || []);
        const board = el('div', 'board');
        const lock = el('button', 'btn btn-lock');

        const paint = () => {
            [...board.children].forEach((tile, i) => {
                tile.classList.toggle('on', picked.has(i));
                tile.disabled = !!view.locked;
            });
            lock.textContent = view.locked ? 'Locked in' : `Lock in ${picked.size} of ${view.pick}`;
            lock.disabled = !!view.locked || picked.size !== view.pick;
        };

        (view.tiles || []).forEach((label, i) => {
            const tile = el('button', 'tile', label);
            tile.addEventListener('click', () => {
                if (view.locked) return;
                if (picked.has(i)) picked.delete(i);
                else if (picked.size < view.pick) picked.add(i);
                else toast(`Pick ${view.pick} — tap one off first`);
                paint();
            });
            board.append(tile);
        });

        lock.addEventListener('click', () => commit({ picks: [...picked] }));
        paint();
        return el('div', 'w-board', [
            el('p', 'prompt', view.prompt || ''),
            el('p', 'hint', 'Anything the other table also picks is worth nothing to either of you.'),
            board,
            lock,
        ]);
    },
};

// ---- rendering ----

function renderView(msg) {
    live = msg;
    const build = widgets[msg.format];
    if (!build) { stage.replaceChildren(el('p', 'idle', 'Watch the big screen.')); return; }
    stage.replaceChildren(build(msg.view || {}));
    if (!msg.open) {
        stage.classList.add('closed');
        stage.querySelectorAll('button, input').forEach((n) => { n.disabled = true; });
    } else {
        stage.classList.remove('closed');
    }
}

function renderIdle(message) {
    live = null;
    stage.classList.remove('closed');
    stage.replaceChildren(el('p', 'idle', message || 'Sit tight.'));
}

function renderTeams() {
    const list = $('team-list');
    list.replaceChildren(...teams.map((t) => {
        const b = el('button', 'team-btn', t.name);
        b.addEventListener('click', () => {
            myTeam = t;
            send({ t: 'claim', teamId: t.id });
            $('team-badge').textContent = t.name;
            show('play');
            keepAwake();
        });
        return b;
    }));
}

// ---- host messages ----

function onHostData(data) {
    if (!data || typeof data !== 'object') return;
    switch (data.t) {
        case 'hello':
            teams = data.teams || [];
            if (data.teamId) {
                myTeam = teams.find((t) => t.id === data.teamId) || myTeam;
                $('team-badge').textContent = myTeam?.name || '';
                show('play');
            } else {
                renderTeams();
                show('team');
            }
            break;
        case 'view':
            if (!myTeam) return;
            renderView(data);
            break;
        case 'idle':
            if (!myTeam) return;
            renderIdle(data.message);
            break;
        case 'ack':
            toast('Locked in');
            break;
        default:
            break;
    }
}

// ---- join ----

async function join(code) {
    const status = $('join-status');
    status.textContent = 'Connecting…';
    $('join-btn').disabled = true;
    try {
        lobby = new globalThis.SlopLobby({
            roomPrefix: 'pubquiz-',
            storageKey: 'pubquiz-client-id',
            onClientData: onHostData,
            onStateChange: (s) => {
                setConn(s);
                if (s === 'reconnected') toast('Back with you');
                if (s === 'disconnected') toast('Lost the host — trying again');
            },
        });
        await lobby.joinRoom(code.trim().toUpperCase(), 'Table');
        status.textContent = '';
        try { sessionStorage.setItem('pubquiz-room', code.trim().toUpperCase()); } catch { /* private mode */ }
    } catch (err) {
        status.textContent = 'Could not find that room. Check the code on the big screen.';
        $('join-btn').disabled = false;
    }
}

$('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('room-code').value;
    if (code.trim()) join(code);
});

// A phone that reloads mid-quiz should not make anyone read the code out again.
try {
    const last = sessionStorage.getItem('pubquiz-room');
    if (last) $('room-code').value = last;
} catch { /* private mode */ }

show('join');
