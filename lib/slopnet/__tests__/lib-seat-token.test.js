/**
 * C9 — seat tokens bind a clientId to the connection that was issued it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry, MockPeer } from './mock-peer.js';
import {
    SlopNet, SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createClient, startHost, joinClient, recordEvents, advance,
} from './lib-harness.js';

const { SEAT_TAKEN_REASON } = SlopNet;
const ALL_CLIENT_EVENTS = ['data', 'disconnected', 'superseded', 'rejected', 'room-closed', 'reconnecting', 'reconnected', 'connected', 'token'];
const HOST_EVENTS = ['client-joined', 'client-rejoined', 'client-left', 'client-lost'];

describe('C9: seat tokens', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C9: a new seat is issued a token in its ack; the client adopts it and emits token', async () => {
        const host = await startHost();
        const c = createClient();
        const tokens = [];
        c.on('token', t => tokens.push(t));
        const ackSpy = [];
        const p = c.connect('ROOM1', 'alice', { name: 'Alice' });
        await advance(50);
        await p;

        expect(typeof c.token).toBe('string');
        expect(c.token.length).toBeGreaterThanOrEqual(16);
        expect(tokens).toEqual([c.token]);
        expect(host._findClientByClientId('alice').token).toBe(c.token);

        // The token is what the client sends on every later join, alongside how long
        // it has been since it heard from this host (used to order two connections
        // claiming one seat — see C3).
        expect(c._joinMessage()).toMatchObject({
            type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' }, token: c.token,
        });
        expect(Object.keys(c._joinMessage()).sort())
            .toEqual(['clientId', 'metadata', 'staleMs', 'token', 'type']);
        expect(ackSpy).toEqual([]);
        c.destroy(); host.destroy();
    });

    for (const [label, connectOpts] of [['NO token', undefined], ['a WRONG token', { token: 'definitely-not-the-real-token' }]]) {
        it(`C9: a second client presenting the same clientId with ${label} is rejected; the seat holder is untouched and hears nothing`, async () => {
            const host = await startHost();
            const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
            const aLog = recordEvents(a, ALL_CLIENT_EVENTS);
            const aRaw = [];
            a.connection.on('data', d => aRaw.push(d));
            const hostLog = recordEvents(host, HOST_EVENTS);
            const seatConn = host._findClientByClientId('alice').conn;

            const b = createClient();
            const bLog = recordEvents(b, ALL_CLIENT_EVENTS);
            const p = b.connect('ROOM1', 'alice', { name: 'Mallory' }, connectOpts).catch(e => e);
            await advance(50);
            const err = await p;

            expect(err).toBeInstanceOf(Error);
            expect(err.type).toBe('rejected');
            expect(err.reason).toBe(SEAT_TAKEN_REASON);
            expect(bLog).toEqual([{ event: 'rejected', args: [SEAT_TAKEN_REASON] }]);
            expect(b.isTerminal).toBe(true);
            expect(b.peer).toBeNull();

            // The seat holder: same connection, same metadata, not a single event.
            expect(aLog).toEqual([]);
            expect(aRaw).toEqual([]);
            expect(hostLog).toEqual([]);
            expect(host._findClientByClientId('alice').conn).toBe(seatConn);
            expect(host._findClientByClientId('alice').metadata).toEqual({ name: 'Alice' });
            expect(host.isClientConnected('alice')).toBe(true);
            expect(a.isConnected).toBe(true);

            // ...and the impostor stays away.
            await advance(60000);
            expect(bLog).toHaveLength(1);

            // The real seat still works both ways.
            const hostGot = vi.fn();
            host.on('data', hostGot);
            a.send({ type: 'move' });
            host.send('alice', { type: 'state' });
            await advance(20);
            expect(hostGot).toHaveBeenCalledWith('alice', { type: 'move' });
            expect(aLog).toEqual([{ event: 'data', args: [{ type: 'state' }] }]);

            a.destroy(); b.destroy(); host.destroy();
        });
    }

    it('C9/C3: the same clientId with the RIGHT token supersedes the seat holder', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const aLog = recordEvents(a, ALL_CLIENT_EVENTS);
        const hostLog = recordEvents(host, HOST_EVENTS);

        const b = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {}, { token: a.token });

        expect(aLog).toEqual([{ event: 'superseded', args: [] }]);
        expect(b.isConnected).toBe(true);
        expect(b.token).toBe(a.token);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);
        expect(host.getConnectedClientIds()).toEqual(['alice']);
        a.destroy(); b.destroy(); host.destroy();
    });

    it('C9: the token survives a host restart — a fresh one is minted, adopted, and protects the seat from then on', async () => {
        const hostA = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const tokens = [c.token];
        c.on('token', t => tokens.push(t));
        const first = c.token;

        hostA.destroy();
        await advance(20);
        expect(c.isConnected).toBe(false);

        const hostB = await startHost('ROOM1');        // same code, fresh host
        const bLog = recordEvents(hostB, HOST_EVENTS);
        await advance(2000);
        expect(c.isConnected).toBe(true);
        expect(bLog.map(e => e.event)).toEqual(['client-joined']);   // hostB never saw alice
        expect(c.token).not.toBe(first);
        expect(tokens).toEqual([first, c.token]);
        expect(hostB._findClientByClientId('alice').token).toBe(c.token);

        // The old token is worthless now.
        const impostor = createClient();
        const p = impostor.connect('ROOM1', 'alice', {}, { token: first }).catch(e => e);
        await advance(50);
        expect((await p).type).toBe('rejected');
        expect(c.isConnected).toBe(true);

        // A duplicate of the live tab presents the new one and takes over.
        const dup = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {}, { token: c.token });
        expect(dup.isConnected).toBe(true);
        expect(c.terminalReason).toBe('superseded');

        c.destroy(); impostor.destroy(); dup.destroy(); hostB.destroy();
    });

    // A seat that has been RELEASED to the game has no holder to protect, so the
    // remembered token is not a lock: presenting it keeps it, presenting nothing (or
    // something stale) buys a fresh one. Refusing here locked a player out of a seat
    // nobody was sitting in, for the life of the room — see the round-1 review.
    it('C9: a parked seat keeps its token for whoever presents it, and re-mints for whoever does not', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 1000 });
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { maxReconnectAttempts: 0 });
        const token = c.token;
        c.destroy();
        await advance(1100);
        expect(host.getAllClientIds()).toEqual([]);
        expect(host._pastClients.get('alice')).toEqual({ metadata: { name: 'Alice' }, token });
        const hostLog = recordEvents(host, HOST_EVENTS);

        // The right token: the same seat, the same token, announced as a return.
        const right = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {}, { token });
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);
        expect(right.token).toBe(token);
        expect(host._pastClients.has('alice')).toBe(false);
        right.destroy();
        await advance(1200);                       // release it again
        expect(host._pastClients.has('alice')).toBe(true);

        // No token at all — the ordinary "my tab could not keep it" case. Let in, and
        // issued a new one, which protects the seat from now on.
        const hostLog2 = recordEvents(host, HOST_EVENTS);
        const tokenless = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(hostLog2.map(e => e.event)).toEqual(['client-rejoined']);
        expect(tokenless.isConnected).toBe(true);
        expect(typeof tokenless.token).toBe('string');
        expect(tokenless.token).not.toBe(token);

        // ...and now that somebody IS sitting in it, the old token is worthless.
        const impostor = createClient();
        const ip = impostor.connect('ROOM1', 'alice', { name: 'Mallory' }, { token }).catch(e => e);
        await advance(50);
        expect((await ip).type).toBe('rejected');
        expect(tokenless.isConnected).toBe(true);

        impostor.destroy(); tokenless.destroy(); host.destroy();
    });

    it('C9: a record with no token (older host) is accepted leniently and issued one', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        host._findClientByClientId('alice').token = null;
        const b = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(b.isConnected).toBe(true);
        expect(typeof host._findClientByClientId('alice').token).toBe('string');
        expect(b.token).toBe(host._findClientByClientId('alice').token);
        a.destroy(); b.destroy(); host.destroy();
    });
});

/**
 * Round-2 review: the token protected only a seat somebody was SITTING in, so for
 * the whole reconnect window — the two minutes during which the holder's ladder is
 * climbing — anyone who had read the clientId off the wire could take the seat, and
 * taking it re-minted the token, which turned the holder's own return into a
 * terminal 'rejected' for the life of the room.
 */
