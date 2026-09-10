/**
 * ROUND-3 ADVERSARIAL REVIEW — spec compliance and test quality.
 *
 * HISTORY: this path previously held a ROUND-1 adversarial suite (26 tests,
 * describes A1..A11 + R1..R5) which the round-3 reviewer overwrote. The file was
 * untracked, so it is gone; nothing in the repo or in any working copy holds it.
 * The inventory of what it covered is at the FOOT of this file, annotated with
 * where each guarantee is covered now — every one of them is, in one of the
 * lib-*.test.js suites, attack-state-machine.test.js or the blocks below.
 *
 * Every block below names the spec item it attacks and the exact sequence.
 * Nothing in the library is modified; these drive the shipped code only. The
 * ATTACK blocks were RED against the round-3 library and are green now; they
 * stand as regression tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';
import {
    SlopNet, SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createClient, startHost, joinClient, recordEvents, advance,
} from './lib-harness.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * ATTACK 1 — C10: the join-error message is NOT unconditional, and 'rejected'
 * is the one terminal state _endOfTheRoad does not wrap. A reasonless kick
 * therefore reports NOTHING an unmodified app understands.
 *
 * Spec C10, verbatim:
 *   client.on('rejected', reason => { this._onClientData({ type: 'join-error',
 *   reason }); this._onStateChange('rejected', reason); })
 *       — keeps every app's existing join-error code path working.
 *
 * sloplobby.js:739 gates that message on `if (reason)`. host.removeClient(id)
 * holds an EMPTY reason for the next knock (slopnet.js:1199), so the client's
 * own ladder walks into a `__slopnet_join_reject { reason: '' }` and turns
 * terminal — with no message, and (unlike 'superseded'/'room-closed',
 * sloplobby.js:767/773) no _endOfTheRoad bookend, so no 'reconnect-failed'.
 *
 * Observed states: connecting, connected, disconnected, reconnecting, rejected("")
 * Observed toasts: ["Disconnected — reconnecting..."]
 * Observed onClientData: []
 *
 * An app that speaks only the pre-round-3 vocabulary (flip-7 creates its
 * reconnect banner in 'disconnected' and only ever rewrites it in
 * 'reconnect-failed') is left on "Reconnecting..." for the rest of the night on
 * a client that is terminal. It also falsifies LIB-CHANGES §1's claim that
 * "Terminal states never reconnect and never raise the 'Disconnected —
 * reconnecting...' toast."
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('ATTACK C10 (fixed): a reasonless kick must report something an unmodified app can act on', () => {
    let env;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    it('C10: host.removeClient(id) with no reason -> no join-error message and no reconnect-failed', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'noreason-', storageKey: 'noreason-host' });
        const msgs = [];
        const states = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'noreason-', storageKey: 'noreason-client',
            onClientData: d => msgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
        });

        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        const id = clientLobby.clientId;

        // The host taps "Remove" with no reason — the shape texas-holdem ships
        // (index.html:1338 / :1344) and the only one SlopLobby.removeClient(id)
        // offers without a second argument.
        hostLobby.removeClient(id);
        await advance(5 * 60 * 1000);              // the client's whole ladder

        const seen = states.map(s => s[0]);

        // The library side is right: terminal, no retries, lobby.client dropped.
        expect(clientLobby.client).toBeNull();
        expect(seen).toContain('rejected');
        expect(seen.filter(s => s === 'reconnecting')).toHaveLength(1);

        // The app side hears nothing it knows.
        expect(
            msgs,
            'C10 makes the join-error message unconditional; sloplobby.js:739 ' +
            'gates it on a truthy reason, so a reasonless kick delivers nothing ' +
            'an unmodified app paints'
        ).toEqual([{ type: 'join-error', reason: '' }]);

        // ...and there is no bookend to close out the reconnect banner that the
        // 'disconnected' state (and its toast) put on screen.
        expect(
            seen.at(-1),
            "'rejected' is the terminal state _endOfTheRoad does not wrap, so the " +
            'last word an unmodified app hears is "reconnecting"'
        ).toBe('reconnect-failed');
        // A reasonless kick closes the channel without a word, so the client really
        // IS disconnected and reconnecting for the ~1 s until its first rung is
        // refused: that toast is honest at the moment it fires, and it is raised by
        // the genuine 'disconnected' event, not by the terminal state. What must not
        // happen — and does not — is a SECOND one after the terminal state.
        expect(
            env.toasts.filter(t => t === 'Disconnected — reconnecting...'),
            'the reconnecting toast belongs to the genuine link loss that precedes ' +
            'the refusal, and must not be repeated once the client is terminal'
        ).toHaveLength(1);

        hostLobby.destroy(); clientLobby.destroy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ATTACK 2 — round-3 "a kick sticks" replays a FIXABLE refusal.
 *
 * flip-7 (index.html:1439-1455) and herd-mentality (index.html:880-892) refuse a
 * join by RETURNING A STRING for validation failures the player fixes on the
 * spot: 'Name is required', 'Name already taken'. SlopLobby routes that through
 * host.rejectClient (sloplobby.js:622) -> PeerHost._rememberRejection
 * (slopnet.js:1227), and _handleJoin consumes the held reason (slopnet.js:740)
 * BEFORE the join ever reaches the app.
 *
 * So the player who reads "Name already taken", types a different name and taps
 * Join is refused again with the same words, and onPlayerJoined is never asked
 * about the new name. Only the THIRD tap gets in.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('ATTACK C5/round-3: a fixable rejection is replayed on the next join', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    it('flip-7/herd: a corrected name is refused with the stale reason and never reaches onPlayerJoined', async () => {
        const taken = ['Alice'];
        const asked = [];
        const hostLobby = new SlopLobby({
            roomPrefix: 'dupname-', storageKey: 'dupname-host',
            onPlayerJoined: (clientId, meta) => {
                asked.push(meta.name);
                if (taken.includes(meta.name)) return 'Name already taken';
                taken.push(meta.name);
            },
        });
        const msgs = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'dupname-', storageKey: 'dupname-client',
            onClientData: d => msgs.push(d),
        });

        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        // Tap 1: "Alice" is taken. Reported correctly.
        const j1 = clientLobby.joinRoom(code, 'Alice').catch(e => e);
        await advance(80);
        await j1;
        expect(msgs).toEqual([{ type: 'join-error', reason: 'Name already taken' }]);
        expect(asked).toEqual(['Alice']);

        // Tap 2: the player types a name nobody has. Same tab, same clientId.
        const j2 = clientLobby.joinRoom(code, 'Bob').catch(e => e);
        await advance(80);
        const err = await j2;

        expect(
            asked,
            'the held rejection is consumed at slopnet.js:740, before _handleJoin ' +
            'reaches the app, so the host is never asked about "Bob"'
        ).toEqual(['Alice', 'Bob']);
        expect(err, 'and the corrected name is refused too').toBeUndefined();
        expect(clientLobby.client && clientLobby.client.isConnected).toBe(true);

        hostLobby.destroy(); clientLobby.destroy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ATTACK 3 — round-3 item 7 did not reach the app it was written for.
 *
 * LIB-CHANGES §7.7: "A door-step rejection reaches unmodified apps as
 * {type:'join-error', reason} again (delivered one tick after the promise, so
 * the app's own catch cannot overwrite it)."  §1 names flip-7 as the app that
 * needs it.
 *
 * The hand-over used to be guarded by `this._destroyed`, and flip-7's catch calls
 * cleanupMultiplayer() (index.html:1737) -> lobby.destroy() (index.html:1944-1948);
 * CAH's catch does the same (index.html:757), as does texas-holdem's resetToLobby
 * (index.html:1452). So the message was dropped for exactly the three apps it was
 * written for, and the player was told to check a room code that was perfectly
 * correct. The guard is now the JOIN GENERATION: only another joinRoom() suppresses
 * it.
 *
 * The door-step refusal is driven here through the seat token, which is the one an
 * unmodified app can still provoke: a second tab asserting a clientId whose seat is
 * occupied and proven cannot present its token, and is refused before any ack.
 * (The held-kick route this originally used is gone — a deliberate re-join now
 * reaches the app; see ATTACK 2.)
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('ATTACK C10/round-3: the deferred door-step join-error must survive the app cleaning up', () => {
    let env;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    it("flip-7 shape: destroy() in the catch must not suppress the host's reason", async () => {
        const hostLobby = new SlopLobby({
            roomPrefix: 'door-', storageKey: 'door-host',
            onPlayerJoined: () => {}, onPlayerRejoined: () => {},
        });
        const created = hostLobby.createRoom('Host', 'ROOMA3');
        await advance(20);
        await created;

        // The player is in, and has confirmed the seat token.
        const seated = new SlopLobby({ roomPrefix: 'door-', storageKey: 'door-seated' });
        const sp = seated.joinRoom('ROOMA3', 'Dave');
        await advance(80);
        await sp;
        expect(hostLobby.getConnectedClientIds()).toEqual([seated.clientId]);

        // Another tab asserts the same clientId (read off the wire; these games put
        // player ids in their state broadcasts) with no token of its own.
        env.store.set('door-thief', seated.clientId);

        const painted = [];
        const thief = new SlopLobby({
            roomPrefix: 'door-', storageKey: 'door-thief',
            onClientData: d => { if (d.type === 'join-error') painted.push('HOST: ' + d.reason); },
        });
        const p = thief.joinRoom('ROOMA3', 'Dave').catch((err) => {
            // projects/flip-7/index.html:1738-1743, verbatim shape.
            painted.push(err.type === 'peer-unavailable'
                ? 'Room not found. Check the code and try again.'
                : 'GENERIC: Could not connect. Check the room code and try again.');
            thief.destroy();                          // <- cleanupMultiplayer()
        });
        await advance(120);
        await p;
        await advance(50);                            // the deferred hand-over's tick

        expect(
            painted,
            "the host's real reason must be the last word, even though the app " +
            'destroyed its lobby inside the catch'
        ).toEqual([
            'GENERIC: Could not connect. Check the room code and try again.',
            'HOST: ' + SlopNet.SEAT_TAKEN_REASON,
        ]);
        expect(seated.client && seated.client.isConnected, 'the seat holder is undisturbed').toBe(true);

        hostLobby.destroy(); seated.destroy(); thief.destroy();
    });

    it("a SECOND joinRoom() does suppress the first attempt's stale reason", async () => {
        const hostLobby = new SlopLobby({
            roomPrefix: 'door2-', storageKey: 'door2-host',
            onPlayerJoined: () => {}, onPlayerRejoined: () => {},
        });
        const created = hostLobby.createRoom('Host', 'ROOMA3B');
        await advance(20);
        await created;

        const seated = new SlopLobby({ roomPrefix: 'door2-', storageKey: 'door2-seated' });
        const sp = seated.joinRoom('ROOMA3B', 'Dave');
        await advance(80);
        await sp;

        env.store.set('door2-thief', seated.clientId);
        const painted = [];
        let thief;
        const retries = [];
        thief = new SlopLobby({
            roomPrefix: 'door2-', storageKey: 'door2-thief',
            onClientData: d => painted.push(d),
            onStateChange: (state) => {
                // The player taps Join again the instant the first attempt is
                // refused — before the deferred reason has had its tick.
                // ...this time at a room that does not exist, so the second attempt
                // has no reason of its own and anything painted can only be the
                // first attempt's.
                if (state === 'rejected' && retries.length === 0) {
                    retries.push(thief.joinRoom('NOSUCH', 'Dave').catch(() => {}));
                }
            },
        });
        const p = thief.joinRoom('ROOMA3B', 'Dave').catch(() => {});
        await advance(300);
        await p;
        await Promise.all(retries);
        await advance(50);

        expect(
            painted.filter(d => d.type === 'join-error').length,
            'the first attempt\'s reason must not land on the screen of the second: ' +
            JSON.stringify(painted)
        ).toBe(0);

        hostLobby.destroy(); seated.destroy(); thief.destroy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ATTACK 4 (CRITICAL) — C3/C9/C20: the staleMs tie-break supersedes the player's
 * OWN next rung, and locks a single-tab player out of the room for good.
 *
 * slopnet.js:794
 *     if (occupied && staleMs > 0 && existing.boundAt &&
 *         Date.now() - staleMs < existing.boundAt) { this._supersede(conn); return; }
 *
 * `staleMs` is "how long since I last heard from this host" and `boundAt` is set
 * by _bindConn (slopnet.js:880) at the moment of the rebind — one statement
 * before the ack is sent. So ANY rebind whose ack does not come back leaves the
 * client with lastContact < boundAt, and its very next rung is read as "a tab the
 * player walked away from".
 *
 * The sequence (all of it ordinary, no second tab anywhere):
 *   T0        Alice is seated. host boundAt = T0, her _lastPongTime = T0.
 *   T0+30s    her radio half-dies: her side of the channel closes, the host's half
 *             still reads open — the ~20 s window slopnet.js:1220 documents.
 *   T0+31s    rung 1 lands. The host rebinds her seat to the new connection
 *             (boundAt = T0+31s) and acks. Her downlink is dead, so the ack never
 *             arrives and _lastPongTime stays at T0.
 *   T0+34s    her connect timeout fires; rung 2 carries staleMs = now - T0.
 *             occupied is still true (nothing has convicted rung 1's channel), and
 *             now - staleMs = T0 < boundAt = T0+31s  ->  _supersede.
 *
 * Result: her own client goes TERMINAL 'superseded'. SlopLobby toasts "This game
 * is open in another tab", never reconnects, and the host goes on holding her seat
 * against a dead channel. One tab, one player, permanent lockout.
 *
 * Fix direction: the tie-break must compare against the last time the CURRENT
 * HOLDER was actually heard from (a rebind that was never acknowledged is not
 * evidence that anybody is sitting there), not against the bind timestamp.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('ATTACK C3/C9: a rejoin whose ack never lands supersedes the player themselves', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Her side of the channel dies; the host's half still reads open. */
    function halfDie(conn) { conn._closed = true; conn.open = false; conn.emit('close'); }

    it('C3/C9: one tab, no duplicate — the player is told the game is open elsewhere and never gets back in', async () => {
        // Production heartbeat numbers on both ends: this is not an artefact of
        // switching the heartbeat off.
        const host = await startHost('ROOM1', { heartbeatInterval: 5000, heartbeatTimeout: 15000, reconnectWindowMs: 120000 });
        const alice = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {
            heartbeatInterval: 5000, heartbeatTimeout: 15000, connectionTimeout: 3000,
            reconnectBackoffBase: 1000, reconnectBackoffMultiplier: 1, reconnectBackoffMax: 1000,
        });
        const log = recordEvents(alice, ['disconnected', 'reconnected', 'superseded', 'rejected']);
        const supersedes = [];
        const realSupersede = host._supersede.bind(host);
        host._supersede = (conn) => { supersedes.push(conn); return realSupersede(conn); };

        await advance(30000);
        halfDie(alice.connection);                    // the radio half-dies
        await advance(5);
        expect(host._findClientByClientId('alice').conn.open,
            'the host still reads the old channel open').toBe(true);

        // Rung 1 lands and rebinds the seat. Her DOWNLINK is dead from the moment
        // the channel opens, so the ack never arrives and her close never leaves.
        let blinded = false;
        const deafen = setInterval(() => {
            if (blinded || !alice.connection || !alice.connection.open) return;
            blinded = true;
            const realEmit = alice.connection.emit.bind(alice.connection);
            alice.connection.emit = (ev, ...a) => { if (ev !== 'data') realEmit(ev, ...a); };
            alice.connection.close = () => {};
        }, 1);
        await advance(1500);
        clearInterval(deafen);

        const rec = host._findClientByClientId('alice');
        expect(rec.conn.open, 'the seat was rebound to a channel the host reads as open').toBe(true);
        expect(Date.now() - rec.boundAt, 'and boundAt has moved to the rebind').toBeLessThan(1000);
        expect(alice._lastPongTime,
            'while her last contact predates the rebind — which is guaranteed for ' +
            'ANY rebind whose ack does not come back').toBeLessThan(rec.boundAt);

        await advance(6000);                          // her own rung 2

        // A rebind always supersedes the connection it replaces — that is the whole
        // of C3 and those entries are correct. What must never be superseded is the
        // channel the player is actually holding.
        expect(
            supersedes.includes(alice.connection),
            'the host superseded her own live reconnect'
        ).toBe(false);
        expect(alice.terminalReason,
            'one tab, one player: told the game is open in another tab and locked out').toBe(null);
        expect(log.map(e => e.event)).not.toContain('superseded');
        expect(alice.isConnected).toBe(true);

        alice.destroy(); host.destroy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PROBES — sequences I expected to break and could not. Kept as regressions.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe('PROBE C24: host.resume() does not convict a silent client early', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // PeerHost.resume() pings every seated client (slopnet.js:1502-1505) and each
    // ping increments _pingsAwaitingPong without the heartbeat's pacing. Six app
    // switches in two seconds therefore satisfy the "N pings ignored" half of the
    // rule instantly — but the wall-clock half still holds the line.
    it('C24: six foreground events inside two seconds do not evict a locked phone early', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 5000, heartbeatTimeout: 15000 });
        const c = await joinClient('ROOM1', 'alice', {}, { heartbeatInterval: 0 });
        const log = recordEvents(host, ['client-left', 'client-lost']);

        c.connection.emit = () => {};                // the player's screen locks

        for (let i = 0; i < 6; i++) { host.resume(); await advance(300); }
        const rec = host._findClientByClientId('alice');
        expect(rec._pingsAwaitingPong).toBeGreaterThanOrEqual(6);
        expect(log, 'no conviction before heartbeatTimeout of silence').toEqual([]);

        await advance(10000);
        expect(log, 'still nothing at t=12s, six unanswered pings notwithstanding').toEqual([]);
        await advance(10000);
        expect(log.map(e => e.event)).toEqual(['client-left']);
        expect(host.getDisconnectedClientIds()).toEqual(['alice']);

        c.destroy(); host.destroy();
    });
});

