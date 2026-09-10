/**
 * Adversarial state-machine / race attacks on PeerHost + PeerClient.
 *
 * Every test here names the change it is attacking (C1..C27) and says in its title
 * whether it demonstrates a BUG or documents a GUARANTEE that currently holds.
 *
 * The tests titled BUG in the first blocks were written against the round-1
 * library, where each one failed; every one of them is now fixed and they stand
 * as regression tests. The tests titled GUARANTEE were green already and exist so
 * a later change cannot quietly break them.
 *
 * The ROUND 3 block at the foot of the file is the current adversarial pass: the
 * tests titled BUG there FAIL against the library as it stands today.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry, MockPeer, registry } from './mock-peer.js';
import {
    SlopNet, SlopLobby, SlopLobbyModule, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createHost, createClient, startHost, joinClient, recordEvents, advance,
} from './lib-harness.js';

const { SEAT_TAKEN_REASON } = SlopNet;
const CLIENT_EVENTS = ['connected', 'reconnected', 'disconnected', 'reconnecting', 'reconnect-failed', 'rejected', 'superseded', 'room-closed', 'token', 'data'];
const HOST_EVENTS = ['client-joined', 'client-rejoined', 'client-left', 'client-lost'];

/**
 * The tab is killed / the page is discarded before the browser dispatches the
 * inbound message event. The bytes reached the machine; the page never ran the
 * handler. Everything else (timers, the wire, the far side) is untouched.
 */
function swallowInbound(conn) {
    const real = conn.emit.bind(conn);
    conn.emit = (event, ...args) => {
        if (event === 'data') return;      // never dispatched to the page
        real(event, ...args);
    };
}

describe('attack: seat tokens (C9) — a token the client never received', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C9: a player whose FIRST join_ack never arrived is locked out of their own seat for the life of the room', async () => {
        const host = await startHost();

        // Bob dials in. The host seats him and mints token T1 in the ack — but Bob's
        // tab is discarded before the browser dispatches that message, so Bob never
        // learns T1 and nothing is written to his sessionStorage.
        const bob = createClient();
        const first = bob.connect('ROOM1', 'bob', { name: 'Bob' }).catch(e => e);
        await advance(0);
        expect(bob.connection).toBeTruthy();
        swallowInbound(bob.connection);
        await advance(50);

        const seat = host._findClientByClientId('bob');
        expect(seat, 'the host HAS seated bob and minted him a token').toBeTruthy();
        expect(typeof seat.token).toBe('string');
        expect(bob.token, 'but bob never saw it').toBe(null);

        // His connect() eventually times out and he is left on a dead screen.
        await advance(4000);
        const err = await first;
        expect(err.type).toBe('connection-timeout');
        bob.destroy();
        await advance(20);

        // He reloads the page. sessionStorage survives a reload, so the SAME clientId
        // comes back — with no token, because there never was one to save.
        const bob2 = createClient();
        const log2 = recordEvents(bob2, CLIENT_EVENTS);
        const p2 = bob2.connect('ROOM1', 'bob', { name: 'Bob' }).catch(e => e);
        await advance(100);
        const err2 = await p2;

        expect(
            err2 && err2.type,
            'bob is refused his own seat: the host demands a token it never managed to give him'
        ).not.toBe('rejected');
        expect(log2.filter(e => e.event === 'rejected')).toEqual([]);
        expect(bob2.isTerminal).toBe(false);

        host.destroy(); bob2.destroy();
    });

    it('BUG C9: the lockout OUTLIVES the reconnect window — _pastClients carries the token forever', async () => {
        const host = await startHost();

        const bob = createClient();
        const first = bob.connect('ROOM1', 'bob', { name: 'Bob' }).catch(e => e);
        await advance(0);
        swallowInbound(bob.connection);
        await advance(50);
        await advance(4000);
        await first;
        bob.destroy();

        // Wait out the whole reconnect window: the seat is released ('client-lost')
        // and bob becomes a "past client"... whose token is remembered with him.
        const hostLog = recordEvents(host, HOST_EVENTS);
        await advance(70000);
        expect(hostLog.map(e => e.event)).toContain('client-lost');
        expect(host.clients.size).toBe(0);
        expect(host._pastClients.get('bob').token).toEqual(expect.any(String));

        // Bob tries again, long after his seat was released to the game.
        const bob3 = createClient();
        const p3 = bob3.connect('ROOM1', 'bob', { name: 'Bob' }).catch(e => e);
        await advance(100);
        const err3 = await p3;

        expect(
            err3 && err3.type,
            'even after the seat was released, the remembered token keeps bob out permanently'
        ).not.toBe('rejected');

        host.destroy(); bob3.destroy();
    });
});

describe('attack: SlopLobby seat tokens with unusable storage (C9 + C17)', () => {
    let env;
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals({ throwingStorage: true });
        installSlopNetGlobal();
    });
    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    it('BUG C9/C17: in a private/partitioned tab the clientId survives a leave but the token cannot — the rejoin is refused for good', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'pt-', storageKey: 'pt-host' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        const msgs = [];
        const states = [];
        const first = new SlopLobby({
            roomPrefix: 'pt-', storageKey: 'pt-client',
            onClientData: d => msgs.push(d), onStateChange: (s, d) => states.push([s, d]),
        });
        const j1 = first.joinRoom(code, 'Bob');
        await advance(60);
        await j1;
        const clientId = first.clientId;
        expect(first.client.isConnected).toBe(true);

        // "Back to menu": the app destroys its lobby and joins again from the SAME page.
        // C17's in-memory fallback hands back the SAME clientId; the token has no such
        // fallback, so the second join presents an identity it cannot prove.
        first.destroy();
        await advance(20);

        const msgs2 = [];
        const states2 = [];
        const again = new SlopLobby({
            roomPrefix: 'pt-', storageKey: 'pt-client',
            onClientData: d => msgs2.push(d), onStateChange: (s, d) => states2.push([s, d]),
        });
        const j2 = again.joinRoom(code, 'Bob').catch(e => e);
        await advance(100);
        const err = await j2;

        expect(again.clientId, 'C17 keeps the identity stable across the leave').toBe(clientId);
        expect(
            msgs2,
            'but the seat check turns the player away from the seat they just left'
        ).toEqual([]);
        expect(err && err.type).not.toBe('rejected');

        hostLobby.destroy(); again.destroy();
    });
});

describe('attack: duplicate tab after a host restart (C3 vs C9)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('GUARANTEE C3/C9: a superseded tab stays dead across a host restart, so only one tab ever holds the seat', async () => {
        let host = await startHost('DUP1');

        // One player, two tabs (Chrome's "Duplicate tab" copies sessionStorage, so both
        // hold the same clientId AND the same token).
        const a = await joinClient('DUP1', 'kim', { name: 'Kim' });
        const token = a.token;
        const b = createClient();
        const bp = b.connect('DUP1', 'kim', { name: 'Kim' }, { token });
        await advance(50);
        await bp;
        expect(a.terminalReason, 'C3: newest wins, the old tab is told').toBe('superseded');
        expect(b.isConnected).toBe(true);

        // The host tab reloads and re-registers the SAME room code.
        host.destroy();
        await advance(50);
        host = await startHost('DUP1');

        const aEvents = recordEvents(a, CLIENT_EVENTS);
        const bEvents = recordEvents(b, CLIENT_EVENTS);
        await advance(30000);

        // The superseded tab never dials again; the live one is re-seated with a fresh
        // token (the restarted host remembers nothing), and nobody is hard-rejected.
        expect(aEvents).toEqual([]);
        expect(bEvents.filter(e => e.event === 'rejected')).toEqual([]);
        expect(b.isConnected).toBe(true);
        expect(b.token).not.toBe(token);
        expect(host.getConnectedClientIds()).toEqual(['kim']);

        host.destroy(); a.destroy(); b.destroy();
    });
});

