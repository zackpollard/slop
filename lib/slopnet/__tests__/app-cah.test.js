/**
 * Cards Against Humanity — app-level regression suite.
 *
 * Every test drives the REAL inline <script> from projects/cards-against-humanity/index.html
 * (see cah-app-harness.js) against real SlopNet/SlopLobby with the mock Peer transport, so
 * what is asserted here is the shipped game logic: the host's guards, the roster's
 * mark-don't-delete rules, the czar rotation, and the one 'resync' snapshot.
 *
 * The bugs each block pins are named in its own comment; the full backlog is
 * docs/multiplayer-bug-audit.md under "# Cards Against Humanity".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import {
    installBrowserGlobals, restoreGlobals, useTab, loadCahApp, makeSeat, seatSubmits, el,
} from './cah-app-harness.js';

describe('CAH app', () => {
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

    async function hostGame(scoreLimit = '7') {
        useTab('host');
        el('player-name').value = 'Alice';
        el('score-limit').value = scoreLimit;
        const p = app.createGame();
        await tick(50);
        await p;
        return app.state.gameCode;
    }

    /** One phone taps the link. `clientId`, when given, is what that tab claims to be. */
    async function joinAs(tabName, displayName, code, clientId) {
        useTab(tabName);
        if (clientId !== undefined) globalThis.sessionStorage.setItem('cah-client-id', clientId);
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

    /** Alice hosts; Bob, Carol and Dan join; the game starts. Round-1 czar is Alice. */
    async function fourPlayerGame(scoreLimit) {
        const code = await hostGame(scoreLimit);
        await joinAs('bob-phone', 'Bob', code);
        await joinAs('carol-phone', 'Carol', code);
        await joinAs('dan-phone', 'Dan', code);
        expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
        app.startGame();
        await tick(80);
        expect(app.state.phase).toBe('playing');
        return code;
    }

    const seatByName = (name) => seats.find(s => s.name === name);
    const sameNameish = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    const idOf = (name) => app.state.players.find(p => p.name === name).id;

    /** The host plays their own cards, through the real click path (selectCard/submitCards). */
    async function hostSubmits() {
        if (app.state.czarId === app.state.myId) return;
        if (app.state.submissions[app.state.myId]) return;
        const pick = (app.state.currentBlack && app.state.currentBlack.p) || 1;
        for (let i = 0; i < pick; i++) app.selectCard(i);
        app.submitCards();
        await tick(20);
    }

    /** Everyone who is connected, is not the czar and has not played yet, plays. */
    async function othersSubmit(skip = []) {
        if (!skip.includes('Alice')) await hostSubmits();
        for (const seat of seats) {
            if (skip.includes(seat.name)) continue;
            if (!seat.lobby.client || seat.lobby.client.isTerminal) continue;
            if (seat.lobby.clientId === app.state.czarId) continue;
            if (app.state.submissions[seat.lobby.clientId]) continue;
            seatSubmits(seat);
            await tick(30);
        }
        await tick(40);
    }

    /**
     * The opaque key a client czar would tap for `winnerName`'s card.
     *
     * A client never learns who wrote what: it finds the card on its own grid and sends the
     * per-round key the host minted for it. This helper does the same lookup the czar's
     * finger does — by CARD TEXT, never by author.
     */
    function keyFor(seat, winnerName) {
        const cards = app.state.submissions[idOf(winnerName)].join();
        const entry = (seat.judging || []).find(e => e.cards.join() === cards);
        expect(entry, `${winnerName}'s card must be on the czar's grid`).toBeTruthy();
        return entry.id;
    }

    /** The czar awards the round to `winnerName` (host czar taps; client czar sends). */
    async function czarPicks(winnerName) {
        if (app.state.czarId === app.state.myId) {
            const idx = app.renderedSubmissions.findIndex(e => e.id === idOf(winnerName));
            expect(idx, 'the winning card must be on the czar grid').toBeGreaterThan(-1);
            app.selectSubmission(idx);
            app.pickWinner();
        } else {
            const czarSeat = seats.find(s => s.lobby.clientId === app.state.czarId);
            czarSeat.lobby.sendToHost({
                type: 'pick-winner', round: app.state.round, playerId: keyFor(czarSeat, winnerName),
            });
        }
        await tick(50);
    }

    /* ── Departure: mark away, never delete ───────────────────────────────── */

    it('a player who drops after submitting keeps their score, hand and card, and the round still reaches judging', async () => {
        await fourPlayerGame();
        const bob = seatByName('Bob');
        const bobId = bob.lobby.clientId;

        seatSubmits(bob);
        await tick(30);
        const bobCards = app.state.submissions[bobId];
        const bobHand = app.state.hands[bobId].slice();
        expect(bobCards).toBeTruthy();

        // Bob's phone dies. SlopNet holds his seat, so this is 'client-left', not death.
        bob.lobby.destroy();
        await tick(200);

        const bobRecord = app.state.players.find(p => p.id === bobId);
        expect(bobRecord, 'the seat is marked away, never filtered out').toBeTruthy();
        expect(bobRecord.away).toBe(true);
        expect(app.state.hands[bobId], 'his hand survives — no redeal on return').toEqual(bobHand);
        expect(app.state.submissions[bobId], 'and the card he played stays judgeable').toEqual(bobCards);

        // Carol and Dan are the only eligible submitters left, so their play completes the
        // round: the gate is re-evaluated on every membership change, not only on a submit.
        await othersSubmit();
        expect(app.state.phase).toBe('judging');
        expect(app.state.submissionOrder).toContain(bobId);

        // The czar can still award the round to the absent player.
        await czarPicks('Bob');
        expect(app.state.players.find(p => p.id === bobId).score).toBe(1);
    });

    it('a departure that satisfies the quorum starts judging with nothing left to submit', async () => {
        await fourPlayerGame();
        // Carol and Dan play; Bob (who has not) walks out. Nothing else will ever look at
        // the gate his departure just satisfied.
        await othersSubmit(['Bob']);
        expect(app.state.phase).toBe('playing');

        seatByName('Bob').lobby.destroy();
        await tick(200);

        expect(app.state.phase).toBe('judging');
        expect(app.state.submissionOrder.length).toBe(2);
    });

    it('parks a lost seat and gives it back — score, hand and all — when the player reopens the game', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Bob');
        const bobId = idOf('Bob');
        expect(app.state.players.find(p => p.id === bobId).score).toBe(1);

        const bobHand = app.state.hands[bobId].slice();
        seatByName('Bob').lobby.destroy();
        await tick(200);
        // ...and stays away long enough for SlopNet to release the seat.
        await tick(130000);
        expect(app.state.players.find(p => p.id === bobId), 'seat released').toBeUndefined();
        expect(Object.keys(app.state.pastPlayers)).toContain(bobId);

        // Bob reopens the game in a NEW tab: a brand-new clientId, the same human.
        const bob2 = await joinAs('bob-laptop', 'Bob', app.state.gameCode);
        expect(bob2.joinFailure, 'a returning name is not a duplicate').toBeUndefined();

        const record = app.state.players.find(p => p.name === 'Bob');
        expect(record.id, 'the seat is rebound to the new clientId').toBe(bob2.lobby.clientId);
        expect(record.score, 'with the score intact').toBe(1);
        expect(app.state.hands[record.id], 'and the same hand').toEqual(bobHand);
        expect(bob2.resyncs.length, 'and a full snapshot to paint it with').toBeGreaterThan(0);
    });

    /* ── Czar identity ────────────────────────────────────────────────────── */

    it('moves the crown off a czar who drops, by identity and from the seat they sat in', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);

        // Round 2's czar is Bob (the seat after Alice).
        expect(app.state.round).toBe(2);
        expect(app.state.czarId).toBe(idOf('Bob'));

        const bobId = idOf('Bob');
        seatByName('Bob').lobby.destroy();
        await tick(200);

        expect(app.state.czarId, 'the crown moves to the next present player, not to seat 0')
            .toBe(idOf('Carol'));
        expect(seatByName('Carol').czarId, 'and every client is told who wears it now')
            .toBe(app.wireId(idOf('Carol')));

        // When the window finally expires the seat goes, and the crown does not go back.
        await tick(130000);
        expect(app.state.players.find(p => p.id === bobId)).toBeUndefined();
        expect(app.state.czarId).toBe(idOf('Carol'));
    });

    it('hands the crown on when the czar goes away mid-judging, and never lets them judge their own card', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);
        expect(app.state.czarId).toBe(idOf('Bob'));   // a client is czar

        // Alice, Carol and Dan play; Bob (the czar) is only watching.
        await othersSubmit();
        expect(app.state.phase).toBe('judging');
        expect(app.state.submissionOrder).toContain(idOf('Carol'));

        // Now the czar's phone dies mid-judging. The crown moves to the next present player
        // rather than freezing the table on a screen only Bob could act on.
        seatByName('Bob').lobby.destroy();
        await tick(200);
        expect(app.state.phase).toBe('judging');
        expect(app.state.czarId).toBe(idOf('Carol'));
        expect(app.state.submissionOrder, "the new czar's own answer leaves the pool")
            .not.toContain(idOf('Carol'));

        // Carol is czar now and can award the round.
        const carol = seatByName('Carol');
        carol.lobby.sendToHost({
            type: 'pick-winner', round: app.state.round, playerId: keyFor(carol, 'Dan'),
        });
        await tick(50);
        expect(app.state.phase).toBe('result');
        expect(app.state.players.find(p => p.name === 'Dan').score).toBe(1);
    });

    /* ── Host command guards ──────────────────────────────────────────────── */

    it('ignores a submit for the wrong round and one that arrives after judging began', async () => {
        await fourPlayerGame();
        await othersSubmit();
        expect(app.state.phase).toBe('judging');
        const order = app.state.submissionOrder.slice();

        // A tap the player made while their link was down, flushed after judging started.
        const dan = seatByName('Dan');
        dan.lobby.sendToHost({ type: 'submit', round: app.state.round, cards: [dan.hand[0]] });
        await tick(50);
        expect(app.state.phase, 'the pool must not be reshuffled under the czar').toBe('judging');
        expect(app.state.submissionOrder).toEqual(order);
        expect(dan.rejections.map(r => r.type)).toContain('submit-rejected');

        // ...and a stale round stamp is dropped even in the phase that would accept it.
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);
        expect(app.state.phase).toBe('playing');
        const staleRound = app.state.round - 1;
        const carol = seatByName('Carol');
        carol.lobby.sendToHost({ type: 'submit', round: staleRound, cards: [carol.hand[0]] });
        await tick(50);
        expect(app.state.submissions[carol.lobby.clientId]).toBeUndefined();
    });

    it('refuses cards the player does not hold, and messages from ids it has never seated', async () => {
        await fourPlayerGame();
        const bob = seatByName('Bob');

        const pick = (app.state.currentBlack && app.state.currentBlack.p) || 1;
        bob.lobby.sendToHost({
            type: 'submit', round: app.state.round,
            cards: Array.from({ length: pick }, () => 'A card nobody was ever dealt'),
        });
        await tick(50);
        expect(app.state.submissions[bob.lobby.clientId]).toBeUndefined();
        expect(bob.rejections[0].reason).toMatch(/not in your hand/i);

        // A malformed payload is ignored rather than thrown on.
        bob.lobby.sendToHost({ type: 'submit', round: app.state.round, cards: 'not-an-array' });
        await tick(50);
        expect(app.state.submissions[bob.lobby.clientId]).toBeUndefined();

        // Traffic under an id the host holds no seat for changes nothing.
        app.handleHostMessage('a-peer-id-nobody-seated', {
            type: 'submit', round: app.state.round, cards: [app.state.hands[bob.lobby.clientId][0]],
        });
        expect(Object.keys(app.state.submissions)).toEqual([]);
        expect(app.state.phase).toBe('playing');
    });

    it('awards a round once however many times the czar taps Pick Winner', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Dan');
        app.triggerNextRound();
        await tick(50);

        // Round 2: Bob is czar, and he is a client — his taps take a round trip, which is
        // exactly the window a second tap (or a flushed queue) used to slip through.
        await othersSubmit();
        expect(app.state.phase).toBe('judging');

        const bob = seatByName('Bob');
        const winnerId = idOf('Carol');
        const key = keyFor(bob, 'Carol');
        const broadcastsBefore = seatByName('Carol').winners.length;
        bob.lobby.sendToHost({ type: 'pick-winner', round: app.state.round, playerId: key });
        bob.lobby.sendToHost({ type: 'pick-winner', round: app.state.round, playerId: key });
        await tick(60);

        expect(app.state.players.find(p => p.id === winnerId).score).toBe(1);
        expect(seatByName('Carol').winners.length - broadcastsBefore,
            'one round-winner broadcast, not two').toBe(1);
        expect(bob.rejections.map(r => r.type)).toContain('pick-rejected');
    });

    it('refuses a pick from anyone but the czar, and a winner who never submitted', async () => {
        await fourPlayerGame();
        await othersSubmit();
        expect(app.state.phase).toBe('judging');

        const dan = seatByName('Dan');
        dan.lobby.sendToHost({ type: 'pick-winner', round: app.state.round, playerId: idOf('Dan') });
        await tick(50);
        expect(app.state.phase, 'a non-czar cannot award the round to themselves').toBe('judging');
        expect(dan.rejections[0].reason).toMatch(/Card Czar/i);

        // The czar (the host here) cannot award it to a player with no card in the pool.
        app.handleHostMessage(app.HOST_SELF, {
            type: 'pick-winner', round: app.state.round, playerId: 'nobody',
        });
        await tick(10);
        expect(app.state.phase).toBe('judging');
        expect(app.state.players.every(p => p.score === 0)).toBe(true);
    });

    it('ignores next-round once the game is over, and fires exactly one podium', async () => {
        await fourPlayerGame('1');            // first point wins
        await othersSubmit();
        await czarPicks('Bob');

        expect(app.state.phase).toBe('gameover');
        const round = app.state.round;

        // A tap that was already in flight when the limit was reached.
        const dan = seatByName('Dan');
        dan.lobby.sendToHost({ type: 'next-round', round });
        app.handleHostMessage(app.HOST_SELF, { type: 'next-round', round });
        await tick(50);
        expect(app.state.phase, 'nobody is dragged back into a round after the podium').toBe('gameover');
        expect(app.state.round).toBe(round);

        await tick(4100);
        expect(seatByName('Carol').gameOvers.length).toBe(1);
        expect(app.state.gameOverTimer, 'the 4s timer is tracked and cleared').toBeNull();
    });

    it('advances the round once when the host and the czar both tap Next Round', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);
        expect(app.state.round).toBe(2);

        // Round 2: Bob is czar. Both he and the host tap in the same breath.
        await othersSubmit();
        await czarPicks('Dan');
        expect(app.state.phase).toBe('result');
        const round = app.state.round;

        seatByName('Bob').lobby.sendToHost({ type: 'next-round', round });
        app.triggerNextRound();
        await tick(60);

        expect(app.state.round, 'one black card, one round').toBe(round + 1);
    });

    it('ignores next-round from a player who is neither the czar nor the host', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        expect(app.state.phase).toBe('result');
        const round = app.state.round;

        seatByName('Dan').lobby.sendToHost({ type: 'next-round', round });
        await tick(50);
        expect(app.state.round, 'only the czar or the host advances the round').toBe(round);
        expect(app.state.phase).toBe('result');
    });

    it('keeps the host\'s own submitted counter up to date', async () => {
        await fourPlayerGame();
        expect(el('submitted-count').textContent).toBe('0 / 3 submitted');
        seatSubmits(seatByName('Bob'));
        await tick(40);
        expect(el('submitted-count').textContent, 'the host never receives its own broadcast')
            .toBe('1 / 3 submitted');

        // An away player leaves the quorum, and the counter says so.
        seatByName('Carol').lobby.destroy();
        await tick(200);
        expect(el('submitted-count').textContent).toBe('1 / 2 submitted');
    });

    /* ── Resync ───────────────────────────────────────────────────────────── */

    it('sends a reloading player one snapshot carrying the phase, the czar and their own hand', async () => {
        await fourPlayerGame();
        const dan = seatByName('Dan');
        const danId = dan.lobby.clientId;
        seatSubmits(dan);
        await tick(40);
        await othersSubmit();
        expect(app.state.phase).toBe('judging');

        // Dan reloads: the tab is the same, so sessionStorage still holds his clientId and
        // his seat token, and the host greets him as a rejoin.
        dan.lobby.destroy();
        await tick(100);
        useTab('dan-phone');
        const dan2 = makeSeat('dan-phone', 'Dan');
        seats.push(dan2);
        const p = dan2.lobby.joinRoom(app.state.gameCode, 'Dan');
        await tick(80);
        await p;
        await tick(40);

        expect(dan2.lobby.clientId, 'a reload keeps its clientId').toBe(danId);
        const snap = dan2.resyncs[dan2.resyncs.length - 1];
        expect(snap, 'one message carries the whole game').toBeTruthy();
        expect(snap.phase).toBe('judging');
        expect(snap.round).toBe(app.state.round);
        expect(snap.czarId).toBe(app.wireId(app.state.czarId));
        expect(snap.black).toEqual(app.state.currentBlack);
        expect(snap.hand).toEqual(app.state.hands[danId]);
        expect(snap.submitted, 'and remembers that he already played').toBe(true);
        expect(snap.submissions.length).toBe(3);
        expect(snap.submissions.every(s => typeof s.id === 'string' && Array.isArray(s.cards))).toBe(true);
    });

    it('answers a resync-request from a seated player and ignores one from a stranger', async () => {
        await fourPlayerGame();
        const carol = seatByName('Carol');
        const before = carol.resyncs.length;
        carol.lobby.sendToHost({ type: 'resync-request' });
        await tick(40);
        expect(carol.resyncs.length).toBe(before + 1);
        expect(carol.resyncs[before].phase).toBe('playing');

        // Nothing is sent anywhere for an id the host holds no seat for.
        expect(() => app.handleHostMessage('ghost', { type: 'resync-request' })).not.toThrow();
    });

    it('carries the finished round in a snapshot, so a returning player sees the result', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Dan');
        expect(app.state.phase).toBe('result');

        const carol = seatByName('Carol');
        carol.lobby.sendToHost({ type: 'resync-request' });
        await tick(40);
        const snap = carol.resyncs[carol.resyncs.length - 1];
        expect(snap.phase).toBe('result');
        expect(snap.result.winnerName).toBe('Dan');
        expect(snap.result.gameOver).toBe(false);
        expect(snap.submissions.length).toBe(3);
    });

    /* ── Joining ──────────────────────────────────────────────────────────── */

    it('rejects a duplicate name with a reason the player can read', async () => {
        const code = await hostGame();
        await joinAs('bob-phone', 'Bob', code);
        const clash = await joinAs('someone-else', 'bob ', code);   // case/space insensitive

        expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob']);
        const reason = (clash.joinFailure && clash.joinFailure.reason) ||
            (clash.joinErrors[0] && clash.joinErrors[0].reason);
        expect(reason).toMatch(/already in the game/i);
        expect(clash.lobby.client === null || clash.lobby.client.isTerminal).toBe(true);
    });

    it('rejects an empty name and deals a mid-game joiner in', async () => {
        const code = await fourPlayerGame();

        const nameless = await joinAs('nameless', '   ', code);
        const reason = (nameless.joinFailure && nameless.joinFailure.reason) ||
            (nameless.joinErrors[0] && nameless.joinErrors[0].reason);
        expect(reason).toMatch(/name/i);
        expect(app.state.players.length).toBe(4);

        const eve = await joinAs('eve-phone', 'Eve', code);
        expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dan', 'Eve']);
        const snap = eve.resyncs[0];
        expect(snap.phase).toBe('playing');
        expect(snap.hand.length, 'a late joiner can play this round').toBe(10);
        expect(
            snap.needed,
            'but the round in progress is not waiting for them: Bob, Carol and Dan are the ' +
            'quorum, exactly as they were before Eve tapped the link'
        ).toBe(3);
    });

    /**
     * The other half of repro-6's deadlock, under a name nobody is holding: the duplicate-name
     * check cannot see this one at all, so the gate itself has to be safe against it.
     */
    it('never lets a mid-round joiner hold the quorum hostage', async () => {
        const code = await fourPlayerGame();

        const eve = await joinAs('eve-phone', 'Eve', code);   // a spectator friend; never plays
        expect(app.state.players.length).toBe(5);

        await othersSubmit(['Eve']);

        expect(
            app.state.phase,
            'Bob, Carol and Dan have all played — an idle seat dealt in mid-hand must not ' +
            'stall the round at 3 / 4 with only a host tap to free it'
        ).toBe('judging');
        expect(app.state.submissionOrder.length).toBe(3);
        expect(eve.lastSubmitCount).toEqual({ count: 3, needed: 3 });
    });

    it('counts a mid-round joiner who does play, and again from the next round', async () => {
        const code = await fourPlayerGame();
        const eve = await joinAs('eve-phone', 'Eve', code);

        // Eve plays the hand she was dealt: her card is judged like anyone else's.
        seatSubmits(eve);
        await tick(40);
        expect(app.state.phase).toBe('playing');
        expect(eve.lastSubmitCount).toEqual({ count: 1, needed: 4 });

        await othersSubmit();
        expect(app.state.phase).toBe('judging');
        expect(app.state.submissionOrder.length).toBe(4);

        // Next round she is simply a player: the round waits for her like everybody else.
        await czarPicks('Bob');
        app.handleHostMessage(app.HOST_SELF, { type: 'next-round', round: app.state.round });
        await tick(40);
        expect(app.state.round).toBe(2);
        await othersSubmit(['Eve']);
        expect(
            app.state.phase,
            'the seat was only late for the round it arrived in'
        ).toBe('playing');
    });

    /* ── Host escape hatches ──────────────────────────────────────────────── */

    it('lets the host force judging while a player is still thinking', async () => {
        await fourPlayerGame();
        await othersSubmit(['Dan']);
        expect(app.state.phase).toBe('playing');

        app.startJudging();          // the #btn-force-judging path
        await tick(30);

        expect(app.state.phase).toBe('judging');
        expect(app.state.submissionOrder.length).toBe(2);
        expect(seatByName('Dan').sawJudging).toBe(true);
    });

    it('lets the host skip a round that nobody can finish', async () => {
        await fourPlayerGame();
        const round = app.state.round;
        const black = app.state.currentBlack;

        app.nextRound();             // the #btn-skip-round path
        await tick(30);

        expect(app.state.round).toBe(round + 1);
        expect(app.state.currentBlack).not.toBe(black);
        expect(app.state.phase).toBe('playing');
        expect(seatByName('Bob').round).toBe(round + 1);
    });

    it('skips a round instead of opening an empty judging screen', async () => {
        await fourPlayerGame();
        const round = app.state.round;
        // Everybody who could play this black card walks out at once.
        for (const seat of seats) seat.lobby.destroy();
        await tick(300);

        expect(app.state.phase).toBe('playing');
        expect(app.state.round, 'the round moved on rather than judging an empty pool')
            .toBe(round + 1);
    });

    /* ── Identity: nothing off the wire speaks as the host ──────────────── */

    it('refuses a join that claims the host\'s own player id, and ignores wire traffic that does', async () => {
        const code = await fourPlayerGame();
        const hostId = app.state.myId;

        // The host id rides in every roster payload and announces itself with a 'host-'
        // prefix; no SlopNet seat token defends it, because the host holds no seat.
        const mallory = await joinAs('mallory-tab', 'Mallory', code, hostId);
        expect(mallory.lobby.clientId, 'precondition: the tab claims the host id').toBe(hostId);
        expect(refusalOf(mallory), 'and is turned away with a reason').toBeTruthy();
        expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
        expect(app.state.players.find(p => p.id === hostId).name).toBe('Alice');

        // Even delivered straight into the host handler the id buys nothing: the host's own
        // taps are marked with a Symbol that cannot survive serialisation.
        await othersSubmit();
        await czarPicks('Bob');
        expect(app.state.phase).toBe('result');
        const round = app.state.round;
        app.handleHostMessage(hostId, { type: 'next-round', round });
        await tick(40);
        expect(app.state.round, 'a wire sender claiming the host id drives nothing').toBe(round);

        // ...and the host's own tap still works.
        app.triggerNextRound();
        await tick(40);
        expect(app.state.round).toBe(round + 1);
    });

    it('never lets a departure event act on the host\'s own seat', async () => {
        await fourPlayerGame();
        // A 'client-left' for the host's id could only come from an impostor connection, and
        // it used to mark the host away, move the crown off them and splice them out.
        app.lobby.host.emit('client-left', app.state.myId, { name: 'Alice' });
        app.lobby.host.emit('client-lost', app.state.myId, { name: 'Alice' });
        await tick(20);
        const me = app.state.players.find(p => p.id === app.state.myId);
        expect(me, 'the host is still at their own table').toBeTruthy();
        expect(me.away).toBe(false);
        expect(app.state.czarId).toBe(app.state.myId);
    });

    it('seats a clientId that names an Object.prototype member instead of throwing on it', async () => {
        const code = await fourPlayerGame();
        // state.pastPlayers / hands / submissions are prototype-less, so 'constructor' is not
        // mistaken for a parked seat — which used to throw inside the join handler, be
        // swallowed by TypedEmitter, and leave the player neither in nor told they were not.
        const ghost = await joinAs('ghost-tab', 'Zoe', code, 'constructor');
        expect(refusalOf(ghost)).toBeNull();
        expect(app.state.players.map(p => p.name)).toContain('Zoe');
        expect(ghost.resyncs.length, 'and they get a screen to paint').toBeGreaterThan(0);
    });

    /* ── Identity: the wire carries aliases, never clientIds ───────────── */

    it('never puts a clientId on the wire, so there is no seat for anyone to claim', async () => {
        const code = await fourPlayerGame();
        // Everything that mints, moves or retires a seat, so every payload shape is exercised:
        // a drop, a rejoin from a fresh tab, a full round, a result and a mid-game joiner.
        const carol = seatByName('Carol');
        carol.lobby.client.connection.close();
        await tick(100);
        await joinAs('carol-laptop', 'Carol', code);
        await joinAs('zoe-phone', 'Zoe', code);
        await othersSubmit();
        await czarPicks('Bob');
        await tick(60);

        // Every clientId in play — the host's own player id included, which no SlopNet seat
        // token defends because the host holds no seat.
        const secrets = [app.state.myId, ...seats.map(s => s.lobby.clientId)];
        for (const seat of seats) {
            expect(seat.messages.length, `${seat.tabName} was told something`).toBeGreaterThan(0);
            for (const msg of seat.messages) {
                const wire = JSON.stringify(msg);
                for (const secret of secrets) {
                    expect(wire.includes(secret),
                        `${seat.tabName} was handed a clientId in a '${msg.type}': ${secret}`)
                        .toBe(false);
                }
            }
        }

        // ...and the host still knows exactly who everyone is behind those aliases.
        expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dan', 'Zoe']);
        expect(app.state.phase).toBe('result');
    });

    it('gives every seat one stable alias, and hands each player their own', async () => {
        const code = await fourPlayerGame();
        const bob = seatByName('Bob');
        const bobAlias = bob.myId;
        expect(bobAlias, 'the snapshot names the seat it is addressed to').toBeTruthy();
        expect(bobAlias).not.toBe(bob.lobby.clientId);
        expect(bob.players.find(p => p.name === 'Bob').id,
            'and the roster calls that seat the same thing').toBe(bobAlias);

        // The alias survives the seat moving to a different device: everyone else's screen
        // must keep showing one Bob, and Bob's own must keep saying "(you)".
        bob.lobby.client.connection.close();
        await tick(100);
        const laptop = await joinAs('bob-laptop', 'Bob', code);
        expect(app.state.players.filter(p => p.name === 'Bob').length).toBe(1);
        expect(laptop.myId, 'the same seat, so the same face').toBe(bobAlias);
        expect(seatByName('Dan').players.find(p => p.name === 'Bob').id).toBe(bobAlias);
    });

    it('cannot be re-entered with an alias read off another player\'s roster', async () => {
        const code = await fourPlayerGame();
        const bobId = seatByName('Bob').lobby.clientId;
        // Mallory reads the roster out of her own page. The only id there is Bob's ALIAS.
        const bobAlias = seatByName('Dan').players.find(p => p.name === 'Bob').id;
        expect(bobAlias).not.toBe(bobId);

        const bobScore = app.state.players.find(p => p.name === 'Bob').score;
        const bobHand = (app.state.hands[bobId] || []).slice();
        const mallory = await joinAs('mallory-tab', 'Mallory', code, bobAlias);
        await tick(60);

        // She is seated as herself and nothing of Bob's moved: the alias addresses no seat.
        expect(refusalOf(mallory)).toBeNull();
        const bobRow = app.state.players.find(p => p.name === 'Bob');
        expect(bobRow.id, 'Bob still answers to his own clientId').toBe(bobId);
        expect(bobRow.score).toBe(bobScore);
        expect(bobRow.away).toBe(false);
        expect(app.state.hands[bobId]).toEqual(bobHand);
        expect(mallory.hand, 'and she was dealt a hand of her own').not.toEqual(bobHand);
        // Her snapshot names HER seat, not Bob's.
        expect(mallory.myId).not.toBe(bobAlias);
    });

    /* ── A seat that has moved device ─────────────────────────────── */

    it('does not mint a second seat when the tab a player walked away from reconnects', async () => {
        const code = await fourPlayerGame();
        const phone = seatByName('Bob');
        const phoneId = phone.lobby.clientId;

        // Bob's phone loses its channel; SlopNet holds the seat and the ladder starts.
        phone.lobby.client.connection.close();
        await tick(100);
        expect(app.state.players.find(p => p.id === phoneId).away).toBe(true);

        // Bob picks up his laptop: a fresh tab, so a fresh clientId, and his seat moves.
        const laptop = await joinAs('bob-laptop', 'Bob', code);
        expect(laptop.lobby.clientId).not.toBe(phoneId);
        expect(app.state.players.filter(p => p.name === 'Bob').length).toBe(1);

        // Now the phone's own ladder lands, with a valid seat token for the retired id.
        await tick(3000);
        expect(
            app.state.players.filter(p => p.name === 'Bob').length,
            'the retired clientId forwards to the seat it moved to — it never mints a new one'
        ).toBe(1);
        expect(phone.joinErrors.map(e => e.reason).join(' '),
            'and the abandoned tab is told why it has nothing to do').toMatch(/another device/i);

        // Every human has played, so the round moves on: the quorum is not waiting on a
        // chair nobody is sitting in.
        await othersSubmit();
        expect(app.state.phase).toBe('judging');
    });

    it('lets the czar award a card whose author came back on a different device', async () => {
        const code = await fourPlayerGame();
        await othersSubmit();
        expect(app.state.phase).toBe('judging');

        const dan = seatByName('Dan');
        const danId = dan.lobby.clientId;
        dan.lobby.client.connection.close();
        await tick(100);
        const laptop = await joinAs('dan-laptop', 'Dan', code);
        expect(refusalOf(laptop)).toBeNull();
        expect(app.state.submissionOrder, 'his answer follows him').toContain(laptop.lobby.clientId);
        expect(app.state.submissionOrder).not.toContain(danId);

        await czarPicks('Dan');
        expect(app.state.phase).toBe('result');
        expect(app.state.players.find(p => p.name === 'Dan').score).toBe(1);
    });

    it('gives a seat back when the player hops between two devices', async () => {
        const code = await fourPlayerGame();
        const phone = seatByName('Bob');
        seatSubmits(phone);
        await tick(40);

        // Phone -> laptop: the seat, its score and the card already played all move.
        phone.lobby.client.connection.close();
        await tick(100);
        const laptop = await joinAs('bob-laptop', 'Bob', code);
        const laptopId = laptop.lobby.clientId;
        expect(app.state.submissions[laptopId], 'his played card follows him').toBeTruthy();

        // ...and back again: the laptop drops, and the phone's own ladder comes home to a
        // seat nobody is sitting in. The forwarding record must not have become a loop.
        laptop.lobby.client.connection.close();
        await tick(3000);

        const bobs = app.state.players.filter(p => p.name === 'Bob');
        expect(bobs.length, 'one human, one seat, whichever device is in front of them').toBe(1);
        expect(bobs[0].away).toBe(false);
        expect(bobs[0].id).toBe(phone.lobby.clientId);
        expect(app.state.submissions[bobs[0].id], 'and the card is still his').toBeTruthy();
    });

    it('refuses a rejoin that claims a name a connected player already holds', async () => {
        const code = await fourPlayerGame();
        const mallory = await joinAs('mallory-tab', 'Mallory', code);

        // Same clientId, same seat token — SlopNet is happy — but a different name.
        useTab('mallory-tab');
        const rejoin = mallory.lobby.joinRoom(code, 'Bob');
        await tick(200);
        await rejoin;

        expect(
            app.state.players.filter(p => !p.away && sameNameish(p.name, 'Bob')).length,
            'the NAME is refused, never the player: they keep the one their seat had'
        ).toBe(1);
        expect(app.state.players.find(p => p.id === mallory.lobby.clientId).name).toBe('Mallory');
    });

    it('remembers a lobby-phase device switch across Start Game', async () => {
        const code = await hostGame();
        const phone = await joinAs('bob-phone', 'Bob', code);
        await joinAs('carol-phone', 'Carol', code);
        await joinAs('dan-phone', 'Dan', code);
        const phoneId = phone.lobby.clientId;

        // Still in the LOBBY: Bob's phone loses its channel and he picks up his laptop.
        phone.lobby.client.connection.close();
        await tick(100);
        expect(app.state.players.find(p => p.id === phoneId).away).toBe(true);
        const laptop = await joinAs('bob-laptop', 'Bob', code);
        expect(laptop.lobby.clientId).not.toBe(phoneId);
        expect(app.state.players.filter(p => p.name === 'Bob').length).toBe(1);

        // Start Game deals a new game — it does not make the table forget who is who.
        app.startGame();
        await tick(80);
        expect(app.state.phase).toBe('playing');

        // The phone thaws and its own ladder lands. It is the tab Bob walked away from,
        // and the forwarding record written in the lobby is what says so.
        await tick(3000);
        expect(
            app.state.players.map(p => p.name),
            'a device switch made in the lobby must still be one human, one seat'
        ).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
        expect(phone.joinErrors.map(e => e.reason).join(' '),
            'and the abandoned tab is told why it has nothing to do')
            .toMatch(/another device|already in the game/i);

        // ...so no later round is left waiting on a chair nobody is sitting in. (Round 1
        // exempts an arrival stamped with the round in progress; round 2 is where a phantom
        // seat would start inflating the quorum.)
        await othersSubmit();
        expect(app.state.phase).toBe('judging');
        await czarPicks('Bob');
        app.triggerNextRound();
        await tick(50);
        expect(app.state.round).toBe(2);
        await othersSubmit();
        expect(app.state.phase, 'round 2 still reaches judging: the quorum counts humans')
            .toBe('judging');
    });

    it('refuses a rejoin it cannot place instead of dealing it a seat of its own', async () => {
        const code = await fourPlayerGame();
        const phone = seatByName('Bob');
        const phoneId = phone.lobby.clientId;

        phone.lobby.client.connection.close();
        await tick(100);
        const laptop = await joinAs('bob-laptop', 'Bob', code);
        expect(app.state.players.filter(p => p.name === 'Bob').length).toBe(1);
        expect(app.state.reboundIds[phoneId]).toBe(laptop.lobby.clientId);

        // The forwarding table is bounded, so on a long flaky night its oldest edge is
        // evicted. Dropping this one by hand stands in for that: the phone's rung is then
        // an id the host cannot place, carrying a name a connected player already holds —
        // which is the abandoned tab, never somebody new.
        delete app.state.reboundIds[phoneId];
        const handsBefore = Object.keys(app.state.hands).length;

        await tick(3000);
        expect(app.state.players.map(p => p.name)).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
        expect(app.state.players.some(p => p.name === 'Unknown'),
            'an arrival the host cannot identify is never seated').toBe(false);
        expect(Object.keys(app.state.hands).length, 'and never dealt a hand').toBe(handsBefore);
        expect(phone.joinErrors.map(e => e.reason).join(' '),
            'it is told why, in the one message the client treats as terminal')
            .toMatch(/already in the game|another device/i);
    });

    /* ── Anonymity, and the guards behind it ──────────────────────── */

    it('keeps authorship off the judging wire, and still resolves the czar\'s pick', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);
        expect(app.state.czarId).toBe(idOf('Bob'));   // a client is czar

        await othersSubmit();
        expect(app.state.phase).toBe('judging');

        const bob = seatByName('Bob');
        const ids = app.state.players.map(p => p.id);
        expect(bob.judging.length).toBe(3);
        for (const entry of bob.judging) {
            expect(ids, 'the payload carries a per-round key, not the author id')
                .not.toContain(entry.id);
        }

        // The czar picks by that key and the host resolves it.
        const danCards = app.state.submissions[idOf('Dan')].join();
        const key = bob.judging.find(e => e.cards.join() === danCards).id;
        bob.lobby.sendToHost({ type: 'pick-winner', round: app.state.round, playerId: key });
        await tick(50);
        expect(app.state.phase).toBe('result');
        expect(app.state.players.find(p => p.name === 'Dan').score).toBe(1);
    });

    it('refuses a client pick that names an author instead of a card', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Dan');
        app.handleHostMessage(app.HOST_SELF, { type: 'next-round', round: app.state.round });
        await tick(50);

        // Round 2: Bob is czar, and a client. He knows every player id — they ride in the
        // roster — but the judging pool is keyed, so naming a person is not a pick.
        await othersSubmit();
        expect(app.state.phase).toBe('judging');
        const bob = seatByName('Bob');
        bob.lobby.sendToHost({
            type: 'pick-winner', round: app.state.round, playerId: idOf('Carol'),
        });
        await tick(50);

        expect(app.state.phase, 'the czar picks a card, never an author').toBe('judging');
        expect(app.state.players.every(p => p.score <= 1)).toBe(true);
        expect(bob.rejections[bob.rejections.length - 1].type).toBe('pick-rejected');

        // ...and the key for that same card is still accepted.
        bob.lobby.sendToHost({
            type: 'pick-winner', round: app.state.round, playerId: keyFor(bob, 'Carol'),
        });
        await tick(50);
        expect(app.state.phase).toBe('result');
        expect(app.state.players.find(p => p.name === 'Carol').score).toBe(1);
    });

    /* ── The round gate, and the host backstops ───────────────────── */

    it('keeps "Start judging now" live as submissions arrive', async () => {
        await fourPlayerGame();
        expect(el('btn-force-judging').disabled, 'nothing played yet').toBe(true);

        seatSubmits(seatByName('Bob'));
        await tick(40);
        expect(
            el('btn-force-judging').disabled,
            'a submit is the ONE event in a round that need not touch the roster, and it is ' +
            'exactly when the host wants this button'
        ).toBe(false);
    });

    it('judges the cards that were played when the last eligible player leaves', async () => {
        await fourPlayerGame();
        const bobId = seatByName('Bob').lobby.clientId;
        seatSubmits(seatByName('Bob'));
        await tick(40);

        // Everyone who could still play walks out, Bob included.
        for (const seat of seats) seat.lobby.destroy();
        await tick(300);

        expect(app.state.phase, 'the played card is judged, not thrown away').toBe('judging');
        expect(app.state.submissionOrder).toEqual([bobId]);
        await czarPicks('Bob');
        expect(app.state.players.find(p => p.id === bobId).score).toBe(1);
    });

    it('does not take the crown off a czar whose link blips while the result is up', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);
        expect(app.state.czarId).toBe(idOf('Bob'));

        await othersSubmit();
        await czarPicks('Dan');
        expect(app.state.phase).toBe('result');

        seatByName('Bob').lobby.client.connection.close();
        await tick(200);
        expect(
            app.state.czarId,
            'the round is already decided and the host can advance it — moving the crown ' +
            'would only skip the blipping player as czar'
        ).toBe(idOf('Bob'));

        app.triggerNextRound();
        await tick(50);
        expect(app.state.round).toBe(3);
    });

    it('answers a Next Round it cannot honour', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        expect(app.state.phase).toBe('result');

        const dan = seatByName('Dan');
        dan.lobby.sendToHost({ type: 'next-round', round: app.state.round });
        await tick(50);
        expect(app.state.phase).toBe('result');
        expect(
            dan.rejections.map(r => r.type),
            'every other host command replies; this one used to return in silence and leave ' +
            'the tapper on a disabled "Starting..."'
        ).toContain('next-round-rejected');
    });

    it('puts the host\'s own cards back when its own submit is refused', async () => {
        await fourPlayerGame();
        await othersSubmit();
        await czarPicks('Carol');
        app.triggerNextRound();
        await tick(50);          // round 2: Bob is czar, so the host plays

        // The optimistic UI submitCards leaves behind, and a command the guards refuse.
        app.state.mySubmitted = true;
        app.handleHostMessage(app.HOST_SELF, {
            type: 'submit', round: app.state.round - 1, cards: [app.state.myHand[0]],
        });
        await tick(20);
        expect(
            app.state.mySubmitted,
            'a bare toast used to leave the host locked out of a round it believed it played'
        ).toBe(false);
        expect(el('toast').textContent).toMatch(/moved on/i);
    });

    /* ── A second game in the same tab ──────────────────────────── */

    it('hosts a clean room after being thrown out of somebody else game', async () => {
        // A player mid-game whose host ends the room. resetToLobby deliberately keeps the
        // game fields so the reason stays readable — Create Game must not inherit them.
        app.state.phase = 'playing';
        app.state.round = 5;
        app.state.czarId = 'someone-elses-id';
        app.handleClientState('room-closed', null);
        expect(app.state.phase, 'precondition: the old round is still in state').toBe('playing');

        const code = await hostGame();
        expect(app.state.phase).toBe('lobby');
        expect(app.state.round).toBe(0);
        expect(app.state.czarId).toBeNull();
        expect(app.state.linkUp).toBe(true);

        await joinAs('bob-phone', 'Bob', code);
        await joinAs('carol-phone', 'Carol', code);
        expect(el('btn-start').disabled, 'and Start Game works').toBe(false);

        app.startGame();
        await tick(80);
        expect(app.state.phase).toBe('playing');
        expect(app.state.czarId).toBe(app.state.myId);
        expect(seatByName('Bob').hand.length).toBe(10);
    });

    /* ── Wire hygiene ─────────────────────────────────────────────────────── */

    it('escapes every name and card it paints', async () => {
        const code = await hostGame();
        await joinAs('x-phone', '<b>Zed</b>', code);
        await tick(20);

        const html = el('waiting-players').innerHTML;
        expect(html).toContain('&lt;b&gt;Zed');
        expect(html).not.toContain('<b>Zed');
    });
});