describe('PROBE C9/C3: the staleMs tie-break cannot supersede a legitimate reconnect', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // slopnet.js:794 mixes the HOST's clock (Date.now(), boundAt) with a duration
    // measured on the CLIENT's (staleMs). A rejoin whose ack was the client's last
    // inbound message therefore lands exactly on the boundary. Confirm the
    // inequality is strict in the right direction: a client that reconnects
    // immediately after binding is seated, not told it is a duplicate.
    it('C9: a client that reconnects moments after being bound is seated, not superseded', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 0, reconnectWindowMs: 60000 });
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { heartbeatInterval: 0 });

        // Two flaps in a row, each while the host still believes the old channel
        // is open (nothing has convicted it — the heartbeat is off).
        for (let i = 0; i < 3; i++) {
            const hostConn = host._findClientByClientId('alice').conn;
            expect(hostConn.open).toBe(true);
            c.connection.close();
            await advance(500);
            expect(c.terminalReason, 'flap ' + i).toBe(null);
            expect(c.isConnected).toBe(true);
        }
        expect(host.getConnectedClientIds()).toEqual(['alice']);

        c.destroy(); host.destroy();
    });
});

describe('PROBE C6: a room closed while a player is inside their window', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // _defaultGrace (slopnet.js:1587) stretches to reconnectBackoffBase + 250 when
    // a seat is held for somebody absent, so their first rung lands inside the
    // grace and is answered with the same goodbye. Check the boundary: a rung that
    // is due AFTER the grace gets nothing, and the client keeps knocking.
    it('C6: the documented limit — a rung past the grace finds an empty room and keeps a live ladder', async () => {
        const host = await startHost('ROOM1', { reconnectBackoffBase: 100 });
        const near = await joinClient('ROOM1', 'near', {}, { reconnectBackoffBase: 100, reconnectBackoffMax: 100 });
        const far = await joinClient('ROOM1', 'far', {}, { reconnectBackoffBase: 5000, reconnectBackoffMax: 5000 });
        near.connection.close();
        far.connection.close();
        await advance(10);
        expect(host.getDisconnectedClientIds().sort()).toEqual(['far', 'near']);

        const p = host.close('Goodnight');
        await advance(2000);
        await p;

        expect(near.terminalReason, 'the near rung lands inside the grace').toBe('room-closed');
        expect(far.terminalReason, 'the far one is beyond reach — the documented limit').toBe(null);
        expect(far.isConnected).toBe(false);

        near.destroy(); far.destroy();
    });
});