describe('attack: the _connecting latch (C7)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C7: a throw from the Peer constructor on a reconnect rung latches _connecting and wedges the client for good', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(client.isConnected).toBe(true);

        // The transport refuses to build a peer for exactly one attempt.
        let broken = true;
        class FlakyPeer extends MockPeer {
            constructor(id, opts) {
                if (broken) { broken = false; throw new Error('cannot construct RTCPeerConnection'); }
                super(id, opts);
            }
        }
        client._PeerClass = FlakyPeer;

        // The link drops; the ladder arms a rung; the rung throws inside the timer.
        client.connection.close();
        await advance(10);
        expect(client._connecting, 'the failed link cleared the flag as C7 requires').toBe(false);
        try { await advance(2000); } catch (e) { /* the throw escapes the timer callback */ }

        // The transport works again from here on, and everything that could rescue the
        // client is tried: the ladder, a manual reconnect(), and a tab focus.
        client.reconnect();
        client.resume();
        await advance(300000);

        expect(
            { connecting: client._connecting, connected: client.isConnected, timers: !!client._reconnectTimer },
            'a throw between "_connecting = true" and the first handler latches the flag on: ' +
            '_attemptReconnect, reconnect() and resume() are all gated on it, so nothing ever ' +
            'runs another attempt'
        ).toEqual({ connecting: false, connected: true, timers: false });

        host.destroy(); client.destroy();
    });
});

describe('attack: host close() racing destroy() (C6/C19/C21)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('GUARANTEE C6: destroy() during the grace resolves close(), destroys once, and emits no client-left/client-lost', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS.concat(['destroyed']));

        const cLog = recordEvents(c, CLIENT_EVENTS);
        const closing = host.close('bye');
        host.destroy();                       // the app hit Leave twice
        await advance(1000);
        await closing;

        expect(host._destroyed).toBe(true);
        expect(hostLog.filter(e => e.event === 'destroyed').length).toBe(1);
        expect(hostLog.filter(e => e.event === 'client-left')).toEqual([]);
        expect(hostLog.filter(e => e.event === 'client-lost')).toEqual([]);
        // The documented forfeit, and (with the mock now dropping a plain close's
        // buffer, C27) actually observable: destroy() closes the channels plainly, so
        // the goodbye that close() had queued dies with them and the client sees a
        // plain drop instead of 'room-closed'.
        expect(cLog.filter(e => e.event === 'room-closed')).toEqual([]);
        expect(cLog.map(e => e.event)).toContain('disconnected');
        expect(host._reconnectWindowTimers.size).toBe(0);
        c.destroy();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('BUG C6/C21: a reconnect window that expires during the grace still fires client-lost on a closed room', async () => {
        const host = await startHost('CLS1', { reconnectWindowMs: 300 });
        const c = await joinClient('CLS1', 'alice', { name: 'Alice' });

        // Alice's link drops; the seat is held. The host then ends the room while her
        // window is still counting down.
        c.connection.close();
        await advance(20);
        const hostLog = recordEvents(host, HOST_EVENTS);
        const closing = host.close('bye', { graceMs: 2000 });
        await advance(1000);

        expect(
            hostLog.map(e => e.event),
            'the room is over: nothing about a seat may still be announced to the app'
        ).toEqual([]);
        await advance(2000);
        await closing;
        c.destroy();
    });

    it('GUARANTEE C6: a second close() returns the same promise and does not re-broadcast', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const seen = [];
        c.on('room-closed', r => seen.push(r));

        const p1 = host.close('bye');
        const p2 = host.close('other');
        expect(p1).toBe(p2);
        await advance(1000);
        await p1;
        expect(seen).toEqual(['bye']);
        c.destroy();
    });
});

describe('attack: window expiry vs rejoin, same timer flush (C4/C5)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('GUARANTEE C4: a window that expires while the seat is still open closes the conn and the client rejoins as a returning player', async () => {
        const host = await startHost('WIN1', { reconnectWindowMs: 20000 });
        const c = await joinClient('WIN1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS);
        const clientLog = recordEvents(c, CLIENT_EVENTS);

        // Convict the seat without closing the channel (what the heartbeat does).
        host._handleDisconnect(c.connection._remote);
        expect(hostLog.map(e => e.event)).toEqual(['client-left']);
        expect(c.connection.open).toBe(true);

        await advance(25000);
        // The expiry releases the seat AND closes the still-open channel, so the client
        // is not left talking into the void: it reconnects and is greeted as a returner.
        expect(hostLog.map(e => e.event)).toEqual(['client-left', 'client-lost', 'client-rejoined']);
        expect(clientLog.filter(e => e.event === 'rejected')).toEqual([]);
        expect(clientLog.filter(e => e.event === 'disconnected').length).toBe(1);
        expect(c.isConnected).toBe(true);
        expect(host._pastClients.size).toBe(0);
        host.destroy(); c.destroy();
    });

    it('GUARANTEE C2: two joins for the same clientId in one tick — the right token supersedes, the wrong one is refused, and exactly one record survives', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const token = a.token;

        const good = createClient();
        const bad = createClient();
        const gp = good.connect('ROOM1', 'alice', { name: 'Alice' }, { token });
        const bp = bad.connect('ROOM1', 'alice', { name: 'Mallory' }).catch(e => e);
        await advance(60);
        await gp;
        const err = await bp;

        expect(good.isConnected).toBe(true);
        expect(err.type).toBe('rejected');
        expect(err.reason).toBe(SEAT_TAKEN_REASON);
        expect(a.terminalReason).toBe('superseded');
        expect(host.getAllClientIds()).toEqual(['alice']);
        host.destroy(); a.destroy(); good.destroy(); bad.destroy();
    });
});

describe('attack: mock fidelity — a plain close() must drop unsent messages (C27)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('C27: a message queued immediately before a PLAIN close is dropped', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const got = [];
        c.on('data', d => got.push(d));

        // The spec's verified peerjs fact: close() with no options "drops any buffered
        // (unsent) outgoing messages". That fact is the whole reason rejectClient and
        // close() flush-close, so the mock has to model it or the guarantee is not
        // under test at all.
        const seatConn = host._findClientByClientId('alice').conn;
        seatConn.send({ type: 'never-sent' });
        seatConn.close();                          // plain: the buffer goes with it
        await advance(50);

        expect(got, 'a plain close drops what has not left yet').toEqual([]);

        host.destroy(); c.destroy();
    });

    it('C5: removeClient flush-closes, so what the APP sent in the same breath still arrives', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const got = [];
        c.on('data', d => got.push(d));

        // texas-holdem does exactly this: send the explanation, then kick. With a plain
        // close the player would be dropped with no idea why.
        host.send('alice', { type: 'error', message: 'Game already in progress' });
        host.removeClient('alice');
        await advance(50);

        expect(got).toEqual([{ type: 'error', message: 'Game already in progress' }]);
        expect(host.getAllClientIds()).toEqual([]);
        host.destroy(); c.destroy();
    });
});