/**
 * The client half, driven directly: every handler must tolerate arriving in any order (the
 * library flushes a queued backlog BEFORE the rejoin snapshot), and none of them may leave a
 * screen blank or a control live that cannot work.
 */
describe('CAH client screen', () => {
    let client;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        client = loadCahApp();
        client.state.myId = 'me';
        client.state.gameCode = 'ABC123';
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    const roster = (extra = {}) => [
        { id: 'czar', name: 'Ada', score: 2, away: false },
        { id: 'me', name: 'Me', score: 1, away: false, ...extra },
    ];

    const resync = (over = {}) => ({
        type: 'resync',
        players: roster(),
        czarId: 'czar',
        scoreLimit: 7,
        phase: 'playing',
        round: 3,
        black: { t: 'Why is _ so _?', p: 2 },
        hand: ['one', 'two', 'three'],
        submitted: false,
        submitCount: 0,
        needed: 1,
        submissions: null,
        result: null,
        gameOver: null,
        ...over,
    });

    it('paints a whole round from one snapshot', () => {
        client.handleClientMessage(resync());
        expect(client.state.phase).toBe('playing');
        expect(client.state.czarId).toBe('czar');
        expect(client.state.round).toBe(3);
        expect(client.state.myHand).toEqual(['one', 'two', 'three']);
        expect(el('game-status').textContent).toMatch(/Pick 2 cards/);
        expect(el('submitted-count').textContent).toBe('0 / 1 submitted');
        expect(el('hand').innerHTML).toContain('one');
    });

    it('learns which seat is its own from the snapshot, never from its clientId', () => {
        // A client cannot work out which row is theirs any more: their clientId names nobody
        // on the wire. The host says so, once, in every snapshot.
        client.state.myId = '';
        client.handleClientMessage(resync({ youId: 'me' }));
        expect(client.state.myId).toBe('me');
        expect(el('game-players').innerHTML).toContain('(you)');

        // An older host that sends no youId must not turn us into a stranger to ourselves.
        client.handleClientMessage(resync());
        expect(client.state.myId).toBe('me');
    });

    it('shows the waiting panel to a player the snapshot says has already played', () => {
        client.handleClientMessage(resync({ submitted: true, hand: [] }));
        expect(client.state.mySubmitted).toBe(true);
        expect(el('game-status').textContent).toMatch(/Cards submitted/);
        expect(el('hand-section').classList.contains('hidden')).toBe(true);
    });

    it('survives messages that arrive before the snapshot they belong to', () => {
        // A backlog flushed at the moment of a rejoin: judging, then a roster, then the
        // snapshot. Nothing here may throw, and nothing may leave the screen blank.
        expect(() => {
            client.handleClientMessage({
                type: 'judging', round: 9, czarId: 'czar',
                submissions: [{ id: 'x', cards: ['a card'] }],
            });
            client.handleClientMessage({ type: 'player-list', players: roster(), czarId: 'czar' });
            client.handleClientMessage({ type: 'submit-count', count: 1, needed: 2 });
            client.handleClientMessage(resync({ phase: 'judging', submissions: [{ id: 'x', cards: ['a card'] }] }));
        }).not.toThrow();

        expect(client.state.phase).toBe('judging');
        expect(el('submissions').innerHTML).toContain('a card');
        expect(el('game-status').textContent).toMatch(/Card Czar is choosing/);
    });

    it('never renders a blank screen for a phase it does not know', () => {
        client.handleClientMessage(resync({ phase: 'something-new' }));
        expect(el('game-status').textContent).toBe('Syncing…');
    });

    it('gives the czar the pick UI and sends a playerId, not a position', () => {
        client.state.myId = 'czar';
        client.handleClientMessage({
            type: 'judging', round: 4, czarId: 'czar',
            submissions: [{ id: 'p1', cards: ['first'] }, { id: 'p2', cards: ['second'] }],
        });
        expect(el('game-status').textContent).toMatch(/Pick the funniest/);
        client.selectSubmission(1);
        expect(client.selectedSubmissionId).toBe('p2');
        expect(el('btn-pick-winner').classList.contains('hidden')).toBe(false);

        // A re-render (a late submission, a czar change) drops the stale choice rather than
        // letting it point at whatever is now in that position.
        client.handleClientMessage({
            type: 'judging', round: 4, czarId: 'czar',
            submissions: [{ id: 'p2', cards: ['second'] }, { id: 'p1', cards: ['first'] }],
        });
        expect(client.selectedSubmissionId).toBeNull();
        expect(el('btn-pick-winner').classList.contains('hidden')).toBe(true);
    });

    it('freezes the grid once a pick is on the wire, and thaws it if the host says no', () => {
        client.state.myId = 'czar';
        client.handleClientMessage({
            type: 'judging', round: 4, czarId: 'czar',
            submissions: [{ id: 'k1', cards: ['first'] }, { id: 'k2', cards: ['second'] }],
        });
        client.selectSubmission(0);
        client.pickWinner();
        expect(el('btn-pick-winner').textContent).toBe('Sending…');

        // Changing your mind now would send a SECOND pick that the host refuses, while the
        // first one is the one that actually scored.
        client.selectSubmission(1);
        expect(client.selectedSubmissionId).toBe('k1');

        client.handleClientMessage({ type: 'pick-rejected', reason: 'That answer is no longer in play' });
        client.handleClientMessage({
            type: 'judging', round: 4, czarId: 'czar',
            submissions: [{ id: 'k2', cards: ['second'] }],
        });
        client.selectSubmission(0);
        expect(client.selectedSubmissionId, 'and a refused pick leaves the czar able to try again')
            .toBe('k2');
    });

    it('hides Next Round on the final result and shows the podium four seconds later', () => {
        client.handleClientMessage({
            type: 'round-winner', round: 2, winnerId: 'czar', winnerName: 'Ada',
            winningCards: ['the winning card'], players: roster(), gameOver: true,
        });
        expect(client.state.phase, 'the phase is decided before the paint').toBe('gameover');
        expect(el('btn-next-round').classList.contains('hidden')).toBe(true);
        expect(el('result-cards').innerHTML).toContain('the winning card');

        expect(client.state.gameOverTimer).not.toBeNull();
        vi.advanceTimersByTime(4000);
        expect(el('gameover-title').textContent).toMatch(/Ada wins the game/);

        // ...and a snapshot that arrives afterwards cancels nothing that is still pending.
        client.handleClientMessage(resync());
        expect(client.state.gameOverTimer).toBeNull();
    });

    it('kills the controls while the link is down and revives them on the snapshot', () => {
        client.handleClientMessage(resync());
        client.handleClientState('disconnected');
        expect(client.state.linkUp).toBe(false);
        expect(el('btn-submit').disabled).toBe(true);
        expect(el('btn-pick-winner').disabled).toBe(true);
        expect(el('btn-next-round').disabled).toBe(true);
        expect(el('conn-banner').classList.contains('hidden')).toBe(false);

        client.handleClientState('reconnecting', { attempt: 2, max: 20 });
        expect(el('conn-banner').textContent).toMatch(/attempt 2 of 20/);

        client.handleClientState('reconnected', { fresh: false });
        expect(el('conn-banner').classList.contains('hidden')).toBe(true);
        client.handleClientMessage(resync());
        expect(el('btn-pick-winner').disabled).toBe(false);
    });

    it('treats a kick as terminal and does not let the bookend overwrite the reason', () => {
        client.handleClientMessage(resync());
        // The library's shape for a kick after the player was in.
        client.handleClientState('disconnected');
        client.handleClientState('rejected', 'The host removed you');
        client.handleClientState('reconnect-failed');
        client.handleClientMessage({ type: 'join-error', reason: 'The host removed you' });

        expect(client.state.terminal).toBe(true);
        expect(el('toast').textContent).toBe('The host removed you');
        expect(el('btn-join').disabled).toBe(false);
    });

    it('clears the submitted counter when a new round begins', () => {
        // A client czar never writes this element itself, so last round's satisfied count
        // used to stare back at them until somebody played.
        client.handleClientMessage({ type: 'submit-count', count: 3, needed: 3 });
        expect(el('submitted-count').textContent).toBe('3 / 3 submitted');

        client.handleClientMessage({
            type: 'new-round', black: { t: 'Why _?', p: 1 }, czarId: 'me', round: 4,
            hand: [], players: roster(), submitCount: 0, needed: 2,
        });
        expect(el('submitted-count').textContent).toBe('0 / 2 submitted');
    });

    it('keeps the host reason on screen when a reasonless kick bookends it', () => {
        client.handleClientMessage(resync());
        // lobby.removeClient(id) with no reason: both channels carry an empty string, and
        // the message used to repaint a vaguer line over the state branch's accurate one.
        client.handleClientState('disconnected');
        client.handleClientState('rejected', '');
        client.handleClientState('reconnect-failed');
        client.handleClientMessage({ type: 'join-error', reason: '' });
        expect(el('toast').textContent).toBe('The host removed you from the game');
        expect(client.state.terminal).toBe(true);
    });

    it('escapes card text before it reaches the page, but keeps the deck\'s own typography', () => {
        client.handleClientMessage(resync({
            hand: ['<img src=x onerror=alert(1)>', 'Hot Pockets&copy;'],
        }));
        const html = el('hand').innerHTML;
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('<img src=x');
        // The printed deck stores its text as HTML; only these exact references come back.
        expect(html).toContain('Hot Pockets\u00a9');
    });

    /* ── Stale and malformed traffic ──────────────────────────────────────── */

    it('ignores a result from a round the table has already left', () => {
        client.handleClientMessage(resync({ round: 3 }));
        client.handleClientMessage({
            type: 'new-round', black: { t: 'Why _?', p: 1 }, czarId: 'czar', round: 4,
            hand: ['a'], players: roster(), submitCount: 0, needed: 1,
        });
        expect(client.state.round).toBe(4);

        // The round-3 result, queued while the link was down and flushed too late.
        client.handleClientMessage({
            type: 'round-winner', round: 3, winnerId: 'czar', winnerName: 'Ada',
            winningCards: ['old news'], players: roster(), gameOver: false,
        });

        expect(client.state.phase, 'round 4 is still being played').toBe('playing');
        expect(client.state.round).toBe(4);
        expect(el('result-cards').innerHTML).not.toContain('old news');
    });

    it('will not be dragged off the podium by a stale round', () => {
        client.handleClientMessage({
            type: 'round-winner', round: 5, winnerId: 'czar', winnerName: 'Ada',
            winningCards: ['the last card'], players: roster(), gameOver: true,
        });
        expect(client.state.phase).toBe('gameover');
        client.state.round = 5;

        // Both shapes of "the game is not over after all", from a peer that is behind us.
        client.handleClientMessage({
            type: 'new-round', black: { t: 'Why _?', p: 1 }, czarId: 'czar', round: 5,
            hand: ['a'], players: roster(), submitCount: 0, needed: 1,
        });
        expect(client.state.phase, 'a repeat of the round we are on cannot restart it').toBe('gameover');

        client.handleClientMessage({
            type: 'round-winner', round: 5, winnerId: 'me', winnerName: 'Me',
            winningCards: ['not this one'], players: roster(), gameOver: false,
        });
        expect(client.state.phase, 'and nothing but a snapshot leaves the podium').toBe('gameover');

        // ...but the host's own snapshot still moves the table wherever it says.
        client.handleClientMessage(resync({ round: 6 }));
        expect(client.state.phase).toBe('playing');
        expect(client.state.round).toBe(6);
    });

    it('ignores a judging screen replayed from a finished round', () => {
        client.state.myId = 'czar';
        client.handleClientMessage(resync({ round: 7, phase: 'playing' }));
        client.handleClientMessage({
            type: 'round-winner', round: 7, winnerId: 'me', winnerName: 'Me',
            winningCards: ['won'], players: roster(), gameOver: false,
        });
        client.handleClientMessage({
            type: 'new-round', black: { t: 'Why _?', p: 1 }, czarId: 'czar', round: 8,
            hand: ['a'], players: roster(), submitCount: 0, needed: 1,
        });

        client.handleClientMessage({
            type: 'judging', round: 7, czarId: 'czar',
            submissions: [{ id: 'k1', cards: ['already judged'] }],
        });

        expect(client.state.phase, 'round 7 has been judged and paid').toBe('playing');
        expect(el('submissions').innerHTML).not.toContain('already judged');
    });

    it('drops judging entries it cannot paint, and paints the rest', () => {
        client.state.myId = 'czar';
        client.handleClientMessage({
            type: 'judging', round: 4, czarId: 'czar',
            submissions: [
                { id: 'good', cards: ['a real answer'] },
                { id: 'no-cards' },
                { cards: ['author-less'] },
                { id: 'wrong-shape', cards: [{ t: 'nope' }] },
                'not even an object',
            ],
        });

        expect(client.state.submissionOrder).toEqual([{ id: 'good', cards: ['a real answer'] }]);
        expect(el('submissions').innerHTML).toContain('a real answer');
        expect(el('submissions').innerHTML).not.toContain('[object Object]');
        client.selectSubmission(0);
        expect(client.selectedSubmissionId).toBe('good');
    });

    it('refuses to paint a submitted counter it cannot trust', () => {
        client.handleClientMessage({ type: 'submit-count', count: 1, needed: 3 });
        expect(el('submitted-count').textContent).toBe('1 / 3 submitted');

        client.handleClientMessage({ type: 'submit-count', count: 999, needed: 1 });
        expect(el('submitted-count').textContent, 'a count can never exceed the quorum')
            .toBe('1 / 1 submitted');

        client.handleClientMessage({ type: 'submit-count', count: 'lots', needed: null });
        expect(el('submitted-count').textContent, 'and nonsense leaves the last real count alone')
            .toBe('1 / 1 submitted');
    });

    it('paints a roster of nonsense as nothing at all', () => {
        client.handleClientMessage(resync({
            players: [
                { id: 'czar', name: 'Ada', score: 2 },
                { id: 42, name: 'Not a player' },
                { id: 'me', name: 'Me', score: 'lots' },
                null,
            ],
        }));
        expect(client.state.players.map(p => p.id)).toEqual(['czar', 'me']);
        expect(client.state.players[1].score, 'a score that is not a number is zero').toBe(0);
        expect(el('game-players').innerHTML).not.toContain('Not a player');
    });

    it('puts the cards back under the player when the host refuses a submit', () => {
        client.handleClientMessage(resync());
        client.selectCard(0);
        client.selectCard(1);
        client.submitCards();
        expect(client.state.mySubmitted).toBe(true);

        client.handleClientMessage({ type: 'submit-rejected', reason: 'That round has moved on' });
        expect(client.state.mySubmitted).toBe(false);
        expect(el('toast').textContent).toBe('That round has moved on');
    });
});
