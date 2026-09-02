/**
 * Two regressions introduced by (or left behind after) the critical-bug fixes.
 * Both were found by an adversarial review of that work, and both are the kind
 * that only bite a real player on a real network.
 *
 * 1. FLUSH ORDER. The reconnect-window fix started queueing host->client
 *    messages for an absent player and flushing them on return. But the flush
 *    ran AFTER emit('client-rejoined'), and emit is synchronous — so the app,
 *    which pushes current state straight from its rejoin handler
 *    (texas-holdem:1360, cards-against-humanity:517-527), had its fresh state
 *    delivered first and then buried under the stale backlog. The returning
 *    player's last render was the OLDEST message in the queue.
 *
 * 2. THE PARKED SEAT. SlopNet learned to greet a post-window returner as
 *    'client-rejoined' rather than a stranger, so an app would not refuse them
 *    their own seat. SlopLobby then deleted the app's record on 'client-lost'
 *    and rebuilt it from wire metadata — `{ name }` — so the player came back
 *    seated with no seat id: hole cards hidden, action controls never built.
 *    The same failure, one layer later.
 *
 * The mock is untouched; both are bookkeeping and ordering, not transport.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { SlopLobby } = require('../../sloplobby/sloplobby.js');

const savedGlobals = {};

function installBrowserGlobals() {
    const store = new Map();
    savedGlobals.sessionStorage = globalThis.sessionStorage;
    savedGlobals.document = globalThis.document;
    globalThis.sessionStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
    };
    const makeEl = () => ({
        style: {}, className: '', textContent: '',
        classList: { add() {}, remove() {} },
        appendChild() {}, remove() {},
    });
    globalThis.document = {
        getElementById: () => null,
        createElement: makeEl,
        querySelectorAll: () => [],
        body: { appendChild() {} },
    };
}

function installSlopNetGlobal() {
    savedGlobals.SlopNet = globalThis.SlopNet;
    globalThis.SlopNet = {
        ...SlopNet,
        PeerHost: class extends SlopNet.PeerHost {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
        PeerClient: class extends SlopNet.PeerClient {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
    };
}

function restoreGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

const SEAT_ID = 'p-seat-1';

describe('a returning player lands on current state, in their own seat', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    it('delivers the backlog BEFORE the state the app pushes on rejoin', async () => {
        const host = new globalThis.SlopNet.PeerHost({ roomPrefix: 'ord-' });
        const started = host.start();
        await vi.advanceTimersByTimeAsync(20);
        const code = await started;

        const client = new globalThis.SlopNet.PeerClient({ roomPrefix: 'ord-' });
        const joined = client.connect(code, 'alice', { name: 'Alice' });
        await vi.advanceTimersByTimeAsync(50);
        await joined;

        // The app pushes current state the moment it hears the player is back —
        // this is what texas-holdem and CAH both do.
        host.on('client-rejoined', () => host.send('alice', { tag: 'FRESH' }));

        // Alice's phone drops. The host keeps pushing state at her.
        client.connection.close();
        await vi.advanceTimersByTimeAsync(200);
        for (let i = 1; i <= 5; i += 1) host.send('alice', { tag: `STALE${i}` });
        await vi.advanceTimersByTimeAsync(50);

        // She comes back inside the reconnect window.
        const back = new globalThis.SlopNet.PeerClient({ roomPrefix: 'ord-' });
        const backReceived = [];
        back.on('data', (d) => backReceived.push(d.tag));
        const rejoined = back.connect(code, 'alice', { name: 'Alice' });
        await vi.advanceTimersByTimeAsync(200);
        await rejoined;

        expect(
            backReceived,
            'The queued backlog must arrive before the state the app pushes from its ' +
            'rejoin handler, or the player\'s final render is the oldest stale message.',
        ).toContain('FRESH');
        expect(backReceived[backReceived.length - 1]).toBe('FRESH');

        host.destroy(); client.destroy(); back.destroy();
    });

    it('gives a player back their seat after the reconnect window expired', async () => {
        const seen = {};
        const lobby = new SlopLobby({
            roomPrefix: 'seat-',
            storageKey: 'seat-client-id',
            onHostData: () => {},
            // texas-holdem:1341-1348 — the seat is minted once, on join, and lives
            // only in the lobby's player record.
            onPlayerJoined: (clientId, metadata) => {
                lobby.players.set(clientId, { name: metadata.name, playerId: SEAT_ID });
            },
            onPlayerRejoined: (clientId) => {
                const entry = lobby.players.get(clientId);
                seen.onRejoin = entry ? { ...entry } : entry;
            },
            onPlayerLeft: () => {},
        });

        const created = lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(20);
        const code = await created;

        const client = new globalThis.SlopNet.PeerClient({ roomPrefix: 'seat-' });
        const joined = client.connect(code, 'bob', { name: 'Bob' });
        await vi.advanceTimersByTimeAsync(50);
        await joined;
        expect(lobby.players.get('bob').playerId).toBe(SEAT_ID);

        // Bob's tab is gone for good — destroyed, so nothing reconnects on his
        // behalf and the host's reconnect window is allowed to actually expire.
        client.destroy();
        await vi.advanceTimersByTimeAsync(200);
        await vi.advanceTimersByTimeAsync(120000 + 2000);
        expect(lobby.players.has('bob')).toBe(false);

        // He walks back in. SlopNet announces him as returning, not as a stranger.
        const back = new globalThis.SlopNet.PeerClient({ roomPrefix: 'seat-' });
        const returned = back.connect(code, 'bob', { name: 'Bob' });
        await vi.advanceTimersByTimeAsync(200);
        await returned;

        expect(
            seen.onRejoin,
            'The app record was rebuilt from wire metadata, so the seat id is gone: the ' +
            'player is seated but getStateForPlayer(undefined) hides their own cards and ' +
            'never builds their controls.',
        ).toEqual({ name: 'Bob', playerId: SEAT_ID });

        lobby.destroy(); back.destroy();
    });

    it('does not resurrect the record of a player who was deliberately kicked', async () => {
        const lobby = new SlopLobby({
            roomPrefix: 'kick-',
            storageKey: 'kick-client-id',
            onHostData: () => {},
            onPlayerJoined: (clientId, metadata) => {
                lobby.players.set(clientId, { name: metadata.name, playerId: SEAT_ID });
            },
            onPlayerRejoined: () => {},
            onPlayerLeft: () => {},
        });
        const created = lobby.createRoom('Host');
        await vi.advanceTimersByTimeAsync(20);
        const code = await created;

        const client = new globalThis.SlopNet.PeerClient({ roomPrefix: 'kick-' });
        const joined = client.connect(code, 'mallory', { name: 'Mallory' });
        await vi.advanceTimersByTimeAsync(50);
        await joined;

        lobby.removeClient('mallory');
        await vi.advanceTimersByTimeAsync(120000 + 2000);

        expect(lobby._pastPlayers.has('mallory')).toBe(false);
        lobby.destroy(); client.destroy();
    });
});