describe('attack: host resume() and heartbeat conviction (C24 vs C13/repro-3)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('GUARANTEE C24: resume()\'s extra pings do not convict a live client — its pongs land before the next tick', async () => {
        const host = await startHost('HB1', { heartbeatInterval: 5000, heartbeatTimeout: 15000 });
        const c = await joinClient('HB1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS);

        // The host tab is hidden for a minute. Its timers do not run; the player's phone
        // is asleep too, so nothing comes in either.
        const seat = host._findClientByClientId('alice');
        seat._lastPong = Date.now() - 60000;

        // The host tab is brought to the foreground three times in quick succession
        // (SlopLobby calls resume() on every visibilitychange).
        host.resume();
        host.resume();
        host.resume();
        expect(seat._pingsAwaitingPong).toBe(3);

        // The next heartbeat tick would otherwise judge a silence that no ping has yet
        // had a chance to break — three "misses" all sent microseconds ago. The pongs
        // arrive first and reset the counter, so nobody is evicted.
        await advance(5000);

        expect(
            hostLog.map(e => e.event),
            'resume()\'s pings must not count as unanswered misses before they could be answered'
        ).toEqual([]);
        expect(seat._pingsAwaitingPong).toBeLessThanOrEqual(1);
        host.destroy(); c.destroy();
    });
});

describe('attack: two joinRoom() calls on one lobby (C9/C10)', () => {
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

    it('BUG C9/C10: a double-tapped Join hard-rejects the second attempt AND nulls lobby.client while the first stays connected', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'dt-', storageKey: 'dt-host' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        const msgs = [];
        const states = [];
        const lobby = new SlopLobby({
            roomPrefix: 'dt-', storageKey: 'dt-client',
            onClientData: d => msgs.push(d), onStateChange: (s, d) => states.push([s, d]),
        });

        // The player taps Join twice before the first attempt has been acked. Nothing in
        // SlopLobby serialises this and PeerClient's own guard is per-instance.
        const a = lobby.joinRoom(code, 'Bob').catch(e => e);
        const b = lobby.joinRoom(code, 'Bob').catch(e => e);
        await advance(200);
        const ra = await a;
        const rb = await b;

        expect(
            [ra, rb].filter(r => r && r.type === 'rejected').length,
            'the same player, from the same tab, is told the seat belongs to someone else'
        ).toBe(0);
        expect(msgs.filter(m => m.type === 'join-error')).toEqual([]);
        expect(
            lobby.client,
            'the rejected attempt nulls lobby.client, orphaning the connection that DID succeed'
        ).not.toBeNull();
        expect(lobby.sendToHost({ type: 'ping' })).toBe(true);

        hostLobby.destroy(); lobby.destroy();
    });
});

describe('attack: SlopLobby createRoom failure (C10 asymmetry)', () => {
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

    it('BUG C10: a failed createRoom leaves lobby.host pointing at a dead host (the client path nulls its client)', async () => {
        class DeadPeer extends MockPeer {
            constructor(id, opts) {
                // Registration never completes; the signalling server refuses us instead.
                super(id, { ...(opts || {}), openDelayMs: 10 ** 9 });
                setTimeout(() => {
                    const err = new Error('server unreachable');
                    err.type = 'server-error';
                    this.emit('error', err);
                }, 0);
            }
        }
        installSlopNetGlobal(DeadPeer);

        const lobby = new SlopLobby({ roomPrefix: 'dead-', storageKey: 'dead-host' });
        const p = lobby.createRoom('Host').catch(e => e);
        await advance(50);
        const err = await p;
        expect(err.type).toBe('server-error');

        expect(
            lobby.host,
            'joinRoom() nulls lobby.client when connect() rejects; createRoom() leaves a dead host behind'
        ).toBeNull();
        expect(env.document._listenerCount('visibilitychange')).toBe(0);
    });
});

/* =========================================================================
 * ROUND 2 — state-machine and race attacks.
 *
 * Titles marked BUG fail against the current library and describe a defect;
 * titles marked GUARANTEE pass and pin down behaviour a later change must keep.
 * ========================================================================= */

describe('attack r2: the seat token protects an OCCUPIED seat only (C9)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C9: a stranger who asserts a clientId while its holder is inside the reconnect window takes the seat, and the holder is locked out for good', async () => {
        const host = await startHost('THEFT', { reconnectWindowMs: 120000 });
        const alice = await joinClient('THEFT', 'alice', { name: 'Alice' });
        const aliceToken = alice.token;

        // Alice's phone loses the channel. The host holds her seat for two minutes
        // and her ladder starts climbing.
        alice.connection.close();
        await advance(5);
        expect(host._findClientByClientId('alice').disconnected).toBe(true);

        // Mallory read 'alice' off the wire — every one of these games broadcasts
        // player ids in its state messages — and asserts it from another device with
        // no token at all. _handleJoin (slopnet.js:702-709) only refuses a token
        // mismatch while `occupied` (bound to an OPEN conn), so an absent seat is
        // handed over and its token is re-minted underneath the holder.
        const mallory = createClient();
        const mp = mallory.connect('THEFT', 'alice', { name: 'Mallory' }).catch(e => e);
        await advance(60);
        await mp;

        expect(
            mallory.isConnected,
            'a connection that cannot prove the seat is its own must not be given a seat somebody is coming back to'
        ).toBe(false);

        // ...and Alice, presenting the token the host actually issued her, is refused
        // for the rest of the room's life: 'rejected' is TERMINAL, so her ladder stops
        // and a reload (same sessionStorage, same clientId, same token) is refused again.
        await advance(200000);
        expect(alice.terminalReason).toBe(null);
        expect(alice.token).toBe(aliceToken);

        host.destroy(); alice.destroy(); mallory.destroy();
    });

    it('BUG C9/C10: the theft is permanent through SlopLobby — the victim gets join-error and cannot get back in by reloading', async () => {
        const env = installBrowserGlobals();
        installSlopNetGlobal();
        try {
            const hostLobby = new SlopLobby({ roomPrefix: 'st-', storageKey: 'st-host' });
            const created = hostLobby.createRoom('Host');
            await advance(20);
            const code = await created;

            const aliceTab = new Map();
            env.useStore(aliceTab);
            const msgs = [];
            const states = [];
            const alice = new SlopLobby({
                roomPrefix: 'st-', storageKey: 'st-client',
                onClientData: d => msgs.push(d), onStateChange: (s, d) => states.push([s, d]),
            });
            const j = alice.joinRoom(code, 'Alice');
            await advance(100);
            await j;
            const aliceId = alice.clientId;

            alice.client.connection.close();
            await advance(10);

            const mallory = createClient({ roomPrefix: 'st-' });
            const mp = mallory.connect(code, aliceId, { name: 'Mallory' }).catch(e => e);
            await advance(100);
            await mp;
            await advance(400000);

            expect(
                msgs.filter(m => m.type === 'join-error'),
                'the seat holder is thrown out of her own game by a stranger'
            ).toEqual([]);
            expect(states.map(s => s[0])).not.toContain('rejected');

            // Reload the tab: sessionStorage survives, so the same clientId and the same
            // token come back — and are refused again. There is no way back into the game.
            env.useStore(aliceTab);
            const alice2 = new SlopLobby({ roomPrefix: 'st-', storageKey: 'st-client' });
            const j2 = alice2.joinRoom(code, 'Alice').catch(e => e);
            await advance(200);
            const err = await j2;
            expect(alice2.clientId).toBe(aliceId);
            expect(err && err.type, 'the lockout survives a reload').not.toBe('rejected');

            hostLobby.destroy(); mallory.destroy();
        } finally {
            restoreGlobals();
        }
    });
});