describe('C9: a HELD seat is defended for as long as the host holds it', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C9: a token-less join for a seat inside its reconnect window is refused, and the holder comes home', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 60000 });
        const alice = await joinClient('ROOM1', 'alice', { name: 'Alice' },
            { reconnectBackoffBase: 5000, reconnectBackoffMultiplier: 1, reconnectBackoffMax: 5000 });
        const token = alice.token;

        alice.connection.close();                       // a tunnel: the seat is HELD, empty
        await advance(50);
        expect(host._findClientByClientId('alice').disconnected).toBe(true);
        const hostLog = recordEvents(host, HOST_EVENTS);

        const thief = createClient();
        const refused = thief.connect('ROOM1', 'alice', { name: 'Mallory' }).catch(e => e);
        await advance(100);
        expect((await refused).type).toBe('rejected');
        expect((await refused).reason).toBe(SEAT_TAKEN_REASON);
        expect(host._findClientByClientId('alice').token, 'and it is not re-minted').toBe(token);
        expect(hostLog, 'the seat did not move and nobody was told anything').toEqual([]);

        // Alice's ladder brings her home with the token this host issued her.
        await advance(6000);
        expect(alice.isConnected).toBe(true);
        expect(alice.terminalReason).toBe(null);
        expect(alice.token).toBe(token);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);

        host.destroy(); alice.destroy(); thief.destroy();
    });

    // The one seat that cannot be defended: the host mints the token in the ack, so a
    // holder whose ack never arrived owns a seat it cannot prove. Refusing there is
    // what locked a player out of their own seat in round 1.
    it('C9: an UNPROVEN seat is still claimable, and claiming it does not lock the original holder out', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 60000 });

        // Bob's tab is discarded before the browser dispatches the ack.
        const bob = createClient();
        const first = bob.connect('ROOM1', 'bob', { name: 'Bob' }).catch(e => e);
        await advance(0);
        const swallowed = bob.connection;
        const realEmit = swallowed.emit.bind(swallowed);
        swallowed.emit = (event, ...args) => { if (event !== 'data') realEmit(event, ...args); };
        await advance(50);
        const seat = host._findClientByClientId('bob');
        const mintedForBob = seat.token;
        expect(typeof mintedForBob).toBe('string');
        expect(seat.tokenProven, 'nothing has come back from bob since the ack').toBe(false);
        expect(bob.token).toBe(null);
        await advance(4000);
        await first;
        bob.destroy();
        await advance(20);

        // He reloads: same clientId (sessionStorage), no token, because there never
        // was one to save. The seat is his and he is let into it.
        const bob2 = await joinClient('ROOM1', 'bob', { name: 'Bob' });
        expect(bob2.isConnected).toBe(true);
        expect(bob2.token).not.toBe(mintedForBob);
        expect(host._findClientByClientId('bob').altTokens.has(mintedForBob),
            'the token bob may yet turn up holding still works').toBe(true);

        // ...and the tab that DID have the original token (the ack arrived after all,
        // its confirm did not) is not shut out either: it takes its seat back.
        const late = createClient();
        const lp = late.connect('ROOM1', 'bob', { name: 'Bob' }, { token: mintedForBob }).catch(e => e);
        await advance(100);
        expect(await lp).toBeUndefined();
        expect(late.isConnected).toBe(true);
        expect(bob2.terminalReason).toBe('superseded');

        host.destroy(); bob2.destroy(); late.destroy();
    });

    it('C9/C3: a rung fired by a tab the player walked away from does not evict the tab in front of them', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 120000 });
        // Tab A: backgrounded, its timers throttled to about one wake a minute.
        const a = await joinClient('ROOM1', 'kim', { name: 'Kim' }, { reconnectBackoffBase: 60000 });
        const token = a.token;
        a.connection.close();
        await advance(20);

        // Tab B: "Duplicate tab" copies sessionStorage, so the same clientId AND token.
        const b = await joinClient('ROOM1', 'kim', { name: 'Kim' }, {}, { token });
        expect(b.isConnected).toBe(true);

        await advance(70000);                     // tab A's overdue rung finally fires
        expect(b.isConnected, 'the live tab keeps the seat').toBe(true);
        expect(b.terminalReason).toBe(null);
        expect(a.terminalReason, 'and the abandoned one is the one told it is a duplicate')
            .toBe('superseded');
        expect(host.getConnectedClientIds()).toEqual(['kim']);

        host.destroy(); a.destroy(); b.destroy();
    });

    it('C9: a second clientId on ONE connection is ignored, and the first seat is untouched', async () => {
        // One connection, one identity, for its whole life. This used to put the first
        // seat down and re-stamp the channel, which let a single client mint seats
        // without limit: each retired record kept a reconnect-window timer and its own
        // copy of every broadcast, and no disconnect could ever clear them because the
        // channel they pointed at belonged to somebody else by then.
        //
        // It is IGNORED rather than refused, because a refusal closes the channel — and
        // the channel is alice's. Refusing would have let an impostor join disconnect the
        // very seat it was trying to take.
        const host = await startHost('ROOM1', { reconnectWindowMs: 1000 });
        const tab = new MockPeer();
        await advance(10);
        const conn = tab.connect('lib-ROOM1', { reliable: true });
        const inbox = [];
        conn.on('data', d => inbox.push(d));
        await advance(10);
        const log = recordEvents(host, HOST_EVENTS);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: {} });
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'bob', metadata: {} });
        await advance(10);

        expect(
            log.map(e => e.event + ':' + e.args[0]),
            'bob is never seated, and alice is never put down for him'
        ).toEqual(['client-joined:alice']);
        expect(host.getAllClientIds(), 'one seat, not two').toEqual(['alice']);
        expect(
            inbox.filter(m => m.type === '__slopnet_join_reject'),
            'nothing terminal is sent: this channel is alice\'s and must keep working'
        ).toEqual([]);
        expect(host.isClientConnected('alice'), 'alice is still connected').toBe(true);

        tab.destroy(); host.destroy();
    });

    it('C9: one connection cannot mint seats in a loop', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 1000 });
        const tab = new MockPeer();
        await advance(10);
        const conn = tab.connect('lib-ROOM1', { reliable: true });
        conn.on('data', () => {});
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: {} });
        await advance(10);
        for (let i = 0; i < 50; i++) {
            conn.send({ type: '__slopnet_join', clientId: 'ghost' + i, metadata: { name: 'G' + i } });
        }
        await advance(50);

        expect(host.getAllClientIds(), 'still one seat after 50 attempts').toEqual(['alice']);
        expect(host._reconnectWindowTimers.size, 'and no window timers for ghosts').toBe(0);

        tab.destroy(); host.destroy();
    });
});

