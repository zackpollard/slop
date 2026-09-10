/**
 * C2 / C3 — a client record is bound to ONE connection; a rejoin with a new
 * connection supersedes the old one and tells it so.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';
import { startHost, joinClient, recordEvents, advance } from './lib-harness.js';

const CLIENT_EVENTS = ['superseded', 'disconnected', 'reconnecting', 'rejected', 'room-closed', 'reconnected', 'connected'];
const HOST_EVENTS = ['client-joined', 'client-rejoined', 'client-left', 'client-lost'];

describe('C2/C3: a rejoin supersedes the old connection', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C3: the old connection receives __slopnet_superseded and is closed; the old PeerClient turns terminal and never reconnects', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, HOST_EVENTS);
        const oldHostConn = host._findClientByClientId('alice').conn;

        // Wire-level view of A's channel, and A's own events.
        const oldRaw = [];
        a.connection.on('data', d => oldRaw.push(d.type));
        const aLog = recordEvents(a, CLIENT_EVENTS);

        // A duplicate tab: same clientId, same token (Chrome copies sessionStorage).
        const b = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {}, { token: a.token });

        // B holds the seat on a new connection.
        const rec = host._findClientByClientId('alice');
        expect(rec.conn).not.toBe(oldHostConn);
        expect(rec.conn.open).toBe(true);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(b.isConnected).toBe(true);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);

        // A was told, in so many words, and closed.
        expect(oldRaw).toContain('__slopnet_superseded');
        expect(oldHostConn._slopnetSuperseded).toBe(true);
        expect(oldHostConn.open).toBe(false);
        expect(aLog).toEqual([{ event: 'superseded', args: [] }]);
        expect(a.isTerminal).toBe(true);
        expect(a.terminalReason).toBe('superseded');
        expect(a.isConnected).toBe(false);
        expect(a.connection).toBeNull();
        expect(a.peer).toBeNull();
        expect(a.send({ type: 'x' })).toBe(false);

        // A never comes back, and never says 'disconnected'.
        await advance(5 * 60 * 1000);
        expect(aLog).toEqual([{ event: 'superseded', args: [] }]);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(b.isConnected).toBe(true);

        a.destroy(); b.destroy(); host.destroy();
    });

    it('C2: the superseded connection closing (or erroring) does not touch the live record', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const oldHostConn = host._findClientByClientId('alice').conn;
        const b = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {}, { token: a.token });
        const hostLog = recordEvents(host, HOST_EVENTS);

        // Whatever the old connection does now — close again, error — is noise.
        host._handleDisconnect(oldHostConn);
        oldHostConn.emit('error', new Error('late'));
        oldHostConn.emit('close');

        expect(hostLog).toEqual([]);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(host.getDisconnectedClientIds()).toEqual([]);
        expect(host._reconnectWindowTimers.size).toBe(0);

        // The live channel is untouched: data flows both ways.
        const got = [];
        b.on('data', d => got.push(d));
        const hostGot = vi.fn();
        host.on('data', hostGot);
        host.send('alice', { type: 'state' });
        b.send({ type: 'move' });
        await advance(20);
        expect(got).toEqual([{ type: 'state' }]);
        expect(hostGot).toHaveBeenCalledWith('alice', { type: 'move' });

        a.destroy(); b.destroy(); host.destroy();
    });

    it('C2/C4: data arriving on a superseded connection is neither delivered nor attributed to the live seat, and is not nudged', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const oldHostConn = host._findClientByClientId('alice').conn;
        const b = await joinClient('ROOM1', 'alice', { name: 'Alice' }, {}, { token: a.token });

        const dataFn = vi.fn();
        host.on('data', dataFn);
        const sent = [];
        oldHostConn.send = (d) => sent.push(d);   // would throw otherwise: it is closed

        host._handleData(oldHostConn, { type: 'late-move' });

        expect(dataFn).not.toHaveBeenCalled();
        expect(sent).toEqual([]);                  // superseded: it was already told something better
        expect(host.isClientConnected('alice')).toBe(true);

        a.destroy(); b.destroy(); host.destroy();
    });

    it('C3: a raw duplicate presenting the right token takes the seat; the previous raw connection is told and closed', async () => {
        const host = await startHost();
        const hostLog = recordEvents(host, HOST_EVENTS);

        const tab1 = new MockPeer();
        await advance(10);
        const conn1 = tab1.connect('lib-ROOM1', { reliable: true });
        await advance(10);
        const got1 = [];
        conn1.on('data', d => got1.push(d));
        conn1.send({ type: '__slopnet_join', clientId: 'bob', metadata: { name: 'Bob' } });
        await advance(10);
        const token = got1.find(d => d.type === '__slopnet_join_ack').token;
        expect(typeof token).toBe('string');

        const tab2 = new MockPeer();
        await advance(10);
        const conn2 = tab2.connect('lib-ROOM1', { reliable: true });
        await advance(10);
        const got2 = [];
        conn2.on('data', d => got2.push(d));
        conn2.send({ type: '__slopnet_join', clientId: 'bob', metadata: { name: 'Bob' }, token });
        await advance(10);

        expect(got2.map(d => d.type)).toEqual(['__slopnet_join_ack']);
        expect(got2[0].reconnected).toBe(true);
        expect(got1.map(d => d.type)).toEqual(['__slopnet_join_ack', '__slopnet_superseded']);
        expect(conn1.open).toBe(false);
        expect(conn2.open).toBe(true);
        expect(hostLog.map(e => e.event)).toEqual(['client-joined', 'client-rejoined']);
        expect(host.getConnectedClientIds()).toEqual(['bob']);

        tab1.destroy(); tab2.destroy(); host.destroy();
    });
});