describe('attack r2: kicking a player who is between sessions (C5)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C5: removeClient/rejectClient are silent no-ops once the reconnect window has expired, and the kicked player walks back in as a rejoin', async () => {
        const host = await startHost('KICK1', { reconnectWindowMs: 200 });
        // A ladder long enough that the client will not come back on its own.
        const c = await joinClient('KICK1', 'alice', { name: 'Alice' }, { reconnectBackoffBase: 10 ** 7 });

        c.connection.close();
        await advance(400);
        expect(host.getAllClientIds()).toEqual([]);
        expect(host._pastClients.has('alice'), 'the identity is remembered so a late return is a rejoin').toBe(true);

        // The host taps "Remove player" on the ghost still shown in its lobby.
        // Both entry points bail at `if (!client) return false` (slopnet.js:1068,
        // 1083) and never touch _pastClients / _pendingRejections, so the kick is
        // a no-op that reports itself as one.
        expect(host.rejectClient('alice', 'Removed by the host')).toBe(true);
        expect(host._pastClients.has('alice'), 'a deliberate kick must forget the identity').toBe(false);
        expect(host._pendingRejections.get('alice')).toBe('Removed by the host');

        // The player's phone comes back on its own — an automatic rung, which is
        // what `staleMs` on the wire marks (the client has been acked by this host
        // before). That knock is refused with the held reason.
        const hostLog = recordEvents(host, HOST_EVENTS);
        const ladderPeer = new MockPeer();
        const rung = ladderPeer.connect('lib-KICK1', { reliable: true });
        const rungInbox = [];
        rung.on('data', d => rungInbox.push(d));
        await advance(10);
        rung.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' }, staleMs: 5000 });
        await advance(20);

        expect(rungInbox.map(m => m.type)).toEqual(['__slopnet_join_reject']);
        expect(rungInbox[0].reason).toBe('Removed by the host');
        expect(
            hostLog.map(e => e.event),
            'a kicked player\'s own ladder must not be re-admitted'
        ).toEqual([]);

        // A DELIBERATE return — the tab reloaded, the app built a new client, the
        // player tapped Join — is handed to the app instead. What the kick took away
        // is the identity: they arrive as a stranger, never as the 'client-rejoined'
        // apps use to bypass their no-new-players-mid-game gate, so the refusal is
        // the app's to make and it still has everything it needs to make it.
        const back = createClient();
        const p = back.connect('KICK1', 'alice', { name: 'Alice' }).catch(e => e);
        await advance(100);
        await p;

        expect(hostLog.map(e => e.event)).toEqual(['client-joined']);

        host.destroy(); c.destroy(); back.destroy();
    });

    it('BUG C5/C26: SlopLobby.removeClient(id, reason) on a player whose window expired leaves the app believing they are gone while they rejoin behind its back', async () => {
        const env = installBrowserGlobals();
        installSlopNetGlobal(MockPeer, { reconnectWindowMs: 200 });
        try {
            const rejoined = [];
            const hostLobby = new SlopLobby({
                roomPrefix: 'kk-', storageKey: 'kk-host',
                onPlayerRejoined: id => rejoined.push(id),
            });
            const created = hostLobby.createRoom('Host');
            await advance(20);
            const code = await created;

            const client = new SlopLobby({ roomPrefix: 'kk-', storageKey: 'kk-client' });
            const j = client.joinRoom(code, 'Bob');
            await advance(100);
            await j;
            const bobId = client.clientId;

            // Bob's phone dies; his window expires and the app is told he is gone.
            client.client.connection.close();
            client.client._clearReconnectTimer();
            await advance(500);
            expect(hostLobby.players.has(bobId)).toBe(false);

            hostLobby.removeClient(bobId, 'Removed by host');

            // Bob's tab thaws and its ladder brings him home.
            client.client.reconnect();
            await advance(500);

            expect(rejoined, 'the host kicked him; nothing may put him back').toEqual([]);
            expect(hostLobby.players.has(bobId)).toBe(false);

            hostLobby.destroy(); client.destroy();
        } finally {
            restoreGlobals();
        }
    });
});

describe('attack r2: SlopLobby.createRoom has no "retire the previous host" guard (C10)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C10: a double-tapped Host button splits the room in two — players on the first code are seated in lobby.players but every message to them is dropped', async () => {
        const env = installBrowserGlobals();
        installSlopNetGlobal();
        try {
            const joined = [];
            const lobby = new SlopLobby({
                roomPrefix: 'dh-', storageKey: 'dh-host',
                onPlayerJoined: (id, meta) => joined.push([id, meta && meta.name]),
            });

            // joinRoom retires the client it is holding before wiring a new one
            // (sloplobby.js:608-612). createRoom has no equivalent: the first PeerHost
            // stays alive, stays registered under the first code, and keeps every one
            // of this lobby's listeners attached.
            const a = lobby.createRoom('Host').catch(e => e);
            const b = lobby.createRoom('Host').catch(e => e);
            await advance(200);
            const firstCode = await a;
            const secondCode = await b;

            expect(
                firstCode,
                'one lobby, one room: the second call must not register a second host under a second code'
            ).toBe(secondCode);

            // A player who was given the first code reaches the orphan.
            const bob = createClient({ roomPrefix: 'dh-' });
            const bp = bob.connect(firstCode, 'bob', { name: 'Bob' }).catch(e => e);
            await advance(200);
            await bp;

            // One lobby, one host: the code the player was given IS the live room, so
            // the app hears about him AND can reach him. (Round 1 registered a second
            // host under a second code: the app was told he joined, by listeners still
            // bound to an orphan, while every message to him was dropped.)
            expect(joined, 'the app is told Bob joined...').toEqual([['bob', 'Bob']]);
            expect(lobby.send('bob', { hi: 1 }), '...and what it sends him arrives').toBe(true);

            // And destroy() cannot clean up a host it no longer points at.
            lobby.destroy();
            await advance(100);
            expect(bob.isConnected, 'ending the game must disconnect everyone').toBe(false);
            bob.destroy();
        } finally {
            restoreGlobals();
        }
    });

    it('BUG C10: the orphaned host later renames the room out from under the live one', async () => {
        const env = installBrowserGlobals();
        installSlopNetGlobal();
        try {
            const codes = [];
            const lobby = new SlopLobby({
                roomPrefix: 'or-', storageKey: 'or-host',
                onRoomCode: (code, changed) => codes.push([code, changed]),
            });
            const a = lobby.createRoom('Host').catch(e => e);
            const b = lobby.createRoom('Host').catch(e => e);
            await advance(200);
            const firstCode = await a;
            await b;
            const live = lobby.roomCode;

            // The orphan's 'ready' handler is still bound to this lobby, so when its
            // own signalling socket blips and it re-registers, _adoptRoomCode rewrites
            // the room code (and sessionStorage) to the code of a host that is no
            // longer `lobby.host`.
            const orphan = registry.get('or-' + firstCode);
            if (orphan) {
                orphan.simulateDisconnect();
                await advance(10000);
            }

            expect(lobby.roomCode, 'the live host still serves ' + live).toBe(live);
            expect(env.store.get('or-host-room-code')).toBe(live);
            expect(codes.filter(c => c[1] === true), 'no spurious "the code changed" repaint').toEqual([]);

            lobby.destroy();
        } finally {
            restoreGlobals();
        }
    });
});