describe('C9: SlopLobby token persistence', () => {
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

    it('C9: the token is saved to sessionStorage and presented on the next joinRoom; a different tab with the same clientId is turned away', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'tok-', storageKey: 'tok-host' });
        const clientLobby = new SlopLobby({ roomPrefix: 'tok-', storageKey: 'tok-client' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;

        const clientId = clientLobby.clientId;
        const token = clientLobby.client.token;
        // Keyed by room: tokens are minted per host, so one key per app locked a tab
        // out of the first room whenever it visited a second one.
        expect(env.store.get('tok-client-token-' + code)).toBe(token);

        // The tab reloads: the lobby object is gone, sessionStorage survives.
        clientLobby.destroy();
        await advance(20);
        expect(hostLobby.host.getDisconnectedClientIds()).toEqual([clientId]);

        const hostLog = recordEvents(hostLobby.host, ['client-joined', 'client-rejoined']);
        const again = new SlopLobby({ roomPrefix: 'tok-', storageKey: 'tok-client' });
        const j2 = again.joinRoom(code, 'Bob');
        await advance(50);
        await j2;
        expect(again.clientId).toBe(clientId);
        expect(again.client.token).toBe(token);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);
        expect(hostLobby.host.isClientConnected(clientId)).toBe(true);

        // A different tab / device that learned the clientId but holds no token. The
        // seat is LIVE (its holder is connected right now), so it is refused.
        const otherTab = new Map([['tok-client', clientId]]);
        env.useStore(otherTab);
        const states = [];
        const msgs = [];
        const stranger = new SlopLobby({
            roomPrefix: 'tok-', storageKey: 'tok-client',
            onClientData: d => msgs.push(d), onStateChange: (s, d) => states.push([s, d]),
        });
        const sp = stranger.joinRoom(code, 'Eve').catch(e => e);
        await advance(50);
        const err = await sp;
        // A refusal at the DOOR settles joinRoom() as the failure — err.reason carries
        // the host's words — and is ALSO delivered as the { type:'join-error' } message
        // every app already paints (C5/C10), one tick later so that an app's own catch
        // cannot overwrite it with a generic "could not connect".
        expect(err.type).toBe('rejected');
        expect(err.reason).toBe(SEAT_TAKEN_REASON);
        expect(stranger.client).toBeNull();
        expect(msgs).toEqual([{ type: 'join-error', reason: SEAT_TAKEN_REASON }]);
        expect(states.map(s => s[0])).toEqual(['connecting', 'rejected']);
        expect(again.client.isConnected).toBe(true);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);

        hostLobby.destroy(); again.destroy(); stranger.destroy();
    });

    it('C9: a restarted host hands out a new token and SlopLobby persists that one', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'tok2-', storageKey: 'tok2-host' });
        const states = [];
        const clientLobby = new SlopLobby({ roomPrefix: 'tok2-', storageKey: 'tok2-client', onStateChange: (s, d) => states.push([s, d]) });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        const first = env.store.get('tok2-client-token-' + code);

        hostLobby.destroy();                      // host tab dies
        await advance(20);
        const hostLobby2 = new SlopLobby({ roomPrefix: 'tok2-', storageKey: 'tok2-host' });
        const c2 = hostLobby2.createRoom('Host', code);
        await advance(20);
        await c2;
        await advance(3000);
        expect(clientLobby.client.isConnected).toBe(true);
        expect(env.store.get('tok2-client-token-' + code)).toBe(clientLobby.client.token);
        expect(env.store.get('tok2-client-token-' + code)).not.toBe(first);
        expect(states.at(-1)).toEqual(['reconnected', { fresh: true }]);

        hostLobby2.destroy(); clientLobby.destroy();
    });
});
