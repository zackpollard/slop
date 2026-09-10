/**
 * C5 / C26 — removeClient ordering with a faithful (synchronous-close) mock, the
 * new rejectClient, and SlopLobby's string-rejection path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry, MockPeer } from './mock-peer.js';
import {
    SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createClient, startHost, joinClient, recordEvents, advance,
} from './lib-harness.js';

const HOST_EVENTS = ['client-joined', 'client-rejoined', 'client-left', 'client-lost'];

/**
 * Round-2 review: a kick has to STICK. Both entry points bailed on "no live record"
 * — which is exactly the ghost a host taps Remove on — and a reasonless removeClient
 * let the player's own ladder walk them straight back in, once a second, all night.
 */
describe('C5: a kick sticks', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C5: removeClient with no reason refuses the return trip instead of re-seating it', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS);

        expect(host.removeClient('alice')).toBe(true);
        await advance(60000);                       // its whole ladder

        expect(hostLog, 'nothing puts a kicked player back at the table').toEqual([]);
        expect(host.getAllClientIds()).toEqual([]);
        expect(client.terminalReason, 'and it stops knocking for good').toBe('rejected');
        // Nothing was said, so there is nothing for an app to paint.
        expect(client._terminalPayload).toBe('');

        client.destroy(); host.destroy();
    });

    it('C5: both kicks work on a player whose reconnect window has already expired', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 200 });
        const gone = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { maxReconnectAttempts: 0 });
        gone.destroy();
        await advance(400);
        expect(host.getAllClientIds()).toEqual([]);
        expect(host._pastClients.has('alice'), 'the identity is remembered: a late return is a rejoin').toBe(true);

        expect(host.rejectClient('alice', 'Removed by the host')).toBe(true);
        expect(host._pastClients.has('alice'), 'a deliberate kick forgets the identity').toBe(false);

        // Their own retry ladder — a join carrying staleMs, i.e. a client this host
        // has acked before — is turned away with the reason.
        const hostLog = recordEvents(host, HOST_EVENTS);
        const peer = new MockPeer();
        const rung = peer.connect('lib-ROOM1', { reliable: true });
        const inbox = [];
        rung.on('data', d => inbox.push(d));
        await advance(10);
        rung.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' }, staleMs: 3000 });
        await advance(20);

        expect(inbox.map(m => m.type)).toEqual(['__slopnet_join_reject']);
        expect(inbox[0].reason).toBe('Removed by the host');
        expect(hostLog, 'nothing puts a kicked player back at the table').toEqual([]);

        host.destroy();
    });

    /**
     * The other edge of the same rule. The hold is aimed at the MACHINE: a join with
     * no staleMs comes from a PeerClient built since — a player tapping Join because
     * the app told them to — and must reach the app, or flip-7's and herd's
     * "Name already taken, try another" costs the player an attempt and paints the
     * stale words over a name nobody has. What the kick keeps is the identity: they
     * arrive as 'client-joined', never the 'client-rejoined' every app uses to
     * bypass its no-new-players-mid-game gate.
     */
    it('C5: a DELIBERATE return after a kick reaches the app, and only as a stranger', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 200 });
        const gone = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { maxReconnectAttempts: 0 });
        gone.destroy();
        await advance(400);
        expect(host.rejectClient('alice', 'Removed by the host')).toBe(true);

        const hostLog = recordEvents(host, HOST_EVENTS);
        const back = createClient();
        const p = back.connect('ROOM1', 'alice', { name: 'Alice' });
        await advance(100);
        await p;

        expect(hostLog.map(e => e.event)).toEqual(['client-joined']);
        expect(back.terminalReason).toBe(null);

        back.destroy(); host.destroy();
    });

    it('C5: a kick whose channel is dead without the host knowing still sticks', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS);

        // Her radio dies. Her side closes at once and her ladder starts; the host's
        // half of the channel still reads open (the heartbeat has not convicted it).
        client.connection._closed = true;
        client.connection.open = false;
        client.connection.emit('close');
        expect(host.clients.get('alice').conn.open).toBe(true);

        expect(host.rejectClient('alice', 'Cheating')).toBe(true);
        await advance(5000);                        // her ladder runs

        expect(client.terminalReason).toBe('rejected');
        expect(client._terminalPayload).toBe('Cheating');
        expect(hostLog.map(e => e.event)).not.toContain('client-joined');
        expect(host.getAllClientIds()).toEqual([]);

        client.destroy(); host.destroy();
    });

    it('C5: a seat released with no reconnect window at all is still a remembered identity', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 0 });
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { maxReconnectAttempts: 0 });
        const hostLog = recordEvents(host, HOST_EVENTS);

        c.connection.close();
        await advance(50);
        expect(hostLog.map(e => e.event)).toEqual(['client-left', 'client-lost']);
        expect(host._pastClients.has('alice'),
            'a player who merely blinked must not come back a stranger').toBe(true);

        const back = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(hostLog.map(e => e.event).slice(-1)).toEqual(['client-rejoined']);

        c.destroy(); back.destroy(); host.destroy();
    });
});

