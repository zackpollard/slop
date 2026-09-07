/**
 * REPRODUCING TEST — bug "peerjs-keepalive-throttled-nukes-whole-room"
 * (lib/slopnet/slopnet.js:237-242 and :225-229, reached into :485-501 and :528)
 *
 * These tests are EXPECTED TO FAIL against the current slopnet.js. They document
 * the bug; they do not hide it. Do not "fix" the tests — fix slopnet.js.
 *
 * ---------------------------------------------------------------------------
 * THE BUG
 * ---------------------------------------------------------------------------
 * PeerJS keeps its SIGNALLING websocket alive with a plain JS timer —
 * `_scheduleHeartbeat(){ this._wsPingTimer = setTimeout(this._sendHeartbeat, 5000) }`
 * (peerjs.js:3568-3582). A backgrounded tab has that timer throttled (Chrome) or
 * suspended outright (iOS Safari on screen-lock / app-switch), the 5s HEARTBEAT
 * frames stop, PeerServer's `alive_timeout` (60s default) expires and the SERVER
 * closes the socket. `socket.onclose` (peerjs.js:3552) makes Peer emit
 * `error{type:'network'}` (peerjs.js:4377) and then `disconnect()` -> 'disconnected'.
 *
 * PeerJS deliberately leaves every DataConnection ALONE here — its own doc comment
 * on Peer#disconnect says "Does not close any active connections" — and it ships
 * `peer.reconnect()` (peerjs.js:4616) for exactly this case. The WebRTC data
 * channels are handled by the native stack, not by JS timers, so they are still
 * carrying traffic. Nothing about the game has actually broken.
 *
 * slopnet treats it as a total failure instead:
 *   slopnet.js:238-242  peer.on('disconnected') -> _startReconnect()
 *   slopnet.js:225-229  peer.on('error')        -> _startReconnect()   (network too)
 *   slopnet.js:489-496  _startReconnect walks `this.clients` and, INLINE, sets
 *                       `client.disconnected = true` and emits 'client-left' for
 *                       EVERY player. It never calls _handleDisconnect, so the
 *                       reconnect-window timer block at :353-362 is never reached
 *                       and `_reconnectWindowTimers` stays empty.
 *   slopnet.js:347      the genuine `conn.on('close')` that arrives later is then
 *                       swallowed by `if (client.disconnected) return;`, so a
 *                       window timer can never be armed after the fact and
 *                       'client-lost' can never fire.
 *   slopnet.js:528      one backoff later _doReconnect -> _destroyPeer ->
 *                       peer.destroy(), whose _cleanup() closes all of those
 *                       still-healthy DataConnections. slopnet kills them; the
 *                       network never did.
 * `grep -n "peer.reconnect()" slopnet.js` -> zero hits. The one PeerJS API built
 * to survive a signalling-only outage is unused.
 *
 * Downstream: sloplobby.js:185-189 deletes the player from `lobby.players` on
 * 'client-left'; cards-against-humanity/index.html:529-539 then deletes their hand
 * and submissions and re-adds them at score 0; herd-mentality/index.html:944 drops
 * them into `disconnectedPlayers` and can advance the round without them. The host
 * glanced at a notification and the whole table lost its state.
 *
 * ---------------------------------------------------------------------------
 * WHY THE 101 EXISTING TESTS MISS IT
 * ---------------------------------------------------------------------------
 * `simulateDisconnect()` is only ever called on `host.peer` in two places:
 * peer-host.test.js:425/451, which has NO clients attached at all, and
 * reconnection.test.js:482/512, whose only meaningful assertion is wrapped in
 * `if (client.isConnected)` (reconnection.test.js:535-538) and so passes
 * vacuously. No test asserts that data channels survive a signalling-only loss,
 * and no test ever reads `_reconnectWindowTimers` after `_startReconnect`.
 *
 * ---------------------------------------------------------------------------
 * MOCK: what is stock, and the one thing added LOCALLY
 * ---------------------------------------------------------------------------
 * mock-peer.js is ADEQUATE for the core of this bug and is NOT modified:
 * `MockPeer.disconnect()` (mock-peer.js:248-254) emits 'disconnected' and does
 * NOT close `this._connections`, which is faithful to real PeerJS. `destroy()`
 * (mock-peer.js:256-269) does close them, also faithful.
 *
 * Where it is too kind is the ROUTE IN: it models no server-side `alive_timeout`
 * and never emits the `error{type:'network'}` that a real socket close raises
 * first, so the `error` branch at slopnet.js:225-229 — a second, independent door
 * into the same eviction — is unreachable from the stock mock. This file adds a
 * local subclass, `ThrottledSignallingPeer`, with one method that plays the real
 * sequence: network error, then 'disconnected', DataConnections untouched.
 * Everything else is stock MockPeer. mock-peer.js is untouched, so the 101
 * existing tests are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient } = SlopNet;

/**
 * A MockPeer that can play out a PeerServer `alive_timeout` expiry the way a
 * real backgrounded phone produces it.
 *
 * Real sequence (peerjs.js:3552 -> :4377 -> Peer#disconnect):
 *   1. server closes the websocket
 *   2. peer emits  error { type: 'network' }
 *   3. peer emits  'disconnected'
 *   4. every DataConnection stays OPEN — "Does not close any active connections"
 *
 * Step 4 is inherited unchanged from MockPeer.disconnect(), which already leaves
 * `this._connections` alone.
 */
