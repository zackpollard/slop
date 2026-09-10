/**
 * REPRO 6 — "One human, two seats: a second tab permanently deadlocks the round"
 *
 * THE BUG (was: projects/cards-against-humanity/index.html:491-507 + :568-575, identity
 * minted in lib/sloplobby/sloplobby.js getClientId)
 *
 *   getClientId mints the clientId into **sessionStorage**, which is per-tab by spec. Open
 *   the room link a second time — a second tab, a laptop, an in-app webview — and joinRoom
 *   mints a BRAND NEW id. PeerHost keys join-vs-rejoin purely on that id, so the second tab
 *   falls through to the "New client" branch and emits 'client-joined', NOT 'client-rejoined'.
 *   One human, two identities.
 *
 *   CAH's onPlayerJoined then seated it unconditionally (no duplicate-name check, no
 *   mid-game rejection), and the round's completion gate lived ONLY inside `case 'submit'`:
 *       const needed = state.players.length - 1;
 *       const got = Object.keys(state.submissions).length;
 *       if (got >= needed) startJudging();
 *   `needed` counted the abandoned seat; `got` never could, because that tab submits nothing.
 *   startJudging had exactly one call site — no timer, no host override, no skip/kick control
 *   anywhere in the file — so the round hung forever and host-reload (which destroys the room
 *   and every score) was the only exit. Closing the stray tab did not heal it either:
 *   onPlayerLeft deleted the seat but nothing re-evaluated the gate the departure satisfied.
 *
 * THE FIX (both halves are asserted below)
 *   1. onPlayerJoined refuses a name that a CONNECTED player already holds, so the stray tab
 *      is turned away at the door instead of being seated. (A name matching an ABSENT seat is
 *      that player coming home with a new clientId, and is rebound to their seat instead —
 *      see app-cah.test.js.)
 *   2. The gate is extracted into maybeStartJudging(), which is phase-guarded, counts only
 *      players who are present and are not the czar, and is called from the submit path AND
 *      from every membership change (join, rejoin, left, lost). A roster change can no longer
 *      satisfy a condition that nothing will ever look at again, and the host has
 *      "Start judging now" / "Skip round" as a backstop.
 *
 * WHY THE EXISTING LIBRARY TESTS CANNOT SEE ANY OF IT
 *   No other test in this suite loads an app's game logic, so nothing else asserts a fact
 *   about `state.players`, `needed`, or the czar rotation. multi-client.test.js always
 *   allocates a distinct clientId per distinct *player*, so "one human, two identities" is
 *   never constructed.
 *
 * ON THE MOCK
 *   mock-peer.js is NOT modified and NOT extended. Nothing here is a transport subtlety: the
 *   second tab is a perfectly healthy, fully-open connection. What was missing is a harness,
 *   and cah-app-harness.js supplies it (per-tab sessionStorage + the real inline <script>
 *   evaluated against a DOM stub). SlopNet/SlopLobby are the real classes; only
 *   `_PeerClass: MockPeer` is injected, exactly as repro-2 does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import {
    installBrowserGlobals, restoreGlobals, useTab, loadCahApp, makeSeat, seatSubmits,
} from './cah-app-harness.js';

/* Both harnesses now live in cah-app-harness.js (shared with app-cah.test.js):
     - `useTab(name)`   — one sessionStorage store per simulated browser tab, which is what
                          makes tab 2 a different clientId (sloplobby.js getClientId).
     - `loadCahApp()`   — evaluates the REAL inline <script> from
                          projects/cards-against-humanity/index.html against a DOM stub, so
                          these assertions are about the shipped game logic.
     - `makeSeat()`     — one player's phone: a plain SlopLobby client recording what the
                          host tells it (resync / new-round / judging / submit-count / ...).
   SlopNet and SlopLobby are the real classes; only the Peer transport is injected. */

