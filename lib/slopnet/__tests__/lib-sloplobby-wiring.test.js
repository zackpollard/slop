/**
 * C10 / C23 — SlopLobby wiring: onStateChange states and details, boolean send
 * results, cleanup on a failed join, the visibilitychange listener, and the
 * 'connected' vs 'reconnected' rule after a host restart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry, registry } from './mock-peer.js';
import { SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals, advance } from './lib-harness.js';

describe('C10: SlopLobby wiring', () => {
    let env;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        env = installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    async function hostAndClient(extraHostOpts = {}, extraClientOpts = {}) {
        const hostStates = [];
        const hostLobby = new SlopLobby({
            roomPrefix: 'w-', storageKey: 'w-host',
            onStateChange: (s, d) => hostStates.push([s, d]),
            ...extraHostOpts,
        });
        const states = [];
        const msgs = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'w-', storageKey: 'w-client',
            onClientData: d => msgs.push(d),
            onStateChange: (s, d) => states.push([s, d]),
            ...extraClientOpts,
        });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        return { hostLobby, clientLobby, hostStates, states, msgs, code };
    }

    it('C10: reconnecting reaches onStateChange with { attempt, max }; reconnected carries { fresh: false } after a plain drop', async () => {
        const { hostLobby, clientLobby, states } = await hostAndClient();
        expect(states).toEqual([['connecting', undefined], ['connected', undefined]]);

        clientLobby.client.connection.close();
        await advance(10);
        expect(states.slice(2)).toEqual([['disconnected', undefined], ['reconnecting', { attempt: 1, max: 20 }]]);
        expect(env.toasts).toContain('Disconnected — reconnecting...');

        await advance(1500);
        expect(states.at(-1)).toEqual(['reconnected', { fresh: false }]);
        expect(env.toasts).toContain('Reconnected!');
        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C10: sendToHost returns true when connected, false when queued, false with no client', async () => {
        const { hostLobby, clientLobby } = await hostAndClient();
        expect(clientLobby.sendToHost({ type: 'a' })).toBe(true);
        clientLobby.client.connection.close();
        await advance(10);
        expect(clientLobby.sendToHost({ type: 'b' })).toBe(false);
        expect(clientLobby.client.queueSize).toBe(1);
        clientLobby.destroy();
        expect(clientLobby.sendToHost({ type: 'c' })).toBe(false);
        hostLobby.destroy();
    });

    it('C10: send(clientId, data) returns the host\'s boolean', async () => {
        const { hostLobby, clientLobby } = await hostAndClient();
        const id = clientLobby.clientId;
        expect(hostLobby.send(id, { type: 'a' })).toBe(true);
        expect(hostLobby.send('nobody', { type: 'a' })).toBe(false);
        clientLobby.client.connection.close();
        await advance(10);
        expect(hostLobby.send(id, { type: 'b' })).toBe(false);   // queued for the held seat
        expect(clientLobby.send(id, { type: 'c' })).toBe(false); // not hosting
        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C10: a failed joinRoom leaves lobby.client null and rethrows', async () => {
        const states = [];
        const lobby = new SlopLobby({ roomPrefix: 'w-', storageKey: 'w-client', onStateChange: (s, d) => states.push([s, d]) });
        const p = lobby.joinRoom('NOWHERE', 'Bob').catch(e => e);
        await advance(50);
        const err = await p;
        expect(err).toBeInstanceOf(Error);
        expect(err.type).toBe('peer-unavailable');
        expect(lobby.client).toBeNull();
        expect(states).toEqual([['connecting', undefined]]);
        expect(vi.getTimerCount()).toBe(0);
        lobby.destroy();
    });

    it('C10: visibilitychange → client.resume() and host.resume(); the listener is removed on destroy', async () => {
        const { hostLobby, clientLobby } = await hostAndClient();
        const doc = env.document;
        expect(doc._listenerCount('visibilitychange')).toBe(2);
        const cSpy = vi.spyOn(clientLobby.client, 'resume');
        const hSpy = vi.spyOn(hostLobby.host, 'resume');

        doc.visibilityState = 'hidden';
        doc._dispatch('visibilitychange');
        expect(cSpy).not.toHaveBeenCalled();
        expect(hSpy).not.toHaveBeenCalled();

        doc.visibilityState = 'visible';
        doc._dispatch('visibilitychange');
        expect(cSpy).toHaveBeenCalledTimes(1);
        expect(hSpy).toHaveBeenCalledTimes(1);

        clientLobby.destroy();
        expect(doc._listenerCount('visibilitychange')).toBe(1);
        hostLobby.destroy();
        expect(doc._listenerCount('visibilitychange')).toBe(0);
        doc._dispatch('visibilitychange');
        expect(cSpy).toHaveBeenCalledTimes(1);
    });

    it('C10: the visibility hook really reconnects a backgrounded client on wake', async () => {
        const { hostLobby, clientLobby } = await hostAndClient();
        clientLobby.client.connection.close();
        await advance(10);
        expect(clientLobby.client.isConnected).toBe(false);   // rung 1 is 1000 ms away
        env.document._dispatch('visibilitychange');
        await advance(50);
        expect(clientLobby.client.isConnected).toBe(true);
        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C10: without document.addEventListener nothing is registered and nothing throws', async () => {
        restoreGlobals();
        env = installBrowserGlobals({ withVisibility: false });
        installSlopNetGlobal();
        const { hostLobby, clientLobby } = await hostAndClient();
        expect(hostLobby._onVisibility).toBeNull();
        expect(clientLobby._onVisibility).toBeNull();
        expect(() => { hostLobby.destroy(); clientLobby.destroy(); }).not.toThrow();
    });

    it('C10: the host\'s own signalling state reaches onStateChange', async () => {
        const { hostLobby, clientLobby, hostStates } = await hostAndClient();
        hostLobby.host.peer.simulateDisconnect();
        await advance(10);
        expect(hostStates).toEqual([['reconnecting', { attempt: 1, max: 20 }]]);
        await advance(1100);
        expect(hostStates.at(-1)).toEqual(['reconnected', undefined]);
        hostLobby.destroy(); clientLobby.destroy();
    });

    it('C23: after a host restart the client hears reconnected with fresh: true, plus a toast — never a stuck disconnected', async () => {
        const { hostLobby, clientLobby, states, code } = await hostAndClient();
        hostLobby.destroy();
        await advance(20);
        expect(states.at(-1)[0]).toBe('reconnecting');

        const hostLobby2 = new SlopLobby({ roomPrefix: 'w-', storageKey: 'w-host' });
        const c2 = hostLobby2.createRoom('Host', code);
        await advance(20);
        await c2;
        await advance(3000);

        expect(clientLobby.client.isConnected).toBe(true);
        expect(states.at(-1)).toEqual(['reconnected', { fresh: true }]);
        expect(env.toasts).toContain('Reconnected!');
        expect(hostLobby2.players.has(clientLobby.clientId)).toBe(true);
        hostLobby2.destroy(); clientLobby.destroy();
    });

    it('C10: a duplicate tab supersedes the first, which toasts and reports superseded', async () => {
        const { hostLobby, clientLobby, states } = await hostAndClient();
        // Same tab duplicated: same store, so same clientId and token.
        const dup = new SlopLobby({ roomPrefix: 'w-', storageKey: 'w-client' });
        const j = dup.joinRoom(hostLobby.roomCode, 'Bob');
        await advance(50);
        await j;
        // The specific state wrapped in the vocabulary an app that has never heard of
        // it does act on — otherwise the losing tab keeps a live-looking game nobody
        // can play (flip-7 only ever CREATES its banner on 'disconnected').
        expect(states.slice(-3)).toEqual([
            ['disconnected', undefined],
            ['superseded', undefined],
            ['reconnect-failed', undefined],
        ]);
        expect(env.toasts).toContain('This game is open in another tab');
        expect(clientLobby.client.isTerminal).toBe(true);
        expect(dup.client.isConnected).toBe(true);
        expect(hostLobby.getConnectedClientIds()).toEqual([clientLobby.clientId]);
        await advance(60000);
        // Nothing further: the one 'disconnected' above is the terminal report, not a
        // reconnection, and no toast claimed otherwise.
        expect(states.filter(s => s[0] === 'disconnected')).toHaveLength(1);
        expect(states.filter(s => s[0] === 'reconnecting' || s[0] === 'reconnected')).toEqual([]);
        expect(env.toasts.filter(t => t.startsWith('Disconnected'))).toEqual([]);
        hostLobby.destroy(); clientLobby.destroy(); dup.destroy();
    });

    // Round-2 review: PeerHost.destroy() clears its own _pastClients (C21); the lobby
    // mirror was missed, so a reused lobby object could restore a seat from a game that
    // was over.
    it('C10: destroy() clears the parked player records as well as the live ones', async () => {
        const { hostLobby, clientLobby } = await hostAndClient();
        const id = clientLobby.clientId;
        clientLobby.destroy();
        await advance(120000 + 100);              // the seat is released and parked
        expect(hostLobby._pastPlayers.has(id)).toBe(true);
        expect(hostLobby.players.size).toBe(0);

        hostLobby.destroy();
        expect(hostLobby._pastPlayers.size).toBe(0);
        expect(hostLobby.players.size).toBe(0);
    });

    // Round-2 review: joinRoom retires the client it is holding before wiring a new
    // one; createRoom had no equivalent, so a double-tapped Host button left a second
    // live PeerHost registered under a second code, carrying every one of this lobby's
    // listeners — and destroy() could only clean up the one the lobby still pointed at.
    it('C10: a double-tapped createRoom makes ONE room, and its players are reachable', async () => {
        const joined = [];
        const codes = [];
        const lobby = new SlopLobby({
            roomPrefix: 'w2-', storageKey: 'w2-host',
            onPlayerJoined: (id) => joined.push(id),
            onRoomCode: (code, changed) => codes.push([code, changed]),
        });

        const a = lobby.createRoom('Host').catch(e => e);
        const b = lobby.createRoom('Host').catch(e => e);
        await advance(50);
        const first = await a;
        expect(first, 'the second tap does not open a second room').toBe(await b);
        expect(typeof first).toBe('string');

        const bob = new globalThis.SlopNet.PeerClient({ roomPrefix: 'w2-' });
        const bp = bob.connect(first, 'bob', { name: 'Bob' });
        await advance(50);
        await bp;
        expect(joined).toEqual(['bob']);
        expect(lobby.send('bob', { hi: 1 }), 'and what the app sends him arrives').toBe(true);

        // No orphan left registered to rename the room later.
        expect([...registry.keys()].filter(k => k.startsWith('w2-')).length).toBe(1);
        lobby.destroy();
        await advance(50);
        expect(bob.isConnected, 'ending the game disconnects everyone').toBe(false);
        expect(codes.filter(c => c[1] === true)).toEqual([]);
        bob.destroy();
    });

    it('C10: createRoom on a lobby that is already hosting retires the old host first', async () => {
        const lobby = new SlopLobby({ roomPrefix: 'w3-', storageKey: 'w3-host' });
        const created = lobby.createRoom('Host', 'FIRST');
        await advance(30);
        await created;
        const firstHost = lobby.host;

        const again = lobby.createRoom('Host', 'SECOND');
        await advance(30);
        expect(await again).toBe('SECOND');
        expect(firstHost._destroyed, 'the first host is not left running').toBe(true);
        expect(registry.has('w3-FIRST')).toBe(false);
        lobby.destroy();
    });

    it('C10: a failed joinRoom leaves no visibilitychange listener behind', async () => {
        for (let i = 0; i < 3; i++) {
            const lobby = new SlopLobby({ roomPrefix: 'w4-', storageKey: 'w4-c' });
            lobby.joinRoom('NOPE' + i, 'Bob').catch(() => {});   // herd never destroys it
            await advance(50);
        }
        expect(
            env.document._listenerCount('visibilitychange'),
            'createRoom\'s failure path has always unregistered its own'
        ).toBe(0);
    });

    it('C10: an app that defines no onPlayerLost hears onPlayerLeft twice (final=false, then final=true)', async () => {
        const left = [];
        const { hostLobby, clientLobby } = await hostAndClient({
            onPlayerLeft: (id, meta, final) => left.push([meta && meta.name, final]),
        });
        clientLobby.destroy();
        await advance(20);
        expect(left).toEqual([['Bob', false]]);
        await advance(120000 + 100);
        expect(left).toEqual([['Bob', false], ['Bob', true]]);
        hostLobby.destroy();
    });
});
