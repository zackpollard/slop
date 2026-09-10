/**
 * C27 — the mock is faithful to peerjs 1.5.5 where SlopNet's correctness depends
 * on it. These pin the mock's own behaviour so the library tests above mean what
 * they say.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, registry } from './mock-peer.js';

async function pair() {
    const a = new MockPeer();
    const b = new MockPeer('b-peer');
    await vi.advanceTimersByTimeAsync(10);
    let remote = null;
    b.on('connection', c => { remote = c; });
    const local = a.connect('b-peer', { reliable: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(local.open).toBe(true);
    expect(remote.open).toBe(true);
    return { a, b, local, remote };
}

describe('C27: mock fidelity', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C27: plain close() emits close SYNCHRONOUSLY on the local side and closes the remote one tick later', async () => {
        const { a, b, local, remote } = await pair();
        const localLog = [];
        const remoteLog = [];
        local.on('close', () => localLog.push('close'));
        remote.on('close', () => remoteLog.push('close'));

        local.close();
        expect(localLog).toEqual(['close']);
        expect(local.open).toBe(false);
        expect(remoteLog).toEqual([]);
        expect(remote.open).toBe(true);

        await vi.advanceTimersByTimeAsync(0);
        expect(remoteLog).toEqual(['close']);
        expect(remote.open).toBe(false);
        // Idempotent.
        local.close(); remote.close();
        expect(localLog).toEqual(['close']);
        expect(remoteLog).toEqual(['close']);
        a.destroy(); b.destroy();
    });

    it('C27: close({ flush: true }) does not close locally; the remote reads everything sent before, then both ends close', async () => {
        const { a, b, local, remote } = await pair();
        const localLog = [];
        const remoteLog = [];
        const remoteData = [];
        local.on('close', () => localLog.push('close'));
        remote.on('close', () => remoteLog.push('close'));
        remote.on('data', d => remoteData.push(d));

        local.send({ n: 1 });
        local.send({ n: 2 });
        local.close({ flush: true });
        expect(local.open).toBe(true);
        expect(localLog).toEqual([]);

        await vi.advanceTimersByTimeAsync(0);
        expect(remoteData).toEqual([{ n: 1 }, { n: 2 }]);    // the control message never surfaced
        expect(remoteLog).toEqual(['close']);
        expect(remote.open).toBe(false);

        // The remote's close scheduled OUR close during that tick; fake-timers run a
        // timer scheduled mid-tick once time moves on.
        await vi.advanceTimersByTimeAsync(1);
        expect(localLog).toEqual(['close']);
        expect(local.open).toBe(false);
        a.destroy(); b.destroy();
    });

    it('C27: a message sent after a plain close of the remote is not delivered; flush-close on a closed connection is a no-op', async () => {
        const { a, b, local, remote } = await pair();
        remote.close();                                  // remote side plain-closes
        const remoteData = [];
        remote.on('data', d => remoteData.push(d));
        expect(() => local.send({ n: 1 })).toThrow('Remote connection is closed');
        await vi.advanceTimersByTimeAsync(10);
        expect(remoteData).toEqual([]);
        expect(local.open).toBe(false);
        expect(() => local.close({ flush: true })).not.toThrow();
        a.destroy(); b.destroy();
    });

    it('C27: a connection that never opened emits nothing on close()', async () => {
        const a = new MockPeer();
        await vi.advanceTimersByTimeAsync(10);
        const conn = a.connect('nobody-home');
        const log = [];
        conn.on('close', () => log.push('close'));
        conn.close();
        expect(conn._closed).toBe(true);
        expect(log).toEqual([]);
        a.destroy();
    });

    it('C27: destroy() emits disconnected synchronously, then closes connections plainly, then emits close', async () => {
        const { a, b, local, remote } = await pair();
        const order = [];
        a.on('disconnected', () => order.push('disconnected'));
        local.on('close', () => order.push('conn-close'));
        a.on('close', () => order.push('close'));

        a.destroy();
        expect(order).toEqual(['disconnected', 'conn-close', 'close']);
        expect(a.destroyed).toBe(true);
        expect(a.disconnected).toBe(true);
        expect(registry.has(a.id)).toBe(false);
        expect(remote.open).toBe(true);                  // remote closes a tick later
        await vi.advanceTimersByTimeAsync(0);
        expect(remote.open).toBe(false);

        // disconnect() is once-only: a destroy after a disconnect emits no second 'disconnected'.
        const c = new MockPeer();
        const cLog = [];
        c.on('disconnected', () => cLog.push('d'));
        c.disconnect(); c.destroy();
        expect(cLog).toEqual(['d']);
        b.destroy();
    });

    it('C27: disconnect() leaves DataConnections alone and frees the id; a peer that lost an id race does not evict the holder', async () => {
        const { a, b, local, remote } = await pair();
        a.disconnect();
        expect(local.open).toBe(true);
        expect(remote.open).toBe(true);
        expect(registry.has(a.id)).toBe(false);

        const loser = new MockPeer('b-peer');
        const errs = [];
        loser.on('error', e => errs.push(e.type));
        await vi.advanceTimersByTimeAsync(10);
        expect(errs).toEqual(['unavailable-id']);
        loser.destroy();
        expect(registry.get('b-peer')).toBe(b);
        a.destroy(); b.destroy();
    });

    it('C27: openDelayMs (per instance or static default) holds registration mid-handshake', async () => {
        const slow = new MockPeer(undefined, { openDelayMs: 300 });
        const opened = vi.fn();
        slow.on('open', opened);
        await vi.advanceTimersByTimeAsync(100);
        expect(opened).not.toHaveBeenCalled();
        expect(registry.has(slow.id)).toBe(true);        // registered, not yet open
        await vi.advanceTimersByTimeAsync(250);
        expect(opened).toHaveBeenCalledWith(slow.id);

        MockPeer.openDelayMs = 200;
        const viaStatic = new MockPeer();
        const opened2 = vi.fn();
        viaStatic.on('open', opened2);
        await vi.advanceTimersByTimeAsync(150);
        expect(opened2).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);
        expect(opened2).toHaveBeenCalled();
        resetRegistry();
        expect(MockPeer.openDelayMs).toBe(0);
        slow.destroy(); viaStatic.destroy();
    });
});
