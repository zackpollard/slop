/**
 * herd-mentality — the SHIPPED script, driven end to end.
 *
 * Every test below loads the real inline <script> out of
 * projects/herd-mentality/index.html (never a transcription of it) and runs it against a
 * DOM stub and the real SlopNet/SlopLobby, with only the Peer transport injected. The
 * assertions are therefore about the game people play. The harness itself lives in
 * herd-app-harness.js, shared with attack-herd-mentality.test.js.
 *
 * Coverage, one per fault the audit found in this file:
 *   - a fast rejoin the host never saw as a departure still gets the round's state
 *   - a latecomer during 'answering' is sent the question, and the round still closes
 *   - a stale answer (previous round, or a phase that has moved on) is ignored, and a
 *     round's points are awarded exactly once however often the host confirms
 *   - a temporary drop does NOT close the round; the seat being released for good does
 *   - a refused join tears the client down instead of dialling for ever
 *   - a moo for a round the player is no longer answering is not played, and the whole
 *     page shares ONE AudioContext
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    $, audio, resetRegistry, useTab, installBrowserGlobals, restoreGlobals, reloadDom,
    loadHerdApp, makeSeat, newClientLobby, freezePage, SlopLobby,
} from './herd-app-harness.js';

/**
 * An AudioContext with iOS/WebKit's actual autoplay behaviour, which the harness's default
 * stub deliberately does not model: `resume()` resolves but does NOT start the context
 * unless there has been a real user activation, `currentTime` is frozen while it is
 * suspended, and the only announcement that it finally started is a 'statechange' event.
 */
class GestureGatedAudioContext {
    constructor() {
        GestureGatedAudioContext.built.push(this);
        this.state = 'suspended';
        this.currentTime = 0;         // frozen: a suspended context's clock does not run
        this.destination = {};
        this.scheduled = 0;           // moos actually built on this context
        this._listeners = [];
    }
    addEventListener(type, fn) { if (type === 'statechange') this._listeners.push(fn); }
    removeEventListener(type, fn) { this._listeners = this._listeners.filter(f => f !== fn); }
    resume() { return Promise.resolve(); }             // asked, but not granted
    /** The player finally taps something, so the platform lets the context run. */
    startFromUserGesture() {
        this.state = 'running';
        for (const fn of this._listeners.slice()) fn();
    }
    createOscillator() {
        return {
            type: '', onended: null,
            frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} },
            connect() {}, start() {}, stop() {},
        };
    }
    createGain() {
        this.scheduled++;             // exactly one gain node per moo
        return {
            gain: {
                setValueAtTime() {}, linearRampToValueAtTime() {},
                exponentialRampToValueAtTime() {},
            },
            connect() {}, disconnect() {},
        };
    }
}
GestureGatedAudioContext.built = [];