describe('C5: removeClient / rejectClient', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C5: removeClient emits neither client-left nor client-lost and leaves no memory of the seat', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { maxReconnectAttempts: 0 });
        const hostLog = recordEvents(host, HOST_EVENTS);
        const clientLog = recordEvents(client, ['disconnected', 'rejected']);

        expect(host.removeClient('alice')).toBe(true);
        await advance(20);

        expect(host.getAllClientIds()).toEqual([]);
        expect(host._reconnectWindowTimers.size).toBe(0);
        // A plain kick: the client merely sees its link drop.
        expect(clientLog.map(e => e.event)).toEqual(['disconnected']);

        await advance(120000);
        expect(hostLog).toEqual([]);
        expect(host._pastClients.size).toBe(0);
        expect(host.removeClient('alice')).toBe(false);

        client.destroy(); host.destroy();
    });

    it('C5: rejectClient delivers the reason BEFORE the close; the client turns terminal and never knocks again', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS);
        const clientLog = recordEvents(client, ['rejected', 'disconnected', 'reconnecting', 'reconnect-failed']);
        const raw = [];
        client.connection.on('data', d => raw.push(d.type));

        expect(host.rejectClient('alice', 'Game full')).toBe(true);
        await advance(20);

        expect(raw).toEqual(['__slopnet_join_reject']);
        expect(clientLog).toEqual([{ event: 'rejected', args: ['Game full'] }]);
        expect(client.isTerminal).toBe(true);
        expect(client.terminalReason).toBe('rejected');
        expect(client.isConnected).toBe(false);
        expect(client.send({ type: 'x' })).toBe(false);
        expect(client.queueSize).toBe(0);

        await advance(5 * 60 * 1000);
        expect(clientLog).toHaveLength(1);
        expect(hostLog).toEqual([]);
        expect(host.getAllClientIds()).toEqual([]);
        expect(host._pastClients.size).toBe(0);
        expect(host.rejectClient('alice', 'again')).toBe(false);

        client.destroy(); host.destroy();
    });

    it('C5: the held reason is aimed at the ladder — one automatic knock spends it, and only one', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 0 });
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(host.rejectClient('alice', 'Cheating')).toBe(true);
        client.destroy();

        const knock = async (staleMs) => {
            const peer = new MockPeer();
            const conn = peer.connect('lib-ROOM1', { reliable: true });
            const inbox = [];
            conn.on('data', d => inbox.push(d));
            await advance(10);
            const msg = { type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alice' } };
            if (staleMs) msg.staleMs = staleMs;
            conn.send(msg);
            await advance(20);
            return inbox.map(m => m.type);
        };

        expect(await knock(4000), 'the first rung is refused').toEqual(['__slopnet_join_reject']);
        expect(host._pendingRejections.has('alice'), 'and the hold is spent').toBe(false);
        expect(await knock(4000), 'the next one is an ordinary join again').toEqual(['__slopnet_join_ack']);

        host.destroy();
    });

    it('C5: a join with no staleMs is never eaten by the hold — it is a deliberate retry', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 0 });
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(host.rejectClient('alice', 'Name already taken')).toBe(true);
        client.destroy();
        expect(host._pendingRejections.get('alice')).toBe('Name already taken');

        const peer = new MockPeer();
        const conn = peer.connect('lib-ROOM1', { reliable: true });
        const inbox = [];
        conn.on('data', d => inbox.push(d));
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alicia' } });
        await advance(20);

        expect(inbox.map(m => m.type), 'the corrected name reaches the app').toEqual(['__slopnet_join_ack']);
        expect(
            host._pendingRejections.has('alice'),
            'and being SEATED spends the hold. It used to be left in the map "for the ladder ' +
            'it was meant for" — but that ladder belonged to the PeerClient the app threw ' +
            'away, and what actually collected the hold was this player\'s next ORDINARY ' +
            'reconnect: a blip minutes into the game they are now legitimately playing, ' +
            'which terminally ejected them with the words from an argument that was over.'
        ).toBe(false);

        host.destroy();
    });

    it('C5: a kick a player was never told about cannot eject them once they are back in', async () => {
        // The detonation the hold used to cause: refused while off the air, re-admitted
        // deliberately, then thrown out of the running game by their own reconnect.
        const host = await startHost('ROOM1', { heartbeatInterval: 0 });
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        expect(host.rejectClient('alice', 'Name already taken')).toBe(true);
        client.destroy();
        await advance(20);

        // The app invites them to try again; they are seated (no staleMs — a fresh client).
        const peer = new MockPeer();
        const conn = peer.connect('lib-ROOM1', { reliable: true });
        const inbox = [];
        conn.on('data', d => inbox.push(d));
        await advance(10);
        conn.send({ type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alicia' } });
        await advance(20);
        expect(host.getConnectedClientIds()).toContain('alice');
        const seatToken = inbox.find(m => m.type === '__slopnet_join_ack').token;

        // Now an ordinary blip: the channel drops and the SAME seat reconnects, carrying
        // its token and a staleMs like every rung of a client that has been acked.
        conn.close();
        await advance(20);
        const peer2 = new MockPeer();
        const conn2 = peer2.connect('lib-ROOM1', { reliable: true });
        const inbox2 = [];
        conn2.on('data', d => inbox2.push(d));
        await advance(10);
        conn2.send({
            type: '__slopnet_join', clientId: 'alice', metadata: { name: 'Alicia' },
            token: seatToken, staleMs: 4000,
        });
        await advance(20);

        expect(
            inbox2.map(m => m.type),
            'their own reconnect is acked, not refused with a spent kick'
        ).toEqual(['__slopnet_join_ack']);
        expect(host.getConnectedClientIds()).toContain('alice');

        host.destroy();
    });

    it('C5: the held-rejection map is capped, dropping the oldest', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 0 });
        // 70 players whose reconnect windows expired: identity remembered, seat gone.
        for (let i = 0; i < 70; i++) host._pastClients.set('p' + i, { metadata: {}, token: null });
        for (let i = 0; i < 70; i++) expect(host.rejectClient('p' + i, 'gone ' + i)).toBe(true);

        expect(host._pendingRejections.size).toBeLessThanOrEqual(64);
        expect(host._pendingRejections.has('p0'), 'the oldest hold is dropped, not the newest').toBe(false);
        expect(host._pendingRejections.get('p69')).toBe('gone 69');

        host.destroy();
        expect(host._pendingRejections.size, 'and destroy() forgets them all').toBe(0);
    });

    it('C5: rejectClient works on a client inside its reconnect window (nothing to send, seat forgotten)', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { reconnectBackoffBase: 5000 });
        client.connection.close();
        await advance(10);
        expect(host.getDisconnectedClientIds()).toEqual(['alice']);

        expect(host.rejectClient('alice', 'Removed')).toBe(true);
        expect(host.getAllClientIds()).toEqual([]);
        expect(host._reconnectWindowTimers.size).toBe(0);
        expect(host._pastClients.size).toBe(0);

        client.destroy(); host.destroy();
    });
});

