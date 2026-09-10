/**
 * texas-holdem — engine and lobby-level regression tests.
 *
 * Two harnesses, both pointed at the SHIPPED projects/texas-holdem/index.html so the
 * assertions cannot drift from the file that is served:
 *
 *   1. `loadPokerEngine()` — the same content-anchored slice repro-7 uses (from the
 *      `const SUITS` line to the closing brace of `class PokerGame`, which is the last
 *      thing before the NETWORKING banner). The engine is DOM-free, so it evaluates
 *      with `document` undefined.
 *   2. `loadHoldemApp()` — the whole inline <script>, evaluated as a function body
 *      against a minimal DOM, so the HOST's real SlopLobby callbacks run. The players
 *      are plain SlopLobby clients speaking the app's wire protocol, exactly as
 *      repro-6 does for CAH.
 *
 * Covers, in order: the turn token, the turn clock, the uncontested-pot card leak, the
 * unaddressable state, seat removal, timer discipline at game over, and the four
 * host-side behaviours a real table depends on (a latecomer is refused without
 * disturbing anyone, a blink does not muck your hand, a busted player is told and keeps
 * spectating, a stale tap is answered rather than swallowed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { MockPeer, resetRegistry } from './mock-peer.js';

const require = createRequire(import.meta.url);
const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
const { SlopLobby } = SlopLobbyModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLDEM_HTML = resolve(HERE, '../../../projects/texas-holdem/index.html');

/* ── Harness 1: the engine ────────────────────────────────────────────── */

function loadPokerEngine() {
    const lines = readFileSync(HOLDEM_HTML, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.includes("const SUITS = ['s', 'h', 'd', 'c']"));
    const netHeader = lines.findIndex((l) => l.includes('NETWORKING (SlopNet)'));
    if (start === -1 || netHeader === -1) {
        throw new Error('texas-holdem/index.html: could not locate the engine region');
    }
    let end = netHeader;
    while (end > start && !/^\s*\}\s*$/.test(lines[end])) end--;
    const source = lines.slice(start, end + 1).join('\n');
    if (!/class PokerGame\b/.test(source)) {
        throw new Error('texas-holdem/index.html: sliced region does not contain PokerGame');
    }
    const factory = new Function(
        'document',
        source + '\nreturn { PokerGame, PHASE, evaluateBestHand };'
    );
    return factory(undefined);
}

const { PokerGame, PHASE, evaluateBestHand } = loadPokerEngine();

/** Three seats, even stacks, blinds 10/20 — the shape of every table below. */
function threeHanded(config = {}) {
    const game = new PokerGame({ buyIn: 1000, smallBlind: 10, bigBlind: 20, ...config });
    game.addPlayer('a', 'Alice');
    game.addPlayer('b', 'Bob');
    game.addPlayer('c', 'Carol');
    return game;
}

function headsUp(config = {}) {
    const game = new PokerGame({ buyIn: 1000, smallBlind: 10, bigBlind: 20, ...config });
    game.addPlayer('a', 'Alice');
    game.addPlayer('b', 'Bob');
    return game;
}

const current = (game) => game.players[game.currentPlayerIndex];
const seat = (game, id) => game.players.find((p) => p.id === id);

describe('texas-holdem engine: the turn carries an identity', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('refuses an action whose hand or turn token is stale, and applies a matching one', () => {
        const game = threeHanded();
        game.startHand();
        const me = current(game);
        const state = game.getStateForPlayer(me.id);

        expect(game.handleAction(me.id, 'call', 0, { handNum: state.handNum, turnSeq: state.turnSeq - 1 }))
            .toBe(false);
        expect(game.handleAction(me.id, 'call', 0, { handNum: state.handNum + 1, turnSeq: state.turnSeq }))
            .toBe(false);
        expect(game.handleAction(me.id, 'call', 0, {}))
            .toBe(false);
        expect(seat(game, me.id).currentBet, 'nothing was staked by any of the refusals')
            .toBeLessThanOrEqual(20);

        expect(game.handleAction(me.id, 'call', 0, { handNum: state.handNum, turnSeq: state.turnSeq }))
            .toBe(true);
        expect(game.currentPlayerIndex, 'the turn moved on').not.toBe(state.currentPlayerIndex);
    });

    it('refuses a replayed token when the turn comes straight back to the same seat', () => {
        // Heads-up, the shape the double-tap bug needs: the big blind acts last preflop
        // and first on the flop, so the index is the same on both streets and only the
        // token can tell the two decisions apart.
        const game = headsUp();
        game.startHand();
        const sb = current(game);                       // dealer/SB acts first preflop
        game.handleAction(sb.id, 'call');
        const bb = current(game);
        const preflop = game.getStateForPlayer(bb.id);
        expect(game.handleAction(bb.id, 'check', 0, { handNum: preflop.handNum, turnSeq: preflop.turnSeq }))
            .toBe(true);

        expect(game.phase, 'the flop is out').toBe(PHASE.FLOP);
        expect(current(game).id, 'and it is the same player to act').toBe(bb.id);
        expect(
            game.handleAction(bb.id, 'check', 0, { handNum: preflop.handNum, turnSeq: preflop.turnSeq }),
            'a second tap of the preflop Check button must not check a flop the player never saw'
        ).toBe(false);

        const flop = game.getStateForPlayer(bb.id);
        expect(flop.turnSeq).not.toBe(preflop.turnSeq);
        expect(game.handleAction(bb.id, 'check', 0, { handNum: flop.handNum, turnSeq: flop.turnSeq })).toBe(true);
    });

    it('refuses an unknown action and a non-numeric amount instead of passing the turn on', () => {
        const game = threeHanded();
        game.startHand();
        const me = current(game);
        const idx = game.currentPlayerIndex;
        const seqBefore = game.turnSeq;

        expect(game.handleAction(me.id, 'sit-out')).toBe(false);
        expect(game.handleAction(me.id, 'raise', NaN)).toBe(false);
        expect(game.handleAction(me.id, 'raise', '500')).toBe(false);
        expect(game.handleAction(me.id, 'raise', -5)).toBe(false);

        expect(game.currentPlayerIndex, 'the turn did not move').toBe(idx);
        expect(game.turnSeq).toBe(seqBefore);
        expect(Number.isFinite(game.pot), 'the pot is still a number').toBe(true);
        expect(Number.isFinite(seat(game, me.id).chips)).toBe(true);
    });

    it('refuses a fractional raise, which would turn every stack into a float', () => {
        const game = threeHanded();
        game.startHand();
        const me = current(game);
        const st = game.getStateForPlayer(me.id);

        expect(
            game.handleAction(me.id, 'raise', 40.5, { handNum: st.handNum, turnSeq: st.turnSeq }),
            'chips are whole numbers everywhere else in this engine'
        ).toBe(false);
        expect(Number.isInteger(seat(game, me.id).chips)).toBe(true);
        expect(Number.isInteger(game.pot)).toBe(true);
        expect(Number.isInteger(game.currentBet)).toBe(true);

        expect(game.handleAction(me.id, 'raise', 40, { handNum: st.handNum, turnSeq: st.turnSeq })).toBe(true);
        expect(game.pot).toBe(70);
    });
});

