/**
 * C25 — start()/connect() settle BEFORE 'ready'/'connected'/'reconnected' are
 * emitted, so a throwing listener can never leave an app's `await` pending.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import { createHost, createClient, startHost, advance } from './lib-harness.js';

describe('C25: promise settlement ordering', () => {
    let errSpy;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        errSpy.mockRestore();
        vi.useRealTimers();
    });

    it('C25: a throwing ready listener cannot leave await start() pending', async () => {
        const host = createHost();
        const order = [];
        host.on('ready', () => { order.push('ready'); throw new Error('app bug'); });
        const p = host.start('ROOM1').then(code => { order.push('resolved:' + code); return code; });
        await advance(20);
        expect(await p).toBe('ROOM1');
        expect(order).toEqual(['ready', 'resolved:ROOM1']);
        expect(errSpy).toHaveBeenCalledTimes(1);
        host.destroy();
    });

    it('C25: a throwing connected listener cannot leave await connect() pending', async () => {
        const host = await startHost();
        const c = createClient();
        c.on('connected', () => { throw new Error('app bug'); });
        const p = c.connect('ROOM1', 'alice', {});
        await advance(50);
        await expect(p).resolves.toBeUndefined();
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C25: a throwing reconnected listener does not break the reconnect', async () => {
        const host = await startHost();
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {});
        await advance(50);
        await p;
        c.on('reconnected', () => { throw new Error('app bug'); });
        c.connection.close();
        await advance(300);
        expect(c.isConnected).toBe(true);
        expect(host.isClientConnected('alice')).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C25: a throwing client-joined listener on the host does not stop the ack or later listeners', async () => {
        const host = await startHost();
        host.on('client-joined', () => { throw new Error('app bug'); });
        const seen = vi.fn();
        host.on('client-joined', seen);
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {});
        await advance(50);
        await p;
        expect(seen).toHaveBeenCalledWith('alice', {});
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });
});