class ThrottledSignallingPeer extends MockPeer {
    /**
     * The host tab was backgrounded, PeerJS's 5s keepalive setTimeout was
     * throttled/suspended, and PeerServer reaped the socket after 60s.
     */
    simulateKeepaliveTimeout() {
        setTimeout(() => {
            if (this.destroyed) return;
            const err = new Error('Lost connection to server.');
            err.type = 'network';
            this.emit('error', err);
            // ...and then Peer#disconnect(), which touches no DataConnection.
            this.disconnect();
        }, 0);
    }
}

const BASE_CONFIG = {
    roomPrefix: 'keepalive-',
    heartbeatInterval: 0,
    reconnectWindowMs: 60000,
    connectionTimeout: 3000,
    reconnectBackoffBase: 50,
    reconnectBackoffMultiplier: 1.5,
    reconnectBackoffMax: 500,
    _PeerClass: ThrottledSignallingPeer,
};

function createHost(overrides = {}) {
    return new PeerHost({ ...BASE_CONFIG, ...overrides });
}

function createClient(overrides = {}) {
    return new PeerClient({ ...BASE_CONFIG, ...overrides });
}

/**
 * Host in a room with two healthy players, exactly as any of the four consumer
 * apps has it mid-game.
 */
async function seatTwoPlayers() {
    const host = createHost();
    const hp = host.start('ROOM1');
    await vi.advanceTimersByTimeAsync(20);
    await hp;

    const alice = createClient();
    const ap = alice.connect('ROOM1', 'alice', { name: 'Alice' });
    await vi.advanceTimersByTimeAsync(50);
    await ap;

    const bob = createClient();
    const bp = bob.connect('ROOM1', 'bob', { name: 'Bob' });
    await vi.advanceTimersByTimeAsync(50);
    await bp;

    return { host, alice, bob };
}