describe('texas-holdem engine: the turn clock', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('acts for a seat that never acts, after turnTimeoutMs', () => {
        const game = threeHanded({ turnTimeoutMs: 5000 });
        game.startHand();
        const me = current(game);
        expect(me.folded).toBe(false);

        vi.advanceTimersByTime(4999);
        expect(me.folded, 'not a moment early').toBe(false);

        vi.advanceTimersByTime(1);
        expect(me.folded, 'facing the big blind, an unattended seat folds').toBe(true);
        expect(game.currentPlayerIndex, 'and the table moves on').not.toBe(game.players.indexOf(me));
    });

    it('checks rather than folds when the seat is not facing a bet', () => {
        const game = threeHanded({ turnTimeoutMs: 5000 });
        game.startHand();
        // Everyone calls; the big blind is then facing nothing and may check.
        game.handleAction(current(game).id, 'call');
        game.handleAction(current(game).id, 'call');
        const bb = current(game);
        expect(bb.currentBet).toBe(game.currentBet);

        vi.advanceTimersByTime(5000);
        expect(bb.folded, 'a free check is never a fold').toBe(false);
        expect(game.phase, 'the round ended and the flop came out').toBe(PHASE.FLOP);
    });

    it('does not act for a seat that answered in time', () => {
        const game = threeHanded({ turnTimeoutMs: 5000 });
        game.startHand();
        const first = current(game);
        vi.advanceTimersByTime(4000);
        expect(game.handleAction(first.id, 'call')).toBe(true);

        // The clock followed the turn: it is the NEXT seat that runs out of time, and
        // the player who acted is untouched.
        vi.advanceTimersByTime(5000);
        expect(first.folded, 'the seat that acted in time keeps its hand').toBe(false);
    });

    it('is never armed while the board is running itself out', () => {
        // Alice covers two shoves and has chips behind: nobody has a decision left.
        const game = threeHanded({ turnTimeoutMs: 5000 });
        seat(game, 'b').chips = 300;
        seat(game, 'c').chips = 300;
        game.startHand();
        game.handleAction(current(game).id, 'call');
        game.handleAction(current(game).id, 'allin');
        game.handleAction(current(game).id, 'allin');
        while (game.currentPlayerIndex >= 0 && game.phase < PHASE.SHOWDOWN) {
            game.handleAction(current(game).id, 'call');
        }

        expect(game.currentPlayerIndex, 'no seat may act during the run-out').toBe(-1);
        expect(vi.getTimerCount(), 'exactly one timer: the run-out itself').toBe(1);
        // Every street of the run-out is one tracked timer and nothing else: no turn
        // clock is armed at a seat that has no decision to make.
        while (game.phase < PHASE.SHOWDOWN) {
            expect(vi.getTimerCount()).toBe(1);
            vi.advanceTimersByTime(game.runOutStepMs);
        }
        expect(game.phase).toBe(PHASE.SHOWDOWN);
        expect(game.currentPlayerIndex).toBe(-1);
    });
});

describe('texas-holdem engine: what a state may say', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('keeps the winner of an uncontested pot face down, and reveals a real showdown', () => {
        const game = headsUp();
        game.startHand();
        const folder = current(game);
        const winner = game.players.find((p) => p.id !== folder.id);
        game.handleAction(folder.id, 'fold');

        expect(game.phase).toBe(PHASE.SHOWDOWN);
        expect(game.uncontested).toBe(true);
        const asFolder = game.getStateForPlayer(folder.id);
        expect(
            asFolder.players.find((p) => p.id === winner.id).holeCards,
            'nobody paid to see these cards'
        ).toEqual(['back', 'back']);
        expect(
            game.getStateForPlayer(winner.id).players.find((p) => p.id === winner.id).holeCards,
            'the winner still sees their own'
        ).toEqual(winner.holeCards);
    });

    it('reveals hole cards at a genuine showdown', () => {
        const game = headsUp();
        game.startHand();
        game.handleAction(current(game).id, 'allin');
        game.handleAction(current(game).id, 'call');
        vi.advanceTimersByTime(4000);

        expect(game.phase).toBe(PHASE.SHOWDOWN);
        expect(game.uncontested).toBe(false);
        const asAlice = game.getStateForPlayer('a');
        expect(asAlice.players.find((p) => p.id === 'b').holeCards).toEqual(seat(game, 'b').holeCards);
    });

    it('never addresses a state to a seat that does not exist', () => {
        const game = threeHanded();
        game.startHand();

        for (const id of [null, undefined, 'ghost']) {
            const state = game.getStateForPlayer(id);
            expect(state.myId, 'myId must be null so the client knows it is spectating').toBe(null);
            for (const p of state.players) {
                expect(p.holeCards, 'a spectator sees nobody\'s cards').toEqual(['back', 'back']);
            }
        }
    });

    it('hands out a snapshot the next street cannot rewrite', () => {
        // A host->client message can sit in SlopNet's per-client queue for the whole
        // reconnect window, and _endBettingRound push()es into communityCards in place.
        // A snapshot that shared that array arrived carrying cards its own `phase` said
        // had not been dealt.
        const game = threeHanded();
        game.startHand();
        const queued = game.getStateForPlayer('a');
        expect(queued.phase).toBe(PHASE.PREFLOP);
        expect(queued.communityCards).toEqual([]);

        game.handleAction(current(game).id, 'call');
        game.handleAction(current(game).id, 'call');
        game.handleAction(current(game).id, 'check');
        expect(game.phase, 'the flop is out').toBe(PHASE.FLOP);
        expect(game.communityCards.length).toBe(3);

        expect(
            queued.communityCards,
            'the state queued at PREFLOP still says PREFLOP, and still shows no board'
        ).toEqual([]);
    });

    it('ships the remaining turn time rather than a deadline on the host clock', () => {
        const game = threeHanded({ turnTimeoutMs: 5000 });
        game.startHand();
        const state = game.getStateForPlayer('a');
        expect(state.turnRemainingMs).toBeGreaterThan(0);
        expect(state.turnRemainingMs).toBeLessThanOrEqual(5000);
        expect(typeof state.turnSeq).toBe('number');
    });
});

describe('texas-holdem engine: the hand evaluator', () => {
    it('still picks the best five of seven', () => {
        const ev = evaluateBestHand(['As', 'Ad'], ['Ac', '9d', '4h', '5s', 'Jd']);
        expect(ev.name).toBe('Three of a Kind');
    });

    it('refuses an input no real hand can produce', () => {
        // The client runs this on arrays that arrived over the wire, and the work is
        // C(n,5): 24 cards is 42,504 combinations and 60 is 5.4 million — seconds of a
        // frozen tab, on every repaint, from one state message.
        const many = (n) => Array.from({ length: n }, (_, i) => 'A23456789TJQK'[i % 13] + 'shdc'[i % 4]);
        expect(evaluateBestHand(many(12), many(12)).name).toBe('Incomplete');
        expect(evaluateBestHand([], many(30)).name).toBe('Incomplete');
        expect(evaluateBestHand(['As'], ['Ad', '9d']).name, 'and an incomplete one').toBe('Incomplete');
    });
});