describe('attack r2: PeerHost.resume() is unthrottled (C13/C24)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C24: every visibilitychange burns a reconnect rung, so app-switching during a signalling blip drives the host to reconnect-failed', async () => {
        const host = await startHost('RSPAM', {
            reconnectBackoffBase: 1000, reconnectBackoffMultiplier: 1.5,
            reconnectBackoffMax: 6000, maxReconnectAttempts: 20,
        });
        const log = recordEvents(host, ['reconnecting', 'reconnected', 'reconnect-failed']);

        host.peer.simulateDisconnect();
        // The PeerServer has not reaped our id yet (~60 s alive_timeout), so every
        // re-registration is answered 'unavailable-id' — the normal shape of this outage.
        const squatter = new MockPeer('lib-RSPAM');
        await advance(10);

        // The host's phone: the player checks a message, looks at the browser, checks
        // the message again... 25 app switches over 25 seconds. The client has
        // RESUME_REDIAL_MIN_MS for exactly this (slopnet.js:162, 2156); resume() on
        // the host (slopnet.js:1319-1329) has no equivalent and calls _doReconnect()
        // every single time.
        for (let i = 0; i < 25; i++) { host.resume(); await advance(1000); }

        expect(
            log.filter(e => e.event === 'reconnect-failed'),
            'switching apps must not be what tells the host its room is unreachable'
        ).toEqual([]);
        expect(
            log.filter(e => e.event === 'reconnecting').length,
            '25 seconds of a 1000ms..6000ms ladder is at most a handful of rungs'
        ).toBeLessThan(12);

        host.destroy();
    });
});

describe('attack r2: a stale ladder rung outranks the tab in front of the player (C3)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C3: the backgrounded duplicate takes the seat back and supersedes the tab the player is actually using', async () => {
        const host = await startHost('PONG', { reconnectWindowMs: 120000 });

        // Tab A is the one the player left open in the background. Its channel drops
        // and its ladder starts climbing — slowly, because a hidden tab's timers are
        // throttled to about one wake a minute.
        const a = await joinClient('PONG', 'kim', { name: 'Kim' }, { reconnectBackoffBase: 60000 });
        const token = a.token;
        a.connection.close();
        await advance(5);
        expect(a._reconnectTimer).toBeTruthy();

        // The player opens the game again (Chrome's Duplicate tab copies
        // sessionStorage, so tab B has the same clientId AND the same token). B is
        // seated: the record was absent, so nobody is superseded.
        const b = createClient();
        const bp = b.connect('PONG', 'kim', { name: 'Kim' }, { token });
        await advance(60);
        await bp;
        expect(b.isConnected, 'the tab the player is looking at holds the seat').toBe(true);

        // Now tab A's overdue rung finally fires. "Newest wins" is applied to a timer,
        // not to the player: the abandoned tab takes the seat back and the tab in
        // front of them is told it is a duplicate.
        await advance(70000);

        expect(
            b.terminalReason,
            'the tab the player just opened must not be killed by a background tab\'s retry timer'
        ).toBe(null);
        expect(b.isConnected).toBe(true);

        host.destroy(); a.destroy(); b.destroy();
    });
});

describe('attack r2: removeClient without a reason is an unbounded reconnect storm (C5)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('BUG C5: the shape texas-holdem ships (send an error, then lobby.removeClient) loops forever at one join a second, with a toast on every pass', async () => {
        const env = installBrowserGlobals();
        installSlopNetGlobal();              // production DEFAULT_CONFIG
        try {
            let calls = 0;
            const hostLobby = new SlopLobby({
                roomPrefix: 'sto-', storageKey: 'sto-host',
                onPlayerJoined: (clientId) => {
                    // projects/texas-holdem/index.html:1336-1339, unmodified.
                    calls++;
                    hostLobby.send(clientId, { type: 'error', message: 'Game already in progress' });
                    hostLobby.removeClient(clientId);
                },
            });
            const created = hostLobby.createRoom('Host');
            await advance(20);
            const code = await created;

            const msgs = [];
            const lobby = new SlopLobby({
                roomPrefix: 'sto-', storageKey: 'sto-client',
                onClientData: d => msgs.push(d),
            });
            const j = lobby.joinRoom(code, 'Bob').catch(e => e);
            await advance(200);
            await j;

            // Every cycle acks the client, which resets _reconnectAttempts
            // (slopnet.js:1800), so the backoff never grows: the ladder is pinned at
            // reconnectBackoffBase for as long as the room lives.
            await advance(300000);

            expect(
                calls,
                'a refused player must be told once, not re-seated and re-kicked once a second for the rest of the night'
            ).toBeLessThan(4);
            expect(env.toasts.length, 'Disconnected.../Reconnected! flickering forever').toBeLessThan(8);
            expect(msgs.length).toBeLessThan(4);

            hostLobby.destroy(); lobby.destroy();
        } finally {
            restoreGlobals();
        }
    });
});

describe('attack r2: storage whose WRITES throw (C17)', () => {
    let saved;
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        saved = globalThis.sessionStorage;
        const store = new Map();
        // Safari's private mode (and any quota-exceeded tab): reads work, writes throw.
        globalThis.sessionStorage = {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: () => { throw new Error('QuotaExceededError'); },
            removeItem: k => store.delete(k),
        };
    });
    afterEach(() => {
        vi.useRealTimers();
        globalThis.sessionStorage = saved;
    });

    it('BUG C17: the in-memory fallback is unreachable when only the WRITE throws, so the clientId changes on every call', () => {
        // readWithFallback (sloplobby.js:162-166) consults memoryStore only when the
        // READ threw. writeStorage stashed the value there (sloplobby.js:157-160) and
        // nothing ever reads it back, so getClientId mints a new identity every time
        // and the seat token and room code are never recalled either.
        const first = SlopLobbyModule.getClientId('sp-client');
        const second = SlopLobbyModule.getClientId('sp-client');
        expect(
            second,
            'an identity that changes between two joinRoom calls can never rejoin its own seat'
        ).toBe(first);
    });
});