describe('ATTACK C27: the mock lets a client dial a host whose signalling socket is dead', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // MockPeer.aliveTimeoutMs (mock-peer.js:339-346) models the PeerServer holding
    // a dropped id for its alive_timeout — but it holds the DISCONNECTED MockPeer
    // in the registry, and MockPeer.connect (mock-peer.js:274) only rejects a peer
    // that is `destroyed`. So a dialler is happily paired with a peer whose socket
    // is gone: it opens a DataConnection, joins, and is seated.
    //
    // Real peerjs routes the offer through the host's signalling socket; a host
    // with no socket cannot receive it and the dialler gets 'peer-unavailable'.
    // Nothing depends on this today (only lib-host-signalling.test.js:312 sets
    // aliveTimeoutMs, and it joins no client), but "a client can still join during
    // an outage" is exactly the assertion C12/C13 tests reach for, and it would
    // pass here without any reconnect having happened.
    it('C27: a disconnected peer that still holds its id must not accept connections', async () => {
        MockPeer.aliveTimeoutMs = 20000;
        const host = await startHost('ROOM1');
        host.peer.simulateDisconnect();

        const c = createClient();
        // The catch is attached before any timer runs: joinClient() advances first
        // and would leave the rejection unhandled for a tick.
        const settled = c.connect('ROOM1', 'alice', {}).then(() => null, e => e);
        await advance(200);
        const err = await settled;
        const outcome = err ? 'ERR:' + err.type : (c.isConnected ? 'CONNECTED' : 'IDLE');

        expect(
            outcome,
            'the mock pairs the dialler with a peer whose signalling socket is dead'
        ).toBe('ERR:peer-unavailable');

        c.destroy(); host.destroy();
    });
});