describe('BUG: a throttled host loses only its signalling socket, and slopnet evicts the whole room', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('must not evict players when only the signalling socket dies (their data channels are still open)', async () => {
        const { host, alice, bob } = await seatTwoPlayers();

        // Sanity: a real, healthy table before the host backgrounds the tab.
        expect(host.getConnectedClientIds().sort()).toEqual(['alice', 'bob']);
        const aliceConn = host._findClientByClientId('alice').conn;
        const bobConn = host._findClientByClientId('bob').conn;
        expect(aliceConn.open).toBe(true);
        expect(bobConn.open).toBe(true);

        const evicted = [];
        host.on('client-left', (clientId) => {
            // Capture the state of the data channels AT THE MOMENT slopnet
            // decides the player is gone.
            evicted.push({
                clientId,
                aliceChannelOpen: aliceConn.open,
                bobChannelOpen: bobConn.open,
            });
        });

        // The host taps a notification / locks the screen for ~70s. PeerJS's
        // keepalive setTimeout is throttled, PeerServer's alive_timeout expires,
        // the server closes the websocket. No DataConnection is affected.
        host.peer.simulateKeepaliveTimeout();
        await vi.advanceTimersByTimeAsync(5);

        // Both WebRTC data channels are demonstrably still carrying traffic...
        expect(aliceConn.open).toBe(true);
        expect(bobConn.open).toBe(true);

        // ...so nobody has left the game. slopnet.js:489-496 says otherwise.
        expect(
            evicted,
            'slopnet emitted client-left for players whose data channels were still open — ' +
            'a signalling-socket loss says nothing about any DataConnection ' +
            '(slopnet.js:238-242 and :225-229 route into _startReconnect, which evicts everyone at :489-496)'
        ).toEqual([]);
        expect(host.getConnectedClientIds().sort()).toEqual(['alice', 'bob']);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('must not tear down healthy data channels itself when re-registering the host peer', async () => {
        const { host, alice, bob } = await seatTwoPlayers();

        const aliceConn = host._findClientByClientId('alice').conn;
        const bobConn = host._findClientByClientId('bob').conn;

        host.peer.simulateKeepaliveTimeout();
        await vi.advanceTimersByTimeAsync(5);

        // Still fine here — the damage is done one backoff later, when
        // _doReconnect (slopnet.js:527-528) calls _destroyPeer() -> peer.destroy(),
        // and PeerJS's _cleanup() closes every DataConnection it owns.
        expect(aliceConn.open).toBe(true);

        await vi.advanceTimersByTimeAsync(200);

        expect(
            { alice: aliceConn.open, bob: bobConn.open },
            'slopnet destroyed the host peer (slopnet.js:528) and with it two perfectly healthy ' +
            'WebRTC data channels; the network never dropped them. PeerJS ships peer.reconnect() ' +
            'for a signalling-only outage and slopnet never calls it (grep: zero hits)'
        ).toEqual({ alice: true, bob: true });

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('must arm a reconnect-window timer for every player it marks as left', async () => {
        const { host, alice, bob } = await seatTwoPlayers();

        const left = [];
        host.on('client-left', (clientId) => left.push(clientId));

        host.peer.simulateKeepaliveTimeout();
        await vi.advanceTimersByTimeAsync(5);

        // Whatever slopnet decided about these players, EVERY player it marked
        // down must have a reconnect-window timer armed — that is the only
        // machinery (slopnet.js:353-362) that can ever free the seat again.
        // _startReconnect bypasses _handleDisconnect entirely, so there are none.
        expect(
            host._reconnectWindowTimers.size,
            `slopnet marked ${left.length} player(s) as left (${left.join(', ')}) but armed ` +
            `${host._reconnectWindowTimers.size} reconnect-window timer(s): _startReconnect ` +
            'sets client.disconnected inline at slopnet.js:490-496 instead of calling _handleDisconnect'
        ).toBe(left.length);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('leaves a player who never comes back as a permanent zombie: client-lost never fires and the seat is never reclaimed', async () => {
        const { host, alice, bob } = await seatTwoPlayers();

        const lost = [];
        host.on('client-lost', (clientId) => lost.push(clientId));

        host.peer.simulateKeepaliveTimeout();
        await vi.advanceTimersByTimeAsync(5);

        // Alice's phone dies / she closes the tab during the outage: she is never
        // coming back. Her real conn.on('close') reaches _handleDisconnect, which
        // returns immediately at slopnet.js:347 because `disconnected` is already
        // true — so it cannot arm a window timer after the fact either.
        alice.destroy();
        await vi.advanceTimersByTimeAsync(20);

        // Let the host finish reconnecting and give Bob time to rejoin, then run
        // well past the full 60s reconnect window.
        await vi.advanceTimersByTimeAsync(130000);

        // Bob came back, so the control half of this works.
        expect(host.isClientConnected('bob')).toBe(true);

        expect(
            lost,
            'the reconnect window expired and client-lost never fired for alice: with no timer armed ' +
            'and the _handleDisconnect guard at slopnet.js:347 swallowing her real close event, ' +
            'she is unreachable from every code path that could remove her'
        ).toContain('alice');

        expect(
            host.getAllClientIds(),
            'alice is a permanent zombie in host.clients / getAllClientIds() / getDisconnectedClientIds(); ' +
            'no sweeper exists anywhere, so her seat is never reclaimed for the rest of the game'
        ).not.toContain('alice');

        bob.destroy();
        host.destroy();
    });
});
