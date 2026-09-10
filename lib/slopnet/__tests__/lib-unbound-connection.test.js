/**
 * C4 / C20 — a connection that holds no seat: its data is never delivered (and
 * never under a raw peer id), its pings are not answered with pongs, and it is
 * told to rejoin. A live PeerClient acts on that nudge. When a seat's window
 * expires with the channel still open, the host closes the channel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, freezePage } from './mock-peer.js';
import { startHost, joinClient, recordEvents, advance } from './lib-harness.js';

describe('C4/C20: unbound connections', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C4: traffic from a connection with no seat is never emitted as data; the sender is nudged to rejoin, at most once per 2 s', async () => {
        const host = await startHost();
        const dataFn = vi.fn();
        host.on('data', dataFn);

        const stranger = new MockPeer();
        await advance(10);
        const conn = stranger.connect('lib-ROOM1', { reliable: true });
        await advance(10);
        const got = [];
        conn.on('data', d => got.push(d));

        conn.send({ type: 'hello' });
        await advance(10);
        expect(dataFn).not.toHaveBeenCalled();
        expect(got).toEqual([{ type: '__slopnet_rejoin_required' }]);

        // Rate-limited per connection.
        conn.send({ type: 'again' });
        conn.send({ type: 'and-again' });
        await advance(10);
        expect(got).toHaveLength(1);

        await advance(2000);
        conn.send({ type: 'later' });
        await advance(10);
        expect(got).toHaveLength(2);
        expect(dataFn).not.toHaveBeenCalled();
        expect(host.getAllClientIds()).toEqual([]);

        stranger.destroy(); host.destroy();
    });

    it('C20: a ping from an unbound connection is answered with rejoin_required, never a pong', async () => {
        const host = await startHost();
        const stranger = new MockPeer();
        await advance(10);
        const conn = stranger.connect('lib-ROOM1', { reliable: true });
        await advance(10);
        const got = [];
        conn.on('data', d => got.push(d.type));

        conn.send({ type: '__slopnet_ping' });
        await advance(10);
        expect(got).toEqual(['__slopnet_rejoin_required']);
        expect(got).not.toContain('__slopnet_pong');

        stranger.destroy(); host.destroy();
    });

    it('C4: a PeerClient nudged to rejoin re-sends its join on the same channel and the host emits client-rejoined', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const hostLog = recordEvents(host, ['client-joined', 'client-rejoined', 'client-left', 'client-lost']);
        const clientLog = recordEvents(client, ['reconnected', 'connected', 'disconnected', 'reconnecting']);
        const dataFn = vi.fn();
        host.on('data', dataFn);

        // The host loses the record while the channel stays open (the seat expired
        // between two of a frozen tab's messages, say). Model that state directly.
        const rec = host._findClientByClientId('alice');
        host.clients.delete(rec.clientId);   // the map is keyed by clientId
        host._rememberPastClient(rec);
        expect(host.getAllClientIds()).toEqual([]);

        client.send({ type: 'move' });
        await advance(30);

        // The orphaned message was not delivered under any id...
        expect(dataFn).not.toHaveBeenCalled();
        // ...the client re-presented its join over the same channel...
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);
        expect(clientLog).toEqual([{ event: 'reconnected', args: [true] }]);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(host._findClientByClientId('alice').conn).toBe(rec.conn);
        expect(client.isConnected).toBe(true);

        // ...and is seated again.
        client.send({ type: 'move-2' });
        await advance(20);
        expect(dataFn).toHaveBeenCalledTimes(1);
        expect(dataFn).toHaveBeenCalledWith('alice', { type: 'move-2' });

        client.destroy(); host.destroy();
    });

    it('C4: the client re-sends its join at most once per 2 s', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const joins = [];
        const raw = host._handleData.bind(host);
        host._handleData = (conn, data) => {
            if (data && data.type === '__slopnet_join') joins.push(data);
            // Swallow the join so the connection stays unbound and every message nudges.
            if (data && data.type === '__slopnet_join') return;
            return raw(conn, data);
        };
        const rec = host._findClientByClientId('alice');
        host.clients.delete(rec.clientId);   // the map is keyed by clientId

        client.send({ type: 'a' });
        await advance(10);
        expect(joins).toHaveLength(1);
        await advance(2100);                 // nudge limit on the host side lapses
        client.send({ type: 'b' });
        await advance(10);
        expect(joins).toHaveLength(2);
        expect(joins[1].token).toBe(client.token);

        client.destroy(); host.destroy();
    });

    it('C4: when the reconnect window expires while the channel is still open, the host closes it so a thawed tab reconnects', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 100, heartbeatTimeout: 300, reconnectWindowMs: 1000 });
        // The client answers the host's pings but runs no heartbeat of its own.
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' }, { heartbeatInterval: 0 });
        const hostLog = recordEvents(host, ['client-left', 'client-lost', 'client-rejoined']);
        const hostConn = host._findClientByClientId('alice').conn;

        // Screen locks: the client's JavaScript stops. The channel stays open.
        const frozen = freezePage(client);
        await advance(2000);

        expect(hostLog.map(e => e.event)).toEqual(['client-left', 'client-lost']);
        expect(hostConn.open).toBe(false);          // the host closed it
        expect(host._pastClients.get('alice')).toEqual({ metadata: { name: 'Alice' }, token: client.token });

        // Screen unlocks: the page runs again and sees a REAL close, then reconnects.
        const clientLog = recordEvents(client, ['disconnected', 'reconnected']);
        frozen.wake();
        frozen.deliverBufferedMessages();
        await advance(300);

        expect(clientLog.map(e => e.event)).toEqual(['disconnected', 'reconnected']);
        expect(clientLog[1].args).toEqual([true]);
        expect(hostLog.map(e => e.event)).toEqual(['client-left', 'client-lost', 'client-rejoined']);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(client.isConnected).toBe(true);

        client.destroy(); host.destroy();
    });
});
