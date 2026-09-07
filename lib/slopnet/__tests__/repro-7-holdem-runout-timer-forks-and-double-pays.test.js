/**
 * REPRO 7 — "the all-in run-out is an untracked setTimeout chain that one ordinary tap
 *            forks in two — the pot is paid twice and the chain never stops"
 *
 * BUG (projects/texas-holdem/index.html:1134-1138, plus :1098, :1160, :1201)
 *
 *   if (skipToShowdown) {
 *       // Run out remaining cards then showdown
 *       this._broadcast();                                       // :1136
 *       setTimeout(() => this._endBettingRound(), 1200);          // :1137  id thrown away
 *       return;                                                   // :1138  returns BEFORE :1141
 *   }
 *
 * Three separate omissions stack up on those five lines:
 *
 *   1. The `return` at :1138 jumps over :1141-1142
 *      (`this.currentPlayerIndex = this.dealerIndex; this._moveToNextPlayer();`),
 *      so `currentPlayerIndex` still points at the player whose action ended the round
 *      (handleAction:958 guarantees `pIdx === this.currentPlayerIndex` on entry).
 *   2. The timer id is stored nowhere — `grep -n clearTimeout projects/texas-holdem/index.html`
 *      returns zero hits, so none of the three setTimeouts (:1137, :1160, :1201) can ever
 *      be cancelled.
 *   3. `_endBettingRound` (:1098) has no terminal-phase guard at the top, and the phase
 *      chain at :1117-1131 is `if / else if` with NO `else`, so a tick that arrives while
 *      `phase === SHOWDOWN` matches nothing, falls through to :1134 and re-arms itself.
 *
 * The user-visible sequence — one tap, no hostile actor, no network fault:
 *
 *   Alice 2000, Bob 500, Carol 500. Preflop Alice calls the BB, Bob shoves, Carol shoves,
 *   Alice calls the 490 with 1500 left behind (she is NOT all-in). `canAct.length === 1`
 *   (:1113-1115) so the run-out arms. The board changes in front of her; `_endBettingRound`
 *   has just zeroed `currentBet` (:1104) so renderActions (:1624-1626) — whose gate is
 *   `currentPlayerIndex >= 0 && players[idx].id === me.id && phase > WAITING && phase < SHOWDOWN`,
 *   then `!me.folded && !me.allIn` — renders a live Fold / Check / Raise row with `toCall === 0`,
 *   redrawn on every _broadcast (:1281 -> :1312-1315). She taps Check.
 *
 *   As host, sendAction (:1462-1463) calls `game.handleAction` directly, so no slopnet or
 *   sloplobby defect is involved or can shield this. handleAction's only guards (:958-960)
 *   are the index (still hers) and WAITING/SHOWDOWN (phase is FLOP), and `check` needs
 *   `player.currentBet < this.currentBet` to bail (:976) — `0 < 0` is false. The tap is
 *   accepted, `_advanceTurn` -> `_isBettingRoundDone()` is true again, and a SECOND,
 *   synchronous `_endBettingRound()` runs while the 1200ms timer is still pending.
 *   The chain has forked.
 *
 * ON THE MOCK — mock-peer.js is NOT modified, and is not used by this file at all.
 *   This bug lives entirely above the transport. The host browser is the sole authority and
 *   `sendAction` (:1462-1463) hands the host's own tap straight to `game.handleAction` with
 *   no serialisation, no queueing and no peer in the path, so a PeerJS fake — kind or cruel —
 *   cannot express it. What was missing is a harness for the APP layer: no test anywhere in
 *   this repo has ever executed PokerGame. `loadPokerEngine()` below is that harness. It
 *   slices the real `projects/texas-holdem/index.html` from `const SUITS` (:655) to the end
 *   of `class PokerGame` (:1288) and evaluates it verbatim — the code under test is the
 *   shipped file, not a copy, so it cannot drift. Nothing is stubbed except `document`,
 *   which only `renderCard` touches and which is never called here.
 *
 *   Determinism: `startHand` shuffles with Math.random. Rather than stub the RNG, `rigBoard()`
 *   overwrites hole cards and the remaining `deck` AFTER the deal — ordinary state, exactly
 *   what a real table could hold — so the exact same board runs out in every test and the
 *   winner is fixed. Timers are vitest fake timers, which is what makes "an untracked
 *   setTimeout interleaved with a synchronous re-entry into the same function" reproducible
 *   at all. The FIRST test drives the identical scenario with NOBODY tapping and passes —
 *   4 `_endBettingRound` calls, one showdown, chips conserved — proving the harness itself
 *   is not what breaks the accounting.
 *
 * WHY THE EXISTING 101 TESTS CANNOT SEE IT
 *   All 101 tests live in lib/slopnet/__tests__ and drive PeerHost/PeerClient only. There is
 *   no texas-holdem test file and no app-layer harness of any kind, so PokerGame's timer
 *   chain has never been run by a test. The bug additionally needs wall-clock interleaving of
 *   an uncancellable timer with a re-entrant synchronous call — nothing in the suite models
 *   a game loop at all.
 *
 * These tests FAIL on purpose. They document the bug; do not relax them to make them pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ── Harness ──────────────────────────────────────────────────────────────
   projects/texas-holdem/index.html is a single page with one big inline <script>.
   There is no module boundary and no export, so we lift the pure engine region
   out of the real file and evaluate it. Boundaries are located by content, not by
   hard-coded line numbers, so the harness survives edits above or below it. */