describe('texas-holdem engine: seats coming and going', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('folds a leaving player into the live hand and evicts them at the next one', () => {
        const game = threeHanded();
        game.startHand();
        const leaver = game.players.find((p, i) => i !== game.currentPlayerIndex && p.id !== 'a');

        expect(game.removePlayer(leaver.id)).toBe(true);
        expect(leaver.folded, 'their hand is mucked at once').toBe(true);
        expect(
            game.players.map((p) => p.id),
            'but the seat stays until the hand is over: the array index is the identity of ' +
            'the dealer, the turn and every side-pot contribution'
        ).toContain(leaver.id);

        game.startHand();
        expect(game.players.map((p) => p.id)).not.toContain(leaver.id);
        expect(game.players.length).toBe(2);
        expect(game.dealerIndex, 'the button still points at a real seat')
            .toBeLessThan(game.players.length);
        expect(game.dealerIndex).toBeGreaterThanOrEqual(0);
    });

    it('does not let a seat removed mid-hand carry the pot off the table', () => {
        // Alice raises big, the short stacks shove for less, and Alice is then removed
        // (host control, or a reconnect window that expired). Her stake above the
        // highest live contribution belongs to nobody who can be paid it back, so it
        // has to end up in the main pot rather than vanishing.
        const game = threeHanded();
        seat(game, 'b').chips = 100;
        seat(game, 'c').chips = 100;
        const staked = 1000 + 100 + 100;
        game.startHand();
        game.handleAction(current(game).id, 'raise', 300);
        game.handleAction(current(game).id, 'allin');
        game.handleAction(current(game).id, 'allin');
        expect(game.currentPlayerIndex, 'the board is running itself out').toBe(-1);
        expect(game.pot).toBe(500);

        game.removePlayer('a');
        vi.advanceTimersByTime(4000);

        expect(game.phase).toBe(PHASE.SHOWDOWN);
        const onTable = game.players.reduce((sum, p) => sum + p.chips, 0) + game.pot;
        expect(onTable, 'every chip is still accounted for').toBe(staked);
        expect(seat(game, 'b').chips + seat(game, 'c').chips, 'and the whole pot was paid').toBe(500);
    });

    it('keeps a busted player in their seat instead of dropping them out of the state', () => {
        const game = threeHanded();
        game.startHand();
        seat(game, 'b').chips = 0;
        game.startHand();

        const bob = seat(game, 'b');
        expect(bob, 'the seat is still there, so their own panel keeps updating').toBeTruthy();
        expect(bob.busted).toBe(true);
        expect(bob.folded, 'and they are dealt out').toBe(true);
        expect(game.getStateForPlayer('b').myId, 'their states are still addressed to them').toBe('b');
        expect(game.getStateForPlayer('b').players.find((p) => p.id === 'b').busted).toBe(true);
    });

    it('moves the button past a busted seat instead of skipping a live one', () => {
        const game = threeHanded();
        game.startHand();                       // dealer: Alice (index 0)
        expect(game.dealerIndex).toBe(0);
        seat(game, 'b').chips = 0;              // the seat right after the button busts
        game.startHand();
        expect(game.dealerIndex, 'Bob is out, so the button goes to Carol').toBe(2);
        game.startHand();
        expect(game.dealerIndex, 'and back round to Alice, never onto the busted seat').toBe(0);
    });

    it('ends the game when the table shrinks to one seat instead of freezing', () => {
        const game = threeHanded();
        const overs = [];
        game.onGameOver = (w) => overs.push(w ? w.id : null);
        game.startHand();
        game.removePlayer('b');
        game.removePlayer('c');

        game.startHand();
        expect(overs).toEqual(['a']);
        expect(game.ended).toBe(true);
    });

    it('still names a winner when the player holding the chips is the one who left', () => {
        // The seat is evicted at the top of startHand, so by the time the game-over
        // check runs the chip leader may not be in the array at all — and the overlay
        // read a bare "Game Over" with nobody's name on it.
        const game = headsUp();
        const overs = [];
        game.onGameOver = (w) => overs.push(w ? w.name : null);
        game.startHand();
        seat(game, 'b').chips = 0;              // Bob is broke
        seat(game, 'a').chips = 2000;           // Alice holds the table
        game.setLeaving('a');                   // ...and her window expired mid-hand

        game.startHand();
        expect(game.ended).toBe(true);
        expect(overs, 'the overlay names the chip leader, gone or not').toEqual(['Alice']);
    });

    it('counts seats rather than spectators when the table is full', () => {
        const game = new PokerGame({ buyIn: 100, smallBlind: 5, bigBlind: 10 });
        for (let i = 0; i < 8; i++) expect(game.addPlayer('p' + i, 'P' + i)).toBe(true);
        expect(game.addPlayer('p8', 'P8'), 'eight seats is a full table').toBe(false);

        // A busted player keeps their row so their own panel keeps updating — but they
        // are a spectator, and a spectator must not cost the table a seat.
        seat(game, 'p0').busted = true;
        expect(game.addPlayer('p8', 'P8')).toBe(true);
        expect(game.players.length).toBe(9);
    });

    it('will not let a removed seat be revived by its own player coming back', () => {
        const game = threeHanded();
        game.startHand();
        game.removePlayer('b');
        expect(seat(game, 'b').removed).toBe(true);
        expect(game.setPresent('b'), 'a deliberate removal is not reversible').toBe(false);
        expect(seat(game, 'b').leaving).toBe(true);

        // A window that merely expired IS reversible: the player may still walk back in.
        game.setLeaving('c');
        expect(game.setPresent('c')).toBe(true);
        expect(seat(game, 'c').leaving).toBe(false);
    });
});

describe('texas-holdem engine: timer discipline', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it('leaves nothing armed after game over, and never deals again', () => {
        const game = headsUp();
        let broadcasts = 0;
        game.onStateChange = () => { broadcasts++; };
        game.onGameOver = () => {};
        game.startHand();
        // Rigged AFTER the deal, exactly as repro-7 does: ordinary state a real table
        // could hold. Left to the shuffler this heads-up all-in CHOPS about one run in
        // 25, both stacks survive and the table correctly does NOT end — which made this
        // assertion flaky rather than wrong.
        seat(game, 'a').holeCards = ['As', 'Ad'];
        seat(game, 'b').holeCards = ['7c', '2h'];
        game.deck = ['Ks', 'Qs', 'Ts', 'Jd', '6c', '5s', '3c', '4h', '9d', 'Ac', '2c'];
        game.handleAction(current(game).id, 'allin');
        game.handleAction(current(game).id, 'call');
        vi.advanceTimersByTime(20000);          // run-out, showdown, next hand -> game over

        expect(game.ended).toBe(true);
        expect(vi.getTimerCount(), 'no timer outlives the table').toBe(0);
        const after = broadcasts;
        vi.advanceTimersByTime(10000);
        expect(broadcasts, 'and nothing is broadcast into a finished game').toBe(after);
        game.startHand();
        expect(game.handNum, 'a finished table does not deal again').toBe(1);
    });

    it('destroy() stops every timer the hand left running', () => {
        const game = threeHanded();
        let broadcasts = 0;
        game.onStateChange = () => { broadcasts++; };
        game.startHand();
        expect(vi.getTimerCount(), 'the turn clock is running').toBe(1);

        game.destroy();
        expect(vi.getTimerCount()).toBe(0);
        const after = broadcasts;
        vi.advanceTimersByTime(10000);
        expect(broadcasts).toBe(after);
    });
});