describe('attack r2: guarantees that currently hold', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('GUARANTEE C19: a player who is off the air when the host closes still hears room-closed — the grace outlives their first rung', async () => {
        const host = await startHost('GRC', { reconnectWindowMs: 60000 });
        const c = await joinClient('GRC', 'alice', { name: 'Alice' });
        const log = recordEvents(c, CLIENT_EVENTS);

        c.connection.close();
        await advance(5);
        expect(c._reconnectTimer, 'a rung is armed and the host cannot reach her').toBeTruthy();

        const closing = host.close('bye', { graceMs: 5000 });
        await advance(6000);
        await closing;

        expect(c.terminalReason).toBe('room-closed');
        expect(log.filter(e => e.event === 'room-closed').map(e => e.args)).toEqual([['bye']]);
        c.destroy();
    });

    it('GUARANTEE C2/C9: three tabs presenting the same token in one tick leave exactly one seat and one live client', async () => {
        const host = await startHost('TRIO');
        const a = await joinClient('TRIO', 'kim', { name: 'Kim' });
        const token = a.token;

        const b = createClient();
        const d = createClient();
        const bp = b.connect('TRIO', 'kim', {}, { token }).catch(e => e);
        const dp = d.connect('TRIO', 'kim', {}, { token }).catch(e => e);
        await advance(80);
        await bp; await dp;

        const live = [a, b, d].filter(x => x.isConnected);
        expect(live.length).toBe(1);
        expect([a, b, d].filter(x => x.terminalReason === 'superseded').length).toBe(2);
        expect(host.getAllClientIds()).toEqual(['kim']);

        host.destroy(); a.destroy(); b.destroy(); d.destroy();
    });

    it('GUARANTEE C15/C21: destroy() racing an in-flight join_ack leaves no seat, no window timer and a rejected connect()', async () => {
        const host = await startHost('DRACE');
        const c = createClient();
        const p = c.connect('DRACE', 'alice', { name: 'Alice' }).catch(e => e);
        await advance(0);
        await advance(0);          // the join is on the wire, the ack is queued
        c.destroy();
        await advance(200);
        const err = await p;

        expect(err.type).toBe('destroyed');
        expect(host.getAllClientIds()).toEqual([]);
        expect(host._reconnectWindowTimers.size).toBe(0);
        await advance(200000);
        expect(host.getAllClientIds()).toEqual([]);
        host.destroy();
    });

    it('GUARANTEE C6/C13: close() while the signalling ladder is still climbing destroys cleanly and leaves no timers', async () => {
        const host = await startHost('CLADDER');
        const c = await joinClient('CLADDER', 'alice', { name: 'Alice' });
        host.peer.simulateDisconnect();
        const squatter = new MockPeer('lib-CLADDER');
        await advance(10);

        const closing = host.close('bye', { graceMs: 400 });
        await advance(2000);
        await closing;

        expect(host._destroyed).toBe(true);
        expect(c.terminalReason).toBe('room-closed');
        c.destroy();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('GUARANTEE C4: a superseded connection is neither nudged nor able to speak for the seat, however late its events arrive', async () => {
        const host = await startHost('LATE');
        const a = await joinClient('LATE', 'kim', { name: 'Kim' });
        const oldConn = host._findClientByClientId('kim').conn;
        const b = createClient();
        const bp = b.connect('LATE', 'kim', {}, { token: a.token });
        await advance(50);
        await bp;

        const log = recordEvents(host, HOST_EVENTS.concat(['data']));
        host._handleData(oldConn, { type: 'late-move' });
        oldConn.emit('close');
        oldConn.emit('error', new Error('late'));
        await advance(100);

        expect(log).toEqual([]);
        expect(host._findClientByClientId('kim').conn).not.toBe(oldConn);
        expect(b.isConnected).toBe(true);

        host.destroy(); a.destroy(); b.destroy();
    });
});

/* =====================================================================
 * ROUND 3 — state machine & races.
 *
 * Everything below was written against the round-3 library. Titles say BUG
 * where the test currently FAILS and GUARANTEE where it documents behaviour
 * that holds today and must keep holding.
 * ===================================================================== */

/**
 * The ICE stack has not yet noticed that a DataChannel's path is dead.
 *
 * Closing a channel is a message like any other: it travels over the same dead
 * path, and the far end only learns from ICE's own failure detection, which
 * takes seconds to tens of seconds. Until then the far end reads `conn.open`
 * as true and keeps talking into it. Every "the host has not caught up yet"
 * case in this file is modelled by silencing the far side's close exactly once.
 */
function hideCloseFromRemote(conn) {
    const remote = conn._remote;
    if (remote) remote.close = () => {};
}

describe('attack r3: a rejoin whose ack never lands (C3/C9/C20)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * The host's tie-break between two connections claiming one seat is
     *   "has this joiner heard from me since the CURRENT holder sat down?"
     * (slopnet.js:794-798). It reads `existing.boundAt`, which _bindConn stamps
     * at the moment the seat is bound — BEFORE the join_ack is sent, and with no
     * check that the ack was ever delivered.
     *
     * So a connection that was bound and then went silent is indistinguishable
     * from a live duplicate tab, and the seat's real owner — dialling back in on
     * a fresh rung, with the right token and one tab open — is the one told it
     * has been superseded. That is TERMINAL: it never reconnects.
     */
    it('BUG C3/C9: a lost join_ack turns the player\'s OWN next rung into "superseded" — one tab, permanent lockout', async () => {
        const host = await startHost('GHOST', {
            heartbeatInterval: 5000, heartbeatTimeout: 15000, reconnectWindowMs: 120000,
        });
        const bob = createClient({
            heartbeatInterval: 5000, heartbeatTimeout: 15000,
            connectionTimeout: 10000,
            reconnectBackoffBase: 1000, reconnectBackoffMultiplier: 1.5, reconnectBackoffMax: 6000,
        });
        const bp = bob.connect('GHOST', 'bob', { name: 'Bob' });
        await advance(50);
        await bp;

        const clientLog = recordEvents(bob, CLIENT_EVENTS);
        const hostLog = recordEvents(host, HOST_EVENTS);
        await advance(2000);

        // Bob walks into a lift. His tab sees its channel close at once; the host
        // will not learn for many seconds (ICE), so from the host's side the seat
        // is still occupied by an open connection.
        hideCloseFromRemote(bob.connection);
        bob.connection.close();
        await advance(10);
        expect(host._findClientByClientId('bob').disconnected).toBe(false);

        // Rung 1 gets through. The host binds the seat to it and acks — but Bob's
        // page is discarded before the browser dispatches that message, so Bob
        // learns nothing, and this connection's own close will not reach the host
        // either. From here on the host is holding the seat for a ghost.
        const realConnect = MockPeer.prototype.connect;
        let rung = 0;
        MockPeer.prototype.connect = function (id, opts) {
            const conn = realConnect.call(this, id, opts);
            if (++rung === 1) {
                swallowInbound(conn);
                setTimeout(() => hideCloseFromRemote(conn), 5);
            }
            return conn;
        };
        try {
            // Rung 1 (1000ms) is bound-but-unheard; its 10s timeout then arms rung 2.
            await advance(30000);
        } finally {
            MockPeer.prototype.connect = realConnect;
        }

        const events = clientLog.map(e => e.event);
        expect(
            bob.terminalReason,
            'Bob has ONE tab open. The connection the host thinks is holding his ' +
            'seat is his own previous rung, which was bound and then never heard ' +
            'from again — but boundAt was stamped before the ack, so the host reads ' +
            'his live rung as the abandoned tab and terminates it. Events: ' +
            JSON.stringify(events)
        ).toBe(null);
        expect(events).not.toContain('superseded');

        host.destroy(); bob.destroy();
    });

    /**
     * The same rule, stated at the host's own API so the mechanism is unambiguous:
     * a seat bound at T is defended against any join whose last contact predates T,
     * whether or not the binding at T ever reached anybody.
     */
    it('BUG C3: the boundAt tie-break never checks that the current holder heard the ack', async () => {
        const host = await startHost('BOUND', { heartbeatInterval: 0, reconnectWindowMs: 120000 });
        const bob = await joinClient('BOUND', 'bob', { name: 'Bob' }, { heartbeatInterval: 0 });
        const token = bob.token;
        const firstBind = host._findClientByClientId('bob').boundAt;

        // A rung of Bob's arrives and is bound. Its ack is dropped on the floor
        // (the page is gone), so nothing on Bob's side moves forward.
        await advance(1000);
        const ghostPeer = new MockPeer();
        const ghost = ghostPeer.connect('lib-BOUND', { reliable: true });
        await advance(10);
        swallowInbound(ghost);
        ghost.send({ type: '__slopnet_join', clientId: 'bob', metadata: { name: 'Bob' }, token, staleMs: 1000 });
        await advance(10);
        expect(host._findClientByClientId('bob').boundAt).toBeGreaterThan(firstBind);

        // Bob's NEXT rung. Right clientId, right token, one tab — and its last
        // contact with this host is the original ack, which predates the ghost.
        await advance(2000);
        const livePeer = new MockPeer();
        const live = livePeer.connect('lib-BOUND', { reliable: true });
        const inbox = [];
        live.on('data', d => inbox.push(d));
        await advance(10);
        live.send({
            type: '__slopnet_join', clientId: 'bob', metadata: { name: 'Bob' }, token,
            staleMs: Date.now() - firstBind,
        });
        await advance(50);

        expect(
            inbox.map(m => m.type),
            'the seat was bound to a connection that was never heard from again, ' +
            'and the real holder is refused on the strength of that binding alone'
        ).toContain('__slopnet_join_ack');
        expect(inbox.map(m => m.type)).not.toContain('__slopnet_superseded');

        host.destroy(); bob.destroy();
    });
});

