/**
 * C22 — a peer 'error' on the client must not tear down a healthy data channel.
 * PeerJS emits error{network} BEFORE 'disconnected' when the signalling socket
 * dies (backgrounded phone, ~60 s); the channel is native WebRTC and still fine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import { createClient, startHost, joinClient, recordEvents, advance } from './lib-harness.js';

describe('C22: client peer error with an open channel', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C22: error{network} then disconnected on the live peer is reported and nothing else happens', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const log = recordEvents(c, ['error', 'disconnected', 'reconnecting', 'reconnected']);
        const hostLog = recordEvents(host, ['client-left', 'client-rejoined']);
        const conn = c.connection;
        const peer = c.peer;

        peer.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' }));
        peer.disconnect();

        expect(log.map(e => e.event)).toEqual(['error']);
        expect(c.isConnected).toBe(true);
        expect(c.connection).toBe(conn);
        expect(conn.open).toBe(true);
        expect(c.peer).toBe(peer);
        expect(peer.destroyed).toBe(false);

        await advance(5000);
        expect(log.map(e => e.event)).toEqual(['error']);
        expect(hostLog).toEqual([]);

        // The channel carries the game as before.
        const got = [];
        c.on('data', d => got.push(d));
        const hostGot = vi.fn();
        host.on('data', hostGot);
        host.send('alice', { type: 'state' });
        c.send({ type: 'move' });
        await advance(20);
        expect(got).toEqual([{ type: 'state' }]);
        expect(hostGot).toHaveBeenCalledWith('alice', { type: 'move' });
        c.destroy(); host.destroy();
    });

    it('C22: every fatal type is likewise ignored while the channel is open', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {});
        const log = recordEvents(c, ['error', 'disconnected', 'reconnecting']);
        for (const type of ['peer-unavailable', 'server-error', 'socket-error', 'socket-closed', 'unavailable-id', 'webrtc']) {
            c.peer.emit('error', Object.assign(new Error(type), { type }));
        }
        expect(log.filter(e => e.event === 'error')).toHaveLength(6);
        expect(log.filter(e => e.event !== 'error')).toEqual([]);
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C22: the same error with NO open channel still fails the attempt and re-arms the ladder', async () => {
        const host = await startHost();
        const c = createClient({ peerOptions: { openDelayMs: 300 } });
        const p = c.connect('ROOM1', 'alice', {});
        await advance(400);
        await p;
        const log = recordEvents(c, ['error', 'disconnected', 'reconnecting']);
        c.connection.close();
        await advance(60);                          // rung 1 in flight, its peer not yet open
        expect(c.isConnecting).toBe(true);
        expect(log.map(e => e.event)).toEqual(['disconnected', 'reconnecting']);

        c.peer.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' }));
        expect(c.isConnecting).toBe(false);
        expect(log.map(e => e.event)).toEqual(['disconnected', 'reconnecting', 'error', 'reconnecting']);
        expect(c._reconnectTimer).not.toBeNull();
        await advance(1000);
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });
});
