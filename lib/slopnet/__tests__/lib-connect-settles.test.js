/**
 * C15 — connect() always settles: a channel that closes or errors before the first
 * ack rejects it, destroy() rejects it with type 'destroyed', and therefore
 * `await lobby.joinRoom()` can never hang on a "Connecting…" screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';
import {
    SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createClient, startHost, advance,
} from './lib-harness.js';

describe('C15: connect() always settles', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C15: the channel closing before the first ack rejects connect() with connection-closed and destroys the peer', async () => {
        const host = await startHost();
        host._handleData = () => {};                  // never acks
        const c = createClient();
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(20);
        const peer = c.peer;
        c.connection.close();
        const err = await p;
        expect(err).toBeInstanceOf(Error);
        expect(err.type).toBe('connection-closed');
        expect(peer.destroyed).toBe(true);
        expect(c.peer).toBeNull();
        expect(c.isConnected).toBe(false);
        expect(c.isConnecting).toBe(false);
        c.destroy(); host.destroy();
    });

    it('C15: a peer error before the first ack rejects connect() with that error', async () => {
        const c = createClient();
        const p = c.connect('NOWHERE', 'alice', {}).catch(e => e);
        await advance(20);
        const err = await p;
        expect(err.type).toBe('peer-unavailable');
        c.destroy();
    });

    it('C15: destroy() while connect() is pending rejects it with type destroyed', async () => {
        const host = await startHost();
        const c = createClient({ peerOptions: { openDelayMs: 500 } });
        const p = c.connect('ROOM1', 'alice', {}).catch(e => e);
        await advance(10);
        c.destroy();
        const err = await p;
        expect(err.type).toBe('destroyed');
        expect(err.message).toBe('Client destroyed');
        host.destroy();
    });

    it('C15: connect() settles exactly once (a later terminal event does not reject a resolved promise)', async () => {
        const host = await startHost();
        const c = createClient();
        const settled = [];
        const p = c.connect('ROOM1', 'alice', {}).then(() => settled.push('resolved'), e => settled.push('rejected:' + e.type));
        await advance(50);
        await p;
        expect(settled).toEqual(['resolved']);
        host.rejectClient('alice', 'later');
        await advance(50);
        expect(c.terminalReason).toBe('rejected');
        expect(settled).toEqual(['resolved']);
        c.destroy(); host.destroy();
    });
});

describe('C15: await lobby.joinRoom() never hangs', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    it('C15: a host that never acks makes joinRoom reject on the connection timeout and leave no client', async () => {
        installSlopNetGlobal();
        const hostLobby = new SlopLobby({ roomPrefix: 'h-', storageKey: 'h-host' });
        const states = [];
        const clientLobby = new SlopLobby({ roomPrefix: 'h-', storageKey: 'h-client', onStateChange: (s, d) => states.push([s, d]) });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        hostLobby.host._handleData = () => {};

        const p = clientLobby.joinRoom(code, 'Bob').catch(e => e);
        await advance(11000);                        // production connectionTimeout is 10 s
        const err = await p;
        expect(err.type).toBe('connection-timeout');
        expect(clientLobby.client).toBeNull();
        expect(states).toEqual([['connecting', undefined]]);
        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C15: lobby.destroy() during joinRoom rejects with type destroyed and leaves nothing running', async () => {
        installSlopNetGlobal(MockPeer, { peerOptions: { openDelayMs: 500 } });
        const hostLobby = new SlopLobby({ roomPrefix: 'h2-', storageKey: 'h2-host' });
        const clientLobby = new SlopLobby({ roomPrefix: 'h2-', storageKey: 'h2-client' });
        const created = hostLobby.createRoom('Host');
        await advance(600);
        const code = await created;

        const p = clientLobby.joinRoom(code, 'Bob').catch(e => e);
        await advance(10);
        clientLobby.destroy();
        const err = await p;
        expect(err.type).toBe('destroyed');
        expect(clientLobby.client).toBeNull();
        hostLobby.destroy();
        // Let the mock's own deferred timers (the 500 ms 'open', the remote closes)
        // drain: nothing of the LIBRARY's may be left.
        await advance(600);
        expect(vi.getTimerCount()).toBe(0);
    });
});
