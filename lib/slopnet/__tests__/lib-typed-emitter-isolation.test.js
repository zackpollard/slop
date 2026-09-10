/**
 * C1 — TypedEmitter isolates listeners from one another.
 *
 * emit() runs from inside PeerJS's own DataConnection handlers. A throw in an app's
 * 'data' handler used to abort every listener after it (the library's own
 * bookkeeping included) and propagate into the transport.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import { SlopNet, startHost, joinClient, advance } from './lib-harness.js';

const { TypedEmitter } = SlopNet;

describe('C1: TypedEmitter listener isolation', () => {
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

    it('C1: a throwing listener does not stop later listeners and does not propagate out of emit', () => {
        const em = new TypedEmitter();
        const calls = [];
        em.on('x', () => calls.push(1));
        em.on('x', () => { throw new Error('boom'); });
        em.on('x', () => calls.push(3));

        let result;
        expect(() => { result = em.emit('x', 'arg'); }).not.toThrow();

        expect(result).toBe(true);
        expect(calls).toEqual([1, 3]);
        expect(errSpy).toHaveBeenCalledTimes(1);
        expect(errSpy.mock.calls[0][0]).toBe('[SlopNet] listener for "x" threw');
        expect(errSpy.mock.calls[0][1]).toBeInstanceOf(Error);
    });

    it('C1: emit still reports whether anything listened', () => {
        const em = new TypedEmitter();
        expect(em.emit('nobody')).toBe(false);
        em.on('x', () => { throw new Error('boom'); });
        expect(em.emit('x')).toBe(true);
    });

    it('C1: a throwing app data handler leaves the library and the transport intact', async () => {
        const host = await startHost();
        const client = await joinClient('ROOM1', 'alice', { name: 'Alice' });

        client.on('data', () => { throw new Error('app bug'); });
        const seen = [];
        client.on('data', d => seen.push(d));

        host.send('alice', { type: 'state', n: 1 });
        await advance(20);
        expect(seen).toEqual([{ type: 'state', n: 1 }]);
        expect(client.isConnected).toBe(true);
        expect(host.isClientConnected('alice')).toBe(true);

        // The next message still arrives: nothing about the channel was disturbed.
        host.send('alice', { type: 'state', n: 2 });
        await advance(20);
        expect(seen).toHaveLength(2);
        expect(errSpy).toHaveBeenCalledTimes(2);

        client.destroy();
        host.destroy();
    });
});
