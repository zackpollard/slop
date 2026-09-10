/**
 * APP TESTS — projects/flip-7/index.html (multiplayer)
 *
 * These load the REAL inline <script> out of flip-7's index.html and run it against
 * a DOM stub, so every assertion below is about the shipped game logic rather than a
 * transcription of it. SlopNet / SlopLobby are the real classes; only the Peer
 * transport is injected (`_PeerClass: MockPeer`), exactly as repro-2 and repro-6 do.
 *
 * What they pin (see docs/multiplayer-bug-audit.md, chapter "Flip 7"):
 *   - flip7-identity-from-payload ............ the sender is the CONNECTION, not data.playerName
 *   - flip7-stale-score-submit ............... a submission carries a round and a stale one is refused
 *   - flip7-lobby-blip-creates-ghost-player .. a blip in the lobby keeps the seat and is answered
 *   - flip7-rejoin-destroys-both-copies ...... rejoin-ok is a reconcile, never a wipe
 *   - flip7-peer-reset-button-evicts-self .... Leave tells the host; the seat is freed
 *   - no-room-closed-signal-on-host-destroy .. Reset says goodbye; nobody dials a dead room
 *   - flip7-nametoid-collapses-two-players ... 'Sam' and 'SAM' cannot both sit down
 *   - flip7-host-edit-voids-the-players-score  an override keeps the evidence and can be undone
 *   - flip7-peer-play-again-forks ............ a joined player cannot reset anyone's scoreboard
 *   - flip7-host-identity-locked ............. the host name field survives leaving a room
 *   - flip7-stale-clientid-ejects-live-player   an abandoned seat's window says nothing
 *   - flip7-seat-stolen-by-name .............. a vouched return outranks a typed name
 *   - flip7-own-seat-blocks-own-return ....... a dead tab does not hold your name
 *   - flip7-host-reload-closes-room .......... a refresh is not a farewell
 *   - flip7-score-cards-not-deduped .......... a hand is a set, not a multiset
 *   - flip7-gameover-stuck-after-winner-leaves  the winner leaving un-ends the game
 *   - flip7-host-override-not-pushed-to-peer .. an override the player is told about
 *   - flip7-host-reconnect-banner-overwritten . the plateau does not repaint the truth
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';
import {
    useTab, installBrowserGlobals, restoreGlobals, loadApp, makeSeat, card,
} from './flip7-app-harness.js';

describe('flip-7 multiplayer (real app script)', () => {
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

    async function joinSeat(tabName, displayName, code) {
        const seat = makeSeat(tabName, displayName);
        seats.push(seat);
        const p = seat.lobby.joinRoom(code, displayName);
        hostApp.activateDom();
        await tick(90);
        await p.then(() => {}, (err) => { seat.joinError = err; });
        return seat;
    }

    /**
     * What submitScorePeer actually puts on the wire: the round number AND the
     * monotonic epoch behind it. Overrides let a test forge a stale stamp.
     */
    function submit(seat, scoreData, overrides) {
        return seat.lobby.sendToHost(Object.assign({
            type: 'score-submit',
            round: hostApp.currentRound,
            epoch: hostApp.roundEpoch,
            scoreData: scoreData,
        }, overrides || {}));
    }

    async function startGame() {
        hostApp.activateDom();
        hostApp.el('host-start-btn').click();
        await tick(40);
    }

    /** A second phone running the REAL app, so client-side handlers are under test. */
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

    /* ── identity ─────────────────────────────────────────────────────────── */

    it('credits a score to the connection it arrived on, not to the name in the payload', async () => {
        const code = await hostRoom('Alice');
        await joinSeat('bob', 'Bob', code);
        const carol = await joinSeat('carol', 'Carol', code);
        await startGame();
        expect(hostApp.players).toEqual(['Alice', 'Bob', 'Carol']);

        // Carol's device claims to be Bob — every name is on every screen, so this is
        // one devtools line away for any player in the room.
        submit(carol, card([12, 11]), { playerName: 'Bob' });
        await tick();

        expect(
            hostApp.peerSubmissions.Bob,
            'the forged name must not be able to write Bob\'s scorecard'
        ).toBeUndefined();
        expect(hostApp.peerSubmissions.Carol).toBeTruthy();
        expect(hostApp.peerSubmissions.Carol.cards.slice().sort((a, b) => a - b)).toEqual([11, 12]);
        expect(carol.last('score-ack').round).toBe(1);
    });

    it('refuses a submission from a round that has already closed', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        submit(bob, card([5]));
        await tick();
        expect(hostApp.peerSubmissions.Bob.score).toBe(5);

        // Host closes round 1.
        hostApp.activateDom();
        hostApp.el('submit-round-btn').click();
        await tick();
        expect(hostApp.currentRound).toBe(2);

        // Bob's phone was offline and its round-1 submission only lands now.
        submit(bob, card([12, 11, 10]), { round: 1, epoch: 1 });
        await tick();

        expect(
            hostApp.peerSubmissions.Bob,
            'a stale submission must not be credited to whatever round is current'
        ).toBeUndefined();
        const rejected = bob.last('score-rejected');
        expect(rejected).toBeTruthy();
        expect(rejected.round).toBe(1);
        expect(rejected.reason).toBe('That round is over');
    });

    it('treats a submission with no round stamp as stale', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        bob.lobby.sendToHost({ type: 'score-submit', scoreData: card([9]) });
        await tick();

        expect(hostApp.peerSubmissions.Bob).toBeUndefined();
        expect(bob.last('score-rejected')).toBeTruthy();
    });

    it('is idempotent: a duplicate submission for the same round changes nothing', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        submit(bob, card([12, 11]));
        await tick();
        submit(bob, card([1]));
        await tick();

        expect(hostApp.peerSubmissions.Bob.score).toBe(23);
        expect(bob.countOf('score-ack')).toBe(2);   // acked, but not re-recorded
    });

    it('drops a payload that is not a score for this ruleset', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        submit(bob, { cards: [999], modifiers: [] });
        await tick();
        submit(bob, { cards: [3], modifiers: [], bust: 'yes' });
        await tick();

        expect(hostApp.peerSubmissions.Bob).toBeUndefined();
        expect(bob.last('score-ack')).toBeNull();
        expect(
            bob.last('score-rejected').reason,
            'the sender must not be left on a "waiting for the host" screen'
        ).toBe('That score could not be read');
    });

    /* ── lobby lifecycle ──────────────────────────────────────────────────── */

    it('keeps a player who blips in the lobby, and answers them when they come back', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        expect(hostApp.lobbyPlayers.map(p => p.name)).toEqual(['Bob']);
        expect(bob.countOf('join-ok')).toBe(1);

        // Bob's phone locks: the channel dies.
        bob.lobby.client.connection.close();
        hostApp.activateDom();
        await tick(10);

        const away = hostApp.lobbyPlayers.find(p => p.name === 'Bob');
        expect(away, 'the seat is held, so the roster keeps them').toBeTruthy();
        expect(away.away).toBe(true);
        expect(hostApp.el('host-start-btn').disabled, 'an absent player cannot make a quorum').toBe(true);

        // ...and comes back before the host taps Start.
        useTab('bob');
        await vi.advanceTimersByTimeAsync(2000);

        const back = hostApp.lobbyPlayers.find(p => p.name === 'Bob');
        expect(back).toBeTruthy();
        expect(back.away).toBe(false);
        expect(
            bob.countOf('join-ok'),
            'a rejoin into the lobby must be answered — silence is what created the ghost'
        ).toBe(2);
        expect(hostApp.el('host-start-btn').disabled).toBe(false);
    });

    it('turns a stranger away from a game that has already started', async () => {
        const code = await hostRoom('Alice');
        await joinSeat('bob', 'Bob', code);
        await startGame();

        const late = await joinSeat('late', 'Zoe', code);
        expect(hostApp.players).toEqual(['Alice', 'Bob']);
        // The library acks a join BEFORE asking the app, so a reason returned from
        // onPlayerJoined arrives as the terminal 'rejected' state plus a join-error
        // message — not as a rejected joinRoom() promise.
        expect(late.sawState('rejected'), 'the refusal must reach the player').toBe(true);
        expect(String(late.stateDetail('rejected'))).toContain('Game already in progress');
        expect(String(late.last('join-error').reason)).toContain('Game already in progress');
        expect(late.lobby.client === null || late.lobby.client.isTerminal).toBe(true);
    });

    it('refuses two names that differ only in case', async () => {
        const code = await hostRoom('Alice');
        await joinSeat('sam1', 'Sam', code);
        const clash = await joinSeat('sam2', 'SAM', code);

        expect(hostApp.lobbyPlayers.map(p => p.name)).toEqual(['Sam']);
        expect(clash.sawState('rejected')).toBe(true);
        expect(clash.stateDetail('rejected')).toBe('Name already taken');
        expect(clash.last('join-error').reason).toBe('Name already taken');

        // ...and the host cannot take a case-variant of a joiner's name either.
        hostApp.activateDom();
        hostApp.el('host-name-input').value = 'sam';
        hostApp.el('host-set-name-btn').click();
        expect(hostApp.myName).toBe('Alice');
    });

    it('re-enables the host name field after leaving a room, so a second room can be hosted', async () => {
        await hostRoom('Alice');
        expect(hostApp.myName).toBe('Alice');
        expect(hostApp.el('host-name-input').disabled).toBe(true);

        hostApp.activateDom();
        hostApp.el('host-back-btn').click();
        await tick(600);

        expect(hostApp.el('host-name-input').disabled).toBe(false);
        expect(hostApp.el('host-set-name-btn').disabled).toBe(false);
        expect(hostApp.el('host-set-name-btn').textContent).toBe('Set Name');

        const code2 = await hostRoom('Alice');
        expect(code2).toBeTruthy();
        expect(hostApp.myName, 'the name must be settable in the new room').toBe('Alice');
    });

    /* ── rejoin is a reconcile ────────────────────────────────────────────── */

    it('hands a returning player back their own submitted score', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        submit(bob, card([12, 11]));
        await tick();

        bob.lobby.client.connection.close();
        hostApp.activateDom();
        await tick(10);
        expect(hostApp.disconnectedPlayers.has('Bob')).toBe(true);

        useTab('bob');
        await vi.advanceTimersByTimeAsync(2000);

        const rejoin = bob.last('rejoin-ok');
        expect(rejoin, 'a mid-game return must be answered with the game').toBeTruthy();
        expect(rejoin.name).toBe('Bob');
        expect(rejoin.currentRound).toBe(1);
        expect(rejoin.submitted, 'the host still holds their 23 — say so').toBe(true);
        expect(rejoin.scoreData.score).toBe(23);
        expect(hostApp.disconnectedPlayers.has('Bob')).toBe(false);
        expect(hostApp.peerSubmissions.Bob.score, 'and it survives the reconnect').toBe(23);
    });

    it('does not wipe a half-entered card when rejoin-ok arrives for the same round', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        // Bob taps two cards but has NOT submitted.
        bobApp.activateDom();
        const id = bobApp.nameToId('Bob');
        bobApp.win._toggleCard(id, 12);
        bobApp.win._toggleCard(id, 11);
        expect(bobApp.roundState[id].cards).toEqual([12, 11]);

        // The host writes a slow-but-connected player off and they answer a ping, so
        // rejoin-ok arrives with nothing having gone wrong on Bob's phone.
        bobApp.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: hostApp.players, rounds: [],
            currentRound: 1, gameOver: false, ruleset: 'classic', brutal: false,
            submitted: false, scoreData: null,
        });

        expect(
            bobApp.roundState[id].cards,
            'the cards they had typed must survive a refresh for the same round'
        ).toEqual([12, 11]);
        expect(bobApp.myScoreSubmitted).toBe(false);
    });

    it('never downgrades a submitted flag within the same round', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        bobApp.el('submit-round-btn').click();     // Submit Score
        await tick();
        expect(bobApp.myScoreSubmitted).toBe(true);

        // The host computes `submitted` one message before ours reaches it.
        bobApp.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: hostApp.players, rounds: [],
            currentRound: 1, gameOver: false, ruleset: 'classic', brutal: false,
            submitted: false, scoreData: null,
        });
        expect(bobApp.myScoreSubmitted).toBe(true);
    });

    /* ── departures ───────────────────────────────────────────────────────── */

    it('frees the seat when a player leaves, and tells the others without wiping their cards', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        const carol = await joinSeat('carol', 'Carol', code);
        await startGame();

        submit(carol, card([4]));
        await tick();

        bob.lobby.sendToHost({ type: 'leave' });
        await tick();

        expect(hostApp.players).toEqual(['Alice', 'Carol']);
        expect(hostApp.lobbyPlayers.map(p => p.name)).toEqual(['Carol']);
        expect(hostApp.peerSubmissions.Bob).toBeUndefined();
        expect(bob.last('leave-ok'), 'the leaver is acked before the channel closes').toBeTruthy();

        const left = carol.last('player-left');
        expect(left, 'a dedicated message, not state-update').toBeTruthy();
        expect(left.name).toBe('Bob');
        expect(left.players).toEqual(['Alice', 'Carol']);
        expect(
            carol.last('state-update'),
            'state-update would reset every other peer\'s round card'
        ).toBeNull();
        expect(hostApp.peerSubmissions.Carol.score, 'Carol\'s score is untouched').toBe(4);
    });

    it('keeps a mid-game player and their scores when their reconnect window expires', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        bob.lobby.client.destroy();     // the tab is gone for good
        hostApp.activateDom();
        await vi.advanceTimersByTimeAsync(130000);   // past reconnectWindowMs

        expect(hostApp.players, 'their scores are part of the game').toEqual(['Alice', 'Bob']);
        expect(hostApp.disconnectedPlayers.has('Bob')).toBe(true);
    });

    /* ── ending the room ──────────────────────────────────────────────────── */

    it('says goodbye on Reset, so nobody dials a dead room', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        hostApp.el('reset-game-btn').click();
        await tick(2000);

        expect(bob.sawState('room-closed'), 'the host said the room is over').toBe(true);
        expect(bob.lobby.client === null || bob.lobby.client.isTerminal).toBe(true);

        const before = bob.states.filter(s => s.state === 'reconnecting').length;
        await vi.advanceTimersByTimeAsync(300000);   // five minutes of nothing
        const after = bob.states.filter(s => s.state === 'reconnecting').length;
        expect(
            after - before,
            'a deliberate end must not look like a tunnel: no retry ladder'
        ).toBe(0);

        expect(hostApp.gameMode).toBe('single');
        expect(hostApp.players).toEqual([]);
    });

    it('drops a peer that receives room-closed straight back to the menu, once', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();
        expect(bobApp.gameStarted).toBe(true);

        bobApp.activateDom();
        // 'disconnected' -> 'room-closed' -> 'reconnect-failed' is how the library
        // reports it; the bookends must not paint over the reason, and the middle one
        // tears the lobby down — so the sequence is driven off a captured reference.
        const peerLobby = bobApp.lobby;
        peerLobby._onStateChange('disconnected');
        peerLobby._onStateChange('room-closed', 'Host reset the game');
        peerLobby._onStateChange('reconnect-failed');

        expect(bobApp.terminalActive).toBe(true);
        expect(bobApp.lobby).toBeNull();
        expect(bobApp.el('reconnect-banner').innerHTML).toContain('Host ended the game');

        // ...and a fresh Join afterwards is not swallowed as more of the same.
        bobApp.el('join-code-input').value = code;
        bobApp.el('join-name-input').value = 'Bob';
        const p = bobApp.attemptJoin();
        await tick(20);
        expect(bobApp.terminalActive).toBe(false);
        await p;
    });

    it('ignores a backlog that lands behind the goodbye', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        const id = bobApp.nameToId('Bob');
        bobApp.win._toggleCard(id, 12);

        const peerLobby = bobApp.lobby;
        peerLobby._onStateChange('disconnected');
        peerLobby._onStateChange('room-closed', 'Host reset the game');
        peerLobby._onStateChange('reconnect-failed');
        expect(bobApp.terminalActive).toBe(true);

        // Whatever was queued behind the goodbye is delivered afterwards. None of it
        // may repaint a board the player has already been told is over.
        bobApp.handlePeerMessage({
            type: 'state-update', epoch: 5, currentRound: 4,
            players: ['Alice', 'Bob'], rounds: [{}, {}, {}],
            ruleset: 'classic', brutal: false, gameOver: false,
        });
        bobApp.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'], rounds: [{}, {}, {}],
            currentRound: 4, epoch: 5, gameOver: false, ruleset: 'classic', brutal: false,
            submitted: true, scoreData: null,
        });
        bobApp.handlePeerMessage({ type: 'play-again', players: ['Alice', 'Bob'], currentRound: 1, epoch: 9 });

        expect(bobApp.currentRound, 'the round is not advanced by a dead room').toBe(1);
        expect(bobApp.roundEpoch).toBe(1);
        expect(bobApp.myScoreSubmitted).toBe(false);
        expect(bobApp.el('reconnect-banner').innerHTML).toContain('Host ended the game');

        // ...but the host's own explanation still gets through, since that is the one
        // message whose whole job is to arrive last.
        bobApp.handlePeerMessage({ type: 'join-error', reason: 'The host removed you' });
        expect(bobApp.el('reconnect-banner').innerHTML).toContain('The host removed you');
    });

    it('ignores a game-start replayed at the epoch already in play', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        const id = bobApp.nameToId('Bob');
        bobApp.win._toggleCard(id, 12);
        bobApp.win._toggleCard(id, 11);

        // A duplicate out of a flushed backlog carries the stamp of the game we are
        // already playing. Re-running it would clear the card mid-entry.
        bobApp.handlePeerMessage({
            type: 'game-start', epoch: bobApp.roundEpoch, currentRound: 1,
            players: ['Alice', 'Bob'], ruleset: 'classic', brutal: false,
        });

        expect(bobApp.roundState[id].cards).toEqual([12, 11]);
        expect(bobApp.currentRound).toBe(1);
    });

    /* ── role gating ──────────────────────────────────────────────────────── */

    it('does not let a joined player reset anyone\'s scoreboard', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        expect(bobApp.el('play-again-btn')._classes.has('hidden')).toBe(true);
        expect(bobApp.el('new-game-btn')._classes.has('hidden')).toBe(true);
        expect(bobApp.el('reset-game-btn').textContent).toBe('Leave Game');

        // Even if the DOM were stale, the handlers must refuse.
        bobApp.el('play-again-btn').click();
        bobApp.el('new-game-btn').click();
        await tick();

        expect(bobApp.gameStarted, 'the peer stays in the game they were in').toBe(true);
        expect(bobApp.gameMode).toBe('peer');
        expect(hostApp.players).toEqual(['Alice', 'Bob']);
    });

    it('lets a peer leave through the relabelled button and frees their seat', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await joinSeat('carol', 'Carol', code);
        await startGame();

        bobApp.activateDom();
        bobApp.el('reset-game-btn').click();     // 'Leave Game'
        await tick(600);
        hostApp.activateDom();
        await tick(60);

        expect(bobApp.gameMode).toBe('single');
        expect(hostApp.players, 'the host is told, so no phantom is scored 0').toEqual(['Alice', 'Carol']);
    });

    /* ── host override custody ────────────────────────────────────────────── */

    it('keeps a player\'s submission when the host takes over, and can hand it back', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        submit(bob, card([12, 11]));
        await tick();
        expect(hostApp.peerSubmissions.Bob.score).toBe(23);

        hostApp.activateDom();
        hostApp.win._hostEditPlayer('Bob');
        expect(
            hostApp.peerSubmissions.Bob,
            'Edit must not destroy the only copy of a real score'
        ).toBeTruthy();
        expect(hostApp.roundState[hostApp.nameToId('Bob')].cards.slice().sort((a, b) => a - b))
            .toEqual([11, 12]);

        hostApp.win._hostCancelEdit('Bob');
        expect(hostApp.hostEditingPlayers.has('Bob')).toBe(false);
        expect(hostApp.peerSubmissions.Bob.score).toBe(23);
    });

    it('lets a real submission reclaim an override the host never typed into', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        hostApp.win._hostEditPlayer('Bob');       // impatient host, empty card
        expect(hostApp.hostEditingPlayers.has('Bob')).toBe(true);

        submit(bob, card([12, 11]));
        await tick();

        expect(hostApp.hostEditingPlayers.has('Bob'), 'the seat goes back to the player').toBe(false);
        expect(hostApp.peerSubmissions.Bob.score).toBe(23);
    });

    it('gives back the seats All Bust took over when it is pressed again', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        hostApp.el('all-bust-btn').click();
        expect(hostApp.hostEditingPlayers.has('Bob')).toBe(true);

        hostApp.el('all-bust-btn').click();       // the documented undo
        expect(
            hostApp.hostEditingPlayers.has('Bob'),
            'undo must release the seats, not leave them host-edited and blank'
        ).toBe(false);

        submit(bob, card([12, 11]));
        await tick();
        expect(hostApp.peerSubmissions.Bob.score).toBe(23);

        hostApp.el('submit-round-btn').click();
        await tick();
        expect(hostApp.rounds[0].Bob.score, 'their own score is what gets recorded').toBe(23);
    });

    it('tells a returning player the host is entering their score, not that they sent one', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        // Bob has typed 12+11 but not submitted; his phone goes quiet.
        bobApp.activateDom();
        const bobId = bobApp.nameToId('Bob');
        bobApp.win._toggleCard(bobId, 12);
        bobApp.win._toggleCard(bobId, 11);

        // The impatient host writes a 3 in for him.
        hostApp.activateDom();
        hostApp.win._hostEditPlayer('Bob');
        hostApp.win._toggleCard(hostApp.nameToId('Bob'), 3);

        // Bob comes back.
        bobApp.activateDom();
        bobApp.lobby.client.connection.close();
        useTab('bobapp');
        await vi.advanceTimersByTimeAsync(4000);
        hostApp.activateDom();
        await tick(200);

        bobApp.activateDom();
        expect(
            bobApp.myScoreSubmitted,
            'the host typing for them is NOT them submitting: saying so hides their ' +
            'card for the rest of the round and strands the score they meant to send'
        ).toBe(false);
        expect(bobApp.myOverridden, 'they are told what is actually happening').toBe(true);
        expect(bobApp.roundState[bobId].cards, 'their own cards survive').toEqual([12, 11]);
        expect(bobApp.el('round-actions')._classes.has('hidden'), 'Submit stays live').toBe(false);
        expect(hostApp.hostEditingPlayers.has('Bob'), 'and the override survives too').toBe(true);

        // Bob sends his real score. The host keeps its own number but keeps the
        // evidence, and 'Use their score' is the way back.
        bobApp.el('submit-round-btn').click();
        await tick(60);
        hostApp.activateDom();
        expect(hostApp.peerSubmissions.Bob.score, 'kept as evidence').toBe(23);
        expect(hostApp.hostEditingPlayers.has('Bob')).toBe(true);

        hostApp.win._hostCancelEdit('Bob');
        hostApp.el('submit-round-btn').click();
        await tick(60);
        expect(hostApp.rounds[0].Bob.score, 'the player\'s own score is recorded').toBe(23);
    });

    it('still hands back an All Bust seat after the player has blipped', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        hostApp.el('all-bust-btn').click();
        expect(hostApp.hostEditingPlayers.has('Bob')).toBe(true);

        // Bob's phone blips and returns, which used to fold the host's bust into
        // peerSubmissions as a phantom submission the undo could not clear.
        bob.lobby.client.connection.close();
        await tick(10);
        useTab('bob');
        await vi.advanceTimersByTimeAsync(3000);
        hostApp.activateDom();
        await tick(60);
        expect(
            hostApp.peerSubmissions.Bob,
            'a score the host typed is not a score the player sent'
        ).toBeUndefined();

        hostApp.el('all-bust-btn').click();     // the documented undo
        expect(hostApp.hostEditingPlayers.has('Bob')).toBe(false);

        submit(bob, card([12, 11]));
        await tick(60);
        hostApp.el('submit-round-btn').click();
        await tick(60);
        expect(hostApp.rounds[0].Bob.score).toBe(23);
    });

    it('drops a Brutal −15 aimed at a player who has left the table', async () => {
        hostApp.activateDom();
        hostApp.win._setRuleset('vengeance');
        hostApp.win._setBrutal(true);
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await joinSeat('carol', 'Carol', code);
        await startGame();

        // Alice takes seven cards (an automatic Flip 7) and aims the −15 at Bob.
        hostApp.activateDom();
        const aliceId = hostApp.nameToId('Alice');
        [1, 2, 3, 4, 5, 6, 7].forEach(n => hostApp.win._toggleCard(aliceId, n));
        hostApp.win._setFlip7Target(aliceId, 'Bob');
        expect(hostApp.roundState[aliceId].flip7Target).toBe('Bob');

        bob.lobby.sendToHost({ type: 'leave' });
        await tick(60);
        expect(hostApp.players).toEqual(['Alice', 'Carol']);
        expect(
            hostApp.roundState[aliceId].flip7Target,
            'a target who has gone home is not a target'
        ).toBeNull();

        hostApp.el('submit-round-btn').click();
        await tick(60);
        expect(
            hostApp.rounds[0].Alice.score,
            'otherwise the +15 is withheld (a target is set) and the −15 hits nobody'
        ).toBe(28 + 15);
    });

    it('answers one resync per client without broadcasting to the whole table', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        const carol = await joinSeat('carol', 'Carol', code);
        const carolUpdates = carol.countOf('lobby-update');

        bob.lobby.sendToHost({ type: 'resync-request' });
        await tick(40);
        bob.lobby.sendToHost({ type: 'resync-request' });
        bob.lobby.sendToHost({ type: 'resync-request' });
        await tick(40);

        expect(bob.countOf('join-ok'), 'one answer, not one per message').toBe(2);
        expect(
            carol.countOf('lobby-update') - carolUpdates,
            'one phone asking is no reason to re-send the roster to everyone'
        ).toBe(0);
        expect(bob.last('lobby-update'), 'the asker gets it directly').toBeTruthy();
    });

    it('takes a peer off a dead scoreboard when the host restarts', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();
        expect(bobApp.gameStarted).toBe(true);

        // The host tab reloaded: it holds the room code but no game. The library says
        // so with fresh:true, and the host answers our resync with join-ok.
        bobApp.activateDom();
        bobApp.lobby._onStateChange('reconnected', { fresh: true });

        expect(bobApp.gameStarted, 'the game we are painting no longer exists').toBe(false);
        expect(bobApp.rounds).toEqual([]);
        expect(bobApp.el('game-phase')._classes.has('hidden')).toBe(true);
        expect(bobApp.el('join-lobby-phase')._classes.has('hidden')).toBe(false);
        expect(bobApp.el('join-waiting')._classes.has('hidden')).toBe(false);

        // ...and a plain join-ok arriving on a screen that still shows a game does
        // the same, rather than leaving live controls whose taps are dropped.
        bobApp.handlePeerMessage({
            type: 'game-start', players: ['Alice', 'Bob'], currentRound: 1, epoch: 1,
            ruleset: 'classic', brutal: false,
        });
        expect(bobApp.gameStarted).toBe(true);
        bobApp.handlePeerMessage({ type: 'join-ok', name: 'Bob' });
        expect(bobApp.gameStarted).toBe(false);
        expect(bobApp.el('join-lobby-phase')._classes.has('hidden')).toBe(false);
    });

    /* ── single device is untouched ───────────────────────────────────────── */

    it('still plays a single-device game exactly as before', async () => {
        const app = loadApp('solo');
        peerApps.push(app);
        app.activateDom();
        app.win._selectMode('single');

        app.el('player-name-input').value = 'Alice';
        app.el('add-player-btn').click();
        app.el('player-name-input').value = 'Bob';
        app.el('add-player-btn').click();
        app.el('player-name-input').value = 'alice';        // case-variant
        app.el('add-player-btn').click();
        expect(app.players, 'two Alices would share one scorecard').toEqual(['Alice', 'Bob']);

        app.el('start-game-btn').click();
        expect(app.gameStarted).toBe(true);

        const aliceId = app.nameToId('Alice');
        const bobId = app.nameToId('Bob');
        expect(aliceId).not.toBe(bobId);
        app.win._toggleCard(aliceId, 12);
        app.win._toggleCard(aliceId, 11);
        app.win._toggleCard(bobId, 3);

        app.el('submit-round-btn').click();
        expect(app.rounds.length).toBe(1);
        expect(app.rounds[0].Alice.score).toBe(23);
        expect(app.rounds[0].Bob.score).toBe(3);
        expect(app.currentRound).toBe(2);

        app.el('undo-round-btn').click();
        expect(app.rounds.length).toBe(0);
        expect(app.currentRound).toBe(1);

        app.el('reset-game-btn').click();
        await tick();
        expect(app.players).toEqual([]);
        expect(app.gameStarted).toBe(false);
    });
    /* ── nothing off the wire re-rules a game in progress ─────────────────── */

    it('refuses a rejoin snapshot that re-rules the game half way through', async () => {
        const code = await hostRoom('Alice');
        hostApp.activateDom();
        hostApp.win._setRuleset('vengeance');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        expect(bobApp.ruleset, 'the lobby said Vengeance').toBe('vengeance');
        expect(bobApp.rulesetLocked, 'and the cards are on the table now').toBe(true);

        // Every scoring function branches on the ruleset, and the rounds already
        // played are only readable under the one they were played under. A snapshot
        // that says "actually this is Classic" is not a snapshot of THIS game.
        bobApp.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 40 }, Bob: { score: 40 } }],
            currentRound: 2, epoch: 2, gameOver: false,
            ruleset: 'classic', brutal: false, submitted: false, scoreData: null,
        });

        expect(bobApp.ruleset, 'the ruleset is frozen for the life of the game').toBe('vengeance');
        expect(bobApp.currentRound, 'and the whole message is dropped, not half-applied').toBe(1);
        expect(bobApp.rounds).toEqual([]);

        // Control: the same snapshot under the game's own rules IS a reconcile.
        bobApp.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 40 }, Bob: { score: 40 } }],
            currentRound: 2, epoch: 2, gameOver: false,
            ruleset: 'vengeance', brutal: false, submitted: false, scoreData: null,
        });
        expect(bobApp.currentRound).toBe(2);
        expect(bobApp.rounds.length).toBe(1);
    });

    it('drops a state-update that arrives under a different ruleset', async () => {
        const code = await hostRoom('Alice');
        hostApp.activateDom();
        hostApp.win._setRuleset('vengeance');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        // The backlog a returning phone is handed is flushed BEFORE the rejoin
        // snapshot, so an older round always arrives under whatever rules are in
        // force. If those could be switched, the flush would re-read every card.
        bobApp.activateDom();
        bobApp.handlePeerMessage({
            type: 'state-update', players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 9 }, Bob: { score: 9 } }],
            currentRound: 2, epoch: 2, gameOver: false, ruleset: 'classic',
        });
        expect(bobApp.ruleset).toBe('vengeance');
        expect(bobApp.currentRound, 'a state-update with foreign rules is not ours').toBe(1);

        // Control: the host never puts a ruleset in a state-update at all.
        bobApp.handlePeerMessage({
            type: 'state-update', players: ['Alice', 'Bob'],
            rounds: [{ Alice: { score: 9 }, Bob: { score: 9 } }],
            currentRound: 2, epoch: 2, gameOver: false,
        });
        expect(bobApp.currentRound).toBe(2);
    });

    it('ignores a replayed game-start from a game that is already history', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        hostApp.win._toggleCard(hostApp.nameToId('Alice'), 5);
        hostApp.el('submit-round-btn').click();
        await tick(60);
        bobApp.activateDom();
        expect(bobApp.currentRound).toBe(2);

        // The very first game-start, redelivered out of a queue. It carries epoch 1,
        // which is behind us — applying it would wipe the round just played and is
        // the one message allowed to change the rules.
        bobApp.handlePeerMessage({
            type: 'game-start', players: ['Alice', 'Bob'],
            currentRound: 1, epoch: 1, ruleset: 'vengeance', brutal: true,
        });
        expect(bobApp.currentRound, 'a stale game-start cannot restart a live game').toBe(2);
        expect(bobApp.rounds.length).toBe(1);
        expect(bobApp.ruleset).toBe('classic');
    });

    /* ── nothing off the wire becomes a card by accident ───────────────────── */

    it('never turns a string into a hand of cards', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        const bobId = bobApp.nameToId('Bob');
        // A spread does not care what it is spreading: [...'hello'] is five
        // one-character "cards", and one non-number makes every later sum NaN.
        bobApp.handlePeerMessage({
            type: 'rejoin-ok', name: 'Bob', players: ['Alice', 'Bob'], rounds: [],
            currentRound: 1, epoch: 1, gameOver: false, ruleset: 'classic', brutal: false,
            submitted: true,
            scoreData: { cards: 'hello', modifiers: '99', x2: 'yes', flip7: 0 },
        });

        const mine = bobApp.roundState[bobId];
        expect(mine.cards, 'a string is not a hand').toEqual([]);
        expect(mine.modifiers).toEqual([]);
        expect(mine.score, 'and nothing NaN reaches the scoreboard').toBe(0);

        // The same rule at the choke point every round entry goes through.
        expect(bobApp.snapshotEntry({ cards: 'ABC' }).cards).toEqual([]);
        expect(bobApp.snapshotEntry({ cards: { length: 3 } }).cards).toEqual([]);
        expect(bobApp.snapshotEntry({ cards: [12, '11', NaN, null, 11] }).cards).toEqual([12, 11]);
        expect(bobApp.snapshotEntry({ cards: [12, 11], x2: 'yes' }).score).toBe(46);
        expect(Number.isFinite(bobApp.snapshotEntry({ cards: 'hello', x2: true }).score)).toBe(true);
    });

    it('keeps painting the standings when the finished rounds arrive malformed', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        // `rounds` is adopted whole from the host and then indexed by player name and
        // reduced over. A null slot, or a card list that is a string, used to throw
        // out of renderGame — and a throw inside a render leaves the scoreboard
        // frozen on its last good paint with every later message dropped.
        expect(() => bobApp.handlePeerMessage({
            type: 'state-update', epoch: 2, currentRound: 2,
            players: ['Alice', 'Bob'],
            rounds: [
                null,
                'nope',
                { Alice: { cards: 'hello', modifiers: 7, score: '12' }, Bob: null },
            ],
            ruleset: 'classic', brutal: false, gameOver: false,
        })).not.toThrow();

        expect(bobApp.currentRound).toBe(2);
        expect(bobApp.rounds.length).toBe(3);
        expect(bobApp.rounds[0], 'a null round becomes an empty one').toEqual({});
        expect(bobApp.rounds[1]).toEqual({});
        // ...and the totals stay numbers rather than becoming NaN or a concatenation.
        const total = bobApp.el('standings-body').innerHTML;
        expect(total).toContain('Alice');
        expect(total).not.toContain('NaN');
    });

    /* ── a refusal is never silent, and never un-submits the wrong round ───── */

    it('keeps the replayed round submitted when a refusal from the old one lands', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        bobApp.activateDom();
        const staleEpoch = bobApp.roundEpoch;
        bobApp.el('submit-round-btn').click();
        await tick(60);

        // The host closes round 1, then takes it back: round 1 again, new epoch.
        hostApp.activateDom();
        hostApp.el('submit-round-btn').click();
        await tick(60);
        hostApp.el('undo-round-btn').click();
        await tick(60);

        bobApp.activateDom();
        expect(bobApp.currentRound).toBe(1);
        expect(bobApp.roundEpoch).toBeGreaterThan(staleEpoch);

        // Bob plays the replayed round 1 and the host has his score.
        bobApp.el('submit-round-btn').click();
        await tick(60);
        expect(bobApp.myScoreSubmitted).toBe(true);

        // NOW the refusal of the submission from the ORIGINAL round 1 turns up. Its
        // round number matches the round on screen; its epoch does not.
        bobApp.handlePeerMessage({
            type: 'score-rejected', round: 1, epoch: staleEpoch, reason: 'That round is over',
        });

        expect(
            bobApp.myScoreSubmitted,
            'a refusal from the round before the undo must not un-submit this one'
        ).toBe(true);
        expect(
            bobApp.el('toast').textContent,
            'and the player is told either way — a score the host threw away is ' +
            'never silently forgotten'
        ).toBe('That round is over');
    });

    it('tells a player their queued score was refused after the round moved on', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        // Bob's phone hands the submission to a channel that is about to die.
        bobApp.activateDom();
        bobApp.el('submit-round-btn').click();
        await tick(60);

        // The host closes the round without it and moves everyone to round 2.
        hostApp.activateDom();
        hostApp.el('submit-round-btn').click();
        await tick(60);

        bobApp.activateDom();
        expect(bobApp.currentRound).toBe(2);
        expect(bobApp.myScoreSubmitted, 'a new round is a clean card').toBe(false);

        // The queued round-1 submission finally lands and is refused.
        bobApp.handlePeerMessage({
            type: 'score-rejected', round: 1, epoch: 1, reason: 'That round is over',
        });

        expect(bobApp.myScoreSubmitted, 'round 2 is untouched').toBe(false);
        expect(bobApp.pendingSubmit, 'and the dead score is not resent forever').toBeFalsy();
        expect(
            bobApp.el('toast').textContent,
            'the player hears about the score that did not make it'
        ).toBe('That round is over');
    });

    /* ── seats belong to connections, not to names ────────────────────────── */

    it('does not re-mark a returning player disconnected when the seat they abandoned expires', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        // Bob's tab is killed. SlopNet holds seat A for the whole reconnect window.
        bob.lobby.client.destroy();
        hostApp.activateDom();
        await tick(60);
        expect(hostApp.disconnectedPlayers.has('Bob')).toBe(true);

        // He re-opens the room link. A new tab is a new clientId (sessionStorage is
        // per tab), so he arrives as a stranger and is re-seated by name.
        const bobAgain = await joinSeat('bob-tab2', 'Bob', code);
        expect(bobAgain.last('rejoin-ok'), 'his own name gets him back into the game').toBeTruthy();
        hostApp.activateDom();
        expect(hostApp.disconnectedPlayers.has('Bob')).toBe(false);

        // Two minutes later the seat he walked away from expires.
        await vi.advanceTimersByTimeAsync(130000);

        expect(
            hostApp.disconnectedPlayers.has('Bob'),
            'a dead tab\'s window says nothing about the player who is sitting there'
        ).toBe(false);
        expect(hostApp.lobbyPlayers.filter(p => p.name === 'Bob')).toHaveLength(1);
        expect(hostApp.lobbyPlayers.find(p => p.name === 'Bob').clientId)
            .toBe(bobAgain.lobby.clientId);
    });

    it('gives a mid-game seat back to the connection that owns it, not to whoever typed the name', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        submit(bob, card([12, 11]));
        await tick();
        expect(hostApp.peerSubmissions.Bob.score).toBe(23);

        // Bob's phone drops; his seat is held for the reconnect window.
        bob.lobby.client.destroy();
        hostApp.activateDom();
        await tick(60);

        // Every screen shows the roster, so anyone with the room code can type 'Bob'.
        // A returning player looks exactly like this, so the claim is allowed — but
        // it is a claim on a NAME, with nothing behind it.
        const claimant = await joinSeat('claimant', 'Bob', code);
        expect(claimant.last('rejoin-ok')).toBeTruthy();

        // Bob's own phone comes home on the clientId and seat token the host issued
        // it, which is the one thing a typed name cannot forge.
        const bobBack = await joinSeat('bob', 'Bob', code);
        hostApp.activateDom();

        expect(bobBack.last('rejoin-ok'), 'the seat is his and he is put back in it').toBeTruthy();
        expect(bobBack.last('rejoin-ok').scoreData.score, 'with his own score').toBe(23);
        expect(
            bobBack.last('join-error'),
            'he must never be told his own name is taken'
        ).toBeNull();
        expect(hostApp.players).toEqual(['Alice', 'Bob']);
        expect(hostApp.lobbyPlayers.filter(p => p.name === 'Bob')).toHaveLength(1);
        expect(hostApp.lobbyPlayers.find(p => p.name === 'Bob').clientId)
            .toBe(bobBack.lobby.clientId);
        expect(claimant.last('join-error'), 'and the claimant is told why it went').toBeTruthy();
    });

    it('does not leave a score sent by the seat\'s claimant standing on the owner\'s card', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        bob.lobby.client.destroy();
        hostApp.activateDom();
        await tick(60);

        // Somebody types 'Bob' and is seated, then submits a round as him.
        const claimant = await joinSeat('claimant', 'Bob', code);
        submit(claimant, card([1]));
        await tick();
        hostApp.activateDom();
        expect(hostApp.peerSubmissions.Bob.score).toBe(1);

        // Bob's own connection comes home and takes its seat back.
        const bobBack = await joinSeat('bob', 'Bob', code);
        hostApp.activateDom();

        expect(
            hostApp.peerSubmissions.Bob,
            'a score from a connection that did not own the seat cannot be scored as his'
        ).toBeUndefined();
        expect(
            bobBack.last('rejoin-ok').submitted,
            'and he is not told he submitted a round he never sent'
        ).toBe(false);
    });

    it('lets a player back into the LOBBY under their own name after their tab dies', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        expect(hostApp.lobbyPlayers.map(p => p.name)).toEqual(['Bob']);

        bob.lobby.client.destroy();          // the tab is gone; the seat is greyed out
        hostApp.activateDom();
        await tick(60);
        expect(hostApp.lobbyPlayers[0].away, 'the seat is held, not deleted').toBe(true);

        // He re-opens the link: a new tab, a new clientId, and the one name he is
        // sure of — which the lobby still has on screen with his dead tab's id on it.
        const bobAgain = await joinSeat('bob-tab2', 'Bob', code);
        hostApp.activateDom();

        expect(bobAgain.last('join-ok'), 'his own name must not lock him out').toBeTruthy();
        expect(bobAgain.last('join-error')).toBeNull();
        expect(hostApp.lobbyPlayers.map(p => p.name)).toEqual(['Bob']);
        expect(hostApp.lobbyPlayers[0].away).toBe(false);
        expect(hostApp.lobbyPlayers[0].clientId).toBe(bobAgain.lobby.clientId);
    });

    /* ── a reload is not a farewell ───────────────────────────────────────── */

    it('does not close the room when the host tab is only being reloaded', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        // The event a plain refresh raises — and the one the browser raises when it
        // discards a backgrounded tab it is about to restore. SlopLobby keeps the room
        // code in sessionStorage precisely so the host comes back as the SAME room.
        hostApp.activateDom();
        hostApp.win.dispatch('beforeunload');
        await tick(60);

        expect(
            bob.sawState('room-closed'),
            'a refresh must not tell the table the game is over'
        ).toBe(false);
        expect(
            bob.lobby.client.isTerminal,
            'and must not stop their phone walking back into the re-adopted room'
        ).toBe(false);
        expect(hostApp.lobby, 'the room is still the host\'s').toBeTruthy();
    });

    /* ── scores off the wire ──────────────────────────────────────────────── */

    it('refuses a hand that plays the same card twice', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        // Every value is legal on its own, and there are no more of them than the
        // ruleset has cards — but the deck cannot deal the same card twice, and the
        // card buttons toggle, so no hand this app can build holds one twice.
        // Thirteen 12s doubled, plus five tens, is 362 in a single round.
        submit(bob, card(new Array(13).fill(12), {
            x2: true, modifiers: new Array(5).fill(10),
        }));
        await tick();

        expect(hostApp.peerSubmissions.Bob, 'a 362-point round is not a hand').toBeUndefined();
        expect(bob.last('score-rejected'), 'and the sender is told, not left waiting').toBeTruthy();
        expect(hostApp.gameOver, 'nobody wins off one message').toBe(false);
    });

    it('re-opens the round when the winner leaves before the game is finished', async () => {
        const code = await hostRoom('Alice');
        const bob = await joinSeat('bob', 'Bob', code);
        await startGame();

        // Two rounds of 114 put Bob over the 200 target.
        for (let round = 0; round < 2; round++) {
            submit(bob, card([12, 11, 10, 9, 8, 7], { x2: true }));
            await tick();
            hostApp.activateDom();
            hostApp.el('submit-round-btn').click();
            await tick(40);
        }
        expect(hostApp.gameOver).toBe(true);
        expect(hostApp.el('round-section')._classes.has('hidden')).toBe(true);

        // The winner presses Leave, and their scores go with them. Nobody is over the
        // line any more, so the table has a game to carry on with.
        bob.lobby.sendToHost({ type: 'leave' });
        await tick(60);

        expect(hostApp.players).toEqual(['Alice']);
        expect(hostApp.gameOver, 'nobody has won it — the game is not over').toBe(false);
        expect(
            hostApp.el('round-section')._classes.has('hidden'),
            'and the round card is back, or there is no way to score another round'
        ).toBe(false);
    });

    /* ── the host taking a card over ──────────────────────────────────────── */

    it('tells a player when the host takes their card over, and when it is given back', async () => {
        const code = await hostRoom('Alice');
        const bobApp = await joinAsApp('bobapp', 'Bob', code);
        await startGame();

        hostApp.activateDom();
        hostApp.win._hostEditPlayer('Bob');
        await tick(40);

        bobApp.activateDom();
        expect(
            bobApp.myOverridden,
            'the host\'s number is about to beat theirs — they have to be told'
        ).toBe(true);

        hostApp.activateDom();
        hostApp.win._hostCancelEdit('Bob');
        await tick(40);

        bobApp.activateDom();
        expect(bobApp.myOverridden, 'and told again when their card is their own').toBe(false);
    });

    /* ── the host's own signalling socket ─────────────────────────────────── */

    it('keeps the host\'s "still trying" banner up while the ladder knocks at the plateau', async () => {
        const code = await hostRoom('Alice');
        hostApp.activateDom();

        // The signalling socket dies and somebody else is holding our id, so every
        // rung of the ladder fails and the host reaches 'reconnect-failed'.
        hostApp.lobby.host.peer.simulateDisconnect();
        const blocker = new MockPeer('flip7-' + code);   // the id is taken the moment it frees
        await vi.advanceTimersByTimeAsync(130000);

        const banner = hostApp.el('reconnect-banner');
        expect(banner.innerHTML).toContain('Lost connection to the server');
        expect(banner.innerHTML).toContain('players already in the room can keep playing');

        // The ladder never gives up, so 'reconnecting' keeps arriving. It must not
        // paint a spinner over the one message that says what to do.
        await vi.advanceTimersByTimeAsync(30000);
        expect(banner.innerHTML).toContain('Lost connection to the server');

        blocker.destroy();
    });
});
