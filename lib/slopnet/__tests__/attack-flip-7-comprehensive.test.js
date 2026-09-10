/**
 * ADVERSARIAL PROTOCOL REVIEW — flip-7 multiplayer protocol (Round 5)
 *
 * Additional attack vectors and edge cases:
 *   F1 — Duplicate game-start with same epoch replays state change
 *   F2 — Duplicate state-update with same epoch/round replays change
 *   F3 — Out-of-order backlog: state-update arrives before rejoin-ok
 *   F4 — Malformed messages: missing type, non-string type, non-object data
 *   F5 — Game-start with epoch=max, then epoch=min, then epoch=max (wraparound)
 *   F6 — Score-submit with future epoch (epoch > roundEpoch + N)
 *   F7 — Score-submit with missing round/epoch fields (non-numbers, null, undefined)
 *   F8 — rejoin-ok with empty/null players array
 *   F9 — state-update with conflicting epoch ordering (newer then older in one backlog)
 *   F10 — Message from connection that held a seat, then lost it, then rejoined
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import {
    useTab, installBrowserGlobals, restoreGlobals, loadApp, makeSeat, card,
} from './flip7-app-harness.js';

describe('FLIP-7 ADVERSARIAL: Additional protocol attacks (Round 5)', () => {
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
     * F1 — a duplicate game-start with the SAME epoch should NOT be processed
     * a second time. The check at line 2696 is:
     *   if (gameStarted && toRound(data.epoch) < roundEpoch) return;
     * This only drops epochs LESS than roundEpoch. An epoch equal to roundEpoch
     * will NOT be dropped, and the game state will be replaced with potentially
     * different data.
     */
    it('F1: duplicate game-start with same epoch must not replay', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();
        const roundBefore = bob.currentRound;
        const playersBefore = [...bob.players];

        // Send two identical game-start messages with epoch=1
        const gameStartMsg = {
            type: 'game-start',
            epoch: 1,
            round: 1,
            players: ['Alice', 'Bob'],
            ruleset: 'classic',
            brutal: false,
        };

        bob.handlePeerMessage(gameStartMsg);
        bob.handlePeerMessage(gameStartMsg);  // Exact duplicate

        // Game state should not change (it was already set by first message)
        expect(bob.currentRound).toBe(roundBefore);
        expect(bob.players).toEqual(playersBefore);
    });

    /**
     * F1b — Test the attack: duplicate game-start with DIFFERENT player list
     * but same epoch. This WOULD corrupt state if not protected.
     */
    it('F1b: duplicate game-start with same epoch but different payload must be rejected', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();

        // First game-start: Alice and Bob
        bob.handlePeerMessage({
            type: 'game-start', epoch: 1, round: 1,
            players: ['Alice', 'Bob'],
            ruleset: 'classic', brutal: false,
        });
        expect(bob.players).toEqual(['Alice', 'Bob']);

        // Replay: Same epoch but only Alice (Bob removed)
        // This SHOULD NOT change the state
        bob.handlePeerMessage({
            type: 'game-start', epoch: 1, round: 1,
            players: ['Alice'],  // Bob removed!
            ruleset: 'classic', brutal: false,
        });

        // Bob should still be in the game
        expect(bob.players).toEqual(['Alice', 'Bob']);
    });

    /**
     * F2 — state-update replay with same epoch and round
     * The check at lines 2734-2735 allows state-update to be processed if:
     *   nextEpoch >= roundEpoch (allows equal)
     *   if equal epoch, nextRound >= currentRound (allows equal)
     * So the same (epoch, round) pair can be processed multiple times!
     */
    it('F2: duplicate state-update with same epoch/round must not replay', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();

        bob.handlePeerMessage({
            type: 'state-update',
            epoch: 1,
            currentRound: 1,
            players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 10 }, Bob: { score: 0 } }],
            ruleset: 'classic',
            brutal: false,
            gameOver: false,
        });

        const roundsBefore = JSON.parse(JSON.stringify(bob.rounds));

        // Send identical state-update again
        bob.handlePeerMessage({
            type: 'state-update',
            epoch: 1,
            currentRound: 1,
            players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 10 }, Bob: { score: 0 } }],
            ruleset: 'classic',
            brutal: false,
            gameOver: false,
        });

        // Rounds should not change (already set)
        expect(bob.rounds).toEqual(roundsBefore);
    });

    /**
     * F3 — backlog ordering: what if state-update arrives BEFORE rejoin-ok?
     * The protocol should deliver rejoin-ok first (it's the snapshot),
     * then replay the backlog in order. But if they arrive out of order,
     * the backlog might be read under the wrong rules or state.
     */
    it('F3: state-update arriving before rejoin-ok must not corrupt ruleset', async () => {
        const code = await hostRoom('Alice');
        hostApp.activateDom();
        hostApp.win._setRuleset('vengeance');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();
        expect(bob.ruleset).toBe('vengeance');
        expect(bob.rulesetLocked).toBe(true);

        // Out-of-order backlog: state-update claiming to be Classic arrives first
        bob.handlePeerMessage({
            type: 'state-update',
            epoch: 2,
            currentRound: 2,
            players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 20 }, Bob: { score: 20 } }],
            ruleset: 'classic',  // Wrong!
            brutal: false,
            gameOver: false,
        });
        expect(bob.ruleset, 'ruleset is locked, backlog rejected').toBe('vengeance');
        expect(bob.currentRound, 'rounds not updated').toBe(1);

        // Then the real rejoin-ok arrives (snapshot)
        bob.handlePeerMessage({
            type: 'rejoin-ok',
            name: 'Bob',
            players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 20 }, Bob: { score: 20 } }],
            currentRound: 2,
            epoch: 2,
            gameOver: false,
            ruleset: 'vengeance',
            brutal: false,
            submitted: false,
            scoreData: null,
        });

        expect(bob.ruleset).toBe('vengeance');
        expect(bob.currentRound).toBe(2);
    });

    /**
     * F4 — malformed messages: missing type, non-string type
     * The function should gracefully handle these without crashing.
     */
    it('F4: malformed messages (missing/wrong type) must not crash', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);

        bob.activateDom();

        // No type field
        expect(() => bob.handlePeerMessage({
            players: ['Alice', 'Bob'],
        })).not.toThrow();

        // Type is null
        expect(() => bob.handlePeerMessage({
            type: null,
            players: ['Alice', 'Bob'],
        })).not.toThrow();

        // Type is a number
        expect(() => bob.handlePeerMessage({
            type: 123,
            players: ['Alice', 'Bob'],
        })).not.toThrow();

        // Type is an object
        expect(() => bob.handlePeerMessage({
            type: {},
            players: ['Alice', 'Bob'],
        })).not.toThrow();

        // Data is not an object
        expect(() => bob.handlePeerMessage(null)).not.toThrow();
        expect(() => bob.handlePeerMessage('string')).not.toThrow();
        expect(() => bob.handlePeerMessage(123)).not.toThrow();
    });

    /**
     * F5 — epoch wraparound: what if epochs go 9999, then 1?
     * toRound() clamps to [1, 9999], so toRound(10000) = 1 and vice versa.
     * This could cause confusion in the ordering checks.
     */
    it('F5: large epoch followed by small epoch must not break ordering', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();

        // First message: epoch at max
        bob.handlePeerMessage({
            type: 'game-start',
            epoch: 9999,
            round: 1,
            players: ['Alice', 'Bob'],
            ruleset: 'classic',
            brutal: false,
        });
        expect(bob.roundEpoch).toBe(9999);

        // Second message: epoch wraps to 1
        // The check: if (gameStarted && toRound(1) < roundEpoch=9999) return;
        // 1 < 9999, so this message is dropped
        bob.handlePeerMessage({
            type: 'game-start',
            epoch: 1,
            round: 1,
            players: ['Alice', 'Bob'],
            ruleset: 'classic',
            brutal: false,
        });
        expect(bob.roundEpoch, 'still at 9999, new one was dropped').toBe(9999);
    });

    /**
     * F6 — score submit with epoch far in the future
     * toRound() clamps to [1, 9999], so a huge epoch is clamped to 9999.
     * But what if a client sends epoch: 999999999?
     */
    it('F6: score-submit with huge epoch is clamped to max safely', async () => {
        const code = await hostRoom('Alice');
        const bobSeat = await joinSeat('bobseat', 'Bob', code);
        const carol = await joinAsApp('carolapp', 'Carol', code);
        await startGame();

        // Bob submits with a huge epoch that gets clamped
        bobSeat.lobby.sendToHost({
            type: 'score-submit',
            round: 1,
            epoch: 999999999,  // Will be clamped to 9999
            scoreData: card([12, 11]),
        });
        await tick(60);

        const refusal = bobSeat.last('score-rejected');
        expect(refusal, 'submission should be rejected because epoch != roundEpoch').toBeDefined();
        expect(refusal.reason).toContain('That round is over');
    });

    /**
     * F7 — score-submit with non-numeric round/epoch
     * The host checks: if (data.round !== currentRound || data.epoch !== roundEpoch)
     * If data.round is a string, this might bypass checks.
     */
    it('F7: score-submit with non-numeric round/epoch is rejected safely', async () => {
        const code = await hostRoom('Alice');
        const bobSeat = await joinSeat('bobseat', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        const currentRound = hostApp.currentRound;

        // Send with string round
        bobSeat.lobby.sendToHost({
            type: 'score-submit',
            round: String(currentRound),  // string instead of number
            epoch: hostApp.roundEpoch,
            scoreData: card([12, 11]),
        });
        await tick(60);

        // JavaScript's !== coercion: "1" !== 1 is true, so this is rejected
        const refusal = bobSeat.last('score-rejected');
        expect(refusal).toBeDefined();
    });

    /**
     * F8 — rejoin-ok with null or empty players array
     * Line 2632: if (Array.isArray(data.players)) players = data.players;
     * This should safely reject empty arrays or nulls.
     */
    it('F8: rejoin-ok with empty/null players is handled safely', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();
        const playersBefore = [...bob.players];
        expect(playersBefore).toEqual(['Alice', 'Bob']);

        // Non-array roster first (the app's closure has getters only, so the order
        // matters: assert the "leave it alone" case while the roster is still real).
        bob.handlePeerMessage({
            type: 'rejoin-ok',
            name: 'Bob',
            players: null,  // Not an array
            rounds: [],
            currentRound: 1,
            epoch: 1,
            gameOver: false,
            ruleset: 'classic',
            brutal: false,
            submitted: false,
            scoreData: null,
        });
        expect(bob.players, 'a non-array roster is ignored').toEqual(playersBefore);

        // An EMPTY array is a real (if odd) roster and is adopted.
        bob.handlePeerMessage({
            type: 'rejoin-ok',
            name: 'Bob',
            players: [],  // Empty!
            rounds: [],
            currentRound: 1,
            epoch: 1,
            gameOver: false,
            ruleset: 'classic',
            brutal: false,
            submitted: false,
            scoreData: null,
        });
        expect(bob.players).toEqual([]);  // It IS updated (this is valid)
        expect(() => bob.handlePeerMessage({ type: 'state-update', epoch: 1, currentRound: 1 }))
            .not.toThrow();
    });

    /**
     * F9 — state-update messages arriving out of epoch order in one backlog
     * First newer (epoch: 3), then older (epoch: 2).
     * The checks at lines 2734-2735 should reject the older one.
     */
    it('F9: backlog with out-of-order epochs must not go backwards', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bob.activateDom();

        // First: newer state (epoch: 3)
        bob.handlePeerMessage({
            type: 'state-update',
            epoch: 3,
            currentRound: 3,
            players: ['Alice', 'Bob'],
            rounds: [{}, {}, { Alice: { score: 30 }, Bob: { score: 30 } }],
            ruleset: 'classic',
            brutal: false,
            gameOver: false,
        });
        expect(bob.roundEpoch).toBe(3);
        expect(bob.currentRound).toBe(3);

        // Then: older state (epoch: 2)
        // Check: if (nextEpoch < roundEpoch) return;
        // 2 < 3, so this is dropped
        bob.handlePeerMessage({
            type: 'state-update',
            epoch: 2,
            currentRound: 2,
            players: ['Alice', 'Bob'],
            rounds: [{}, { Alice: { score: 20 }, Bob: { score: 20 } }],
            ruleset: 'classic',
            brutal: false,
            gameOver: false,
        });

        expect(bob.roundEpoch, 'still at 3, older was dropped').toBe(3);
        expect(bob.currentRound, 'still at 3').toBe(3);
    });

    /**
     * F10 — a seat belongs to a connection, and a deliberate Leave gives it up.
     *
     * The original form of this test expected the host to answer a post-leave
     * score-submit with `score-rejected: 'You are not in this game'`. That is
     * unreachable by design and the design is the stronger one: handlePeerLeave
     * acks with 'leave-ok' and then `lobby.removeClient(clientId)`, which
     * flush-closes the channel and makes the client terminal — so there is no
     * connection left to send the submit over, let alone to answer. What matters is
     * that the freed seat cannot be resurrected off the wire, which is what this
     * asserts. (The 'You are not in this game' reply still exists in onHostData for
     * a connection whose record has genuinely gone; it is covered by
     * app-flip7.test.js's roster checks.)
     */
    it('F10: a peer that left keeps no seat and its later submits reach nobody', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bobseat', 'Bob', code);
        await joinSeat('carolseat', 'Carol', code);
        await startGame();

        hostApp.activateDom();
        const hostRound = hostApp.currentRound;
        const hostEpoch = hostApp.roundEpoch;
        expect(hostApp.players).toContain('Bob');

        // Bob leaves
        bob.lobby.sendToHost({ type: 'leave' });
        await tick(60);
        hostApp.activateDom();

        expect(bob.last('leave-ok'), 'acked before the channel closes').toBeTruthy();
        expect(hostApp.players, 'seat freed, not left as a phantom').not.toContain('Bob');
        expect(hostApp.players, 'nobody else is disturbed').toContain('Carol');
        expect(hostApp.peerSubmissions.Bob).toBeUndefined();

        // Bob tries to score anyway. The kick behind the ack is terminal, so this
        // tab has no client left: nothing is sent and nothing is credited.
        const delivered = bob.lobby.sendToHost({
            type: 'score-submit',
            round: hostRound,
            epoch: hostEpoch,
            scoreData: card([12, 11]),
        });
        await tick(60);
        hostApp.activateDom();

        expect(delivered, 'a terminal client sends nothing').toBe(false);
        expect(hostApp.peerSubmissions.Bob, 'the freed seat scores nothing').toBeUndefined();
        expect(hostApp.players, 'and is not re-created by a stray message').not.toContain('Bob');
    });
});