describe('attack r3: the host signalling ladder can die silently (C13)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * C13: "keep retrying at reconnectBackoffMax for as long as _started &&
     * !_destroyed". _doReconnect's own guard breaks that promise: a throw out of
     * _newPeer() clears _reconnecting, emits 'error' and RETURNS (slopnet.js:1393-1399)
     * without arming another rung. No timer is left, so nothing will ever run again;
     * 'reconnect-failed' is never emitted, so no app can tell; and resume() is gated
     * on a pending _reconnectTimer, so the visibilitychange path cannot restart it
     * either. The room is off the signalling server for the rest of the night.
     *
     * PeerClient wraps exactly this call in a try/catch that feeds the failure back
     * into its ladder (_createPeerAndConnect, slopnet.js:1808-1814). The host does not.
     */
    it('BUG C13: a throw from the Peer constructor on a reconnect rung ends the ladder for good, silently', async () => {
        let built = 0;
        class ThrowOnSecondPeer extends MockPeer {
            constructor(id, opts) {
                if (++built >= 2) throw new Error('new Peer() threw');
                super(id, opts);
            }
        }
        const host = createHost({ _PeerClass: ThrowOnSecondPeer, heartbeatInterval: 0 });
        const started = host.start('DEADEND');
        await advance(20);
        await started;

        const log = recordEvents(host, ['reconnecting', 'reconnected', 'reconnect-failed', 'error', 'ready']);
        host.peer.simulateDisconnect();
        await advance(5000);
        // The app's tab comes back to the foreground, twice. This is the only lever
        // SlopLobby has for the host role.
        host.resume();
        await advance(1000);
        host.resume();
        await advance(300000);   // five more minutes

        const events = log.map(e => e.event);
        expect(
            events.filter(e => e === 'reconnecting').length,
            'the ladder stopped after a single rung and nothing re-armed it: ' + JSON.stringify(events)
        ).toBeGreaterThan(1);
        expect(events, 'nothing was ever reported to the app either').toContain('reconnect-failed');
        expect(
            vi.getTimerCount(),
            'no timer is left, so the host will never knock again'
        ).toBeGreaterThan(0);

        host.destroy();
    });

    it('GUARANTEE C12/C13: two ordinary outages in a row are both repaired and a client can join after each', async () => {
        const host = await startHost('TWICE', { heartbeatInterval: 0 });
        const log = recordEvents(host, ['reconnected', 'reconnect-failed']);

        host.peer.simulateDisconnect();
        await advance(3000);
        const a = await joinClient('TWICE', 'a', { name: 'A' }, { heartbeatInterval: 0 });
        expect(a.isConnected).toBe(true);

        host.peer.simulateDisconnect();
        await advance(3000);
        const b = await joinClient('TWICE', 'b', { name: 'B' }, { heartbeatInterval: 0 });
        expect(b.isConnected).toBe(true);

        expect(log.map(e => e.event)).toEqual(['reconnected', 'reconnected']);
        host.destroy(); a.destroy(); b.destroy();
    });
});

describe('attack r3: a kick with no reason leaves the app mid-reconnect (C5/C8/C10/C26)', () => {
    let env;
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals();
        installSlopNetGlobal(MockPeer, {
            reconnectBackoffBase: 50, reconnectBackoffMultiplier: 1, reconnectBackoffMax: 50,
            heartbeatInterval: 0, connectionTimeout: 500, reconnectWindowMs: 5000,
            maxReconnectAttempts: 3,
        });
    });
    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    /**
     * _endOfTheRoad (sloplobby.js:822-826) exists because 'superseded' and
     * 'room-closed' are words no shipped app knows: it sandwiches them between
     * 'disconnected' and 'reconnect-failed' so an app that only learnt the old
     * vocabulary still leaves its game screen.
     *
     * 'rejected' — the terminal state a player is most likely to actually meet,
     * because every app ships a Remove button and texas-holdem kicks late joiners
     * on sight (index.html:1337-1345) — does NOT go through it (sloplobby.js:738-762).
     * A REASONLESS kick has no join-error message either (the `if (reason)` guard),
     * so the whole report is one onStateChange the app has never heard of. The
     * player is left on 'Disconnected — reconnecting...' with nothing else coming:
     * before this change they at least reached 'reconnect-failed' when the ladder ran out.
     */
    it('BUG C10/C26: lobby.removeClient(id) with no reason strands the player on "reconnecting" for ever', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'k-', storageKey: 'k-host' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        const states = [];
        const msgs = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'k-', storageKey: 'k-client',
            onClientData: d => msgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
        });
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        states.length = 0;

        // The host taps Remove. No reason given — the shape texas-holdem ships.
        hostLobby.removeClient(clientLobby.clientId);
        await advance(5000);

        const names = states.map(s => s[0]);
        expect(
            names,
            'the only terminal signal is a state the shipped apps do not branch on, ' +
            'and no { type: "join-error" } message was delivered either (' +
            JSON.stringify(msgs) + '). States: ' + JSON.stringify(names)
        ).toContain('reconnect-failed');
        expect(
            names[names.length - 1],
            'the last thing the app was told must not be "we are reconnecting"'
        ).not.toBe('reconnecting');

        hostLobby.destroy(); clientLobby.destroy();
    });

    it('GUARANTEE C5/C10: the same kick WITH a reason is reported cleanly and never toasts "reconnecting"', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'k2-', storageKey: 'k2-host' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        const states = [];
        const msgs = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'k2-', storageKey: 'k2-client',
            onClientData: d => msgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
        });
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        states.length = 0;
        env.toasts.length = 0;

        hostLobby.removeClient(clientLobby.clientId, 'Cheating');
        await advance(5000);

        // 'rejected' is wrapped in _endOfTheRoad's bookends like the other two
        // terminal states: CAH and texas-holdem never look at join-error, so without
        // them a kicked player's app sits on a live-looking board for ever. The
        // reason is delivered LAST so an app that DOES paint it keeps the host's
        // words on screen rather than a generic "lost connection".
        expect(states.map(s => s[0])).toEqual(['disconnected', 'rejected', 'reconnect-failed']);
        expect(states[1][1]).toBe('Cheating');
        expect(msgs).toEqual([{ type: 'join-error', reason: 'Cheating' }]);
        // The channel was open, so the reason arrived before any link loss: there is
        // no genuine 'disconnected' here and therefore no toast.
        expect(env.toasts).not.toContain('Disconnected — reconnecting...');
        expect(clientLobby.client).toBe(null);

        hostLobby.destroy(); clientLobby.destroy();
    });
});

describe('attack r3: the reconnect window closes a connection it no longer owns (C2/C4)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * C2 gave _handleDisconnect a binding check so a stale connection cannot mark a
     * live record down. The window-expiry timer closes `client.conn` (slopnet.js:1032-1035)
     * with no such check, and _handleJoin deliberately leaves the retired record's
     * `conn` pointing at a connection it has since re-stamped for somebody else
     * (slopnet.js:734-735 — it puts the old seat down but never unbinds it).
     *
     * So when the retired record's window runs out, the close lands on whoever holds
     * that connection NOW: a seated, connected player is dropped, 120 seconds after
     * an event that had nothing to do with them.
     */
    it('C2/C4: no two records can share a channel, so a window timer cannot close another seat\'s', async () => {
        // This used to be reachable: a second join on one channel re-stamped it, leaving
        // record A pointing at a connection record B now owned — and when A's reconnect
        // window expired it closed that channel, dropping B over an event that had
        // nothing to do with them. The route is gone at the source: a second identity on
        // a live channel is ignored, so the two-records-one-channel state cannot be built.
        const host = await startHost('CROSS', { reconnectWindowMs: 5000, heartbeatInterval: 0 });
        const peer = new MockPeer();
        const conn = peer.connect('lib-CROSS', { reliable: true });
        await advance(10);

        const log = recordEvents(host, HOST_EVENTS);
        conn.send({ type: '__slopnet_join', clientId: 'A', metadata: { name: 'A' } });
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'B', metadata: { name: 'B' } });
        await advance(10);

        expect(host.getAllClientIds(), 'B is never seated on A\'s channel').toEqual(['A']);
        expect(conn.open, 'and A\'s channel is untouched by the attempt').toBe(true);
        expect(host.isClientConnected('A')).toBe(true);

        // A itself now drops, and its own window expires: that channel IS A's, so
        // closing it is right.
        conn.close();
        await advance(6000);
        expect(
            log.map(e => e.event + ':' + e.args[0]),
            'exactly one seat, joined then lost, and nothing about a B'
        ).toEqual(['client-joined:A', 'client-left:A', 'client-lost:A']);

        host.destroy();
    });
});

