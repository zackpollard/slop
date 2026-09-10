/**
 * C6 / C19 — the room-closed protocol: PeerHost.close(), the grace window, and
 * SlopLobby.closeRoom().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import {
    SlopLobby, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    createClient, startHost, joinClient, recordEvents, advance,
} from './lib-harness.js';

const CLIENT_EVENTS = ['room-closed', 'disconnected', 'reconnecting', 'reconnect-failed', 'rejected', 'superseded'];

describe('C6/C19: PeerHost.close()', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('C6: close(reason) tells every client before closing them; they turn terminal and never reconnect; the promise resolves after destroy', async () => {
        const host = await startHost('ROOM1', { heartbeatInterval: 100, heartbeatTimeout: 300 });
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const b = await joinClient('ROOM1', 'bob', { name: 'Bob' });
        const hostLog = recordEvents(host, ['client-left', 'client-lost']);
        const aLog = recordEvents(a, CLIENT_EVENTS);
        const bLog = recordEvents(b, CLIENT_EVENTS);
        const rawA = [];
        a.connection.on('data', d => rawA.push(d.type));
        const destroyedFn = vi.fn();
        host.on('destroyed', destroyedFn);

        const p = host.close('Goodnight');
        expect(host._closing).toBe(true);
        expect(host._destroyed).toBe(false);
        expect(host._heartbeatTimer).toBeNull();

        await advance(20);
        expect(rawA).toEqual(['__slopnet_room_closed']);
        expect(aLog).toEqual([{ event: 'room-closed', args: ['Goodnight'] }]);
        expect(bLog).toEqual([{ event: 'room-closed', args: ['Goodnight'] }]);
        expect(a.isTerminal).toBe(true);
        expect(a.terminalReason).toBe('room-closed');
        expect(a.isConnected).toBe(false);
        expect(host._destroyed).toBe(false);          // inside the grace

        await advance(400);
        expect(host._destroyed).toBe(true);
        expect(destroyedFn).toHaveBeenCalledTimes(1);
        await p;

        await advance(5 * 60 * 1000);
        expect(aLog).toHaveLength(1);
        expect(bLog).toHaveLength(1);
        expect(hostLog).toEqual([]);
        expect(a.send({ type: 'x' })).toBe(false);

        a.destroy(); b.destroy();
    });

    it('C6: close() with no reason delivers null; a client inside its reconnect window is simply forgotten', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const b = await joinClient('ROOM1', 'bob', { name: 'Bob' }, { reconnectBackoffBase: 5000 });
        b.connection.close();                          // Bob is inside his window
        await advance(10);
        const aLog = recordEvents(a, CLIENT_EVENTS);
        const hostLog = recordEvents(host, ['client-left', 'client-lost']);

        const p = host.close();
        await advance(500);
        await p;
        expect(aLog).toEqual([{ event: 'room-closed', args: [null] }]);
        expect(hostLog).toEqual([]);
        expect(host._destroyed).toBe(true);
        expect(host._reconnectWindowTimers.size).toBe(0);
        a.destroy(); b.destroy();
    });

    it('C6/C19: close() is idempotent; destroy() during the grace destroys at once and stays idempotent', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });

        const p1 = host.close('x');
        const p2 = host.close('y');
        expect(p2).toBe(p1);
        await advance(10);                             // the goodbye has left

        host.destroy();                                // lobby.destroy() right after closeRoom()
        expect(host._destroyed).toBe(true);
        expect(host._closeTimer).toBeNull();
        await p1;
        expect(() => host.destroy()).not.toThrow();
        expect(host.close('z')).toBeInstanceOf(Promise);

        expect(a.terminalReason).toBe('room-closed');
        a.destroy();
    });

    it('C19: a join arriving during the grace is answered room_closed and flush-closed; the host waits for graceMs only', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const p = host.close('over', { graceMs: 1000 });
        await advance(10);

        const late = createClient();
        const lateLog = recordEvents(late, CLIENT_EVENTS.concat(['connected']));
        const lp = late.connect('ROOM1', 'carol', { name: 'Carol' }).catch(e => e);
        await advance(50);
        const err = await lp;

        expect(err).toBeInstanceOf(Error);
        expect(err.type).toBe('room-closed');
        expect(err.reason).toBe('over');
        expect(lateLog).toEqual([{ event: 'room-closed', args: ['over'] }]);
        expect(late.isTerminal).toBe(true);
        // Carol was never seated; Alice's record simply waits for destroy().
        expect(host.getAllClientIds()).toEqual(['alice']);

        expect(host._destroyed).toBe(false);
        await advance(950);
        expect(host._destroyed).toBe(true);
        await p;

        a.destroy(); late.destroy();
    });

    it('C6: destroy() alone says nothing — clients see a plain drop and reconnect (the old behaviour, kept)', async () => {
        const host = await startHost();
        const a = await joinClient('ROOM1', 'alice', { name: 'Alice' });
        const aLog = recordEvents(a, CLIENT_EVENTS);
        host.destroy();
        await advance(100);
        const events = aLog.map(e => e.event);
        expect(events[0]).toBe('disconnected');
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events.slice(1).every(e => e === 'reconnecting')).toBe(true);
        expect(a.isTerminal).toBe(false);
        a.destroy();
    });
});

describe('C6: SlopLobby.closeRoom()', () => {
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

    it('C6: closeRoom drives onStateChange(room-closed) on every client lobby and cleans up the host lobby', async () => {
        const hostStates = [];
        const hostLobby = new SlopLobby({
            roomPrefix: 'rc-', storageKey: 'rc-host',
            onStateChange: (s, d) => hostStates.push([s, d]),
        });
        const states = [];
        const clientLobby = new SlopLobby({
            roomPrefix: 'rc-', storageKey: 'rc-client',
            onStateChange: (s, d) => states.push([s, d]),
        });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        expect(env.store.get('rc-host-room-code')).toBe(code);
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        const hostObj = hostLobby.host;

        const closing = hostLobby.closeRoom('Host ended the game');
        await advance(20);
        // The specific state wrapped in the states every app already branches on:
        // 'room-closed' is new vocabulary, and an app that does not know it would
        // otherwise keep a fully painted, fully dead game on screen.
        expect(states.slice(-3)).toEqual([
            ['disconnected', undefined],
            ['room-closed', 'Host ended the game'],
            ['reconnect-failed', undefined],
        ]);
        expect(env.toasts).toContain('Host ended the game: Host ended the game');

        await advance(500);
        await closing;
        expect(hostObj._destroyed).toBe(true);
        expect(hostLobby.host).toBeNull();
        expect(hostLobby.roomCode).toBeNull();
        expect(hostLobby.players.size).toBe(0);
        expect(env.store.has('rc-host-room-code')).toBe(false);   // the remembered code is forgotten

        // The client never reconnects and cannot send. The single 'disconnected' is
        // the terminal report above (the link IS gone); no reconnection follows it,
        // and the "reconnecting" toast — the thing that would be a lie — never fires.
        await advance(5 * 60 * 1000);
        expect(states.filter(s => s[0] === 'disconnected')).toHaveLength(1);
        expect(states.filter(s => s[0] === 'reconnecting')).toEqual([]);
        expect(clientLobby.sendToHost({ type: 'x' })).toBe(false);
        expect(env.toasts.filter(t => t.startsWith('Disconnected'))).toEqual([]);

        // Calling destroy() afterwards is harmless.
        expect(() => hostLobby.destroy()).not.toThrow();
        clientLobby.destroy();
    });

    it('C6: closeRoom without a reason toasts the plain message; a client lobby calling closeRoom just destroys', async () => {
        const hostLobby = new SlopLobby({ roomPrefix: 'rc2-', storageKey: 'rc2-host' });
        const states = [];
        const clientLobby = new SlopLobby({ roomPrefix: 'rc2-', storageKey: 'rc2-client', onStateChange: (s, d) => states.push([s, d]) });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;

        const closing = hostLobby.closeRoom();
        await advance(500);
        await closing;
        expect(states.slice(-3)).toEqual([
            ['disconnected', undefined], ['room-closed', null], ['reconnect-failed', undefined],
        ]);
        expect(env.toasts).toContain('Host ended the game');

        await clientLobby.closeRoom();                  // not hosting: plain cleanup
        expect(clientLobby.client).toBeNull();
    });
});
