/**
 * C23 — 'connected' is for the FIRST successful ack of the instance's life; every
 * later ack emits 'reconnected' with one boolean: whether the host remembered us.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import { startHost, joinClient, recordEvents, advance } from './lib-harness.js';

describe('C23: connected vs reconnected', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C23: a plain drop yields reconnected(true); a host restart yields reconnected(false); connected fires once', async () => {
        const hostA = await startHost();
        const c = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const log = recordEvents(c, ['connected', 'reconnected', 'disconnected']);

        c.connection.close();
        await advance(300);
        expect(log).toEqual([{ event: 'disconnected', args: [] }, { event: 'reconnected', args: [true] }]);

        hostA.destroy();
        await advance(20);
        const hostB = await startHost('ROOM1');
        const bLog = recordEvents(hostB, ['client-joined', 'client-rejoined']);
        await advance(2000);
        expect(c.isConnected).toBe(true);
        expect(bLog.map(e => e.event)).toEqual(['client-joined']);
        expect(log.slice(2)).toEqual([{ event: 'disconnected', args: [] }, { event: 'reconnected', args: [false] }]);
        expect(log.filter(e => e.event === 'connected')).toEqual([]);   // recorded after the first ack
        c.destroy(); hostB.destroy();
    });

    it('C23: a return after the window expired is reconnected(true) — the host remembered the seat', async () => {
        const host = await startHost('ROOM1', { reconnectWindowMs: 200 });
        const c = await joinClient('ROOM1', 'alice', {}, { reconnectBackoffBase: 1000, reconnectBackoffMax: 1000 });
        const log = recordEvents(c, ['connected', 'reconnected']);
        const hostLog = recordEvents(host, ['client-lost', 'client-rejoined']);
        c.connection.close();
        await advance(1200);
        expect(hostLog.map(e => e.event)).toEqual(['client-lost', 'client-rejoined']);
        expect(log).toEqual([{ event: 'reconnected', args: [true] }]);
        c.destroy(); host.destroy();
    });
});