describe('CAH: a second tab seats the same human twice and deadlocks the round', () => {
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

    /** Alice hosts (index.html:475-555, driven through the real createGame). */
    async function hostGame() {
        useTab('host');
        document.getElementById('player-name').value = 'Alice';
        document.getElementById('score-limit').value = '7';
        const p = app.createGame();
        await vi.advanceTimersByTimeAsync(50);
        await p;
        return app.state.gameCode;
    }

    /** One phone taps the link: `tabName` is the browser tab it opens in. */
    async function joinAs(tabName, displayName, code) {
        useTab(tabName);
        const seat = makeSeat(tabName, displayName);
        seats.push(seat);
        const p = seat.lobby.joinRoom(code, displayName);   // index.html joinGame
        await vi.advanceTimersByTimeAsync(60);
        // A refused join settles as a rejection ('rejected' at the door) — that is a
        // legitimate outcome now, and the seat records the reason either way.
        try { await p; } catch (e) { seat.joinFailure = e; }
        return seat;
    }

    /** Everyone who is not the czar plays their cards (index.html submitCards). */
    async function everyoneNonCzarSubmits() {
        for (const seat of seats) {
            if (seat.abandoned) continue;                        // nobody is looking at that tab
            if (!seat.lobby.client) continue;                    // tab already closed / refused
            if (seat.lobby.client.isTerminal) continue;           // the host turned it away
            if (seat.myId && seat.myId === seat.czarId) continue; // the czar does not submit
            if (seat.submitted) continue;
            // The round stamp and the black card's pick count are both part of the wire
            // format now: the host drops a submit for a round it has moved on from, and one
            // that does not play exactly the cards the black card asks for.
            seatSubmits(seat);
            await vi.advanceTimersByTimeAsync(30);
        }
        await vi.advanceTimersByTimeAsync(60);
    }

    /**
     * Alice hosts; Bob, Carol and Dan join from their phones; the game starts.
     * Round 1 czar is state.players[0] — Alice, the host.
     */
    async function gameInProgress() {
        const code = await hostGame();
        await joinAs('bob-phone', 'Bob', code);
        await joinAs('carol-phone', 'Carol', code);
        await joinAs('dan-phone', 'Dan', code);

        expect(app.state.players.length).toBe(4);   // precondition: 4 humans, 4 seats
        app.startGame();                            // index.html startGame
        await vi.advanceTimersByTimeAsync(80);
        expect(app.state.phase).toBe('playing');
        return code;
    }

    /** Bob taps the room link again — a NEW tab, so a fresh sessionStorage. */
    async function bobOpensASecondTab(code) {
        const before = seats[0].lobby.clientId;
        const tab2 = await joinAs('bob-laptop', 'Bob', code);
        expect(
            tab2.lobby.clientId,
            'precondition: the second tab must mint a different clientId (sloplobby.js getClientId)'
        ).not.toBe(before);
        // Bob plays in his phone tab; this one just sits there (and is refused a seat).
        tab2.abandoned = true;
        return tab2;
    }

    /**
     * Control: the harness really does drive a round to judging, so the three assertions
     * below are about the duplicate seat, not about the scaffolding.
     */
    it('control: with one tab per human the round reaches judging', async () => {
        await gameInProgress();
        await everyoneNonCzarSubmits();
        expect(app.state.phase).toBe('judging');
        // Seats are named on the wire by the host's own alias, never by a clientId, so
        // "am I the czar?" is asked in the ids the snapshot handed this device.
        expect(seats.every(s => s.sawJudging || (s.myId && s.myId === s.czarId))).toBe(true);
    });

    it('does not seat the same human twice when they re-open the room link', async () => {
        const code = await gameInProgress();
        await bobOpensASecondTab(code);

        const names = app.state.players.map(p => p.name);
        expect(
            names,
            'onPlayerJoined must refuse a name a CONNECTED player already holds, so the ' +
            'second tab is never seated'
        ).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);

        const tab2 = seats[seats.length - 1];
        const refusal = (tab2.joinFailure && tab2.joinFailure.reason) ||
            (tab2.joinErrors[0] && tab2.joinErrors[0].reason);
        expect(refusal, 'and the refused tab is told WHY, once').toMatch(/already in the game/i);
    });

    it('still reaches judging once every real player has submitted', async () => {
        const code = await gameInProgress();
        await bobOpensASecondTab(code);   // this tab is left on the game screen, untouched

        await everyoneNonCzarSubmits();   // Bob (phone), Carol, Dan — Alice is czar

        const eligible = app.state.players.filter(p => !p.away && p.id !== app.state.czarId);
        const got = eligible.filter(p => app.state.submissions[p.id]).length;
        expect(
            app.state.phase,
            `round must reach judging: got=${got} needed=${eligible.length} — the abandoned ` +
            'tab holds no seat, and maybeStartJudging() counts only present non-czar players'
        ).toBe('judging');
    });

    it('recovers when the abandoned tab is closed', async () => {
        const code = await gameInProgress();
        const tab2 = await bobOpensASecondTab(code);

        await everyoneNonCzarSubmits();

        // Bob notices the stray tab and closes it.
        tab2.lobby.destroy();
        await vi.advanceTimersByTimeAsync(200);

        expect(
            app.state.players.length,
            'the abandoned tab never held a seat, so closing it changes nothing'
        ).toBe(4);
        expect(
            app.state.phase,
            'every remaining player has played, and the gate is re-evaluated on every ' +
            'membership change — the round moves on instead of hanging'
        ).toBe('judging');
    });
});
