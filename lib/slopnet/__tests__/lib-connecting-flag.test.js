/**
 * C7 / C14 / C24 — PeerClient: one attempt at a time. `_connecting` must be
 * cleared on EVERY terminal path of an attempt (clearing it only on success would
 * latch it and block reconnection forever); a retired peer must never drive the
 * state machine; reconnect()/resume() semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, registry } from './mock-peer.js';
import { SlopNet, createClient, startHost, joinClient, recordEvents, advance } from './lib-harness.js';

const { PeerHost } = SlopNet;

/** A host that never acks a join (swallows every message). */
function muteHost(host) {
    host._handleData = () => {};
}
function unmuteHost(host) {
    delete host._handleData;            // back to the prototype's
}

describe('C7: _connecting is cleared on every terminal path of an attempt', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C7: join_ack', async () => {
        const host = await startHost();
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {});
        expect(c.isConnecting).toBe(true);
        await advance(50);
        await p;
        expect(c.isConnecting).toBe(false);
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C7: join_reject (before any ack)', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', {});
        const b = createClient();
        const p = b.connect('ROOM1', 'alice', {}).catch(e => e);   // no token: refused at the door
        expect(b.isConnecting).toBe(true);
        await advance(50);
        const err = await p;
        expect(err.type).toBe('rejected');
        expect(b.isConnecting).toBe(false);
        expect(b.peer).toBeNull();
        a.destroy(); b.destroy(); host.destroy();
    });

    it('C7: peer error', async () => {
        const c = createClient();
        const p = c.connect('NOWHERE', 'alice', {}).catch(e => e);
        expect(c.isConnecting).toBe(true);
        await advance(20);
        const err = await p;
        expect(err.type).toBe('peer-unavailable');
        expect(c.isConnecting).toBe(false);
        c.destroy();
    });

    it('C7: connection close', async () => {
        const host = await startHost();
        muteHost(host);
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(20);                       // join sent, no ack
        expect(c.isConnecting).toBe(true);
        c.connection.close();                    // synchronous 'close'
        expect(c.isConnecting).toBe(false);
        const err = await p;
        expect(err.type).toBe('connection-closed');
        c.destroy(); host.destroy();
    });

    it('C7: connection error', async () => {
        const host = await startHost();
        muteHost(host);
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(20);
        expect(c.isConnecting).toBe(true);
        c.connection.emit('error', Object.assign(new Error('boom'), { type: 'negotiation-failed' }));
        expect(c.isConnecting).toBe(false);
        const err = await p;
        expect(err.type).toBe('negotiation-failed');
        c.destroy(); host.destroy();
    });

    it('C7: overall timeout', async () => {
        const host = await startHost();
        muteHost(host);
        const c = createClient({ connectionTimeout: 300 });
        const errors = [];
        c.on('error', e => errors.push(e.type));
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(400);
        const err = await p;
        expect(err.type).toBe('connection-timeout');
        expect(errors).toEqual(['connection-timeout']);
        expect(c.isConnecting).toBe(false);
        expect(c.peer).toBeNull();
        c.destroy(); host.destroy();
    });

    it('C7: destroy()', async () => {
        const host = await startHost();
        const c = createClient({ peerOptions: { openDelayMs: 500 } });
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(10);
        expect(c.isConnecting).toBe(true);
        c.destroy();
        expect(c.isConnecting).toBe(false);
        const err = await p;
        expect(err.type).toBe('destroyed');
        host.destroy();
    });

    it('C7: a failed reconnect rung clears the flag so the next rung can arm, and the ladder can run to the end', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {}, { maxReconnectAttempts: 2 });
        const failedFn = vi.fn();
        c.on('reconnect-failed', failedFn);
        host.destroy();                            // every rung will get peer-unavailable
        await advance(20);
        expect(c.isConnected).toBe(false);
        await advance(60);                         // rung 1 fired and failed
        expect(c.isConnecting).toBe(false);
        expect(c._reconnectTimer).not.toBeNull();  // rung 2 is armed
        await advance(3000);
        expect(failedFn).toHaveBeenCalled();
        expect(c.isConnecting).toBe(false);
        c.destroy();
    });
});

