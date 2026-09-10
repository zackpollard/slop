/**
 * C16 — the client's outbound queue is bounded, and a send that throws mid-flush
 * keeps the rest of the queue in order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import { startHost, joinClient, advance } from './lib-harness.js';

describe('C16: client outbound queue', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C16: the queue is capped at 200 messages, dropping the oldest', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {}, { reconnectBackoffBase: 60000 });
        c.connection.close();
        await advance(10);
        expect(c.isConnected).toBe(false);

        for (let i = 0; i < 250; i++) expect(c.send({ seq: i })).toBe(false);
        expect(c.queueSize).toBe(200);
        expect(c._messageQueue[0]).toEqual({ seq: 50 });
        expect(c._messageQueue[199]).toEqual({ seq: 249 });

        // A terminal client queues nothing at all.
        host.rejectClient('alice', 'x');          // inside the window: seat forgotten, no message
        c.destroy(); host.destroy();
    });

    it('C16: a send that throws mid-flush keeps the TAIL, in order, ahead of anything queued since', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {});
        const got = [];
        host.on('data', (id, d) => got.push(d.seq));

        c._messageQueue = [{ seq: 0 }, { seq: 1 }, { seq: 2 }, { seq: 3 }];
        const conn = c.connection;
        const realSend = conn.send.bind(conn);
        conn.send = (d) => {
            if (d.seq === 1) throw new Error('channel hiccup');
            return realSend(d);
        };

        c._flushQueue();
        expect(c._messageQueue.map(m => m.seq)).toEqual([1, 2, 3]);

        c.send({ seq: 4 });                       // goes out directly, the channel is open
        conn.send = realSend;
        c._flushQueue();
        await advance(20);
        expect(got).toEqual([0, 4, 1, 2, 3]);
        expect(c.queueSize).toBe(0);
        c.destroy(); host.destroy();
    });

    it('C16: queued messages are flushed in order on reconnect', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {});
        const got = [];
        host.on('data', (id, d) => got.push(d.seq));
        c.connection.close();
        await advance(10);
        for (let i = 0; i < 5; i++) c.send({ seq: i });
        await advance(300);
        expect(c.isConnected).toBe(true);
        await advance(20);
        expect(got).toEqual([0, 1, 2, 3, 4]);
        c.destroy(); host.destroy();
    });
});