const HOLDEM_HTML = fileURLToPath(
    new URL('../../../projects/texas-holdem/index.html', import.meta.url)
);

function loadPokerEngine() {
    const lines = fs.readFileSync(HOLDEM_HTML, 'utf8').split('\n');

    const start = lines.findIndex((l) => l.includes("const SUITS = ['s', 'h', 'd', 'c']"));
    const netHeader = lines.findIndex((l) => l.includes('NETWORKING (SlopNet)'));
    if (start === -1 || netHeader === -1) {
        throw new Error('texas-holdem/index.html: could not locate the engine region');
    }
    // Walk back from the NETWORKING banner to the closing brace of `class PokerGame`.
    let end = netHeader;
    while (end > start && !/^\s*\}\s*$/.test(lines[end])) end--;

    const source = lines.slice(start, end + 1).join('\n');
    if (!/class PokerGame\b/.test(source)) {
        throw new Error('texas-holdem/index.html: sliced region does not contain PokerGame');
    }

    // `document` is referenced only inside renderCard, which nothing here calls.
    const factory = new Function(
        'document',
        source + '\nreturn { PokerGame, PHASE, evaluateBestHand, compareHandValues };'
    );
    return factory(undefined);
}

const { PokerGame, PHASE } = loadPokerEngine();

/* ── Scenario ──────────────────────────────────────────────────────────────
   Alice 2000 / Bob 500 / Carol 500 — 3000 chips on the table, blinds 10/20.
   Alice is the dealer and acts first preflop. */

const STARTING_TOTAL = 3000;

function totalChips(game) {
    return game.players.reduce((sum, p) => sum + p.chips, 0) + game.pot;
}

/**
 * Replace the post-deal randomness with a fixed board so the winner is not deck luck.
 * Called immediately after startHand(), before any action. Alice makes trips aces on
 * Ac 9d 4h 5s Jd; Bob and Carol make a pair of aces, so Alice scoops the single 1500 pot
 * and both opponents bust — the branch that drives the table into _gameOver.
 * Cards are popped off the END of `deck`: burn, flop x3, burn, turn, burn, river.
 */
function rigBoard(game) {
    game.players.find((p) => p.id === 'alice').holeCards = ['As', 'Ad'];
    game.players.find((p) => p.id === 'bob').holeCards = ['7c', '2h'];
    game.players.find((p) => p.id === 'carol').holeCards = ['8c', '3h'];
    game.deck = ['Ks', 'Qs', 'Ts', 'Jd', '6c', '5s', '3c', '4h', '9d', 'Ac', '2c'];
}

/** Seat everyone, deal, and play the preflop that puts two players all in. */
function playPreflopToAllIn(game) {
    game.addPlayer('alice', 'Alice');
    game.addPlayer('bob', 'Bob');
    game.addPlayer('carol', 'Carol');
    game.players.find((p) => p.id === 'alice').chips = 2000; // uneven stacks

    game.startHand();
    rigBoard(game);

    game.handleAction('alice', 'call');   // 20
    game.handleAction('bob', 'allin');    // 500
    game.handleAction('carol', 'allin');  // 500
    game.handleAction('alice', 'call');   // covers the 490 — 1500 left behind
}