describe('C7/C24: reconnect() and resume()', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C7: reconnect() during an in-flight attempt is a no-op and does not destroy the pending peer', async () => {
        const host = await startHost();
        const c = createClient({ peerOptions: { openDelayMs: 500 } });
        const p = c.connect('ROOM1', 'alice', {});
        await advance(600);
        await p;

        c.connection.close();
        await advance(60);                         // rung 1 fired; its peer is waiting to open
        const pending = c.peer;
        expect(c.isConnecting).toBe(true);
        expect(pending.destroyed).toBe(false);
        const recFn = vi.fn();
        c.on('reconnecting', recFn);

        c.reconnect();
        expect(c.peer).toBe(pending);
        expect(pending.destroyed).toBe(false);
        expect(recFn).not.toHaveBeenCalled();

        await advance(600);
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C24: reconnect() clears a pending rung and runs it NOW, announcing rung 1', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {}, { reconnectBackoffBase: 5000 });
        c.connection.close();
        await advance(10);
        expect(c._reconnectTimer).not.toBeNull();
        const recLog = recordEvents(c, ['reconnecting']);

        c.reconnect();
        expect(c._reconnectTimer).toBeNull();
        expect(recLog).toEqual([{ event: 'reconnecting', args: [1, 20] }]);
        expect(c.isConnecting).toBe(true);
        await advance(50);
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C7: reconnect() is a no-op when connected, never connected, terminal or destroyed', async () => {
        const host = await startHost();
        const fresh = createClient();
        fresh.reconnect();
        expect(fresh.peer).toBeNull();
        const c = await joinClient('ROOM1', 'alice', {});
        const recFn = vi.fn();
        c.on('reconnecting', recFn);
        c.reconnect();
        expect(recFn).not.toHaveBeenCalled();
        host.rejectClient('alice', 'bye');
        await advance(20);
        c.reconnect();
        c.resume();
        expect(recFn).not.toHaveBeenCalled();
        expect(c.peer).toBeNull();
        c.destroy(); fresh.destroy(); host.destroy();
    });

    it('C7/C24: resume() while connected sends a ping immediately; an answer clears the probe', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {});
        const hostConn = host._findClientByClientId('alice').conn;
        const raw = [];
        hostConn.on('data', d => raw.push(d.type));
        const discFn = vi.fn();
        c.on('disconnected', discFn);

        c.resume();
        expect(c._pingsAwaitingPong).toBe(1);
        expect(c._resumeProbe).not.toBeNull();
        await advance(10);
        expect(raw).toEqual(['__slopnet_ping']);
        expect(c._pingsAwaitingPong).toBe(0);
        expect(c._resumeProbe).toBeNull();
        await advance(10000);
        expect(discFn).not.toHaveBeenCalled();
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    // The probe never invents a verdict of its own. Three seconds of silence from a
    // peer whose page is frozen (the other end of these games is a phone too) is not
    // evidence of a dead channel — tearing the peer down there closes a working
    // DataChannel. It re-applies the HEARTBEAT's rule, up to one tick early.
    it('C24: resume()\'s probe does not convict a quiet channel; it only brings the heartbeat verdict forward', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 0 });
        const c = await joinClient('ROOM1', 'alice', {}, { heartbeatInterval: 5000, heartbeatTimeout: 15000 });
        const cLog = recordEvents(c, ['disconnected', 'reconnected']);
        muteHost(host);                            // the host's page has frozen

        // 3 s later the probe fires and finds one unanswered ping and 3 s of silence —
        // nothing like the heartbeat's evidence. The channel is left alone.
        c.resume();
        await advance(3100);
        expect(cLog).toEqual([]);
        expect(c.isConnected).toBe(true);
        expect(c.connection.open).toBe(true);

        // The heartbeat goes on pinging and convicts on its own evidence: three pings
        // sent and ignored AND more than heartbeatTimeout of silence (t = 20 s here,
        // the first tick at which both are true).
        await advance(17100);
        expect(cLog.map(e => e.event)).toEqual(['disconnected']);
        expect(c.isConnected).toBe(false);

        // (the rung that fired while the host was still frozen has to time out first)
        unmuteHost(host);
        await advance(6000);
        expect(c.isConnected).toBe(true);
        expect(cLog.map(e => e.event)).toEqual(['disconnected', 'reconnected']);
        c.destroy(); host.destroy();
    });

    it('C24: resume() convicts as soon as the heartbeat\'s own evidence exists', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 0 });
        const c = await joinClient('ROOM1', 'alice', {}, { heartbeatInterval: 5000, heartbeatTimeout: 15000 });
        const cLog = recordEvents(c, ['disconnected']);
        muteHost(host);

        await advance(14000);                      // 2 pings out, 14 s of silence
        expect(cLog).toEqual([]);
        await advance(2000);                       // 3rd ping at 15 s; still under the rule
        c._pingsAwaitingPong = 3;
        c.resume();                                // the player comes back to the tab
        await advance(3100);
        expect(cLog.map(e => e.event)).toEqual(['disconnected']);
        c.destroy(); host.destroy();
    });

    it('C7: resume() while disconnected reconnects now instead of waiting for the backoff', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {}, { reconnectBackoffBase: 5000 });
        c.connection.close();
        await advance(10);
        expect(c.isConnected).toBe(false);
        expect(c._reconnectTimer).not.toBeNull();

        c.resume();
        await advance(50);
        expect(c.isConnected).toBe(true);
        c.destroy(); host.destroy();
    });

    it('C7: connect() twice on one instance throws', async () => {
        const host = await startHost();
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {});
        expect(() => c.connect('ROOM1', 'alice', {})).toThrow('already connecting');
        await advance(50);
        await p;
        expect(() => c.connect('ROOM1', 'alice', {})).toThrow('already connected');
        c.connection.close();
        await advance(10);
        expect(() => c.connect('ROOM1', 'alice', {})).toThrow('already connecting/connected');
        c.destroy(); host.destroy();
    });

    it('C7: a first-connect failure destroys the peer it created', async () => {
        const c = createClient();
        const p = c.connect('NOWHERE', 'alice', {}).catch(e => e);
        const peer = c.peer;
        expect(peer).toBeTruthy();
        await advance(20);
        await p;
        expect(peer.destroyed).toBe(true);
        expect(registry.has(peer.id)).toBe(false);
        expect(c.peer).toBeNull();
        expect(c.connection).toBeNull();
        c.destroy();
    });
});

