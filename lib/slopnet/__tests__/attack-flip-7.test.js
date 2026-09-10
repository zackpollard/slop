/**
 * ADVERSARIAL PROTOCOL REVIEW — flip-7 multiplayer protocol
 *
 * Attack vectors, each now driven against the REAL inline script through
 * flip7-app-harness.js rather than described in prose:
 *   A1 — Host-to-client: ruleset change mid-game causes score reinterpretation
 *   A2 — Host-to-client: malformed scoreData with non-array cards/modifiers
 *   A3 — Host-to-client: queued backlog replayed under a switched ruleset
 *   A4 — Client-to-host: score submit with a stale epoch
 *   A5 — Client-to-host: resync flooding / forged clientId in the payload
 *   A6 — Client-to-host: score-submit from a connection holding no seat
 *
 * A1-A4 were reported as open findings and are fixed in projects/flip-7/index.html;
 * the tests below are what stops them coming back. A5/A6 were reported SECURE and
 * are pinned here so that stays true.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import {
    useTab, installBrowserGlobals, restoreGlobals, loadApp, makeSeat, card,
} from './flip7-app-harness.js';

describe('FLIP-7 ADVERSARIAL: Protocol attacks', () => {
    let hostApp, seats, peerApps;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        seats = [];
        peerApps = [];
        hostApp = loadApp('host');
    });

    afterEach(() => {
        try { hostApp.lobby && hostApp.lobby.destroy(); } catch (e) {}
        for (const a of peerApps) { try { a.lobby && a.lobby.destroy(); } catch (e) {} }
        for (const s of seats) { try { s.lobby.destroy(); } catch (e) {} }
        vi.useRealTimers();
        restoreGlobals();
    });

    const tick = (ms = 40) => vi.advanceTimersByTimeAsync(ms);

    async function hostRoom(name = 'Alice') {
        hostApp.activateDom();
        useTab('host');
        hostApp.win._selectMode('host');
        await tick(80);
        hostApp.el('host-name-input').value = name;
        hostApp.el('host-set-name-btn').click();
        return hostApp.roomCode;
    }

    /** A player's phone running the REAL app, so client handlers are under test. */
    async function joinAsApp(tabName, displayName, code) {
        const app = loadApp(tabName);
        peerApps.push(app);
        useTab(tabName);
        app.el('join-code-input').value = code;
        app.el('join-name-input').value = displayName;
        const p = app.attemptJoin();
        await tick(90);
        await p;
        hostApp.activateDom();
        await tick(20);
        return app;
    }

    /** A player's phone as a bare SlopLobby client, for host-side attacks. */
    async function joinSeat(tabName, displayName, code) {
        const seat = makeSeat(tabName, displayName);
        seats.push(seat);
        const p = seat.lobby.joinRoom(code, displayName);
        hostApp.activateDom();
        await tick(90);
        await p.then(() => {}, (err) => { seat.joinError = err; });
        return seat;
    }

    async function startGame() {
        hostApp.activateDom();
        hostApp.el('host-start-btn').click();
        await tick(40);
    }

    /**
     * A1 — a ruleset change mid-game re-scores rounds that were never played
     * under those rules. Every scoring function branches on `ruleset`/`brutal`, so
     * the ruleset is frozen at game-start (`rulesetLocked`) and a message that
     * disagrees is dropped whole rather than half-applied.
     */
    it('A1: a rejoin-ok cannot re-rule a game that is already being played', async () => {
        const code = await hostRoom('Alice');
        hostApp.activateDom();
        hostApp.win._setRuleset('vengeance');
        hostApp.win._setBrutal(true);
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();
        expect(bob.ruleset).toBe('vengeance');
        expect(bob.brutal).toBe(true);
        expect(bob.rulesetLocked).toBe(true);

        for (const forged of [
            { ruleset: 'classic', brutal: false },
            { ruleset: 'vengeance', brutal: false },   // Brutal Mode is scoring too
        ]) {
            bob.handlePeerMessage(Object.assign({
                type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'],
                rounds: [{ Alice: { score: 99 }, Bob: { score: 0 } }],
                currentRound: 2, epoch: 2, gameOver: false,
                submitted: false, scoreData: null,
            }, forged));
            expect(bob.ruleset).toBe('vengeance');
            expect(bob.brutal).toBe(true);
            expect(bob.currentRound, 'the message is dropped, not half-applied').toBe(1);
            expect(bob.rounds).toEqual([]);
        }
    });

    /**
     * A2 — `snapshotEntry` used to copy array slots with a spread, and a spread does
     * not care what it is spreading: [...'hello'] is five one-character "cards".
     * Slots are now filled by the TEMPLATE's type, so nothing off the wire can
     * become a card, a flag or a NaN in a total.
     */
    it('A2: malformed scoreData cannot become a hand of cards', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();
        bob.activateDom();

        const bobId = bob.nameToId('Bob');
        bob.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'], rounds: [],
            currentRound: 1, epoch: 1, gameOver: false, ruleset: 'classic', brutal: false,
            submitted: true,
            scoreData: { cards: 'hello', modifiers: { 0: 99, length: 1 }, x2: 'yes' },
        });

        expect(bob.roundState[bobId].cards).toEqual([]);
        expect(bob.roundState[bobId].modifiers).toEqual([]);
        expect(bob.roundState[bobId].score).toBe(0);
        expect(bob.snapshotEntry({ cards: 'ABC' }).cards).toEqual([]);
        expect(bob.snapshotEntry({ cards: [7, '7', Infinity, 12] }).cards).toEqual([7, 12]);
        expect(Number.isFinite(bob.snapshotEntry({ cards: 'hello', x2: true }).score)).toBe(true);
    });

    /**
     * A3 — a returning phone is handed its queued backlog BEFORE the rejoin
     * snapshot, so every queued message is read under whatever rules are in force
     * when it lands. Switching the rules between the two would re-read every card
     * in the backlog; neither half of the sequence is allowed to do it.
     */
    it('A3: a backlog replayed under a switched ruleset changes nothing', async () => {
        const code = await hostRoom('Alice');
        hostApp.activateDom();
        hostApp.win._setRuleset('vengeance');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();
        bob.activateDom();

        // The backlog: an older state-update claiming to be Classic.
        bob.handlePeerMessage({
            type: 'state-update', players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 20 }, Bob: { score: 20 } }],
            currentRound: 2, epoch: 2, gameOver: false, ruleset: 'classic',
        });
        expect(bob.ruleset).toBe('vengeance');
        expect(bob.currentRound, 'foreign rules, foreign game').toBe(1);

        // …then the snapshot, in the rules the game is actually being played under.
        bob.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 20 }, Bob: { score: 20 } }],
            currentRound: 2, epoch: 2, gameOver: false,
            ruleset: 'vengeance', brutal: false, submitted: false, scoreData: null,
        });
        expect(bob.ruleset).toBe('vengeance');
        expect(bob.currentRound, 'the real snapshot still lands').toBe(2);
    });

    /**
     * A4 — a submission queued across the end of a round is refused by the host
     * (round AND epoch must match). The refusal must reach the player: it used to
     * be discarded unread whenever they had already moved on, so a score that was
     * never recorded looked exactly like one that was.
     */
    it('A4: a stale-epoch submission is refused, and the player is told', async () => {
        const code = await hostRoom('Alice');
        const bobSeat = await joinSeat('bobseat', 'Bob', code);
        const carolApp = await joinAsApp('carolapp', 'Carol', code);
        await startGame();

        // Round 1 closes with nothing from Bob.
        hostApp.activateDom();
        hostApp.el('submit-round-btn').click();
        await tick(60);
        expect(hostApp.currentRound).toBe(2);

        // Bob's phone comes back and its round-1 submission is delivered at last.
        bobSeat.lobby.sendToHost({
            type: 'score-submit', round: 1, epoch: 1, scoreData: card([12, 11]),
        });
        await tick(60);

        expect(hostApp.peerSubmissions.Bob, 'never credited to round 2').toBeUndefined();
        const refusal = bobSeat.last('score-rejected');
        expect(refusal.round).toBe(1);
        expect(refusal.epoch, 'stamped with the submission it refuses').toBe(1);
        expect(refusal.reason).toBe('That round is over');

        // And on a phone running the app, that refusal is spoken aloud without
        // touching the round now on screen.
        carolApp.activateDom();
        expect(carolApp.currentRound).toBe(2);
        carolApp.el('submit-round-btn').click();      // Carol's round-2 score
        await tick(60);
        expect(carolApp.myScoreSubmitted).toBe(true);

        carolApp.handlePeerMessage({
            type: 'score-rejected', round: 1, epoch: 1, reason: 'That round is over',
        });
        expect(
            carolApp.myScoreSubmitted,
            'a refusal from round 1 does not un-submit round 2'
        ).toBe(true);
        expect(
            carolApp.el('toast').textContent,
            'but the player still hears that a score of theirs was thrown away'
        ).toBe('That round is over');
    });

    /**
     * A5 — the resync throttle is keyed by the CONNECTION's clientId, which SlopNet
     * binds before the app sees the message, so a clientId in the payload buys
     * nothing. One message in is at most one snapshot out.
     */
    it('A5: resync flooding cannot be amplified with a forged clientId', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bobseat', 'Bob', code);
        const carol = await joinSeat('carolseat', 'Carol', code);
        await startGame();
        const carolBefore = carol.countOf('rejoin-ok');

        for (let i = 0; i < 10; i++) {
            bob.lobby.sendToHost({ type: 'resync-request', clientId: 'carol-forged' });
        }
        await tick(60);

        expect(bob.countOf('rejoin-ok'), 'one answer, not ten').toBe(1);
        expect(carol.countOf('rejoin-ok'), 'and nobody else is disturbed').toBe(carolBefore);
    });

    /**
     * A6 — identity is the connection, never the payload. A connection that holds
     * no seat cannot score for one, whatever name it puts in the message.
     */
    it('A6: a connection with no seat cannot submit a score for one', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bobseat', 'Bob', code);
        const carol = await joinSeat('carolseat', 'Carol', code);
        await startGame();

        // Carol walks out, then keeps talking with Bob's name in the payload.
        carol.lobby.sendToHost({ type: 'leave' });
        await tick(60);
        carol.lobby.sendToHost({
            type: 'score-submit', round: hostApp.currentRound, epoch: hostApp.roundEpoch,
            playerName: 'Bob', scoreData: card([12, 11]),
        });
        await tick(60);

        expect(hostApp.peerSubmissions.Bob, 'Bob\'s scorecard is Bob\'s').toBeUndefined();
        expect(hostApp.peerSubmissions.Carol).toBeUndefined();
        expect(carol.last('score-ack'), 'and nothing is acked').toBeNull();

        // The real Bob, on his own connection, is credited normally.
        bob.lobby.sendToHost({
            type: 'score-submit', round: hostApp.currentRound, epoch: hostApp.roundEpoch,
            scoreData: card([12, 11]),
        });
        await tick(60);
        expect(hostApp.peerSubmissions.Bob.score).toBe(23);
    });
});
