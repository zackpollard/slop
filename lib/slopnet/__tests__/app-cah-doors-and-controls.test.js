/**
 * Cards Against Humanity — the two lobby doors, and the host's own controls.
 *
 * Like app-cah.test.js, every test here drives the REAL inline <script> out of
 * projects/cards-against-humanity/index.html (see cah-app-harness.js) against real
 * SlopNet/SlopLobby with the mock Peer transport, and presses the shipped buttons through
 * the listeners the app itself registered.
 *
 * What each block pins:
 *   1. `lobby` is the page's ONE connection to a room. Create and Join both write to it and
 *      the lobby screen keeps both buttons on screen for the whole attempt, so a second tap
 *      used to leave two live lobbies behind one variable — and the loser's failure path
 *      then destroyed the winner's room.
 *   2. A name is a claim, not a proof. A connection the host has already TOLD that a name
 *      is not its own must not be handed that name's seat the moment its owner blinks.
 *   3. New Game closes the room with a deliberate grace so an absent player is told the game
 *      ended; a second tap must not reload the page out from under it.
 *   4. The Skip-round confirmation expires on a timer, not on the next repaint — the round
 *      Skip exists for is the one where nothing repaints at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry, registry } from './mock-peer.js';
import {
    installBrowserGlobals, restoreGlobals, useTab, loadCahApp, makeSeat, el, tap, reloads,
} from './cah-app-harness.js';

describe('CAH doors and host controls', () => {
    let app, seats;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        app = loadCahApp();
        seats = [];
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) {}
        for (const s of seats) { try { s.lobby.destroy(); } catch (e) {} }
        vi.useRealTimers();
        restoreGlobals();
    });

    const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

    async function hostGame() {
        useTab('host');
        el('player-name').value = 'Alice';
        el('score-limit').value = '7';
        const p = app.createGame();
        await tick(50);
        await p;
        return app.state.gameCode;
    }

    /** One phone taps the link. The tab name is the sessionStorage store, i.e. the clientId. */
    async function joinAs(tabName, displayName, code) {
        useTab(tabName);
        const seat = makeSeat(tabName, displayName);
        seats.push(seat);
        const p = seat.lobby.joinRoom(code, displayName);
        await tick(60);
        try { await p; } catch (e) { seat.joinFailure = e; }
        return seat;
    }

    /** Whatever the host told this tab about why it could not play. */
    const refusalOf = (seat) => (seat.joinFailure && seat.joinFailure.reason) ||
        (seat.joinErrors[0] && seat.joinErrors[0].reason) || null;

    /** Every room this page's peers are still answering dials on. */
    const liveRooms = () => [...registry.keys()].filter(id => id.startsWith('cah-'));

    /* ── 1. Two doors, one lobby ──────────────────────────────────────────── */

    describe('the lobby screen keeps both doors on screen', () => {
        it('shuts both of them for the length of an attempt, and opens both again if it fails',
            async () => {
                useTab('host');
                el('player-name').value = 'Bob';
                el('join-code').value = 'NOSUCH';
                const joining = app.joinGame();

                expect(el('btn-join').disabled, 'the door being used').toBe(true);
                expect(el('btn-create').disabled, 'and the other one, which writes to the same lobby')
                    .toBe(true);
                // A finger on it now does nothing at all — the handler is not even reached.
                expect(tap('btn-create')).toBeUndefined();

                await tick(15000);
                await joining;
                expect(el('btn-join').disabled, 'a failed attempt hands the screen back').toBe(false);
                expect(el('btn-create').disabled).toBe(false);
            });

        it('does not let a join that is still dialling destroy the room the page went on to host',
            async () => {
                useTab('host');
                el('player-name').value = 'Alice';
                el('join-code').value = 'NOSUCH';
                // Nothing visible happens for ten seconds, so Alice gives up and hosts instead.
                const joining = app.joinGame();
                const creating = app.createGame();
                await tick(80);
                await creating;

                const code = app.state.gameCode;
                expect(code, 'the room was made').toBeTruthy();

                // ...and long afterwards, the abandoned join gives up. It must take nothing
                // with it: `lobby` is Alice's own room now.
                await tick(15000);
                await joining;
                expect(app.lobby, 'the page still holds the room it is hosting').toBeTruthy();
                expect(app.state.isHost).toBe(true);

                const bob = await joinAs('bob-phone', 'Bob', code);
                expect(refusalOf(bob), 'and players can still get in').toBeNull();
                expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
            });

        it('leaves no orphan room listening when the page switches from Create to Join',
            async () => {
                useTab('host');
                el('player-name').value = 'Alice';
                const creating = app.createGame();
                // Still registering — and Alice remembers she meant to join Bob's game.
                el('join-code').value = 'NOSUCH';
                const joining = app.joinGame();

                await tick(15000);
                await creating;
                await joining;

                expect(
                    liveRooms(),
                    'a room the page has walked away from is closed, never left answering dials'
                ).toEqual([]);
                expect(app.state.isHost, 'and the page is not still telling itself it is a host')
                    .toBe(false);
            });
    });

    /* ── 2. A name is a claim, not a proof ────────────────────────────────── */

    describe('an absent seat', () => {
        it('is not handed to the retry the host itself just refused', async () => {
            const code = await hostGame();
            const bob = await joinAs('bob-phone', 'Bob', code);
            const bobId = bob.lobby.clientId;
            await joinAs('carol-phone', 'Carol', code);

            // Somebody else at the party is also called Bob (or read the roster off a screen).
            const other = await joinAs('other-tab', 'Bob', code);
            expect(refusalOf(other), 'refused, and told to try again in a moment')
                .toMatch(/already in the game/i);

            app.startGame();
            await tick(80);
            const bobHand = (app.state.hands[bobId] || []).slice();
            expect(bobHand.length, 'Bob is playing, with a hand of his own').toBeGreaterThan(0);

            // Bob's phone locks. SlopNet holds his seat — and his token — for two minutes.
            bob.lobby.client.connection.close();
            await tick(100);
            expect(app.state.players.find(p => p.id === bobId).away).toBe(true);

            // The other Bob does exactly what the refusal told them to.
            const retry = await joinAs('other-tab', 'Bob', code);
            const seat = app.state.players.find(p => p.name === 'Bob');
            expect(seat.id, "Bob's seat has not moved — a name is a claim, not a proof")
                .toBe(bobId);
            expect(app.state.hands[bobId], 'nor his hand').toEqual(bobHand);
            expect(retry.hand, 'and the claimant was dealt nothing of his').toEqual([]);
            expect(
                String(refusalOf(retry) || ''),
                'a second, luckier answer to the same question is not on offer'
            ).toMatch(/already in the game/i);

            // Bob's own ladder comes home to the seat that was still his.
            await tick(4000);
            expect(bob.joinErrors, 'he is not thrown out of a game he is playing').toEqual([]);
            expect(app.state.players.find(p => p.id === bobId).away).toBe(false);
            expect(app.state.players.filter(p => p.name === 'Bob').length).toBe(1);

            // The other Bob is not barred from the room, only from that name.
            const asSelf = await joinAs('other-tab', 'Robert', code);
            expect(refusalOf(asSelf)).toBeNull();
            expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Robert']);
        });

        it('is not inherited by that same tab once the seat is released for good', async () => {
            const code = await hostGame();
            const bob = await joinAs('bob-phone', 'Bob', code);
            const bobId = bob.lobby.clientId;
            await joinAs('carol-phone', 'Carol', code);
            const other = await joinAs('other-tab', 'Bob', code);
            expect(String(refusalOf(other) || '')).toMatch(/already in the game/i);

            app.startGame();
            await tick(80);
            const bobHand = (app.state.hands[bobId] || []).slice();

            // Bob's phone is gone for good: the reconnect window runs out and the host parks
            // his seat, hand and score against a late return.
            bob.lobby.destroy();
            await tick(150000);
            expect(app.state.players.some(p => p.name === 'Bob'),
                'the seat is parked, not on the roster').toBe(false);
            expect(app.state.pastPlayers[bobId], 'and it is being kept for him').toBeTruthy();

            // The other Bob tries once more, now that the name looks free.
            const retry = await joinAs('other-tab', 'Bob', code);
            expect(refusalOf(retry), 'they are welcome — as themselves').toBeNull();
            const seat = app.state.players.find(p => p.id === retry.lobby.clientId);
            expect(seat.score, 'a new player, with a new score').toBe(0);
            expect(app.state.pastPlayers[bobId],
                "Bob's parked seat was not handed over with his name").toBeTruthy();
            expect(app.state.pastPlayers[bobId].hand,
                "and his cards are still his").toEqual(bobHand);
            expect(retry.hand).not.toEqual(bobHand);
        });

        it('still follows its owner onto a second device', async () => {
            const code = await hostGame();
            const phone = await joinAs('bob-phone', 'Bob', code);
            const phoneId = phone.lobby.clientId;
            await joinAs('carol-phone', 'Carol', code);
            app.startGame();
            await tick(80);

            phone.lobby.client.connection.close();
            await tick(100);

            // A tab that has never been told this name is not its own is the player coming
            // back on the laptop: the seat, and everything on it, moves with them.
            const laptop = await joinAs('bob-laptop', 'Bob', code);
            expect(refusalOf(laptop)).toBeNull();
            expect(app.state.players.filter(p => p.name === 'Bob').length).toBe(1);
            expect(app.state.players.find(p => p.name === 'Bob').id).toBe(laptop.lobby.clientId);
            expect(app.state.hands[phoneId], 'and the hand goes with it').toBeUndefined();
            expect(laptop.hand.length).toBeGreaterThan(0);
        });
    });

    /* ── 3. New Game ──────────────────────────────────────────────────────── */

    describe('New Game', () => {
        it('reloads once, and only after the room has said goodbye', async () => {
            const code = await hostGame();
            const carol = await joinAs('carol-phone', 'Carol', code);
            const bob = await joinAs('bob-phone', 'Bob', code);

            // Bob's phone is locked: the host is still holding his seat, which is exactly
            // when closeRoom takes its longer grace so his next knock can be answered.
            bob.lobby.client.connection.close();
            await tick(100);

            const ending = tap('btn-new-game');
            expect(el('btn-new-game').disabled, 'the control says it is busy').toBe(true);
            // Nothing has changed on screen yet, so the host taps it again.
            tap('btn-new-game');
            expect(reloads(), 'the page must not reload while the goodbye is going out').toBe(0);

            await tick(3000);
            await ending;
            expect(reloads(), 'one tap, one reload — after the room closed').toBe(1);
            expect(
                carol.states.map(s => s.status),
                'and the players were told the host ended the game'
            ).toContain('room-closed');
        });
    });

    /* ── 4. Skip round ────────────────────────────────────────────────────── */

    describe('the Skip round confirmation', () => {
        it('expires on its own, on a round where nothing else repaints', async () => {
            const code = await hostGame();
            await joinAs('bob-phone', 'Bob', code);
            await joinAs('carol-phone', 'Carol', code);
            app.startGame();
            await tick(80);
            expect(app.state.phase).toBe('playing');
            const round = app.state.round;

            // The table is waiting on one player who has walked off with an unlocked phone:
            // no submit, no membership event, nothing to repaint the host's controls.
            tap('btn-skip-round');
            expect(el('btn-skip-round').textContent).toBe('Tap again to skip');

            await tick(6000);
            expect(
                el('btn-skip-round').textContent,
                'the arm is long gone, and the button must not still claim otherwise'
            ).toBe('Skip round');
            expect(app.state.round, 'and nothing was skipped behind the host\'s back').toBe(round);

            // Two taps from there skip the round — the second is not spent re-arming.
            tap('btn-skip-round');
            expect(el('btn-skip-round').textContent).toBe('Tap again to skip');
            tap('btn-skip-round');
            await tick(30);
            expect(app.state.round, 'two taps skip').toBe(round + 1);
            expect(el('btn-skip-round').textContent).toBe('Skip round');
        });
    });
});
