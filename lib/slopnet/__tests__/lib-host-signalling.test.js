/**
 * C12 / C13 / C24 — the host's own signalling socket: a second outage is repaired
 * like the first, the ladder never gives up for good, a failed FIRST registration
 * starts nothing, and resume() runs a pending rung now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, SimpleEmitter, resetRegistry, registry } from './mock-peer.js';
import { createHost, startHost, joinClient, recordEvents, advance } from './lib-harness.js';

describe('C12/C13/C24: host signalling reconnection', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C12: two consecutive signalling outages are both repaired, and a client can join after each', async () => {
        const host = await startHost();
        const log = recordEvents(host, ['reconnecting', 'reconnected', 'reconnect-failed', 'ready']);
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });

        host.peer.simulateDisconnect();
        await advance(100);
        expect(log.filter(e => e.event === 'reconnected')).toHaveLength(1);
        expect(registry.get('lib-ROOM1')).toBe(host.peer);
        const b = await joinClient('ROOM1', 'bob', { name: 'Bob' });
        expect(b.isConnected).toBe(true);
        expect(a.isConnected).toBe(true);           // the outage touched no data channel

        // The SECOND outage used to be ignored: the adopted peer carried inert handlers.
        host.peer.simulateDisconnect();
        await advance(100);
        expect(log.filter(e => e.event === 'reconnected')).toHaveLength(2);
        expect(registry.get('lib-ROOM1')).toBe(host.peer);
        const c = await joinClient('ROOM1', 'carol', { name: 'Carol' });
        expect(c.isConnected).toBe(true);
        expect(host.getConnectedClientIds().sort()).toEqual(['alice', 'bob', 'carol']);

        // And a third, for good measure.
        host.peer.simulateDisconnect();
        await advance(100);
        expect(log.filter(e => e.event === 'reconnected')).toHaveLength(3);
        expect(log.filter(e => e.event === 'reconnect-failed')).toHaveLength(0);
        expect(log.filter(e => e.event === 'ready').every(e => e.args[0] === 'ROOM1')).toBe(true);

        a.destroy(); b.destroy(); c.destroy(); host.destroy();
    });

    it('C12: a network error followed by disconnected on the live peer (peerjs\'s real sequence) is repaired, twice', async () => {
        const host = await startHost();
        const reconnected = vi.fn();
        host.on('reconnected', reconnected);
        host.on('error', () => {});
        for (let i = 1; i <= 2; i++) {
            host.peer.emit('error', Object.assign(new Error('Lost connection to server.'), { type: 'network' }));
            host.peer.disconnect();
            await advance(100);
            expect(reconnected).toHaveBeenCalledTimes(i);
        }
        host.destroy();
    });

    it('C12: a webrtc error on a healthy live peer is reported but does not start a ladder', async () => {
        const host = await startHost();
        const errors = [];
        host.on('error', e => errors.push(e.type));
        const recFn = vi.fn();
        host.on('reconnecting', recFn);
        host.peer.emit('error', Object.assign(new Error('negotiation failed'), { type: 'webrtc' }));
        await advance(500);
        expect(errors).toEqual(['webrtc']);
        expect(recFn).not.toHaveBeenCalled();
        expect(host._reconnecting).toBe(false);
        host.destroy();
    });

    it('C13: exhausting the ladder emits reconnect-failed ONCE, keeps knocking at the plateau, and recovers when the id frees up', async () => {
        const host = await startHost('ROOM1', { maxReconnectAttempts: 3, reconnectBackoffBase: 50, reconnectBackoffMax: 100 });
        const failed = vi.fn();
        const reconnected = vi.fn();
        const attempts = [];
        host.on('reconnect-failed', failed);
        host.on('reconnected', reconnected);
        host.on('reconnecting', (n, max) => attempts.push([n, max]));

        host.peer.simulateDisconnect();
        // Somebody (the server, still holding our dead socket's id) has it.
        const blocker = new MockPeer('lib-ROOM1');
        await advance(2000);

        expect(failed).toHaveBeenCalledTimes(1);
        expect(reconnected).not.toHaveBeenCalled();
        expect(attempts.length).toBeGreaterThan(3);
        expect(attempts.slice(0, 3).map(a => a[0])).toEqual([1, 2, 3]);
        expect(attempts.slice(3).every(a => a[0] === 3 && a[1] === 3)).toBe(true);
        const knocksSoFar = attempts.length;

        await advance(1000);
        expect(attempts.length).toBeGreaterThan(knocksSoFar);   // still knocking
        expect(failed).toHaveBeenCalledTimes(1);

        blocker.destroy();
        await advance(300);
        expect(reconnected).toHaveBeenCalledTimes(1);
        expect(registry.get('lib-ROOM1')).toBe(host.peer);
        expect(host._reconnecting).toBe(false);
        const c = await joinClient('ROOM1', 'alice', {});
        expect(c.isConnected).toBe(true);

        // A later outage starts a fresh ladder and may report failure again, once.
        host.peer.simulateDisconnect();
        const blocker2 = new MockPeer('lib-ROOM1');
        await advance(2000);
        expect(failed).toHaveBeenCalledTimes(2);
        blocker2.destroy();
        await advance(300);
        expect(reconnected).toHaveBeenCalledTimes(2);

        c.destroy(); host.destroy();
    });

    it('C13: a failed FIRST registration rejects start(), starts no ladder and leaves nothing behind; the app owns the retry', async () => {
        /** A peer whose signalling server is unreachable: peerjs's sequence is error, then disconnect. */
        class DeadServerPeer extends SimpleEmitter {
            constructor(id) {
                super();
                this.id = id;
                this.destroyed = false;
                this.disconnected = false;
                setTimeout(() => {
                    const err = new Error('Could not get an ID from the server.');
                    err.type = 'server-error';
                    this.emit('error', err);
                    this.disconnect();
                }, 0);
            }
            disconnect() { if (this.disconnected) return; this.disconnected = true; this.emit('disconnected'); }
            destroy() { if (this.destroyed) return; this.disconnect(); this.destroyed = true; this.emit('close'); }
        }

        const host = createHost({ _PeerClass: DeadServerPeer });
        const errors = [];
        host.on('error', e => errors.push(e.type));
        const recFn = vi.fn();
        host.on('reconnecting', recFn);

        const p = host.start('ROOM1').catch(e => e);
        await advance(10);
        const err = await p;

        expect(err.type).toBe('server-error');
        expect(errors).toEqual(['server-error']);
        expect(recFn).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        expect(registry.has('lib-ROOM1')).toBe(false);
        expect(host.peer).toBeNull();
        expect(host._started).toBe(false);
        expect(host._reconnecting).toBe(false);
        expect(host._destroyed).toBe(false);

        // Later (network back): the same instance may be started again.
        host._PeerClass = MockPeer;
        const p2 = host.start('ROOM1');
        await advance(20);
        expect(await p2).toBe('ROOM1');
        expect(registry.get('lib-ROOM1')).toBe(host.peer);
        host.destroy();
    });

    it('C13: an initial id collision still re-rolls (unchanged), and the new peer is live for later outages', async () => {
        const squatter = new MockPeer('lib-TAKEN');
        await advance(10);
        const host = createHost();
        const p = host.start('TAKEN');
        await advance(50);
        const code = await p;
        expect(code).not.toBe('TAKEN');
        expect(registry.has('lib-TAKEN')).toBe(true);       // the squatter was not evicted
        const reconnected = vi.fn();
        host.on('reconnected', reconnected);
        host.peer.simulateDisconnect();
        await advance(100);
        expect(reconnected).toHaveBeenCalledTimes(1);
        squatter.destroy(); host.destroy();
    });

    it('C13/C24: host.resume() runs a pending reconnect rung now and pings every seated client', async () => {
        const host = await startHost('ROOM1', { reconnectBackoffBase: 5000 });
        const a = await joinClient('ROOM1', 'alice', {});
        const raw = [];
        a.connection.on('data', d => raw.push(d.type));   // what the CLIENT receives
        const reconnected = vi.fn();
        host.on('reconnected', reconnected);

        host.peer.simulateDisconnect();
        await advance(10);
        expect(host._reconnectTimer).not.toBeNull();
        expect(reconnected).not.toHaveBeenCalled();

        host.resume();
        expect(host._reconnectTimer).toBeNull();
        await advance(10);
        expect(reconnected).toHaveBeenCalledTimes(1);
        expect(raw).toEqual(['__slopnet_ping']);
        expect(a.isConnected).toBe(true);

        // resume() with nothing pending only pings.
        host.resume();
        await advance(10);
        expect(raw).toEqual(['__slopnet_ping', '__slopnet_ping']);
        expect(reconnected).toHaveBeenCalledTimes(1);
        a.destroy(); host.destroy();
    });

    it('C13: resume() during an in-flight attempt does not start a second one', async () => {
        const host = createHost({ peerOptions: { openDelayMs: 300 } });
        const started = host.start('ROOM1');
        await advance(350);
        await started;
        host.peer.simulateDisconnect();
        await advance(60);                          // rung 1 fired: attempt pending (300 ms open)
        const pending = host._pendingPeer;
        expect(pending).toBeTruthy();
        host.resume();
        expect(host._pendingPeer).toBe(pending);
        await advance(400);
        expect(host.peer).toBe(pending);
        host.destroy();
    });

    // Round-2 review: resume() dialled unconditionally, so a host whose player
    // app-switches during a signalling blip burned one rung per visibilitychange and
    // marched itself to 'reconnect-failed' — the state every app reads as "the room
    // is gone" — while the room was perfectly healthy over its existing channels.
    it('C24: resume() on every app switch does not burn the ladder', async () => {
        const host = await startHost('ROOM1', {
            reconnectBackoffBase: 1000, reconnectBackoffMultiplier: 1.5,
            reconnectBackoffMax: 6000, maxReconnectAttempts: 20,
        });
        const log = recordEvents(host, ['reconnecting', 'reconnected', 'reconnect-failed']);

        host.peer.simulateDisconnect();
        // The PeerServer has not reaped our id yet, so every re-registration is
        // answered 'unavailable-id' — the normal shape of this outage.
        const squatter = new MockPeer('lib-ROOM1');
        await advance(10);

        for (let i = 0; i < 25; i++) { host.resume(); await advance(1000); }

        expect(log.filter(e => e.event === 'reconnect-failed')).toEqual([]);
        expect(
            log.filter(e => e.event === 'reconnecting').length,
            '25 seconds of a 1000ms..6000ms ladder is a handful of rungs, not 25'
        ).toBeLessThan(12);

        squatter.destroy(); host.destroy();
    });

    // The same guard must not swallow the case resume() exists for: a rung that is
    // OVERDUE because the tab was frozen runs the moment the page is back.
    it('C24: an overdue rung is still brought forward by resume()', async () => {
        const host = await startHost('ROOM1', {
            reconnectBackoffBase: 5000, reconnectBackoffMultiplier: 1, reconnectBackoffMax: 5000,
        });
        const reconnected = vi.fn();
        host.on('reconnected', reconnected);

        host.peer.simulateDisconnect();
        await advance(10);
        host.resume();                       // nothing dialled yet: this one goes now
        await advance(10);
        expect(reconnected).toHaveBeenCalledTimes(1);

        // Second outage; this time let the ladder dial once and then freeze the page
        // past the next rung's due time.
        host.peer.simulateDisconnect();
        const squatter = new MockPeer('lib-ROOM1');
        await advance(6000);                 // rung 1 fires and fails against the squatter
        squatter.destroy();
        const armed = host._reconnectTimer;
        expect(armed).not.toBeNull();
        host._reconnectDueAt = Date.now() - 1;   // the tab was frozen past it
        host.resume();
        expect(host._reconnectTimer, 'the overdue rung ran now').toBeNull();
        await advance(20);
        expect(reconnected).toHaveBeenCalledTimes(2);

        host.destroy();
    });

    // Round-2 review: destroy() while the FIRST registration was still in flight left
    // the caller's `await start()` pending for ever — which is what a lobby retiring a
    // host it is still making does.
    it('C13: destroy() while start() is in flight rejects it', async () => {
        const host = createHost();
        const p = host.start('ROOM1').catch(e => e);
        host.destroy();
        await advance(50);
        const err = await p;
        expect(err.type).toBe('destroyed');
        expect(registry.has('lib-ROOM1'), 'and nothing is left registered').toBe(false);
    });

    // The mock, left to itself, freed a disconnected peer's id immediately, so the
    // branch that must NOT re-roll the room code was only reachable with a
    // hand-written squatter. MockPeer.aliveTimeoutMs models the PeerServer's real
    // alive_timeout instead.
    it('C13: an id the signalling server has not yet reaped keeps the room code', async () => {
        MockPeer.aliveTimeoutMs = 20000;               // the PeerServer's alive_timeout
        const host = await startHost('ROOM1');
        const log = recordEvents(host, ['ready', 'reconnected', 'error']);

        host.peer.simulateDisconnect();
        await advance(10000);                          // every rung is answered unavailable-id
        expect(host.roomCode, 'the code on the host\'s screen never changes').toBe('ROOM1');
        expect(log.filter(e => e.event === 'error'), 'and it is not reported as an error').toEqual([]);

        await advance(20000);                          // the server frees it
        expect(host.roomCode).toBe('ROOM1');
        expect(log.filter(e => e.event === 'reconnected').length).toBe(1);
        expect(log.filter(e => e.event === 'ready').map(e => e.args[0])).toEqual(['ROOM1']);

        host.destroy();
    });
});