describe('C5/C26: SlopLobby rejection path', () => {
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

    it('C5/C26: onPlayerJoined returning a string yields exactly one join-error on the client and no retry storm', async () => {
        const onPlayerJoined = vi.fn(() => 'Game full');
        const hostLobby = new SlopLobby({ roomPrefix: 'rej-', storageKey: 'rej-host', onPlayerJoined });
        const clientMsgs = [];
        const states = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'rej-', storageKey: 'rej-client',
            onClientData: d => clientMsgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
        });

        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        // The ack lands before the reject, so joinRoom itself resolves.
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;

        await advance(5 * 60 * 1000);

        expect(clientMsgs).toEqual([{ type: 'join-error', reason: 'Game full' }]);
        expect(onPlayerJoined).toHaveBeenCalledTimes(1);
        expect(clientLobby.client).toBeNull();
        // A refusal after the ack gets _endOfTheRoad's bookends (C10/C26): apps that
        // never learnt 'rejected' still leave their game screen.
        expect(states.map(s => s[0])).toEqual([
            'connecting', 'connected', 'disconnected', 'rejected', 'reconnect-failed',
        ]);
        expect(states[3][1]).toBe('Game full');
        expect(hostLobby.players.size).toBe(0);
        expect(hostLobby._pastPlayers.size).toBe(0);
        expect(hostLobby.getConnectedClientIds()).toEqual([]);
        expect(hostLobby.host.getAllClientIds()).toEqual([]);
        expect(env.toasts).not.toContain('Disconnected — reconnecting...');

        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C26: lobby.removeClient(clientId, reason) rejects with the reason and forgets the parked record', async () => {
        const hostLobby = new SlopLobby({
            roomPrefix: 'kick-', storageKey: 'kick-host',
            onPlayerJoined: (clientId, meta) => { hostLobby.players.set(clientId, { name: meta.name, seat: 3 }); },
        });
        const clientMsgs = [];
        const states = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'kick-', storageKey: 'kick-client',
            onClientData: d => clientMsgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
        });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        const id = clientLobby.clientId;
        hostLobby._pastPlayers.set(id, { name: 'Bob', seat: 3 });   // as if parked earlier

        hostLobby.removeClient(id, 'Kicked by host');
        await advance(20);

        expect(clientMsgs).toEqual([{ type: 'join-error', reason: 'Kicked by host' }]);
        expect(states.map(s => s[0]).slice(-3)).toEqual(['disconnected', 'rejected', 'reconnect-failed']);
        expect(states.at(-2)).toEqual(['rejected', 'Kicked by host']);
        expect(clientLobby.client).toBeNull();
        expect(hostLobby.players.has(id)).toBe(false);
        expect(hostLobby._pastPlayers.has(id)).toBe(false);
        expect(hostLobby.host.getAllClientIds()).toEqual([]);

        // Without a reason the old behaviour stands: a silent kick.
        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C26: the "Disconnected — reconnecting" toast never fires for a terminal reason', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'term-', storageKey: 'term-host', onPlayerJoined: () => 'Nope' });
        const clientLobby = new SlopLobby({ roomPrefix: 'term-', storageKey: 'term-client' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        await advance(60000);
        expect(env.toasts.filter(t => t.startsWith('Disconnected'))).toEqual([]);
        hostLobby.destroy(); clientLobby.destroy();
    });
});