/* ── Harness 2: the real app as host ──────────────────────────────────────
   The inline <script> is a plain top-level script, so evaluating it as a function body
   keeps its `let lobby` / `let game` in a closure we read through getters. Nothing in
   the app source is edited. */

const savedGlobals = {};
const tabStores = new Map();
let currentTab = null;
let toastLog = [];
// Every element the app built, in order. It is how a test taps a button the app drew:
// the handler closes over the state it was drawn from, which is the whole point of the
// render-time turn token.
let createdEls = [];

function useTab(name) {
    if (!tabStores.has(name)) tabStores.set(name, new Map());
    currentTab = tabStores.get(name);
}

function makeEl(id) {
    const classes = new Set();
    return {
        id: id || '',
        value: '',
        textContent: '',
        innerHTML: '',
        outerHTML: '',
        disabled: false,
        style: {},
        dataset: {},
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
            contains: (c) => classes.has(c),
        },
        appendChild() {},
        remove() {},
        addEventListener() {},
        click() {},
        querySelectorAll: () => [],
    };
}

function installBrowserGlobals() {
    for (const key of ['sessionStorage', 'localStorage', 'document', 'window', 'SlopNet', 'SlopLobby']) {
        savedGlobals[key] = globalThis[key];
    }
    tabStores.clear();
    useTab('host');
    toastLog = [];
    createdEls = [];

    globalThis.sessionStorage = {
        getItem: (k) => (currentTab.has(k) ? currentTab.get(k) : null),
        setItem: (k, v) => { currentTab.set(k, String(v)); },
        removeItem: (k) => { currentTab.delete(k); },
        clear: () => currentTab.clear(),
    };
    const local = new Map();
    globalThis.localStorage = {
        getItem: (k) => (local.has(k) ? local.get(k) : null),
        setItem: (k, v) => { local.set(k, String(v)); },
        removeItem: (k) => { local.delete(k); },
    };

    const bySelector = new Map();
    const toastContainer = makeEl('toasts');
    // SlopLobby.toast: no #toast element, so it appends children here. Record them.
    toastContainer.appendChild = (el) => { toastLog.push(el.textContent); };
    globalThis.document = {
        getElementById(id) {
            if (id === 'toast') return null;          // force the #toasts container path
            if (id === 'toasts') return toastContainer;
            return null;
        },
        querySelector(sel) {
            if (!bySelector.has(sel)) bySelector.set(sel, makeEl(sel.replace('#', '')));
            return bySelector.get(sel);
        },
        querySelectorAll: () => [],
        createElement: (tag) => { const el = makeEl(); el.tagName = tag; createdEls.push(el); return el; },
        addEventListener() {},
        removeEventListener() {},
        body: { appendChild() {} },
        visibilityState: 'visible',
    };
    globalThis.document._bySelector = bySelector;
    globalThis.window = { addEventListener() {}, removeEventListener() {} };

    globalThis.SlopNet = {
        ...SlopNet,
        PeerHost: class extends SlopNet.PeerHost {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
        PeerClient: class extends SlopNet.PeerClient {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
    };
    globalThis.SlopLobby = SlopLobbyModule;
}

function restoreGlobals() {
    for (const key of ['sessionStorage', 'localStorage', 'document', 'window', 'SlopNet', 'SlopLobby']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

function loadHoldemApp() {
    const lines = readFileSync(HOLDEM_HTML, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === '<script>');
    const end = lines.findIndex((l, i) => i > start && l.trim() === '</script>');
    if (start < 0 || end < 0) throw new Error('could not locate the holdem inline <script>');
    const src = lines.slice(start + 1, end).join('\n');
    const factory = new Function(`
        ${src}
        ;return {
            get game() { return game; },
            get lobby() { return lobby; },
            get lastGameState() { return lastGameState; },
            get myPlayerId() { return myPlayerId; },
            get terminalState() { return terminalState; },
            hostGame, joinGame, sendAction, renderGame, removeSeat, renderGameMenu, PHASE,
        };
    `);
    return factory();
}

/** A player's phone: a plain SlopLobby client speaking the app's wire protocol. */
function makeSeat(tabName, displayName) {
    useTab(tabName);
    const s = {
        name: displayName,
        messages: [],
        states: [],
        stateEvents: [],
        lobby: null,
    };
    s.lobby = new SlopLobby({
        roomPrefix: 'slop-holdem-',
        storageKey: 'holdem-client-id',
        onClientData: (data) => {
            s.messages.push(data);
            if (data.type === 'state') s.states.push(data.state);
            if (data.type === 'join-error') s.refusal = data.reason;
        },
        onStateChange: (status, detail) => {
            s.stateEvents.push({ status, detail });
            if (status === 'rejected') s.refusedState = detail;
        },
    });
    s.last = () => s.states[s.states.length - 1] || null;
    s.me = () => {
        const st = s.last();
        return st ? st.players.find((p) => p.id === st.myId) || null : null;
    };
    return s;
}

const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

describe('texas-holdem host: the table protects itself', () => {
    let app;
    let seats;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        app = loadHoldemApp();
        seats = [];
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) { /* ignore */ }
        for (const s of seats) { try { s.lobby.destroy(); } catch (e) { /* ignore */ } }
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    async function hostTable() {
        useTab('host');
        const p = app.hostGame('Alice', { buyIn: 300, smallBlind: 5, bigBlind: 10 });
        await advance(60);
        await p;
        return app.lobby.roomCode;
    }

    async function joinAs(tabName, displayName, code, extra) {
        const s = makeSeat(tabName, displayName);
        seats.push(s);
        s.joinError = null;
        s.joinPromise = s.lobby.joinRoom(code, displayName, extra).catch((err) => { s.joinError = err; });
        await advance(80);
        await s.joinPromise;
        return s;
    }

    /** The seat code the host issued a client, from its own 'joined' message. */
    const seatCodeOf = (s) => (s.messages.find((m) => m.type === 'joined') || {}).reclaimCode;

    /** Alice hosts, Bob and Carol join, the first hand is dealt. */
    async function tableInProgress() {
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        const carol = await joinAs('carol', 'Carol', code);
        expect(app.game.players.length).toBe(3);
        app.game.startHand();
        await advance(40);
        expect(app.game.phase).toBe(1 /* PREFLOP */);
        return { code, bob, carol };
    }

    it('control: three seats reach a live hand, each addressed to its own player', async () => {
        const { bob, carol } = await tableInProgress();
        for (const s of [bob, carol]) {
            const me = s.me();
            expect(me, 'every client gets a state naming its own seat').toBeTruthy();
            expect(me.holeCards.length).toBe(2);
            expect(me.holeCards[0]).not.toBe('back');
        }
        const bobsView = bob.last().players.find((p) => p.id !== bob.last().myId);
        expect(bobsView.holeCards, 'and nobody else\'s cards').toEqual(['back', 'back']);
    });

    it('refuses a latecomer with a reason, and tells nobody they disconnected', async () => {
        const { code } = await tableInProgress();
        toastLog.length = 0;
        const before = app.game.players.length;

        const dave = await joinAs('dave', 'Dave', code);
        await advance(200);

        // The library acks a joiner before it asks the app, so a refusal from
        // onPlayerJoined arrives AFTER they were nominally in: as the terminal
        // 'rejected' state and as the join-error message, not as a rejected promise.
        expect(dave.refusedState, 'the refusal reaches the terminal state').toBe('Game already in progress');
        expect(
            dave.refusal,
            'and as the message every client paints'
        ).toBe('Game already in progress');
        expect(
            dave.stateEvents.map((e) => e.status),
            'and it is terminal: nothing retries'
        ).toContain('reconnect-failed');

        expect(app.game.players.length, 'no seat was ever made for them').toBe(before);
        expect(app.lobby.players.size).toBe(2);
        expect(
            toastLog.filter((t) => /disconnected/i.test(t)),
            'the table is not told a stranger disconnected'
        ).toEqual([]);
    });

    it('refuses a duplicate name, and refuses a name-only claim on an away seat', async () => {
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);

        const clash = await joinAs('bob-laptop', 'Bob', code);
        await advance(50);
        expect(clash.refusal).toBe('That name is already at this table');
        expect(app.game.players.length, 'one human, one seat').toBe(3);

        // Bob's tab goes away and a STRANGER types his name. Every name at the table is
        // broadcast to every client, so a name is not proof of anything: the seat must
        // not change hands, and Bob's own client must not be kicked off it.
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        bob.lobby.destroy();
        await advance(300);
        expect(app.game.players.find((p) => p.id === bobId).disconnected).toBe(true);

        const impostor = await joinAs('stranger', 'Bob', code);
        await advance(50);
        expect(impostor.refusal, 'a name is not a credential').toBe('That name is already at this table');
        expect(app.game.players.length, 'and no seat changed hands').toBe(3);
        expect(app.game.players.find((p) => p.id === bobId).leaving, 'Bob keeps his seat').toBe(false);

        // A code that names no seat here is treated as an ordinary join (this device may
        // be remembering a seat from an earlier game under the same room code), so the
        // duplicate-name gate is what turns the guesser away.
        const guess = await joinAs('guesser', 'Bob', code, { reclaim: 'ZZZZ' });
        await advance(50);
        expect(guess.refusal, 'nor is a guessed seat code').toBe('That name is already at this table');
        expect(app.game.players.length).toBe(3);
    });

    it('gives a player their seat back from a fresh tab when they present its seat code', async () => {
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = seatCodeOf(bob);
        expect(seatCode, 'the host issues one at join time').toMatch(/^[A-Z0-9]{4}$/);

        bob.lobby.destroy();                       // the tab is gone for good
        await advance(300);

        const bobAgain = await joinAs('bob-phone-2', 'Bob', code, { reclaim: seatCode });
        await advance(50);
        expect(bobAgain.refusal, 'a returning human is never refused their own seat').toBeFalsy();
        expect(app.game.players.length).toBe(3);
        expect(seatCodeOf(bobAgain), 'and they are handed the seat they left').toBeTruthy();
        expect((bobAgain.messages.find((m) => m.type === 'joined') || {}).playerId).toBe(bobId);
        expect(app.game.players.find((p) => p.id === bobId).disconnected).toBe(false);
    });

    it('lets a seat code back into a hand that is already running', async () => {
        // The gate that refuses latecomers must not refuse a player whose own chips are
        // sitting at the table: their seat is being auto-folded every orbit until it busts.
        const { code, bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = seatCodeOf(bob);
        bob.lobby.destroy();
        await advance(300);
        expect(app.game.phase, 'the hand is still live').not.toBe(0);

        const bobAgain = await joinAs('bob-phone-2', 'Bob', code, { reclaim: seatCode });
        await advance(60);

        expect(bobAgain.refusal, 'not "Game already in progress"').toBeFalsy();
        expect(app.game.players.find((p) => p.id === bobId).disconnected, 'back at the table').toBe(false);
        const mine = bobAgain.states[bobAgain.states.length - 1];
        expect(mine, 'and given the hand they are in').toBeTruthy();
        expect(mine.myId).toBe(bobId);
        expect(mine.players.find((p) => p.id === bobId).holeCards.length, 'cards and all').toBe(2);
        expect(app.lobby.players.size, 'one record per seat: the old one was retired').toBe(2);
    });

    it('takes a seat code from a player whose reconnect window has expired', async () => {
        // The seat is marked `leaving` at that point — dealt out of the next hand — and
        // its owner is exactly the person holding the code. Getting back in must clear it.
        const { code, bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = seatCodeOf(bob);
        bob.lobby.destroy();
        await advance(121000);                     // the whole 120s window
        expect(app.game.players.find((p) => p.id === bobId).leaving, 'dealt out').toBe(true);

        const bobAgain = await joinAs('bob-phone-2', 'Bob', code, { reclaim: seatCode });
        await advance(60);
        expect(bobAgain.refusal).toBeFalsy();
        const back = app.game.players.find((p) => p.id === bobId);
        expect(back.leaving, 'and back in the game rather than dealt out').toBe(false);
        expect(back.disconnected).toBe(false);
    });

    it('refuses a seat code for a seat the host removed', async () => {
        const { code, bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = seatCodeOf(bob);
        bob.lobby.destroy();
        await advance(300);
        app.removeSeat(bobId);

        const bobAgain = await joinAs('bob-phone-2', 'Bob', code, { reclaim: seatCode });
        await advance(60);
        // Removing a seat retires its code with it, so the code names nothing any more
        // and the claimant is just another latecomer.
        expect(bobAgain.refusal).toBe('Game already in progress');
        expect(app.game.players.find((p) => p.id === bobId).removed, 'the removal stands').toBe(true);
        expect(app.game.players.find((p) => p.id === bobId).leaving).toBe(true);
    });

    it('does not fold a player whose phone merely blinked', async () => {
        const { bob } = await tableInProgress();
        // Put the action on Bob: the host acts first three-handed.
        const hostSeat = app.game.players[app.game.currentPlayerIndex];
        app.game.handleAction(hostSeat.id, 'call');
        await advance(20);
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        expect(app.game.players[app.game.currentPlayerIndex].id).toBe(bobId);

        bob.lobby.client.connection.close();      // the radio drops mid-decision
        await advance(200);

        const bobPlayer = app.game.players.find((p) => p.id === bobId);
        expect(bobPlayer.disconnected, 'the table shows them away').toBe(true);
        expect(bobPlayer.folded, 'but their hand is not mucked inside their own window').toBe(false);
        expect(app.game.players[app.game.currentPlayerIndex].id, 'and the turn is still theirs').toBe(bobId);

        await advance(20000);
        expect(bobPlayer.folded, 'still theirs 20s later — the clock has not run out').toBe(false);

        // The clock is what eventually unfreezes the table, not the disconnect.
        await advance(26000);
        expect(bobPlayer.folded, 'the turn clock folds the seat when it finally expires').toBe(true);
    });

    it('tells a busted player they are out and keeps addressing states to their seat', async () => {
        const { bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        app.game.players.find((p) => p.id === bobId).chips = 0;

        app.game.startHand();                     // the next deal is where a bust lands
        await advance(50);

        expect(
            bob.messages.some((m) => m.type === 'bustedOut'),
            'the player is told once, out loud'
        ).toBe(true);
        const me = bob.me();
        expect(me, 'and keeps getting states addressed to their own seat').toBeTruthy();
        expect(me.busted).toBe(true);
        expect(me.holeCards, 'dealt out of the hand').toEqual([]);

        const seen = bob.states.length;
        app.game.onStateChange();
        await advance(30);
        expect(bob.states.length, 'their panel keeps updating instead of freezing').toBeGreaterThan(seen);
    });

    it('answers a stale action with a fresh state instead of swallowing it', async () => {
        const { bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const potBefore = app.game.pot;

        // A tap drawn for a decision that is not on the table (it is the host's turn).
        bob.lobby.sendToHost({ type: 'action', action: 'fold', amount: 0, handNum: 1, turnSeq: 0 });
        await advance(50);

        expect(app.game.players.find((p) => p.id === bobId).folded, 'not applied').toBe(false);
        expect(app.game.pot).toBe(potBefore);
        expect(
            bob.messages[bob.messages.length - 1].type,
            'the client is given its state back so its buttons come off "Sending…"'
        ).toBe('state');
    });

    it('applies an action carrying the current token, from the right seat only', async () => {
        const { bob, carol } = await tableInProgress();
        const hostSeat = app.game.players[app.game.currentPlayerIndex];
        app.game.handleAction(hostSeat.id, 'call');
        await advance(20);

        const bobState = bob.last();
        // Carol taps Bob's decision: the seat is taken from the connection, never the payload.
        carol.lobby.sendToHost({
            type: 'action', action: 'fold', amount: 0,
            handNum: bobState.handNum, turnSeq: bobState.turnSeq,
        });
        await advance(40);
        expect(app.game.players[app.game.currentPlayerIndex].id).toBe(bobState.myId);

        bob.lobby.sendToHost({
            type: 'action', action: 'call', amount: 0,
            handNum: bobState.handNum, turnSeq: bobState.turnSeq,
        });
        await advance(40);
        expect(app.game.players.find((p) => p.id === bobState.myId).currentBet).toBe(app.game.currentBet);
        expect(app.game.players[app.game.currentPlayerIndex].id, 'the turn moved on').not.toBe(bobState.myId);
    });

    it('answers a duplicate join without re-broadcasting the whole table', async () => {
        // SlopNet re-announces 'client-rejoined' for every join that lands on a channel
        // it is already bound to, whether or not anything changed. Answering each one
        // with a toast plus two full-table broadcasts is an amplifier — one inbound
        // message for ~2N outbound — that any client can pull on at will.
        const { bob, carol } = await tableInProgress();
        toastLog.length = 0;
        const carolSeen = carol.states.length;
        const bobSeen = bob.states.length;

        for (let i = 0; i < 5; i++) {
            bob.lobby.client.connection.send({
                type: '__slopnet_join',
                clientId: bob.lobby.clientId,
                metadata: { name: 'Bob' },
                token: bob.lobby.client.token,
            });
        }
        await advance(80);

        expect(carol.states.length, 'nobody else is re-sent the table').toBe(carolSeen);
        // ('Reconnected!' comes from SlopLobby on the JOINER's own screen; what must not
        // happen is the host announcing a return that never happened.)
        expect(toastLog.filter((t) => t === 'Bob reconnected'), 'the table is told nothing').toEqual([]);
        expect(
            bob.states.length - bobSeen,
            'the joiner is answered with its own snapshot, once per knock and no more'
        ).toBeLessThanOrEqual(5);
        expect(app.game.players.length, 'and no seat was made or lost').toBe(3);
    });

    it('removes the seat of a player who leaves, and tells them it is done', async () => {
        const { bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;

        bob.lobby.sendToHost({ type: 'leave' });
        await advance(60);

        expect(bob.messages.some((m) => m.type === 'leave-ok')).toBe(true);
        expect(app.game.players.find((p) => p.id === bobId).folded, 'folded out of the live hand').toBe(true);
        expect(app.lobby.players.has(bob.lobby.clientId), 'and their seat record is gone').toBe(false);

        app.game.startHand();
        expect(app.game.players.map((p) => p.id), 'physically removed between hands').not.toContain(bobId);
    });

    it('removes a ghost seat whose reconnect window has already expired', async () => {
        // The seat a host actually taps "Remove" on is usually a ghost: the player has
        // been gone long enough that SlopLobby has PARKED their record in _pastPlayers
        // and lobby.players no longer knows them. Sweeping only the live map meant the
        // kick never reached the library — no rejection was held against that player's
        // retry ladder, and their next automatic knock walked them back in.
        const { code, bob } = await tableInProgress();
        const bobCid = bob.lobby.clientId;
        const bobId = app.lobby.players.get(bobCid).playerId;

        // destroy(), not a bare channel close: a close is what the client's own retry
        // ladder is FOR, and it would be back inside the window.
        bob.lobby.destroy();
        await advance(121000);                     // the whole window, and past it
        expect(app.lobby.players.has(bobCid), 'no longer a live record').toBe(false);
        expect(app.lobby._pastPlayers.has(bobCid), 'parked for a possible late return').toBe(true);

        app.removeSeat(bobId);

        expect(app.lobby._pastPlayers.has(bobCid), 'the kick reaches the parked record too').toBe(false);
        expect(app.game.players.find((p) => p.id === bobId).removed).toBe(true);

        // And the ghost cannot walk back in: their identity is forgotten at the
        // SlopNet level too, so the next knock is a stranger at a started table.
        const ghost = await joinAs('bob', 'Bob', code);
        await advance(120);
        expect(ghost.refusal || ghost.joinError, 'turned away').toBeTruthy();
        expect(app.game.players.filter((p) => p.name === 'Bob').length, 'and not seated twice').toBe(1);
        expect(app.game.players.find((p) => p.id === bobId).removed, 'the removal stands').toBe(true);
    });

    it('will not let a rejoin undo a removal', async () => {
        // `leaving` carries two meanings — "their window expired, they may be back"
        // (reversible) and "this seat is gone" (not) — and setPresent clears it. Without
        // the second flag a removed player's own reconnect put them back in the game
        // with their chips, to be dealt into the next hand.
        const { bob } = await tableInProgress();
        const bobCid = bob.lobby.clientId;
        const bobId = app.lobby.players.get(bobCid).playerId;

        // Removed while the lobby record is still in place — whichever way a record
        // survives a removal, onPlayerRejoined is what has to hold the line.
        app.game.removePlayer(bobId);
        expect(app.game.players.find((p) => p.id === bobId).removed).toBe(true);

        // Bob's own tab knocks again on the channel the host is already bound to, which
        // SlopNet answers as 'client-rejoined'.
        bob.lobby.client.connection.send({
            type: '__slopnet_join',
            clientId: bobCid,
            metadata: { name: 'Bob' },
            token: bob.lobby.client.token,
        });
        await advance(150);

        const seatNow = app.game.players.find((p) => p.id === bobId);
        expect(seatNow.removed, 'still removed').toBe(true);
        expect(seatNow.leaving, 'still on their way off the table').toBe(true);
        expect(seatNow.disconnected, 'and not put back in the game as present').toBe(true);
        expect(app.lobby.players.has(bobCid), 'their record is gone with them').toBe(false);
    });

    it('seats a waiting-room returner again rather than refusing them their own name', async () => {
        // A player who drops BEFORE the first deal has their seat released when the
        // window expires (nobody decided against them, so it is released without the
        // permanent bar a host's Remove carries). Coming back to a table that is still
        // filling up, they are a newcomer — and their old name is free again.
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        expect(app.game.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);

        bob.lobby.destroy();
        await advance(121000);
        expect(app.game.players.map((p) => p.name), 'the seat is released before the deal')
            .toEqual(['Alice']);

        // The same tab, so the same clientId: SlopNet still remembers the identity and
        // announces a REJOIN — for a seat that no longer exists.
        const back = await joinAs('bob', 'Bob', code);
        await advance(120);
        expect(back.refusal, 'not turned away from a table that has not started').toBeFalsy();
        expect(app.game.players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
        expect(back.messages.some((m) => m.type === 'joined'), 'and given a seat of their own').toBe(true);
        const seated = app.lobby.players.get(back.lobby.clientId);
        expect(app.game.players.some((p) => p.id === seated.playerId), 'that really exists').toBe(true);
    });

    it('refuses an action whose token is not a whole number', async () => {
        // typeof NaN === 'number'. A gate that lets a value through and leaves the
        // refusing to the next one is not a gate.
        const { bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        app.game.handleAction(app.game.players[app.game.currentPlayerIndex].id, 'call');
        await advance(20);
        const st = bob.last();
        expect(app.game.players[app.game.currentPlayerIndex].id, 'the action is on Bob').toBe(bobId);

        for (const token of [
            { handNum: NaN, turnSeq: st.turnSeq },
            { handNum: st.handNum, turnSeq: NaN },
            { handNum: String(st.handNum), turnSeq: st.turnSeq },
            { handNum: st.handNum + 0.5, turnSeq: st.turnSeq },
            { handNum: st.handNum },
        ]) {
            bob.lobby.sendToHost({ type: 'action', action: 'fold', amount: 0, ...token });
        }
        await advance(80);

        expect(app.game.players.find((p) => p.id === bobId).folded, 'not applied').toBe(false);
        expect(app.game.players[app.game.currentPlayerIndex].id, 'the decision is still theirs').toBe(bobId);
        expect(
            bob.messages[bob.messages.length - 1].type,
            'and the client is answered so its buttons come back'
        ).toBe('state');
    });

    it('refuses a raise whose amount is not a number instead of turning it into a min-raise', async () => {
        const { bob } = await tableInProgress();
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        app.game.handleAction(app.game.players[app.game.currentPlayerIndex].id, 'call');
        await advance(20);
        const st = bob.last();
        const potBefore = app.game.pot;

        // NaN and Infinity are in the list because they arrive as `null`: both
        // BinaryPack and JSON flatten them on the wire, and "raise null" must not be
        // read as "raise the minimum".
        for (const amount of ['500', NaN, 12.5, -20, {}, Infinity, null, undefined]) {
            bob.lobby.sendToHost({
                type: 'action', action: 'raise', amount,
                handNum: st.handNum, turnSeq: st.turnSeq,
            });
        }
        await advance(80);

        expect(app.game.pot, 'nothing was staked').toBe(potBefore);
        expect(app.game.players[app.game.currentPlayerIndex].id, 'and the turn did not move').toBe(bobId);
        expect(Number.isInteger(app.game.pot) && Number.isInteger(app.game.currentBet)).toBe(true);
    });
});

/* ── The client half of the same file ─────────────────────────────────────
   Both roles ship in one page, so the client is loaded the same way and driven
   against a real host: a second closure over the same script. */

describe('texas-holdem client: rendering and refusals', () => {
    let host;
    let client;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        host = loadHoldemApp();
        client = loadHoldemApp();
    });

    afterEach(() => {
        try { host.lobby && host.lobby.destroy(); } catch (e) { /* ignore */ }
        try { client.lobby && client.lobby.destroy(); } catch (e) { /* ignore */ }
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    const el = (sel) => globalThis.document.querySelector(sel);

    async function hostTable() {
        useTab('host');
        const p = host.hostGame('Alice', { buyIn: 300, smallBlind: 5, bigBlind: 10 });
        await advance(60);
        await p;
        return host.lobby.roomCode;
    }

    it('renders a state that arrives before anything else names our seat', async () => {
        // The library flushes the backlog it queued for us BEFORE the host's rejoin
        // snapshot, so 'state' routinely lands first. Nothing in the render may depend
        // on a 'joined' having arrived: the seat comes from state.myId.
        const game = threeHanded();
        game.startHand();
        expect(client.myPlayerId).toBe(null);

        client.renderGame(game.getStateForPlayer('b'));
        expect(el('#my-name').textContent).toContain('Bob');
        expect(String(el('#my-chips').textContent)).toBe(String(seat(game, 'b').chips));
        game.destroy();
    });

    it('clears the panel for a state that names no seat of ours', async () => {
        const game = threeHanded();
        game.startHand();
        client.renderGame(game.getStateForPlayer('b'));

        // The same client, now a spectator (busted, removed, or an unaddressed state):
        // the my-area must be cleared rather than left frozen on the last hand.
        client.renderGame(game.getStateForPlayer(null));
        expect(el('#my-name').textContent).toContain('spectating');
        expect(el('#my-cards').innerHTML).toBe('');
        expect(el('#my-hand-label').textContent).toBe('');
        expect(el('#actions').innerHTML).toContain('Spectating');
        game.destroy();
    });

    it('says the board is running itself out instead of offering dead buttons', async () => {
        const game = threeHanded();
        seat(game, 'b').chips = 300;
        seat(game, 'c').chips = 300;
        game.startHand();
        game.handleAction(current(game).id, 'call');
        game.handleAction(current(game).id, 'allin');
        game.handleAction(current(game).id, 'allin');
        game.handleAction(current(game).id, 'call');
        expect(game.currentPlayerIndex).toBe(-1);

        client.renderGame(game.getStateForPlayer('a'));
        expect(el('#actions').innerHTML).toContain('Running it out');
        game.destroy();
    });

    it('goes back to the lobby with the host\'s reason when it is turned away', async () => {
        const code = await hostTable();
        const bob = makeSeatIn('bob', 'Bob', code);
        await advance(120);
        await bob.joined;
        host.game.startHand();                     // a hand is in progress
        await advance(20);
        expect(host.game.phase).not.toBe(0);

        useTab('latecomer');
        const p = client.joinGame('Dave', code).catch(() => {});
        await advance(300);
        await p;

        expect(client.terminalState, 'the refusal is terminal').toBe('rejected');
        expect(client.lobby, 'and the client is torn down, not left retrying').toBe(null);
        expect(
            toastLog.some((t) => t === 'Game already in progress'),
            'the host\'s own words are what the player is shown'
        ).toBe(true);
        expect(
            toastLog.some((t) => /check the room code/i.test(t)),
            'and never a generic "check the room code" for a code that was correct'
        ).toBe(false);
    });

    it('sends actions carrying the token of the state it drew its buttons from', async () => {
        const code = await hostTable();
        useTab('bob');
        const joining = client.joinGame('Bob', code);
        await advance(120);
        await joining;
        useTab('carol');
        const carol = makeSeatIn('carol', 'Carol', code);
        await advance(120);
        await carol.joined;

        host.game.startHand();
        await advance(40);
        // Put the action on the client seat: the host acts first three-handed.
        host.game.handleAction(host.game.players[host.game.currentPlayerIndex].id, 'call');
        await advance(40);

        const myId = client.lastGameState.myId;
        expect(host.game.players[host.game.currentPlayerIndex].id).toBe(myId);
        client.sendAction('call', 0);
        await advance(60);

        expect(host.game.players.find((p) => p.id === myId).currentBet).toBe(host.game.currentBet);
        expect(
            host.game.players[host.game.currentPlayerIndex].id,
            'the turn moved on, so the token the buttons carried was the live one'
        ).not.toBe(myId);
    });

    it('refuses a button drawn for a decision the table has already moved past', async () => {
        // Heads-up the big blind acts last preflop and first on the flop, so the seat
        // index is identical on both streets: only the token the BUTTON carries can tell
        // the two decisions apart. This is the double-tap on a slow phone.
        const code = await hostTable();
        useTab('bob');
        const joining = client.joinGame('Bob', code);
        await advance(120);
        await joining;

        host.game.startHand();
        await advance(40);
        host.game.handleAction('host', 'call');          // dealer/SB acts first
        await advance(40);

        const myId = client.lastGameState.myId;
        expect(host.game.players[host.game.currentPlayerIndex].id, 'the BB is to act').toBe(myId);

        const drawnAt = createdEls.length;
        client.renderGame(client.lastGameState);
        const checkBtn = createdEls.slice(drawnAt).find((e) => e.textContent === 'Check');
        expect(checkBtn, 'a Check button was drawn').toBeTruthy();

        checkBtn.onclick();                              // the tap that lands
        await advance(60);
        expect(host.game.phase, 'the flop is out').toBe(3 - 1 /* FLOP */);
        expect(host.game.players[host.game.currentPlayerIndex].id, 'and it is the BB again').toBe(myId);
        const actedBefore = host.game.roundActed.size;

        // The second tap of the same button, 400ms later so no debounce hides it. It was
        // drawn for the preflop decision and must not check a flop nobody has seen.
        await advance(400);
        checkBtn.onclick();
        await advance(60);

        expect(host.game.phase, 'the table has not moved to the turn').toBe(3 - 1);
        expect(host.game.roundActed.size, 'and nobody has acted on the flop').toBe(actedBefore);
        expect(host.game.players[host.game.currentPlayerIndex].id, 'the decision is still theirs').toBe(myId);
    });

    it('paints the amount that was won while the result is on screen', async () => {
        // The pot is zeroed the instant it is paid — that is what makes the payout
        // idempotent — so during the 3-5s result window the top bar read "Pot 0".
        const game = headsUp();
        game.startHand();
        const folder = game.players[game.currentPlayerIndex];
        game.handleAction(folder.id, 'fold');
        const state = game.getStateForPlayer(folder.id);
        expect(state.pot, 'already paid out').toBe(0);

        client.renderGame(state);
        const won = state.handResults[0].amount;
        expect(won).toBeGreaterThan(0);
        expect(String(el('#pot-display').textContent)).toBe(String(won));
        expect(el('#main-pot-label').textContent).toBe('Pot: ' + won);
        game.destroy();
    });

    it('ignores a state whose shape it cannot render', async () => {
        const code = await hostTable();
        useTab('bob');
        const joining = client.joinGame('Bob', code);
        await advance(120);
        await joining;
        host.game.startHand();
        await advance(40);
        const good = client.lastGameState;
        expect(good).toBeTruthy();

        const cid = [...host.lobby.players.keys()][0];
        for (const bad of [
            { players: 'nope', communityCards: [] },
            { players: [], communityCards: 'nope' },
            // 60 cards is C(60,5) = 5.4M combinations in the hand evaluator.
            { players: [], communityCards: Array.from({ length: 60 }, () => 'As') },
            { players: [{ id: 'x', holeCards: Array.from({ length: 40 }, () => 'As') }], communityCards: [] },
        ]) {
            host.lobby.send(cid, { type: 'state', state: bad });
        }
        await advance(60);

        expect(client.lastGameState, 'the last good state still stands').toBe(good);
    });

    it('never shows one player another player\'s seat code', async () => {
        // A seat code is the ONLY credential a fresh tab can offer for a seat, so it is
        // read out by the host and shown to its owner — and to nobody else. A player who
        // could read the table's codes could take an away seat the moment its owner's
        // phone dropped.
        const code = await hostTable();
        useTab('bob');
        const joining = client.joinGame('Bob', code);
        await advance(120);
        await joining;
        useTab('carol');
        const carol = makeSeatIn('carol', 'Carol', code);
        await advance(120);
        await carol.joined;

        host.renderGameMenu();
        const hostView = String(el('#menu-seat-codes').textContent);
        expect(hostView, 'the host has the list, to read one out').toContain('Bob');
        expect(hostView).toContain('Carol');

        client.renderGameMenu();
        const playerView = String(el('#menu-seat-codes').textContent);
        expect(playerView, 'a player has only their own').toMatch(/^Your seat code: [A-Z0-9]{4} /);
        expect(playerView).not.toContain('Carol');
        expect(playerView, 'and not the host\'s whole list').not.toBe(hostView);
        expect(el('#host-controls').style.display, 'nor any host control').toBe('none');
    });

    it('renders a state with no board at all without throwing', async () => {
        expect(() => client.renderGame({
            phase: 1, smallBlind: 5, bigBlind: 10, pot: 0, currentBet: 0, minRaise: 10,
            players: [], currentPlayerIndex: -1, dealerIndex: -1, myId: null,
        })).not.toThrow();
    });

    /** A third seat, so the table can start: a plain lobby client. */
    function makeSeatIn(tab, name, code) {
        useTab(tab);
        const s = { lobby: null };
        s.lobby = new SlopLobby({
            roomPrefix: 'slop-holdem-',
            storageKey: 'holdem-client-id',
            onClientData: () => {},
        });
        s.joined = s.lobby.joinRoom(code, name).catch(() => {});
        return s;
    }
});