describe('C14: attempt isolation', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C14: a reconnect attempt is not torn down by its predecessor\'s destroy; exactly one attempt is in flight', async () => {
        let constructed = 0;
        class CountingPeer extends MockPeer {
            constructor(id, opts) { super(id, opts); constructed++; }
        }
        const host = await startHost();
        const c = createClient({ _PeerClass: CountingPeer, peerOptions: { openDelayMs: 200 } });
        const p = c.connect('ROOM1', 'alice', {});
        await advance(300);
        await p;
        expect(constructed).toBe(1);
        const oldPeer = c.peer;
        const discLog = recordEvents(c, ['disconnected']);

        c.connection.close();
        await advance(60);                         // rung 1: old peer destroyed, new peer pending
        expect(oldPeer.destroyed).toBe(true);
        expect(constructed).toBe(2);
        expect(c.isConnecting).toBe(true);
        expect(c._reconnectTimer).toBeNull();
        expect(c.peer.destroyed).toBe(false);
        expect(discLog).toHaveLength(1);           // the old peer's synchronous 'disconnected' changed nothing

        await advance(100);
        expect(constructed).toBe(2);               // still the same attempt
        expect(c.isConnecting).toBe(true);
        await advance(200);
        expect(c.isConnected).toBe(true);
        expect(constructed).toBe(2);
        c.destroy(); host.destroy();
    });

    it('C14: no stale connection-timeout error fires after a successful reconnect', async () => {
        const host = await startHost();
        const c = await joinClient('ROOM1', 'alice', {}, { connectionTimeout: 300 });
        const errors = [];
        c.on('error', e => errors.push(e.type));
        c.connection.close();
        await advance(200);
        expect(c.isConnected).toBe(true);
        await advance(5000);
        expect(errors).toEqual([]);
        expect(c.isConnected).toBe(true);
        expect(c._connectTimer).toBeNull();
        c.destroy(); host.destroy();
    });

    it('C14: _destroyPeer clears the attempt timeout, and destroy() leaves no client timers', async () => {
        const host = await startHost();
        muteHost(host);
        const c = createClient({ connectionTimeout: 5000 });
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(20);
        expect(c._connectTimer).not.toBeNull();
        c.destroy();
        expect(c._connectTimer).toBeNull();
        expect((await p).type).toBe('destroyed');
        host.destroy();
        await advance(10);                         // the mock's deferred remote closes
        expect(vi.getTimerCount()).toBe(0);
    });
});