describe('herd-mentality (the shipped script)', () => {
    let app, seats;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        audio.contexts = 0;
        audio.moos = 0;
        installBrowserGlobals();
        app = loadHerdApp();
        seats = [];
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) {}
        for (const s of seats) { try { s.lobby && s.lobby.destroy(); } catch (e) {} }
        vi.useRealTimers();
        restoreGlobals();
    });

    /* ── driving the app as HOST ───────────────────────────────────── */

    async function hostGame(name = 'Alice') {
        useTab('host');
        $('host-name-input').value = name;
        $('btn-create-go').click();
        await vi.advanceTimersByTimeAsync(80);
        expect(app.roomCode, 'the host never got a room code').toBeTruthy();
        return app.roomCode;
    }

    async function joinAs(tabName, displayName, code) {
        useTab(tabName);
        const seat = makeSeat(tabName, displayName);
        seats.push(seat);
        seat.attach(newClientLobby(seat));
        const p = seat.lobby.joinRoom(code, displayName);
        await vi.advanceTimersByTimeAsync(80);
        await p;
        return seat;
    }

    /** The same tab, reloaded: same clientId, same seat token, brand-new client. */
    async function reloadTab(seat) {
        useTab(seat.tabName);
        const fresh = newClientLobby(seat);
        const old = seat.lobby;
        seat.lobby = fresh;
        seats.push({ lobby: old });        // torn down in afterEach
        const p = fresh.joinRoom(app.roomCode, seat.name);
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
        expect(app.players).toEqual(['Alice', 'Bob', 'Carol']);
        await startGame();
        expect(app.gamePhase).toBe('question');
        await sendQuestion();
        expect(app.gamePhase).toBe('answering');
        return code;
    }

    /* ── control: the game people actually play ────────────────────── */

    it('control: three players answer, the host merges and the round scores once', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        expect(bob.question, 'the question never reached Bob').toBeTruthy();
        expect(bob.round).toBe(1);

        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        expect(app.gamePhase, 'the round closed before the host had answered').toBe('answering');
        await hostAnswers('dog');

        expect(app.gamePhase).toBe('merge');
        expect(app.mergeGroups.length).toBe(1);

        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        expect(app.gamePhase).toBe('results');
        expect(app.scores).toEqual({ Alice: 1, Bob: 1, Carol: 1 });
        expect(bob.received.filter(m => m.type === 'results').length).toBe(1);
        expect(bob.acked, 'the host never acked the answer').toEqual([1]);
    });

    /* ── rejoin ────────────────────────────────────────────────────── */

    it('a fast rejoin the host never saw as a departure still gets the round state', async () => {
        await roundInProgress();
        const [bob] = seats;
        const before = bob.received.length;

        // The tab is discarded and restored before any heartbeat could convict it, so
        // slopnet announces 'client-rejoined' with no 'client-left' in front of it.
        await reloadTab(bob);

        expect(app.awayPlayers.size, 'precondition: the host never observed a departure').toBe(0);
        expect(app.disconnectedPlayers.size).toBe(0);
        expect(app.players, 'the returning player must not be seated twice')
            .toEqual(['Alice', 'Bob', 'Carol']);

        const rejoin = bob.received.slice(before).find(m => m.type === 'rejoin');
        expect(
            rejoin,
            'no state was sent at all: re-admission must be an unconditional re-seat, not a ' +
            'lookup in a set that only a previously observed departure writes to'
        ).toBeTruthy();
        expect(rejoin.gamePhase).toBe('answering');
        expect(rejoin.round).toBe(1);
        expect(rejoin.question, 'the rejoin payload carried no question').toBeTruthy();
        expect(rejoin.hasAnswered).toBe(false);

        // ...and the round still completes through the returning tab.
        await seatAnswers(bob, 'dog', rejoin.round);
        await seatAnswers(seats[1], 'dog');
        await hostAnswers('dog');
        expect(app.gamePhase).toBe('merge');
    });

    it('answers a resync-request from a client that reconnected quietly', async () => {
        await roundInProgress();
        const [bob] = seats;
        const before = bob.received.length;

        bob.lobby.sendToHost({ type: 'resync-request' });
        await vi.advanceTimersByTimeAsync(40);

        const payload = bob.received.slice(before).find(m => m.type === 'rejoin');
        expect(payload, 'resync-request must be answerable at any time').toBeTruthy();
        expect(payload.gamePhase).toBe('answering');
        expect(payload.round).toBe(1);
    });

    /* ── latecomer ─────────────────────────────────────────────────── */

    it('a latecomer during answering is sent the question and the round still closes', async () => {
        const code = await roundInProgress();
        const [bob, carol] = seats;

        const dan = await joinAs('dan', 'Dan', code);

        const types = dan.received.map(m => m.type).filter(t => t === 'joined' || t === 'rejoin');
        expect(types, "'joined' must come first, or it paints the lobby over the answer screen")
            .toEqual(['joined', 'rejoin']);
        const rejoin = dan.received.find(m => m.type === 'rejoin');
        expect(rejoin.gamePhase).toBe('answering');
        expect(rejoin.question, 'the latecomer was counted but never asked the question').toBeTruthy();
        expect([...app.roundParticipants].sort()).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);

        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        expect(app.gamePhase, 'the round closed without the player it had just asked').toBe('answering');

        await seatAnswers(dan, 'cat', rejoin.round);
        expect(app.gamePhase, 'the round never closed: the latecomer deadlocked it').toBe('merge');
    });

    it('a latecomer during results is parked, and is not waited for by the round just played', async () => {
        const code = await roundInProgress();
        const [bob, carol] = seats;
        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        await hostAnswers('cat');
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(app.gamePhase).toBe('results');

        const dan = await joinAs('dan', 'Dan', code);
        const rejoin = dan.received.find(m => m.type === 'rejoin');
        expect(rejoin.gamePhase).toBe('results');
        expect(rejoin.results, 'a player who arrives during results must be sent them').toBeTruthy();
        expect(app.roundParticipants.has('Dan')).toBe(false);
    });

    /* ── round / phase discipline ──────────────────────────────────── */

    it('ignores a late answer for a round that is over, and scores that round once', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        expect(app.gamePhase).toBe('merge');

        // The host hand-merges, then confirms.
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(app.scores).toEqual({ Alice: 1, Bob: 1, Carol: 1 });

        // A queued answer for round 1 flushes in after the round was scored.
        await seatAnswers(bob, 'late answer', 1);
        expect(
            app.gamePhase,
            'a late answer walked the round back to the merge screen and wiped the host\'s work'
        ).toBe('results');
        expect(app.scores, 'a late answer must not re-score the round').toEqual({ Alice: 1, Bob: 1, Carol: 1 });

        // And a second confirm (the host taps twice, or is thrown back) pays nothing again.
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(app.scores, 'confirming twice paid the round twice').toEqual({ Alice: 1, Bob: 1, Carol: 1 });
    });

    it('does not accept a stale round-N answer as round N+1\'s', async () => {
        await roundInProgress();
        const [bob, carol] = seats;
        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        $('rs-next-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        await sendQuestion();
        expect(app.roundNumber).toBe(2);

        await seatAnswers(bob, 'stale', 1);
        expect(
            app.answers.Bob,
            'a round-1 answer was accepted as round 2\'s and can close it early for everyone'
        ).toBeUndefined();

        await seatAnswers(bob, 'fresh', 2);
        expect(app.answers.Bob).toBe('fresh');
    });

    it('cannot spend an answer queued in the LAST game on this game\'s first round', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        // Round 1 of game 1 is played out without Bob (his phone is busy).
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        $('hw-reveal-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        $('rs-end-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        expect(app.gamePhase).toBe('lobby');

        // A brand-new game in the same room.
        await startGame();
        await sendQuestion();
        expect(
            app.roundNumber,
            'round identity must keep counting across games, or the stale answer below matches'
        ).toBe(2);
        const question = bob.received.filter(m => m.type === 'question').pop();
        expect(question.label, 'players must still be told this is Round 1 of the new game').toBe(1);

        // Bob's phone finally flushes what he typed in the previous game.
        await seatAnswers(bob, 'answer from the last game', 1);
        expect(
            app.answers.Bob,
            'a queued answer from the previous GAME was accepted as this game\'s first round: ' +
            'the round number must not restart when a new game starts'
        ).toBeUndefined();
        expect(
            bob.rejected,
            'the drop must be reported, or the phone keeps showing "Answer Submitted"'
        ).toEqual([1]);

        await seatAnswers(bob, 'fresh', 2);
        expect(app.answers.Bob).toBe('fresh');
    });

    it('tells a straggler their answer was binned when the host has already revealed', async () => {
        await roundInProgress();
        const [bob, carol] = seats;
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');

        // The host will not wait for Bob.
        $('hw-reveal-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        expect(app.gamePhase).toBe('merge');
        expect(
            bob.received.some(m => m.type === 'round-closed' && m.round === 1),
            'the answer boxes must be taken away when the round closes, or a straggler keeps ' +
            'typing into a round whose answers are binned on arrival'
        ).toBe(true);

        await seatAnswers(bob, 'badger', 1);
        expect(app.answers.Bob).toBeUndefined();
        expect(
            bob.rejected,
            'the host discarded the answer without a word, so the player believes it counted'
        ).toEqual([1]);
        expect(bob.acked).toEqual([]);
    });

    it('gives a reopened round back only to the players it asked, with the truth about each', async () => {
        await roundInProgress();
        const [bob, carol] = seats;
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        $('hw-reveal-btn').click();
        await vi.advanceTimersByTimeAsync(20);

        const bobBefore = bob.received.length;
        const carolBefore = carol.received.length;
        $('merge-back-btn').click();
        await vi.advanceTimersByTimeAsync(20);

        const bobReopen = bob.received.slice(bobBefore).find(m => m.type === 'reopen');
        const carolReopen = carol.received.slice(carolBefore).find(m => m.type === 'reopen');
        expect(bobReopen, 'the player the host has no answer for must get their box back').toBeTruthy();
        expect(bobReopen.hasAnswered).toBe(false);
        expect(
            carolReopen.hasAnswered,
            'a player who HAS answered must not be handed a blank box for it'
        ).toBe(true);
    });

    it('scores an answer of "constructor" instead of wedging the round', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        await hostAnswers('dog');
        await seatAnswers(carol, 'dog');
        await seatAnswers(bob, 'constructor');

        expect(
            { screen: app.currentScreen, groups: app.mergeGroups.length },
            'an ordinary English word that is also an Object.prototype member threw inside the ' +
            'host\'s data handler, stranding it in a phase with no screen'
        ).toEqual({ screen: 'host-merge-screen', groups: 2 });

        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        expect(app.scores).toEqual({ Alice: 1, Bob: 0, Carol: 1 });
        expect(app.cowHolder).toBe('Bob');
    });

    it('does not queue a moo for a seat that has gone quiet', async () => {
        await roundInProgress();
        const [bob, carol] = seats;
        const bobId = bob.lobby.clientId;

        // Bob's phone locks. The host cannot know yet — its heartbeat convicts at ~20s.
        const frozen = freezePage(bob.lobby.client);
        await vi.advanceTimersByTimeAsync(17000);
        expect([...app.awayPlayers], 'precondition: not convicted yet').toEqual([]);

        // Everyone else answers, so the 5s nudge is armed for Bob — and the conviction lands
        // inside those five seconds.
        await hostAnswers('dog');
        await seatAnswers(carol, 'dog');
        await vi.advanceTimersByTimeAsync(8000);
        expect([...app.awayPlayers]).toEqual(['Bob']);

        const held = app.lobby.host.clients.get(bobId);
        const queued = (held && held._messageQueue) || [];
        expect(
            queued.filter(m => m.type === 'moo'),
            'a moo queued for an absent seat is flushed on their return and moos at them for a ' +
            'round that has long since been scored'
        ).toEqual([]);

        frozen.wake();
        frozen.deliverBufferedMessages();
        await vi.advanceTimersByTimeAsync(20);
        expect(bob.moos, 'the nudge was delivered late, to a player nobody is waiting on').toBe(0);
    });

    it('keeps an absent player marked away across End Game and Start Game', async () => {
        await roundInProgress();
        const [bob] = seats;
        const [, carol] = seats;

        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        $('hw-reveal-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(20);

        // Bob's phone locks during the results.
        const frozen = freezePage(bob.lobby.client);
        await vi.advanceTimersByTimeAsync(25000);
        expect([...app.awayPlayers]).toEqual(['Bob']);

        $('rs-end-btn').click();
        await vi.advanceTimersByTimeAsync(20);

        expect(
            [...app.awayPlayers],
            'End Game cleared the away marks while SlopNet was still holding the seat, so an ' +
            'absent phone was repainted as present and counted towards the minimum'
        ).toEqual(['Bob']);
        expect($('btn-start-game').disabled, 'two present players is not enough').toBe(true);
        frozen.wake();
    });

    it('will not hand a seat that is merely away to whoever types the name', async () => {
        const code = await roundInProgress();
        const [bob] = seats;
        const bobId = bob.lobby.clientId;

        const frozen = freezePage(bob.lobby.client);
        await vi.advanceTimersByTimeAsync(25000);
        expect([...app.awayPlayers]).toEqual(['Bob']);

        useTab('impostor');
        const other = makeSeat('impostor', 'Bob');
        seats.push(other);
        other.attach(newClientLobby(other));
        let err = null;
        try {
            const p = other.lobby.joinRoom(code, 'bob');
            await vi.advanceTimersByTimeAsync(80);
            await p;
        } catch (e) { err = e; }
        await vi.advanceTimersByTimeAsync(50);

        expect(
            app.lobby.players.has(bobId),
            'a seat SlopNet is still holding was handed to a stranger, evicting the player ' +
            'whose phone had merely locked'
        ).toBe(true);
        const told = (err && err.reason) ||
            (other.received.find(m => m.type === 'join-error') || {}).reason;
        expect(told).toBe('That player is reconnecting — try again in a moment');
        frozen.wake();
    });

    it('does not hand out the question the host is still browsing, and rate-limits resync', async () => {
        const code = await hostGame();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        await startGame();
        expect(app.gamePhase).toBe('question');

        const before = bob.received.length;
        bob.lobby.sendToHost({ type: 'resync-request' });
        await vi.advanceTimersByTimeAsync(40);
        const payload = bob.received.slice(before).find(m => m.type === 'rejoin');
        expect(payload.gamePhase).toBe('question');
        expect(
            payload.question,
            'the host is still skipping and typing; a client that polls resync must not read ' +
            'the question before it is asked'
        ).toBe('');

        const after = bob.received.length;
        bob.lobby.sendToHost({ type: 'resync-request' });
        bob.lobby.sendToHost({ type: 'resync-request' });
        await vi.advanceTimersByTimeAsync(40);
        expect(
            bob.received.slice(after).filter(m => m.type === 'rejoin').length,
            'resync-request is a free amplifier without a rate limit'
        ).toBe(0);
    });

    it('rejects a name a rejoining connection made up for itself', async () => {
        const code = await roundInProgress();
        const [bob] = seats;

        // A seated client re-announces itself on the same channel under Bob's name.
        useTab('mallory');
        const mallory = await joinAs('mallory', 'Mallory', code);
        expect(app.players).toContain('Mallory');
        const malId = mallory.lobby.clientId;

        mallory.lobby.client.connection.send({
            type: '__slopnet_join', clientId: malId, metadata: { name: 'Bob' },
        });
        await vi.advanceTimersByTimeAsync(40);

        expect(
            app.lobby.players.get(malId) && app.lobby.players.get(malId).name,
            'identity must come from the host\'s own record, never from the payload'
        ).toBe('Mallory');
        expect(app.players.filter(p => p === 'Bob').length).toBe(1);
    });

    it('rejects an answer from a player the round never asked', async () => {
        const code = await roundInProgress();
        const [bob, carol] = seats;

        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        expect(app.gamePhase).toBe('merge');

        // Dan arrives during the merge: he was never asked, so the round does not wait for
        // him — and it must not take his answer either.
        const dan = await joinAs('dan', 'Dan', code);
        expect(app.roundParticipants.has('Dan')).toBe(false);
        $('merge-back-btn').click();
        await vi.advanceTimersByTimeAsync(20);

        dan.lobby.sendToHost({ type: 'answer', answer: 'sneaked in', round: app.roundNumber });
        await vi.advanceTimersByTimeAsync(40);
        expect(
            app.answers.Dan,
            'an answer from a player the round never asked was scored and could take the herd'
        ).toBeUndefined();
    });

    it('rejects a malformed or empty answer without wedging the round', async () => {
        await roundInProgress();
        const [bob] = seats;

        bob.lobby.sendToHost({ type: 'answer', answer: { evil: true }, round: 1 });
        bob.lobby.sendToHost({ type: 'answer', answer: '   ', round: 1 });
        bob.lobby.sendToHost({ type: 'answer', round: 1 });
        await vi.advanceTimersByTimeAsync(40);

        expect(app.answers).toEqual({});
        expect(app.gamePhase).toBe('answering');

        await seatAnswers(bob, '  dog  ');
        expect(app.answers.Bob, 'a valid answer must still be trimmed and stored').toBe('dog');
    });

    /* ── away vs gone ──────────────────────────────────────────────── */

    it('does not close the round on a temporary drop, but does when the seat is released', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        expect(app.gamePhase).toBe('answering');

        // Bob's phone locks. The host's heartbeat convicts him (~20s) but slopnet holds
        // the seat, so this is a 'client-left' with final=false.
        const frozen = freezePage(bob.lobby.client);
        await vi.advanceTimersByTimeAsync(25000);

        expect([...app.awayPlayers], 'a heartbeat timeout is a temporary event').toEqual(['Bob']);
        expect([...app.disconnectedPlayers]).toEqual([]);
        expect(
            app.gamePhase,
            'the round advanced past a player whose phone had merely locked'
        ).toBe('answering');
        expect(
            $('hw-progress').textContent,
            'the host must be told WHO the round is waiting on, or they have no reason to ' +
            'reach for Reveal'
        ).toBe('2 of 3 answered — waiting on Bob (reconnecting)');

        // The reconnect window expires: now he really is gone, and the table moves on.
        await vi.advanceTimersByTimeAsync(120000);
        expect([...app.disconnectedPlayers]).toEqual(['Bob']);
        expect(
            app.gamePhase,
            'a player gone for good must not hold the round open for ever'
        ).toBe('merge');

        frozen.wake();
    });

    it('lets the host reveal the answers early when a round cannot close itself', async () => {
        await roundInProgress();
        const [, carol] = seats;

        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        expect($('hw-reveal-btn').disabled).toBe(false);

        $('hw-reveal-btn').click();
        await vi.advanceTimersByTimeAsync(10);
        expect(app.gamePhase, 'the host has no way out of a round that will not close').toBe('merge');

        // ...and back again, without losing the answers already in.
        $('merge-back-btn').click();
        await vi.advanceTimersByTimeAsync(10);
        expect(app.gamePhase).toBe('answering');
        expect(Object.keys(app.answers).sort()).toEqual(['Alice', 'Carol']);
    });

    it('keeps a dropped player on the lobby roster until their seat is really released', async () => {
        const code = await hostGame();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        expect(app.players).toEqual(['Alice', 'Bob', 'Carol']);

        const frozen = freezePage(bob.lobby.client);
        await vi.advanceTimersByTimeAsync(25000);

        expect(app.players, 'a lobby blip must not delete the player outright').toEqual(['Alice', 'Bob', 'Carol']);
        expect([...app.awayPlayers]).toEqual(['Bob']);
        expect($('btn-start-game').disabled, 'an absent seat must not count towards the minimum').toBe(true);

        await vi.advanceTimersByTimeAsync(120000);
        expect(app.players, 'a released lobby seat is freed').toEqual(['Alice', 'Carol']);
        frozen.wake();
    });

    it('lets a player reclaim their own name from a new tab instead of refusing it', async () => {
        const code = await roundInProgress();
        const [bob] = seats;

        // Bob's phone dies for good; his seat is released.
        const frozen = freezePage(bob.lobby.client);
        await vi.advanceTimersByTimeAsync(150000);
        frozen.wake();
        expect([...app.disconnectedPlayers]).toEqual(['Bob']);

        // He picks up a laptop: a brand-new clientId, the same name.
        const laptop = await joinAs('bob-laptop', 'Bob', code);

        expect(app.players, 'Bob must get his own seat back, not a second one')
            .toEqual(['Alice', 'Bob', 'Carol']);
        expect([...app.disconnectedPlayers], 'the ghost must be cleared').toEqual([]);
        expect(laptop.received.some(m => m.type === 'joined')).toBe(true);
        const rejoin = laptop.received.find(m => m.type === 'rejoin');
        expect(rejoin, 'a mid-game reclaim must be handed the round state').toBeTruthy();
        expect(rejoin.gamePhase).toBe('answering');
    });

    it('caps the roster instead of letting the round grow without bound', async () => {
        const code = await hostGame();
        // Alice is seat 1; fill the room to the cap.
        for (let i = 2; i <= 16; i++) await joinAs('t' + i, 'P' + i, code);
        expect(app.players.length).toBe(16);

        useTab('overflow');
        const extra = makeSeat('overflow', 'P17');
        seats.push(extra);
        extra.attach(newClientLobby(extra));
        let err = null;
        try {
            const p = extra.lobby.joinRoom(code, 'P17');
            await vi.advanceTimersByTimeAsync(80);
            await p;
        } catch (e) { err = e; }
        await vi.advanceTimersByTimeAsync(50);

        expect(app.players.length, 'every new seat is another player the round waits for').toBe(16);
        const told = (err && err.reason) ||
            (extra.received.find(m => m.type === 'join-error') || {}).reason;
        expect(told).toBe('This game is full');
    });

    it('still refuses a name a connected player is using', async () => {
        const code = await hostGame();
        await joinAs('bob', 'Bob', code);

        useTab('impostor');
        const other = makeSeat('impostor', 'Bob');
        seats.push(other);
        other.attach(newClientLobby(other));
        let err = null;
        try {
            const p = other.lobby.joinRoom(code, 'Bob');
            await vi.advanceTimersByTimeAsync(80);
            await p;
        } catch (e) { err = e; }

        await vi.advanceTimersByTimeAsync(50);
        expect(app.players).toEqual(['Alice', 'Bob']);
        const told = (err && err.reason) ||
            (other.received.find(m => m.type === 'join-error') || {}).reason;
        expect(told).toBe('Name already taken');
    });

    /* ── the app as a PLAYER ───────────────────────────────────────── */

    /** A minimal herd-shaped host the app can join. */
    function makePlainHost(opts) {
        const state = { joins: 0, lobby: null, clientIds: [] };
        state.lobby = new SlopLobby({
            roomPrefix: 'herdm-',
            storageKey: 'plain-host-id',
            onHostData: (clientId, data) => { (opts.onData || (() => {}))(clientId, data); },
            onPlayerJoined: (clientId, metadata) => {
                state.joins++;
                if (opts.refuse) return opts.refuse;
                state.clientIds.push(clientId);
                state.lobby.send(clientId, {
                    type: 'joined', name: metadata.name,
                    players: ['Host', metadata.name], scores: {}, cowHolder: null, away: [],
                });
            },
        });
        return state;
    }

    async function appJoins(code, name = 'Bob') {
        useTab('player');
        $('join-name-input').value = name;
        $('join-code-input').value = code;
        $('btn-join-go').click();
        await vi.advanceTimersByTimeAsync(100);
    }

    it('tears the client down when the host refuses the join, and never dials again', async () => {
        useTab('plain-host');
        const host = makePlainHost({ refuse: 'Name already taken' });
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;
        seats.push({ lobby: host.lobby });

        await appJoins(code, 'Bob');

        expect($('error-banner').textContent, 'the host\'s own words must survive the bookends')
            .toBe('Name already taken');
        expect(app.lobby, 'the refused client was left running').toBeNull();
        expect(app.currentScreen).toBe('join-screen');

        const joinsAfterRefusal = host.joins;
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(
            host.joins,
            'the refused client kept dialling: every ack rewinds its backoff, so the retry ' +
            'ladder never exhausts and it eventually swaps into a live seat'
        ).toBe(joinsAfterRefusal);
    });

    it('plays a moo only for the round it is still answering, from one shared AudioContext', async () => {
        useTab('plain-host');
        const host = makePlainHost({});
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;
        seats.push({ lobby: host.lobby });

        await appJoins(code, 'Bob');
        expect(app.currentScreen).toBe('lobby-screen');
        const cid = host.clientIds[0];

        host.lobby.send(cid, { type: 'question', round: 3, question: 'Best biscuit?' });
        await vi.advanceTimersByTimeAsync(120);
        expect(app.currentScreen).toBe('player-answer-screen');
        expect(app.roundNumber).toBe(3);

        // A moo for a round that has been and gone, and one with no round at all.
        host.lobby.send(cid, { type: 'moo', round: 2 });
        host.lobby.send(cid, { type: 'moo' });
        await vi.advanceTimersByTimeAsync(30);
        expect(audio.moos, 'a stale moo was played for a round that is over').toBe(0);

        // The moo it exists for.
        host.lobby.send(cid, { type: 'moo', round: 3 });
        await vi.advanceTimersByTimeAsync(30);
        expect(audio.moos, 'the nudge the game is named after never sounded').toBe(1);

        // Once the answer is in there is nothing to nudge.
        $('pa-input').value = 'digestive';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('player-waiting-screen');
        host.lobby.send(cid, { type: 'moo', round: 3 });
        await vi.advanceTimersByTimeAsync(30);
        expect(audio.moos).toBe(1);

        expect(
            audio.contexts,
            'a context per sound leaks an audio thread each time and goes silent after a handful'
        ).toBe(1);
    });

    it('keeps its own submitted answer when the host says it has none', async () => {
        useTab('plain-host');
        const received = [];
        const host = makePlainHost({ onData: (cid, data) => received.push(data) });
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;
        seats.push({ lobby: host.lobby });

        await appJoins(code, 'Bob');
        const cid = host.clientIds[0];

        host.lobby.send(cid, { type: 'question', round: 1, question: 'Best biscuit?' });
        await vi.advanceTimersByTimeAsync(120);
        $('pa-input').value = 'hobnob';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(received.some(m => m.type === 'answer' && m.round === 1 && m.answer === 'hobnob')).toBe(true);

        // The host composes the rejoin payload before it has seen the answer — which is
        // exactly what happens when the answer is still queued on the phone.
        host.lobby.send(cid, {
            type: 'rejoin', name: 'Bob', players: ['Host', 'Bob'], scores: {}, cowHolder: null,
            away: [], gamePhase: 'answering', round: 1, question: 'Best biscuit?', hasAnswered: false,
        });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            app.currentScreen,
            'the player was handed a blank box for an answer they had already sent, and the ' +
            'retype would have been binned by first-write-wins'
        ).toBe('player-waiting-screen');
    });

    it('asks the host for the state again after a reconnect', async () => {
        useTab('plain-host');
        const received = [];
        const host = makePlainHost({ onData: (cid, data) => received.push(data) });
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;
        seats.push({ lobby: host.lobby });

        await appJoins(code, 'Bob');
        expect(app.lobby).toBeTruthy();

        // Drop the channel; the client ladder redials and is re-seated.
        app.lobby.client.connection.close();
        await vi.advanceTimersByTimeAsync(5000);

        expect(
            received.some(m => m.type === 'resync-request'),
            'after a reconnect the client must ask for the state: the host may never have ' +
            'noticed it was gone, and then it sends nothing at all'
        ).toBe(true);
    });

    /** Join the app to a plain host and put it on round 1's answer box. */
    async function playerOnAnswerScreen(opts) {
        useTab('plain-host');
        const received = [];
        const host = makePlainHost({ onData: (cid, data) => received.push(data), ...(opts || {}) });
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;
        seats.push({ lobby: host.lobby });

        await appJoins(code, 'Bob');
        const cid = host.clientIds[0];
        host.lobby.send(cid, { type: 'question', round: 1, label: 1, question: 'Best biscuit?' });
        await vi.advanceTimersByTimeAsync(120);
        expect(app.currentScreen).toBe('player-answer-screen');
        return { host, cid, received };
    }

    it('gives the box back, with the text in it, when the host says it has no answer', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        $('pa-input').value = 'digestive';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('player-waiting-screen');

        // The host reopens the round and says, for this very round, that it holds nothing
        // from Bob — his answer was binned by a reveal, or died in flight.
        host.lobby.send(cid, { type: 'reopen', round: 1 });
        host.lobby.send(cid, { type: 'progress', answered: [], total: 2, round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            app.currentScreen,
            'the player sat on "Answer Submitted" for an answer nobody held, and the round ' +
            'waited on them: progress converged in one direction only'
        ).toBe('player-answer-screen');
        expect($('pa-input').value, 'their typing must come back with the box').toBe('digestive');
        expect(app.myAnswer).toBeNull();
    });

    it('does not wipe an answer that is still queued when a progress message lands', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        // The link is down, so the submit is queued rather than sent.
        app.lobby.client._connected = false;
        $('pa-input').value = 'hobnob';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(20);
        expect(app.myAnswer).toEqual({ round: 1, answer: 'hobnob' });

        // A progress broadcast from before the answer could arrive says nothing about it.
        app.lobby.client._connected = true;
        host.lobby.send(cid, { type: 'progress', answered: [], total: 2, round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            app.myAnswer,
            'a queued answer has not reached the host yet, so "the host holds nothing from you" ' +
            'is not news — wiping it here loses the answer the library is about to deliver'
        ).toEqual({ round: 1, answer: 'hobnob' });
        expect(app.currentScreen).toBe('player-waiting-screen');
    });

    it('does not snatch the tick away for a progress broadcast that crossed the answer', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        $('pa-input').value = 'digestive';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        // Somebody else answered a moment after we tapped Submit, so the host's progress was
        // composed before ours arrived. It says nothing about an answer still on the wire.
        host.lobby.send(cid, { type: 'progress', answered: ['Host'], total: 2, round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            app.currentScreen,
            'an ordinary progress broadcast put the answer box back for a round trip: the ' +
            '"the host holds nothing from you" reading is only true once the host has told us ' +
            'it closed or reopened the round'
        ).toBe('player-waiting-screen');
        expect(app.myAnswer).toEqual({ round: 1, answer: 'digestive' });
    });

    it('shows a queued answer as saved rather than sent', async () => {
        await playerOnAnswerScreen();

        app.lobby.client._connected = false;
        $('pa-input').value = 'hobnob';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(20);

        expect($('pw-title').textContent, 'the banner and the screen must not disagree')
            .toBe('Answer Saved');
        expect($('pw-check').style.display).toBe('none');
    });

    it('says so at once when the host refuses the answer', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        $('pa-input').value = 'digestive';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        // The host had already closed the round.
        host.lobby.send(cid, { type: 'round-closed', round: 1 });
        host.lobby.send(cid, { type: 'answer-reject', round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(app.myAnswer, 'the client kept claiming an answer the host refused').toBeNull();
        expect(app.currentScreen).toBe('player-waiting-screen');
        expect($('pw-check').style.display, 'the tick must not stand for a binned answer').toBe('none');
        expect($('error-banner').textContent).toBe('The host closed the round before your answer arrived');
    });

    it('takes the answer box away when the host closes the round', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        host.lobby.send(cid, { type: 'round-closed', round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            app.currentScreen,
            'a straggler kept typing into a round whose answers are binned on arrival'
        ).toBe('player-waiting-screen');
        expect($('pw-title').textContent).toBe('Waiting for the host…');
    });

    it('believes the host when it says our answer is already in', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        // This tab never sent anything (a reload), but the host holds an answer for us.
        host.lobby.send(cid, {
            type: 'rejoin', name: 'Bob', players: ['Host', 'Bob'], scores: {}, cowHolder: null,
            away: [], gamePhase: 'answering', round: 1, label: 1, question: 'Best biscuit?',
            hasAnswered: true,
        });
        await vi.advanceTimersByTimeAsync(30);

        expect(app.currentScreen).toBe('player-waiting-screen');
        expect(
            $('pw-title').textContent,
            'the host holds their answer, so the screen must not read like it was lost'
        ).toBe('Answer Submitted');
    });

    it('re-sends an answer the host never got after a reconnect', async () => {
        const { host, cid, received } = await playerOnAnswerScreen();

        $('pa-input').value = 'hobnob';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        const sentFirst = received.filter(m => m.type === 'answer').length;
        expect(sentFirst).toBe(1);

        // It reported success but never arrived, and the host's snapshot says so.
        host.lobby.send(cid, {
            type: 'rejoin', name: 'Bob', players: ['Host', 'Bob'], scores: {}, cowHolder: null,
            away: [], gamePhase: 'answering', round: 1, label: 1, question: 'Best biscuit?',
            hasAnswered: false,
        });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            received.filter(m => m.type === 'answer' && m.answer === 'hobnob').length,
            'nothing was queued for a send that reported success, so an answer lost in flight ' +
            'is gone unless the client sends it again'
        ).toBe(2);
        expect(app.currentScreen).toBe('player-waiting-screen');
    });

    it('offers a way back in when the reconnect ladder runs out', async () => {
        useTab('plain-host');
        const host = makePlainHost({});
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;

        await appJoins(code, 'Bob');
        expect(app.currentScreen).toBe('lobby-screen');

        // The host's tab dies. The client climbs its whole ladder and gives up.
        host.lobby.destroy();
        await vi.advanceTimersByTimeAsync(400000);

        expect(app.currentScreen).toBe('home-screen');
        expect(
            $('removed-banner').classList.contains('visible'),
            'a link that merely ran out of ladder is not being thrown out of the game: the ' +
            'player must be offered the way back in'
        ).toBe(true);
        expect(
            sessionStorage.getItem('herd-session'),
            'clearing the session made a reload retype the room code by hand'
        ).toBeTruthy();
    });

    /* ── replayed host messages ────────────────────────────────────
     * Every host->client message can arrive late: SlopNet holds one for an absent seat and
     * flushes it on the reconnect, and a phone that froze runs its buffered events on thaw.
     * A message about a round the player has already left must therefore never be able to
     * move them, because "the round is over" and "here are the results" are both catastrophic
     * when applied to the round they are answering right now.
     */

    /** Move the player on to `round`, which they are answering. */
    async function playerMovesTo(host, cid, round, question) {
        host.lobby.send(cid, {
            type: 'question', round, label: round, question: question || 'Best crisp flavour?',
        });
        await vi.advanceTimersByTimeAsync(60);
        expect(app.roundNumber).toBe(round);
        expect(app.currentScreen).toBe('player-answer-screen');
    }

    it('ignores a results payload for a round it has already left', async () => {
        const { host, cid } = await playerOnAnswerScreen();
        await playerMovesTo(host, cid, 2);

        // Round 1's results, flushed out of a queue long after round 2 started.
        host.lobby.send(cid, {
            type: 'results', round: 1, hasHerd: true, cowHolder: null, scores: { Bob: 1 },
            sorted: [{ answer: 'hobnob', players: ['Host', 'Bob'] }],
        });
        await vi.advanceTimersByTimeAsync(30);

        expect(app.roundNumber, 'a replayed results payload wound the round back').toBe(2);
        expect(app.gamePhase).toBe('answering');
        expect(
            app.currentScreen,
            'stale results painted themselves over the question the player is answering'
        ).toBe('player-answer-screen');

        // The live round's results still land.
        host.lobby.send(cid, {
            type: 'results', round: 2, hasHerd: false, cowHolder: null, scores: {}, sorted: [],
        });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('results-screen');
    });

    it('ignores a rejoin snapshot older than what it already knows', async () => {
        const { host, cid } = await playerOnAnswerScreen();
        await playerMovesTo(host, cid, 4, 'Best cereal?');

        host.lobby.send(cid, {
            type: 'rejoin', name: 'Bob', players: ['Host', 'Bob'], scores: {}, cowHolder: null,
            away: [], gamePhase: 'results', round: 3, label: 3, question: 'Best biscuit?',
            hasAnswered: false, results: { sorted: [], hasHerd: false, scores: {}, cowHolder: null },
        });
        await vi.advanceTimersByTimeAsync(30);

        expect(app.roundNumber, 'an old snapshot overwrote a newer one').toBe(4);
        expect(app.currentScreen).toBe('player-answer-screen');
    });

    it('ignores a next-round from before the round it is on', async () => {
        const { host, cid } = await playerOnAnswerScreen();
        await playerMovesTo(host, cid, 2);

        // Mid-typing on round 2 when round 1's "that round is over" arrives.
        $('pa-input').value = 'salt and vinegar';
        host.lobby.send(cid, { type: 'next-round', round: 1 });
        await vi.advanceTimersByTimeAsync(30);

        expect(app.gamePhase, 'a replayed next-round ended a round that had only just begun').toBe('answering');
        expect(app.currentScreen).toBe('player-answer-screen');
        expect($('pa-input').value, 'the draft was binned by a message about an older round')
            .toBe('salt and vinegar');

        // An answer already in for this round survives it too.
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        host.lobby.send(cid, { type: 'next-round', round: 1 });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.myAnswer && app.myAnswer.round).toBe(2);

        // The one for the round we are actually on still works.
        host.lobby.send(cid, { type: 'next-round', round: 2 });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.gamePhase).toBe('question');
        expect(app.myAnswer).toBeNull();
        expect(app.currentScreen).toBe('player-waiting-screen');
    });

    it('ignores an end message from a game that is already over', async () => {
        const { host, cid } = await playerOnAnswerScreen();
        await playerMovesTo(host, cid, 15, 'Best sandwich filling?');

        // The previous game's final broadcast, delivered into the middle of this one.
        host.lobby.send(cid, { type: 'end', round: 5 });
        await vi.advanceTimersByTimeAsync(30);

        expect(app.gamePhase, 'a replayed end abandoned a live round').toBe('answering');
        expect(app.currentScreen).toBe('player-answer-screen');

        host.lobby.send(cid, { type: 'end', round: 15 });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.gamePhase).toBe('lobby');
        expect(app.currentScreen).toBe('lobby-screen');
    });

    it('takes a fresh seat from a host that restarted, whatever round it had reached', async () => {
        const { host, cid } = await playerOnAnswerScreen();
        await playerMovesTo(host, cid, 9, 'Best cereal?');

        // The host's tab reloaded: it re-adopts its remembered room code, so the ladder walks
        // back into a host whose round counter starts again from nothing. This is the one time
        // the host's round legitimately goes backwards, and it must not be read as a replay.
        host.lobby.send(cid, {
            type: 'joined', name: 'Bob', players: ['Host', 'Bob'], scores: {}, cowHolder: null, away: [],
        });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('lobby-screen');

        host.lobby.send(cid, { type: 'question', round: 1, label: 1, question: 'Best pizza topping?' });
        await vi.advanceTimersByTimeAsync(60);
        expect(
            app.roundNumber,
            'the never-go-backwards rule locked the player out of a restarted host\'s game'
        ).toBe(1);
        expect(app.currentScreen).toBe('player-answer-screen');
    });

    it('does not play a moo that was held across a reconnect', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        // Live, it sounds — this is the nudge the game is named after.
        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: Date.now() });
        await vi.advanceTimersByTimeAsync(30);
        expect(audio.moos).toBe(1);

        // Now the link drops. The host aims a moo at a seat nobody is in, SlopNet holds it,
        // and it is flushed when the ladder gets back — for a nudge about a moment that has
        // passed. Wall-clock age cannot catch this: the whole outage is seconds long.
        app.lobby.client.connection.close();
        await vi.advanceTimersByTimeAsync(60);
        const sentWhileAway = Date.now();
        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: sentWhileAway });
        await vi.advanceTimersByTimeAsync(8000);

        expect(app.currentScreen, 'the player must still be on the same round\'s box')
            .toBe('player-answer-screen');
        expect(app.roundNumber).toBe(1);
        expect(
            Date.now() - sentWhileAway,
            'the replay has to be well inside the age limit or this proves nothing'
        ).toBeLessThan(15000);
        expect(
            audio.moos,
            'a moo held across the outage sounded on the far side of it'
        ).toBe(1);

        // And a fresh one, sent now, still works.
        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: Date.now() });
        await vi.advanceTimersByTimeAsync(30);
        expect(audio.moos, 'the guard silenced the live moo as well').toBe(2);
    });

    it('reaches the same state from the progress broadcast as from the ack', async () => {
        const { host, cid } = await playerOnAnswerScreen();

        $('pa-input').value = 'hobnob';
        $('pa-submit-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        // The host sends the ack and then the progress; if the two ever swapped, this is the
        // one the client would see first — and it must leave exactly the state the ack does.
        host.lobby.send(cid, { type: 'progress', answered: ['Bob'], total: 2, round: 1 });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('player-waiting-screen');
        expect(app.myAnswer && app.myAnswer.round).toBe(1);
        expect(app.myAnswerSent, 'progress means the host holds it: that is a SENT answer').toBe(true);

        // The ack behind it changes nothing.
        host.lobby.send(cid, { type: 'answer-ack', round: 1 });
        await vi.advanceTimersByTimeAsync(30);
        expect(app.currentScreen).toBe('player-waiting-screen');
        expect(app.myAnswer && app.myAnswer.answer).toBe('hobnob');
        expect(app.myAnswerSent).toBe(true);
    });

    it('stamps the round on the messages that end one', async () => {
        await roundInProgress();
        const [bob, carol] = seats;

        await seatAnswers(bob, 'dog');
        await seatAnswers(carol, 'dog');
        await hostAnswers('dog');
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        $('rs-next-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        const next = bob.received.filter(m => m.type === 'next-round');
        expect(next.length).toBe(1);
        expect(
            next[0].round,
            'an unstamped next-round cannot be told from a replay of an older one'
        ).toBe(1);

        await sendQuestion();
        await seatAnswers(bob, 'cat');
        await seatAnswers(carol, 'cat');
        await hostAnswers('cat');
        $('merge-confirm-btn').click();
        await vi.advanceTimersByTimeAsync(30);

        $('rs-end-btn').click();
        await vi.advanceTimersByTimeAsync(30);
        const end = bob.received.filter(m => m.type === 'end');
        expect(end.length).toBe(1);
        expect(end[0].round, 'an unstamped end can abandon a later game\'s round').toBe(2);
    });

    it('tells a player who is no longer on the roster, with a way back in', async () => {
        useTab('plain-host');
        const host = makePlainHost({});
        const creating = host.lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(80);
        const code = await creating;
        seats.push({ lobby: host.lobby });

        await appJoins(code, 'Bob');
        const cid = host.clientIds[0];

        host.lobby.send(cid, { type: 'lobby', players: ['Host'], scores: {}, cowHolder: null, away: [] });
        await vi.advanceTimersByTimeAsync(30);

        expect(
            $('removed-banner').classList.contains('visible'),
            'a player dropped from the roster sat on a dead waiting screen with no way out'
        ).toBe(true);
    });

    /* ── the audio context the moo has to survive ──────────────────────
     * The player a moo is aimed at is, by construction, the one who has touched nothing
     * this round — so on iOS their AudioContext is very often still suspended when the
     * nudge lands. A suspended context does not throw and does not drop what is scheduled
     * into it: its clock is FROZEN, so every moo written into it is stored at time zero and
     * they all fire together the moment the player finally taps.
     */

    /** Swap in an AudioContext that only starts on a real user gesture. */
    function installGatedAudio() {
        GestureGatedAudioContext.built = [];
        globalThis.window.AudioContext = GestureGatedAudioContext;
        return GestureGatedAudioContext;
    }

    it('waits for a suspended audio context instead of scheduling a moo into it', async () => {
        installGatedAudio();
        const { host, cid } = await playerOnAnswerScreen();
        const ctx = GestureGatedAudioContext.built[0];
        expect(ctx, 'the join tap should have built the page\'s one audio context').toBeTruthy();
        expect(ctx.state, 'this test is only meaningful while the context is asleep').toBe('suspended');

        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: Date.now() });
        await vi.advanceTimersByTimeAsync(60);
        expect(
            ctx.scheduled,
            'the moo was written into a stopped context: nothing is heard now, and the whole ' +
            'graph fires at once whenever the player next taps'
        ).toBe(0);

        // The player taps to start typing. The round is still open and the answer is still
        // missing, so the nudge is still worth making — and now it can be heard.
        ctx.startFromUserGesture();
        await vi.advanceTimersByTimeAsync(10);
        expect(ctx.scheduled, 'the nudge the game is named after never sounded at all').toBe(1);
    });

    it('drops a moo that stopped being true while the audio context was asleep', async () => {
        installGatedAudio();
        const { host, cid } = await playerOnAnswerScreen();
        const ctx = GestureGatedAudioContext.built[0];

        host.lobby.send(cid, { type: 'moo', round: 1, sentAt: Date.now() });
        await vi.advanceTimersByTimeAsync(60);
        expect(ctx.scheduled).toBe(0);

        // The host gives up waiting and moves the table on. The phone has still not been
        // touched, so nothing has been heard.
        host.lobby.send(cid, { type: 'question', round: 2, label: 2, question: 'Best crisp flavour?' });
        await vi.advanceTimersByTimeAsync(60);
        expect(app.roundNumber).toBe(2);
        expect(app.currentScreen).toBe('player-answer-screen');

        // Now the player taps, to answer round 2.
        ctx.startFromUserGesture();
        await vi.advanceTimersByTimeAsync(10);
        expect(
            ctx.scheduled,
            'the nudge for round 1 sounded over round 2 — a stale moo replayed by the ' +
            'very tap that unfroze the context'
        ).toBe(0);

        // ...and a moo for the round they are actually on still works.
        host.lobby.send(cid, { type: 'moo', round: 2, sentAt: Date.now() });
        await vi.advanceTimersByTimeAsync(30);
        expect(ctx.scheduled, 'the guard silenced the live moo as well').toBe(1);
    });

    /* ── a host tab that reloads keeps the room, so it must keep the counter ──
     * sloplobby remembers the room code in sessionStorage, so a host tab that is reloaded —
     * or discarded and restored, which browsers do to backgrounded tabs routinely — comes
     * back as the SAME room. Every answer still sitting in a player's outbound queue is
     * stamped with a round number of the old session, and the host's ingest guard is
     * nothing but a comparison against its own counter.
     */
    it('refuses an answer queued for the round of a host session that has since reloaded', async () => {
        // Spelt out rather than reusing roundInProgress() so that every write the HOST makes
        // lands in the host tab's sessionStorage — which is the storage that survives its
        // reload, and the whole point of this test.
        const code = await hostGame();
        const bob = await joinAs('bob', 'Bob', code);
        const carol = await joinAs('carol', 'Carol', code);
        useTab('host');
        await startGame();
        await sendQuestion();
        const app1 = app;
        expect(app1.roundNumber).toBe(1);
        expect(bob.round).toBe(1);

        // Bob's link drops and he taps Submit: the answer goes into his outbound queue,
        // stamped with round 1, and waits there for a reconnect.
        bob.lobby.client.connection.close();
        await vi.advanceTimersByTimeAsync(20);
        expect(
            bob.lobby.sendToHost({ type: 'answer', answer: 'STALE', round: 1 }),
            'this test needs the answer QUEUED, not sent'
        ).toBe(false);

        // The host's tab is reclaimed by the browser: its peer dies with it, sessionStorage
        // (clientId, room code) does not. Carol's tab is closed for good.
        app1.lobby.host.destroy();
        carol.lobby.destroy();
        seats.push({ lobby: app1.lobby });

        // The host opens the page again and taps Create Room. sloplobby re-adopts the
        // remembered code, so this is the same room Bob's phone is still dialling.
        useTab('host');
        reloadDom();
        app = loadHerdApp();
        $('host-name-input').value = 'Alice';
        $('btn-create-go').click();
        await vi.advanceTimersByTimeAsync(80);
        expect(app.roomCode, 'the restarted host must land back in the same room').toBe(code);

        // A fresh table, and a game that counts "Round 1" on screen all over again.
        await joinAs('carol2', 'Carol', code);
        await joinAs('dave', 'Dave', code);
        useTab('host');
        await startGame();
        await sendQuestion();
        expect(app.gamePhase).toBe('answering');
        expect($('hw-round').textContent, 'the players are told this is round 1').toBe('Round 1');

        // Bob's phone wakes up and his ladder finds the room. He is seated as a latecomer to
        // this round — and his queued answer flushes the moment he is acked.
        await vi.advanceTimersByTimeAsync(3000);
        expect(app.players, 'Bob never got back in, so this proves nothing').toContain('Bob');
        expect(app.roundParticipants.has('Bob')).toBe(true);
        expect(
            app.answers.Bob,
            'an answer typed for a round of the PREVIOUS host session was recorded as this ' +
            'round\'s: the counter restarted with the host tab while the room did not, so the ' +
            'old stamp fitted the new round exactly'
        ).toBeUndefined();
        expect(Object.keys(app.answers)).toEqual([]);
        expect(app.gamePhase, 'and it closed the round with text nobody wrote for it').toBe('answering');
        expect(bob.rejected.length, 'the player was never told their answer was dropped')
            .toBeGreaterThan(0);
        expect(
            app.roundNumber,
            'round identity must never restart while the room lives on'
        ).toBeGreaterThan(1);
    });

    /* ── a refusal the app invited the player to fix ───────────────────
     * herd refuses a bad name by returning a string from onPlayerJoined and putting the
     * player back on the join form. SlopNet holds that reason to spend on the clientId's
     * next AUTOMATIC reconnect, so a kick sticks against a retry ladder — but the corrected
     * join carries no staleMs, so it is admitted WITHOUT spending the hold, which is then
     * left armed against a player who is now sitting in the game.
     */
    it('does not leave a corrected join\'s refusal armed against the seated player', async () => {
        const code = await hostGame();
        await joinAs('carol', 'Carol', code);

        // Bob types a name somebody at the table is already using. herd refuses, in its own
        // words, and puts him back on the join form to try again.
        useTab('bob');
        const wrong = makeSeat('bob', 'Carol');
        seats.push(wrong);
        wrong.attach(newClientLobby(wrong));
        let err = null;
        try {
            const p = wrong.lobby.joinRoom(code, 'Carol');
            await vi.advanceTimersByTimeAsync(80);
            await p;
        } catch (e) { err = e; }
        await vi.advanceTimersByTimeAsync(50);
        const told = (err && err.reason) ||
            (wrong.received.find(m => m.type === 'join-error') || {}).reason;
        expect(told).toBe('Name already taken');
        wrong.lobby.destroy();

        // Same tab — so the same clientId — with the name corrected. He is let in and plays.
        const bob = await joinAs('bob', 'Bob', code);
        expect(app.players).toEqual(['Alice', 'Carol', 'Bob']);

        // Now an ordinary blip: his phone locks, the channel drops, his own ladder dials
        // back in. That is the knock the held refusal is waiting for.
        bob.lobby.client.connection.close();
        await vi.advanceTimersByTimeAsync(4000);

        expect(
            bob.received.filter(m => m.type === 'join-error').map(m => m.reason),
            'a seated player was thrown out mid-game by the refusal from a join they had ' +
            'already corrected'
        ).toEqual([]);
        expect(bob.lobby.client && bob.lobby.client.isTerminal).toBe(false);
        expect(app.lobby.getConnectedClientIds().length, 'his seat was torn down').toBe(2);
        expect(app.players).toEqual(['Alice', 'Carol', 'Bob']);
        expect(app.awayPlayers.has('Bob'), 'he is back on the wire, not away').toBe(false);
    });
});
