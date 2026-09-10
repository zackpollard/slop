/**
 * C17 / C18 — sloplobby helpers: getClientId and the token helpers survive a
 * sessionStorage that throws; esc() escapes quotes.
 *
 * The throwing-storage test flips a module-level "storage unreliable" flag inside
 * sloplobby.js for the rest of this file's module instance, so it runs LAST and
 * nothing after it depends on a clean store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetRegistry } from './mock-peer.js';
import {
    SlopLobby, SlopLobbyModule, installBrowserGlobals, installSlopNetGlobal, restoreGlobals,
    recordEvents, advance,
} from './lib-harness.js';

const { esc, getClientId } = SlopLobbyModule;

describe('C18: esc()', () => {
    it('C18: escapes & < > " and \' so a name is safe in a text node and inside a quoted attribute', () => {
        expect(esc(`O'Brien <b>"x"</b>`)).toBe('O&#39;Brien &lt;b&gt;&quot;x&quot;&lt;/b&gt;');
        expect(esc('a & b')).toBe('a &amp; b');
        expect(esc('plain')).toBe('plain');
    });

    it('C18: tolerates non-strings the way textContent did', () => {
        expect(esc(null)).toBe('');
        expect(esc(undefined)).toBe('');
        expect(esc(42)).toBe('42');
        expect(esc('')).toBe('');
    });

    it('C18: does not need a document', () => {
        const saved = globalThis.document;
        delete globalThis.document;
        try {
            expect(esc('<i>')).toBe('&lt;i&gt;');
        } finally {
            if (saved !== undefined) globalThis.document = saved;
        }
    });
});

describe('C17: storage robustness', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreGlobals();
    });

    it('C17: with a working store getClientId is stable across calls and per store', () => {
        const env = installBrowserGlobals();
        const id = getClientId('k');
        expect(id).toMatch(/^p\d+/);
        expect(getClientId('k')).toBe(id);
        expect(env.store.get('k')).toBe(id);
        env.useStore(new Map());                      // another tab
        expect(getClientId('k')).not.toBe(id);
    });

    it('C17: a sessionStorage that throws does not stop joinRoom (and the id is stable for the page)', async () => {
        installBrowserGlobals({ throwingStorage: true });
        installSlopNetGlobal();
        const hostLobby = new SlopLobby({ roomPrefix: 'st-', storageKey: 'st-host' });
        const states = [];
        const clientLobby = new SlopLobby({ roomPrefix: 'st-', storageKey: 'st-client', onStateChange: (s, d) => states.push([s, d]) });

        const created = hostLobby.createRoom('Host');   // loadRoomCode / saveRoomCode swallow the throw
        await advance(20);
        const code = await created;
        expect(code).toBeTruthy();

        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        expect(states.at(-1)).toEqual(['connected', undefined]);
        expect(clientLobby.clientId).toMatch(/^p\d+/);
        expect(hostLobby.getConnectedClientIds()).toEqual([clientLobby.clientId]);
        expect(typeof clientLobby.client.token).toBe('string');   // saveToken swallowed its throw

        // The same page keeps the same identity even though nothing could be stored.
        expect(getClientId('st-client')).toBe(clientLobby.clientId);
        hostLobby.destroy(); clientLobby.destroy();
    });

    // Round-2 review: the fallback was WRITE-only. The commonest broken storage is
    // not one that throws on everything — it is Safari's private mode and any
    // quota-exceeded tab, where getItem works and setItem throws. There the read
    // succeeded and handed back the null the write had just failed to store, so the
    // memory copy was never consulted: getClientId minted a new identity on every
    // call, loadToken always missed, and a reloaded HOST came back as a new room.
    it('C17: a store whose WRITES throw still keeps the identity, the token and the room code', async () => {
        const env = installBrowserGlobals();
        const backing = env.store;
        globalThis.sessionStorage = {
            getItem: (k) => (backing.has(k) ? backing.get(k) : null),
            setItem: () => { throw new Error('QuotaExceededError'); },
            removeItem: (k) => backing.delete(k),
        };
        installSlopNetGlobal();

        const id = getClientId('q-client');
        expect(getClientId('q-client'), 'two joins in one page are the same player').toBe(id);
        expect(backing.size, 'and nothing actually reached the store').toBe(0);

        const hostLobby = new SlopLobby({ roomPrefix: 'q-', storageKey: 'q-host' });
        const created = hostLobby.createRoom('Host');
        await advance(20);
        const code = await created;

        const clientLobby = new SlopLobby({ roomPrefix: 'q-', storageKey: 'q-client' });
        const joined = clientLobby.joinRoom(code, 'Bob');
        await advance(50);
        await joined;
        const token = clientLobby.client.token;
        expect(clientLobby.clientId).toBe(id);

        // The tab is discarded and restored: a fresh lobby object, same page, so the
        // in-memory copies are all it has — and they are enough to rejoin its seat.
        const hostLog = recordEvents(hostLobby.host, ['client-joined', 'client-rejoined']);
        clientLobby.destroy();
        await advance(20);
        const again = new SlopLobby({ roomPrefix: 'q-', storageKey: 'q-client' });
        const j2 = again.joinRoom(code, 'Bob');
        await advance(50);
        await j2;

        expect(again.clientId).toBe(id);
        expect(again.client.token).toBe(token);
        expect(hostLog.map(e => e.event)).toEqual(['client-rejoined']);

        // And a HOST tab the browser discarded and restored (its object is gone;
        // nothing called lobby.destroy(), which is the one thing that forgets a room
        // on purpose) comes back as the same room rather than stranding every player
        // holding the old code.
        hostLobby.host.destroy();
        hostLobby.host = null;
        await advance(20);
        const hostAgain = new SlopLobby({ roomPrefix: 'q-', storageKey: 'q-host' });
        const recreated = hostAgain.createRoom('Host');
        await advance(20);
        expect(await recreated).toBe(code);

        hostAgain.destroy(); hostLobby.destroy(); again.destroy();
    });
});