/** renderActions' gate, transcribed from index.html:1624-1628. */
function actionButtonsAreLive(game, playerId) {
    const state = game.getStateForPlayer(playerId);
    const me = state.players.find((p) => p.id === playerId);
    if (!me) return false;
    const isMyTurn =
        state.currentPlayerIndex >= 0 &&
        state.players[state.currentPlayerIndex]?.id === me.id &&
        state.phase > PHASE.WAITING &&
        state.phase < PHASE.SHOWDOWN;
    return Boolean(isMyTurn && !me.folded && !me.allIn);
}

describe('repro 7 — texas-holdem all-in run-out: forked timer chain and double payout', () => {
    let game;
    let endCalls;
    let showdowns;
    let awards;
    let startHands;
    let gameOvers;
    let broadcasts;

    beforeEach(() => {
        vi.useFakeTimers();
        game = new PokerGame({ buyIn: 500, smallBlind: 10, bigBlind: 20 });

        endCalls = 0; showdowns = 0; awards = 0; startHands = 0; broadcasts = 0; gameOvers = [];

        vi.spyOn(game, '_endBettingRound');
        game._endBettingRound.mockImplementation(function (...args) {
            endCalls++;
            return PokerGame.prototype._endBettingRound.apply(game, args);
        });
        vi.spyOn(game, '_showdown');
        game._showdown.mockImplementation(function (...args) {
            showdowns++;
            return PokerGame.prototype._showdown.apply(game, args);
        });
        vi.spyOn(game, '_awardPotToLastPlayer');
        game._awardPotToLastPlayer.mockImplementation(function (...args) {
            awards++;
            return PokerGame.prototype._awardPotToLastPlayer.apply(game, args);
        });
        vi.spyOn(game, 'startHand');
        game.startHand.mockImplementation(function (...args) {
            startHands++;
            return PokerGame.prototype.startHand.apply(game, args);
        });

        game.onStateChange = () => { broadcasts++; };
        game.onGameOver = (winner) => { gameOvers.push(winner ? winner.id : null); };
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    /* ── Control: nobody taps anything ────────────────────────────────── */

    it('CONTROL (passes): left alone, the run-out deals out, pays once and stops', () => {
        playPreflopToAllIn(game);

        expect(game.phase).toBe(PHASE.FLOP);
        expect(game.pot).toBe(1500);
        expect(totalChips(game)).toBe(STARTING_TOTAL);

        // Let the whole chain and the post-showdown startHand run.
        vi.advanceTimersByTime(12000);

        expect(endCalls, 'run-out should be exactly PREFLOP->FLOP->TURN->RIVER->showdown').toBe(4);
        expect(showdowns).toBe(1);
        expect(awards).toBe(0);
        expect(gameOvers).toEqual(['alice']);
        expect(game.players.find((p) => p.id === 'alice').chips).toBe(3000);
        expect(totalChips(game) - game.pot).toBe(STARTING_TOTAL);
        // Chain is finished: nothing left armed.
        expect(vi.getTimerCount(), 'no timers should still be armed once the table is over').toBe(0);
    });

    /* ── 1. The buttons are live during the run-out ───────────────────── */

    it('BUG 1: Fold/Check/Raise stay live for the whole run-out because the turn pointer is never cleared', () => {
        playPreflopToAllIn(game);

        // index.html:1137 has just armed the 1200ms run-out and returned at :1138,
        // skipping the `currentPlayerIndex = this.dealerIndex` reset at :1141.
        expect(game.phase).toBe(PHASE.FLOP);
        expect(vi.getTimerCount(), 'the run-out timer is armed').toBe(1);

        const state = game.getStateForPlayer('alice');
        const me = state.players.find((p) => p.id === 'alice');
        expect(me.allIn, 'Alice covered the shove, she has 1500 behind').toBe(false);
        // currentBet was zeroed at :1104, so renderActions builds a "Check" button (:1652-1657).
        expect(state.currentBet - me.currentBet).toBe(0);

        expect(
            actionButtonsAreLive(game, 'alice'),
            'Alice has no decision left to make — the hand is running itself out — yet ' +
            'renderActions renders live Fold/Check/Raise buttons at her, for 1200ms per street'
        ).toBe(false);
    });

    /* ── 2. The tap is accepted and forks the chain ───────────────────── */

    it('BUG 2: one Check tap 300ms into the run-out is accepted and forks the timer chain in two', () => {
        playPreflopToAllIn(game);
        const endsBefore = endCalls;

        vi.advanceTimersByTime(300); // 300ms into the 1200ms run-out; T1 still pending
        expect(vi.getTimerCount()).toBe(1);
        expect(game.phase).toBe(PHASE.FLOP);

        // The tap. As host this is sendAction -> game.handleAction (index.html:1462-1463).
        game.handleAction('alice', 'check');

        expect(
            endCalls - endsBefore,
            'handleAction should have rejected an action from a player with no decision to make; ' +
            'instead it re-entered _endBettingRound synchronously while the run-out timer was pending'
        ).toBe(0);

        expect(
            vi.getTimerCount(),
            'the run-out is now two independent timer chains advancing the same hand'
        ).toBe(1);
    });

    /* ── 3. The chain outlives the hand ───────────────────────────────── */

    it('BUG 3: after the showdown the orphan chain re-arms itself every 1200ms and keeps broadcasting', () => {
        playPreflopToAllIn(game);

        vi.advanceTimersByTime(300);
        game.handleAction('alice', 'check');

        vi.advanceTimersByTime(1500); // T1 (t=1200) and T2 (t=1500) have both fired
        expect(game.phase, 'the hand is decided').toBe(PHASE.SHOWDOWN);
        expect(showdowns).toBe(1);

        const endsAtShowdown = endCalls;
        const broadcastsAtShowdown = broadcasts;

        // phase === SHOWDOWN matches none of the four branches at :1117-1131 and there is no
        // `else`, so control falls into the skipToShowdown block at :1134 and re-arms.
        vi.advanceTimersByTime(3600); // three more 1200ms ticks

        expect(
            endCalls - endsAtShowdown,
            '_endBettingRound keeps being called after the hand is over'
        ).toBe(0);
        expect(
            broadcasts - broadcastsAtShowdown,
            'every client is being re-sent the whole table every 1.2s by a loop that has ' +
            'outlived the hand it belongs to'
        ).toBe(0);
    });

    /* ── 4. The payoff: the same pot is paid twice, after game over ───── */

    it('BUG 4: the same 1500 pot is paid twice — 1500 chips minted on a 3000-chip table, after the game-over screen', () => {
        playPreflopToAllIn(game);
        expect(totalChips(game)).toBe(STARTING_TOTAL);

        vi.advanceTimersByTime(300);
        game.handleAction('alice', 'check'); // the one ordinary tap

        // t=1500 showdown pays Alice 1500 (1500 -> 3000) and arms startHand at t=6500.
        // t=6500 startHand drops the busted players, hits the "<2 players" branch and returns
        // via _gameOver() at :868-871 — BEFORE `this.pot = 0` at :876, so the pot is still 1500.
        // t=7200 a still-armed orphan tick sees playersInHand().length === 1 (:1107-1110) and
        // _awardPotToLastPlayer (:1149-1153) does `winner.chips += this.pot` all over again.
        vi.advanceTimersByTime(8000);

        expect(gameOvers, 'the game-over screen went up at t=6500').toEqual(['alice']);

        const alice = game.players.find((p) => p.id === 'alice');
        expect(
            totalChips(game) - game.pot,
            'chips are not conserved: the table started with 3000 and the sole survivor was ' +
            'paid the SAME 1500 pot twice — once at the showdown and again 700ms AFTER the ' +
            'game-over screen was already up'
        ).toBe(STARTING_TOTAL);

        expect(
            awards,
            '_awardPotToLastPlayer ran on a hand that had already been paid out at showdown'
        ).toBe(0);
        expect(alice.chips, 'Alice should hold the whole 3000, not 4500').toBe(3000);
    });

    /* ── 5. Fold variant: folding a hand that is already resolving ────── */

    it('BUG 5: tapping Fold instead applies a fold to a hand that is already running itself out', () => {
        playPreflopToAllIn(game);

        vi.advanceTimersByTime(300);
        game.handleAction('alice', 'fold');

        const alice = game.players.find((p) => p.id === 'alice');
        expect(
            alice.folded,
            'Alice cannot fold here: she is not facing a bet and the hand is already running ' +
            'itself out to showdown — but the fold is applied, forfeiting the 500 she has ' +
            'committed and rewriting who is eligible for the pot in _calculateSidePots'
        ).toBe(false);
    });
});