describe('attack r3: giving up leaves the last attempt running (C7/C14)', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * _linkFailed only tears the peer down on a FIRST connect (slopnet.js:1922-1926).
     * On the ladder it hands over to _onDisconnect, and the peer/connection of the
     * rung that just failed are left for the NEXT rung's _destroyPeer() to clean up
     * — except when there is no next rung. When _attemptReconnect reports
     * 'reconnect-failed' (slopnet.js:2250-2253) it returns without touching them, so
     * a client that has given up still holds a registered Peer (and its signalling
     * socket) for the life of the page.
     *
     * It also stays wired: that peer's later 'disconnected' — which is exactly what a
     * backgrounded phone's socket does after ~60 s — walks back into _attemptReconnect
     * and emits 'reconnect-failed' a second time, so SlopLobby toasts
     * "Lost connection to game" again on a client that gave up minutes ago.
     */
    it('BUG C7/C14: after reconnect-failed the client still owns a live peer, and reports failure twice', async () => {
        const host = await startHost('GIVEUP', { heartbeatInterval: 0, reconnectWindowMs: 600000 });
        const c = await joinClient('GIVEUP', 'z', { name: 'Z' }, {
            heartbeatInterval: 0, maxReconnectAttempts: 1, connectionTimeout: 200,
        });
        const log = recordEvents(c, CLIENT_EVENTS);

        host.destroy();
        c.connection.close();
        await advance(20000);
        expect(log.map(e => e.event)).toContain('reconnect-failed');

        const leaked = c.peer;
        expect.soft(
            leaked,
            'the peer built for the rung that failed is still registered with the ' +
            'signalling server and still wired to this client'
        ).toBe(null);

        // The leaked socket dies in the background, as PeerJS's keepalive lets it.
        if (leaked) leaked.simulateDisconnect();
        await advance(5000);
        expect.soft(
            log.filter(e => e.event === 'reconnect-failed').length,
            'a client that has already given up must not announce it again — ' +
            'SlopLobby toasts "Lost connection to game" once per repeat'
        ).toBe(1);
        expect(leaked).toBe(null);

        c.destroy();
    });

    it('GUARANTEE C7/C24: resume() after the ladder is spent starts a fresh one and recovers', async () => {
        const host = await startHost('BACK', { heartbeatInterval: 0, reconnectWindowMs: 600000 });
        const c = await joinClient('BACK', 'z', { name: 'Z' }, {
            heartbeatInterval: 0, maxReconnectAttempts: 1, connectionTimeout: 200,
        });
        const log = recordEvents(c, CLIENT_EVENTS);
        c.connection.close();
        // The host is unreachable for the whole ladder.
        const saved = registry.get('lib-BACK');
        registry.delete('lib-BACK');
        await advance(20000);
        expect(log.map(e => e.event)).toContain('reconnect-failed');

        registry.set('lib-BACK', saved);
        c.resume();
        await advance(2000);
        expect(c.isConnected).toBe(true);
        expect(log.map(e => e.event)).toContain('reconnected');

        host.destroy(); c.destroy();
    });
});

describe('attack r3: guarantees that hold under the raciest orderings', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('GUARANTEE C4/C5: a window that expires in the same tick as the rejoin still lands the player in their seat once', async () => {
        const host = await startHost('WEX', { reconnectWindowMs: 1000, heartbeatInterval: 0 });
        const c = await joinClient('WEX', 'w', { name: 'W' }, {
            heartbeatInterval: 0, reconnectBackoffBase: 1000, reconnectBackoffMultiplier: 1,
        });
        const hostLog = recordEvents(host, HOST_EVENTS);
        c.connection.close();
        await advance(1005);

        expect(hostLog.map(e => e.event)).toEqual(['client-left', 'client-rejoined']);
        expect(c.isConnected).toBe(true);
        expect(host.getConnectedClientIds()).toEqual(['w']);
        expect([...host._pastClients.keys()]).toEqual([]);
        host.destroy(); c.destroy();
    });

    it('GUARANTEE C6/C25: close() called from inside a client-joined handler settles the joiner as room-closed', async () => {
        const host = await startHost('CJC', { heartbeatInterval: 0 });
        let closing = null;
        host.on('client-joined', () => { closing = host.close('nope', { graceMs: 100 }); });
        const c = createClient({ heartbeatInterval: 0 });
        const p = c.connect('CJC', 'x', {});
        await advance(50);
        await p;                       // the ack went out before the goodbye
        await advance(500);
        await closing;

        expect(c.terminalReason).toBe('room-closed');
        expect(host._destroyed).toBe(true);
        c.destroy();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('GUARANTEE C3/C15: superseded arriving before the first ack settles connect() and clears _connecting', async () => {
        const host = await startHost('SUP1', { heartbeatInterval: 0 });
        const a = await joinClient('SUP1', 'dup', {}, { heartbeatInterval: 0 });
        const b = createClient({ heartbeatInterval: 0 });
        const bp = b.connect('SUP1', 'dup', {}, { token: a.token });
        await advance(50);
        await bp;

        expect(a.terminalReason).toBe('superseded');
        expect(a.isConnecting).toBe(false);
        expect(a.peer).toBe(null);
        expect(b.isConnected).toBe(true);
        expect(host.getConnectedClientIds()).toEqual(['dup']);
        host.destroy(); a.destroy(); b.destroy();
    });

    it('GUARANTEE C4/C16: the host\'s backlog reaches a returning client in order, ahead of what the app pushes on rejoin', async () => {
        const host = await startHost('QUEUE', { reconnectWindowMs: 60000, heartbeatInterval: 0 });
        const c = await joinClient('QUEUE', 'q1', { name: 'Q' }, { heartbeatInterval: 0 });
        const got = [];
        c.on('data', d => got.push(d));
        host.on('client-rejoined', () => host.send('q1', { m: 'state-from-app' }));

        c.connection.close();
        await advance(30);
        host.send('q1', { m: 1 });
        host.send('q1', { m: 2 });
        host.send('q1', { m: 3 });
        await advance(5000);

        expect(got).toEqual([{ m: 1 }, { m: 2 }, { m: 3 }, { m: 'state-from-app' }]);
        host.destroy(); c.destroy();
    });

    it('GUARANTEE C21: two signalling outages then destroy() leaves no timers and no live peer', async () => {
        const host = await startHost('RET', { heartbeatInterval: 0 });
        host.peer.simulateDisconnect();
        await advance(2000);
        host.peer.simulateDisconnect();
        await advance(2000);
        expect(host._retiredPeers.length).toBe(2);

        const retired = host._retiredPeers.slice();
        host.destroy();
        expect(vi.getTimerCount()).toBe(0);
        expect(retired.every(p => p.destroyed)).toBe(true);
        expect(host.peer).toBe(null);
    });
});
