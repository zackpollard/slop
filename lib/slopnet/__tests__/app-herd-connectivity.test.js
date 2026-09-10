/**
 * herd-mentality — the connectivity faults an audit of the shipped page confirmed.
 *
 * Like app-herd.test.js, every test here loads the real inline <script> out of
 * projects/herd-mentality/index.html and runs it against a DOM stub and the real
 * SlopNet/SlopLobby, with only the Peer transport injected. Nothing is transcribed: each
 * assertion is about the game people play.
 *
 * One test per fault:
 *   - the host's own seat is claimable from the wire, because SlopLobby seeds the joiner's
 *     record before the app is asked and the app then reads it back as "already ours"
 *   - a departure event for an abandoned clientId is spent on the NAME, evicting whoever is
 *     connected under it now
 *   - a host that merely reloads says goodbye on the way out, which is terminal for everyone
 *   - a rejoin that could not reach the host throws away the session that offered it
 *   - an answer the host already holds is refused rather than confirmed once the round closes
 *   - after a reopened round, an ordinary progress broadcast snatches the tick away
 *   - a round counter from a different room makes the new room's snapshot look like a replay
 *   - a moo is judged against the host's wall clock, on two devices whose clocks differ
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    $, audio, resetRegistry, useTab, installBrowserGlobals, restoreGlobals, reloadDom,
    loadHerdApp, makeSeat, newClientLobby, freezePage, SlopLobby,
} from './herd-app-harness.js';

describe('herd-mentality connectivity (the shipped script)', () => {
    let app, seats, unloadHandlers;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        audio.contexts = 0;
        audio.moos = 0;
        installBrowserGlobals();
        // The page registers its unload handling on `window`; the harness's window swallows
        // listeners, so keep hold of them to fire the way a browser would.
        unloadHandlers = [];
        globalThis.window.addEventListener = (type, fn) => {
            if (type === 'beforeunload') unloadHandlers.push(fn);
        };
        app = loadHerdApp();
        seats = [];
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) {}
        for (const s of seats) { try { s.lobby && s.lobby.destroy(); } catch (e) {} }
        vi.useRealTimers();
        restoreGlobals();
    });

    /* ── driving the app ───────────────────────────────────────────── */

    async function hostGame(name = 'Alice') {
        useTab('host');
        $('host-name-input').value = name;
        $('btn-create-go').click();
        await vi.advanceTimersByTimeAsync(80);
        expect(app.roomCode, 'the host never got a room code').toBeTruthy();
        return app.roomCode;
    }

    /** A player's phone: a plain SlopLobby client speaking herd's protocol. */
    async function joinAs(tabName, displayName, code) {
        useTab(tabName);
        const seat = makeSeat(tabName, displayName);
        seat.states = [];
        seats.push(seat);
        seat.attach(new SlopLobby({
            roomPrefix: 'herdm-',
            storageKey: 'herd-client-id',
            onClientData: seat.onData,
            onStateChange: (state) => { seat.states.push(state); },
        }));
        const p = seat.lobby.joinRoom(code, displayName);
        await vi.advanceTimersByTimeAsync(80);
        await p;
        return seat;
    }

    async function startGame() {
        $('btn-start-game').click();
        await vi.advanceTimersByTimeAsync(30);
    }

    async function sendQuestion() {
        $('hq-send-btn').click();
        await vi.advanceTimersByTimeAsync(30);
    }

    async function hostAnswers(text) {
        $('hw-answer-input').value = text;
        $('hw-answer-submit').click();
        await vi.advanceTimersByTimeAsync(30);
    }

    async function seatAnswers(seat, text, round) {
        seat.lobby.sendToHost({
            type: 'answer', answer: text,
            round: round === undefined ? seat.round : round,
        });
        await vi.advanceTimersByTimeAsync(40);
    }

    /** Alice hosts, Bob and Carol join, round 1's question is out. */
    async function roundInProgress() {
        const code = await hostGame();
        await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        await startGame();
        await sendQuestion();
        expect(app.gamePhase).toBe('answering');
        return code;
    }

    /* ── 1. the host's own seat ────────────────────────────────────── */

    it('refuses a joiner who types the host\'s name exactly as the host spelled it', async () => {
        const code = await roundInProgress();

        // A fourth person at the table types "Alice" — the host's name, character for
        // character. SlopLobby seeds their record from the wire BEFORE the app is asked, so
        // the app's own seat map now answers "who holds Alice?" with the joiner themselves.
        useTab('impostor');
        const impostor = makeSeat('impostor', 'Alice');
        seats.push(impostor);
        impostor.attach(newClientLobby(impostor));
        let err = null;
        try {
            const p = impostor.lobby.joinRoom(code, 'Alice');
            await vi.advanceTimersByTimeAsync(80);
            await p;
        } catch (e) { err = e; }
        await vi.advanceTimersByTimeAsync(50);

        const told = (err && err.reason) ||
            (impostor.received.find(m => m.type === 'join-error') || {}).reason;
        expect(
            told,
            'the guard that says the host\'s seat is never claimable from the wire was ' +
            'skipped: the joiner\'s own seeded record answered the "is this already ours?" ' +
            'question for a name whose owner has no record of their own'
        ).toBe('Name already taken');
        expect(app.players, 'the impostor was seated into the host\'s roster slot')
            .toEqual(['Alice', 'Bob', 'Carol']);

        // ...and the host can still answer their own round. Sharing the seat makes the
        // host's Submit a silent no-op for every round the other tab answers first.
        try { impostor.lobby.sendToHost({ type: 'answer', answer: 'stolen', round: 1 }); } catch (e) {}
        await vi.advanceTimersByTimeAsync(40);
        await hostAnswers('mine');
        expect(
            app.answers.Alice,
            'the host\'s own answer was silently dropped: another tab already occupied their slot'
        ).toBe('mine');
    });

    /* ── 2. a departure is spent on a clientId, not on a name ──────── */

    it('does not write off a returned player when an abandoned clientId\'s window expires', async () => {
        const code = await roundInProgress();
        const [phone] = seats;

        // Bob's phone dies for good and his seat is released.
        const frozen = freezePage(phone.lobby.client);
        await vi.advanceTimersByTimeAsync(150000);
        expect([...app.disconnectedPlayers]).toEqual(['Bob']);

        // He picks up a laptop: a new clientId under the same name, and he is seated.
        const laptop = await joinAs('bob-laptop', 'Bob', code);
        expect([...app.disconnectedPlayers]).toEqual([]);

        // The laptop's wifi then drops, so a fresh reconnect window is armed for IT...
        const laptopFrozen = freezePage(laptop.lobby.client);
        await vi.advanceTimersByTimeAsync(25000);
        expect([...app.awayPlayers], 'precondition: the laptop is the away seat').toEqual(['Bob']);

        // ...and the phone comes back out of the tunnel while the laptop is still absent, so
        // nothing is holding the name and Bob is seated on his original clientId again.
        frozen.wake();
        frozen.deliverBufferedMessages();
        frozen.resumeTimers();
        await vi.advanceTimersByTimeAsync(20000);
        expect([...app.awayPlayers], 'precondition: Bob is connected again').toEqual([]);
        expect([...app.disconnectedPlayers]).toEqual([]);

        // Now the LAPTOP's window expires. It is a departure for a clientId nobody is using.
        await vi.advanceTimersByTimeAsync(150000);

        expect(
            [...app.disconnectedPlayers],
            'an expiring window for an abandoned clientId was spent on the NAME, so the ' +
            'player sitting there on another connection was written off: the round then ' +
            'closes without waiting for him and End Game deletes him from the roster'
        ).toEqual([]);
        expect(app.players).toEqual(['Alice', 'Bob', 'Carol']);

        // He is still playing: his answer is taken and the round closes on it.
        await seatAnswers(phone, 'dog', 1);
        expect(app.answers.Bob).toBe('dog');
        laptopFrozen.wake();
    });

    /* ── 3. a host reload is not a goodbye ─────────────────────────── */

    it('does not close the room on unload: a reloading host is not an ending host', async () => {
        const code = await roundInProgress();
        const [bob] = seats;

        // The host pulls to refresh. beforeunload fires; the tab's JavaScript then stops.
        for (const fn of unloadHandlers.slice()) fn({});
        await vi.advanceTimersByTimeAsync(50);

        expect(
            bob.states,
            'the host said goodbye on its way out of a RELOAD: room-closed is terminal, so ' +
            'every player stops reconnecting and clears the session that would have walked ' +
            'them back into the room the host is about to re-adopt'
        ).not.toContain('room-closed');

        // The tab comes back: same sessionStorage, so createRoom() re-adopts the same code.
        try { app.lobby.destroy(); } catch (e) {}
        reloadDom();
        useTab('host');
        app = loadHerdApp();
        const again = await hostGame();
        expect(again, 'sloplobby must re-adopt the room code the players are dialling').toBe(code);

        // Bob's ladder is still running, and walks back in.
        await vi.advanceTimersByTimeAsync(30000);
        expect(
            app.players,
            'the player never came back: their ladder had been stopped by the goodbye'
        ).toContain('Bob');
    });

    /* ── 4. the app as a PLAYER ────────────────────────────────────── */

    /** A minimal herd-shaped host the app can join. */
    function makePlainHost(opts) {
        const o = opts || {};
        const state = { lobby: null, clientIds: [], received: [] };
        state.lobby = new SlopLobby({
            roomPrefix: 'herdm-',
            storageKey: o.storageKey || 'plain-host-id',
            onHostData: (clientId, data) => { state.received.push(data); },
            onPlayerJoined: (clientId, metadata) => {
                state.clientIds.push(clientId);
                if (o.greet) { o.greet(state, clientId, metadata); return; }
                state.lobby.send(clientId, {
                    type: 'joined', name: metadata.name,
                    players: ['Host', metadata.name], scores: {}, cowHolder: null, away: [],
                });
            },
        });
        return state;
    }

    async function plainHostRoom(opts) {
        useTab('plain-host');
        const host = makePlainHost(opts);
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        host.code = await creating;
        seats.push({ lobby: host.lobby });
        return host;
    }

    async function appJoins(code, name = 'Bob') {
        useTab('player');
        $('join-name-input').value = name;
        $('join-code-input').value = code;
        $('btn-join-go').click();
        await vi.advanceTimersByTimeAsync(100);
    }

    it('keeps the session when a Rejoin cannot reach the host', async () => {
        const host = await plainHostRoom();
        await appJoins(host.code, 'Bob');
        useTab('player');
        expect(globalThis.sessionStorage.getItem('herd-session'), 'precondition').toBeTruthy();

        // The host tab is reloading: its peer is gone for a few seconds, and the player taps
        // Rejoin during that window.
        host.lobby.destroy();
        await vi.advanceTimersByTimeAsync(20);
        $('btn-rejoin').click();
        await vi.advanceTimersByTimeAsync(30000);

        useTab('player');
        expect(
            globalThis.sessionStorage.getItem('herd-session'),
            'one failed attempt threw away the saved session, so the Rejoin button and the ' +
            'auto-rejoin on reload are both gone while the seat is still being held'
        ).toBeTruthy();
        expect(
            $('removed-banner').classList.contains('visible'),
            'the player was left on the home screen with nothing to tap'
        ).toBe(true);
    });

    /* ── 5. an answer the host already holds ───────────────────────── */

    it('confirms a resent answer it already holds instead of refusing it', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        // Bob's link drops with his answer still in the outbound queue; it is delivered when
        // his ladder gets back — AFTER the host has answered the rejoin with a snapshot
        // composed before it arrived.
        bob.lobby.client._connected = false;
        bob.lobby.sendToHost({ type: 'answer', answer: 'dog', round: 1 });
        const before = bob.received.length;
        bob.lobby.client._connected = true;
        bob.lobby.client.connection.close();
        await vi.advanceTimersByTimeAsync(8000);

        const snapshot = bob.received.slice(before).find(m => m.type === 'rejoin');
        expect(snapshot, 'the returning tab was never sent the round state').toBeTruthy();
        expect(app.answers.Bob, 'the queued answer must land').toBe('dog');
        expect(
            snapshot.hasAnswered,
            'precondition: the snapshot was composed before the queued answer was ingested, ' +
            'which is what makes an honest client resend it'
        ).toBe(false);

        // The round closes on the answer the host does hold.
        await seatAnswers(carol, 'cat');
        await hostAnswers('fish');
        expect(app.gamePhase).toBe('merge');

        // ...and only now does the resend the snapshot asked for arrive.
        bob.rejected.length = 0;
        await seatAnswers(bob, 'dog', 1);

        expect(
            bob.rejected,
            'the host refused a copy of the answer it is holding and scoring, so the player ' +
            'is told "the host closed the round before your answer arrived" and their tick ' +
            'is taken away for an answer that is in'
        ).toEqual([]);
        expect(bob.acked, 'a resend must be confirmed').toContain(1);
        expect(app.answers.Bob, 'first write wins').toBe('dog');
    });

    /* ── 6. a reopened round ───────────────────────────────────────── */

    it('does not snatch the tick away for a progress broadcast sent after a reopen', async () => {
        const host = await plainHostRoom();
        await appJoins(host.code, 'Bob');
        const cid = host.clientIds[0];

        host.lobby.send(cid, { type: 'question', round: 1, label: 1, question: 'Best biscuit?' });
        await vi.advanceTimersByTimeAsync(120);
        expect(app.currentScreen).toBe('player-answer-screen');

        // The host reveals early and then goes back to answering: nobody has answered yet, so
        // the reopen hands the box back and the round is now flagged as interrupted.
        host.lobby.send(cid, { type: 'round-closed', round: 1 });
        host.lobby.send(cid, { type: 'reopen', round: 1, hasAnswered: false });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('player-answer-screen');

        // Bob answers the reopened round.
        $('pa-input').value = 'hobnob';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('player-waiting-screen');

        // Somebody else answers a moment later, so the host's progress was composed while
        // Bob's answer was still on the wire. It says nothing about it.
        host.lobby.send(cid, { type: 'progress', answered: ['Host'], total: 2, round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            app.currentScreen,
            'the interruption flag stayed latched for the whole reopened round, so every ' +
            'progress broadcast that crossed an answer read as "your answer was binned" and ' +
            'put the box back'
        ).toBe('player-waiting-screen');
        expect(app.myAnswer).toEqual({ round: 1, answer: 'hobnob' });
    });

    /* ── 7. a round counter belongs to one room ────────────────────── */

    it('does not measure a new room\'s snapshot against the last room\'s round counter', async () => {
        const first = await plainHostRoom({ storageKey: 'plain-host-a' });
        await appJoins(first.code, 'Bob');
        const cidA = first.clientIds[0];
        first.lobby.send(cidA, { type: 'question', round: 8, label: 8, question: 'Room A, round 8?' });
        await vi.advanceTimersByTimeAsync(120);
        expect(app.roundNumber).toBe(8);

        // Bob's table finishes and he joins the room next door, which is only on round 5 —
        // and whose host already knows this clientId, so it re-seats him with a snapshot
        // rather than greeting him as new.
        const second = await plainHostRoom({
            storageKey: 'plain-host-b',
            greet: (state, clientId) => {
                state.lobby.send(clientId, {
                    type: 'rejoin', name: 'Bob', players: ['Host', 'Bob'], scores: {},
                    cowHolder: null, away: [], gamePhase: 'answering', round: 5, label: 5,
                    question: 'Room B, round 5?', hasAnswered: false,
                });
            },
        });
        await appJoins(second.code, 'Bob');
        await vi.advanceTimersByTimeAsync(200);

        expect(
            app.roundNumber,
            'the counter from the previous ROOM survived the join, so the new host\'s ' +
            'snapshot looked like a replay and was discarded — the only message that could ' +
            'have painted a screen'
        ).toBe(5);
        expect(
            app.currentScreen,
            'the player was left on the connecting spinner in a room they are seated in'
        ).toBe('player-answer-screen');
    });

    /* ── 8. two devices, two clocks ────────────────────────────────── */

    it('judges a moo without comparing clocks across devices', async () => {
        const host = await plainHostRoom();
        await appJoins(host.code, 'Bob');
        const cid = host.clientIds[0];
        host.lobby.send(cid, { type: 'question', round: 1, label: 1, question: 'Best biscuit?' });
        await vi.advanceTimersByTimeAsync(120);
        expect(app.currentScreen).toBe('player-answer-screen');

        // The host's phone is a minute behind this one — an ordinary, undetectable amount for
        // two handsets that have not been synced. The nudge is live all the same.
        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: Date.now() - 60000 });
        await vi.advanceTimersByTimeAsync(30);
        expect(
            audio.moos,
            'a live nudge was binned as stale because the host\'s clock reads differently'
        ).toBe(1);

        // And the other way round: the host's clock is a minute AHEAD, and this moo really is
        // a replay — it was held for the seat across an outage and flushed on the way back.
        app.lobby.client.connection.close();
        await vi.advanceTimersByTimeAsync(60);
        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: Date.now() + 60000 });
        await vi.advanceTimersByTimeAsync(8000);

        expect(app.currentScreen).toBe('player-answer-screen');
        expect(app.roundNumber).toBe(1);
        expect(
            audio.moos,
            'a moo held across the outage sounded on the far side of it: a stamp from the ' +
            'host\'s clock cannot be compared with ours, and one that reads ahead of ours ' +
            'passes every freshness test there is'
        ).toBe(1);
    });
});