/*
 * ROUND-1 SUITE — INVENTORY AND WHERE ITS GUARANTEES LIVE NOW
 *
 * The round-1 adversarial suite used to live at this path (26 tests, describes
 * A1..A11 + R1..R5). The round-3 reviewer overwrote it; the file was untracked, so
 * there is no copy anywhere and it cannot be restored. Below is the inventory the
 * reviewer recovered from the run logs, annotated with the file that carries each
 * guarantee today — every one of them is still covered.
 *
 *   A1  a plain close drops unsent messages, so flush-close is load-bearing (3)
 *         -> lib-mock-fidelity.test.js;
 *            attack-state-machine.test.js "mock fidelity — a plain close() must
 *            drop unsent messages (C27)" (both halves, incl. removeClient's flush)
 *   A2  a kick with a reason sticks even if the player is momentarily absent (2)
 *         -> lib-remove-reject-client.test.js "a kick sticks" block, incl. the new
 *            "held reason is aimed at the ladder" and "deliberate return" tests;
 *            attack-state-machine.test.js "kicking a player who is between sessions"
 *   A3  closeRoom() waits for the first rung of anyone it cannot reach (3)
 *         -> lib-room-closed.test.js; PROBE C6 above (the documented limit);
 *            attack-state-machine.test.js "GUARANTEE C19"
 *   A4  a reconnect-window timer that expires during close()'s grace says nothing
 *         -> attack-state-machine.test.js "BUG C6/C21"; lib-room-closed.test.js
 *   A5  game data is not emitted during the close grace
 *         -> lib-room-closed.test.js "C19: a join arriving during the grace..."
 *            and slopnet's _closing guard in _handleData (host-client.test.js)
 *   A6  a stale seat token loses to the live tab, but only while that tab is live
 *         -> lib-seat-token.test.js; attack-state-machine.test.js "duplicate tab
 *            after a host restart (C3 vs C9)"
 *   A6b losing the FIRST join_ack does not lock a player out of their own seat
 *         -> attack-state-machine.test.js "attack: seat tokens (C9)"; and the
 *            neighbouring case the round-1 test did NOT pin (a lost REJOIN ack)
 *            is ATTACK C3/C9 above + "a rejoin whose ack never lands" there
 *   A6c unusable storage keeps the clientId AND its token
 *         -> lib-storage-robustness.test.js; attack-state-machine.test.js
 *            "SlopLobby seat tokens with unusable storage (C9 + C17)"
 *   A6d a double-tapped Join leaves exactly one live client
 *         -> attack-state-machine.test.js "two joinRoom() calls on one lobby"
 *   A6e a throw from the Peer constructor is just a failed rung
 *         -> attack-state-machine.test.js "the _connecting latch (C7)" (client) and
 *            "BUG C13: a throw from the Peer constructor on a reconnect rung" (host)
 *   A7  a failed createRoom leaves nothing behind
 *         -> attack-state-machine.test.js "SlopLobby createRoom failure (C10 asymmetry)"
 *   A8  only the rejected terminal drops lobby.client
 *         -> lib-sloplobby-wiring.test.js; lib-room-closed.test.js
 *   A9  two clientIds from one peer id are two independent seats
 *         -> regression-rejoin-ordering-and-seat.test.js; attack-state-machine.test.js
 *            "BUG C2/C4: a window expiring for record A closes the connection
 *            record B is now bound to"
 *   A10 connect()'s documented throw message is only one of four
 *         -> lib-connecting-flag.test.js; lib-connect-settles.test.js
 *   A11 visibilitychange nudges the ladder without rewinding or hammering it
 *         -> lib-sloplobby-wiring.test.js; attack-state-machine.test.js
 *            "PeerHost.resume() is unthrottled (C13/C24)"
 *   R1  a HELD seat must not be claimable without its token (2)
 *         -> lib-seat-token.test.js; attack-state-machine.test.js "the seat token
 *            protects an OCCUPIED seat only (C9)"
 *   R2  rejectClient must stick even when the host thinks the channel is open
 *         -> lib-remove-reject-client.test.js "a kick whose channel is dead without
 *            the host knowing still sticks"
 *   R3  a connection rebound to a second clientId must release the first seat
 *         -> regression-rejoin-ordering-and-seat.test.js; attack-state-machine.test.js
 *            "BUG C2/C4"
 *   R4  an unmodified app must be able to show the host's rejection reason
 *         -> attack-app-compat.test.js D1/D3; ATTACK C10 and ATTACK C10/round-3
 *            above — including the case the round-1 test did NOT pin (an app that
 *            destroys its lobby inside its own catch)
 *   R5  a failed joinRoom leaves nothing registered
 *         -> lib-sloplobby-wiring.test.js "a failed joinRoom leaves lobby.client
 *            null and rethrows" / "...leaves no visibilitychange listener behind"
 */
