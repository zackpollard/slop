/**
 * C21 — destroy() and _handleDisconnect are teardown-safe with a mock whose
 * close() fires 'close' synchronously; _pastClients is bounded and shaped
 * { metadata, token }.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';
import { startHost, joinClient, recordEvents, advance } from './lib-harness.js';

describe('C21: teardown safety', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C21: destroy() with seated players emits no client-left/client-lost and re-arms no window timers', async () => {
        const host = await startHost();
        const clients = [];
        for (const id of ['alice', 'bob', 'carol']) clients.push(await joinClient('ROOM1', id, { name: id }, { maxReconnectAttempts: 0 }));
        // One of them is already inside the window, with a timer armed.
        clients[2].connection.close();
        await advance(10);
        expect(host._reconnectWindowTimers.size).toBe(1);
        const hostLog = recordEvents(host, ['client-left', 'client-lost', 'client-rejoined']);

        host.destroy();

        expect(hostLog).toEqual([]);
        expect(host.clients.size).toBe(0);
        expect(host._pastClients.size).toBe(0);
        expect(host._reconnectWindowTimers.size).toBe(0);
        await advance(200000);
        expect(hostLog).toEqual([]);
        expect(host._reconnectWindowTimers.size).toBe(0);

        // The players did see their channels close.
        expect(clients[0].isConnected).toBe(false);
        expect(clients[1].isConnected).toBe(false);
        clients.forEach(c => c.destroy());
    });

    it('C21: a late close/error from a connection after destroy() is ignored', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', {}, { maxReconnectAttempts: 0 });
        const conn = host._findClientByClientId('alice').conn;
        host.destroy();
        expect(() => { host._handleDisconnect(conn); conn.emit('close'); conn.emit('error'); host._handleData(conn, { type: 'x' }); }).not.toThrow();
        expect(host.clients.size).toBe(0);
        a.destroy();
    });

    it('C21: _pastClients entries are { metadata, token } and capped at 256 (oldest dropped)', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 10 });
        const tab = new MockPeer();
        await advance(10);
        const conn = tab.connect('lib-ROOM1', { reliable: true });
        await advance(10);
        const got = [];
        conn.on('data', d => got.push(d));
        conn.send({ type: '__slopnet_join', clientId: 'p0', metadata: { name: 'P0' } });
        await advance(10);
        const token = got[0].token;
        conn.close();
        await advance(30);
        expect(host._pastClients.get('p0')).toEqual({ metadata: { name: 'P0' }, token });

        for (let i = 1; i <= 300; i++) {
            host._rememberPastClient({ clientId: 'q' + i, metadata: {}, token: 't' + i });
        }
        expect(host._pastClients.size).toBe(256);
        expect(host._pastClients.has('p0')).toBe(false);
        expect(host._pastClients.has('q44')).toBe(false);
        expect(host._pastClients.has('q45')).toBe(true);
        expect(host._pastClients.has('q300')).toBe(true);

        // Re-remembering an existing id moves it to the newest end rather than growing the map.
        host._rememberPastClient({ clientId: 'q45', metadata: {}, token: 't45' });
        expect(host._pastClients.size).toBe(256);
        expect([...host._pastClients.keys()].at(-1)).toBe('q45');
        tab.destroy(); host.destroy();
    });
});
