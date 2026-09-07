/**
 * REPRODUCING TEST - bug "host-reconnect-silently-rerolls-room-code"
 *
 *   slopnet.js:216   if (err.type === 'unavailable-id' && resolve) { ...reroll... }
 *   slopnet.js:219-221  this.roomCode = generateRoomCode(...); this.peerId = prefix + roomCode;
 *   reached from slopnet.js:527-537  _doReconnect() -> _createPeer(() => this.emit('reconnected'), () => {})
 *
 * These tests are EXPECTED TO FAIL against the current slopnet.js. They document
 * the bug. Do not weaken them to make them green - fix slopnet.js.
 *
 * WHAT HAPPENS TO A REAL USER
 *   A host phone creates a room; sloplobby.js:199 does `this.roomCode = await
 *   host.start()` and the app paints e.g. FMURJ6 on the screen. The phone then
 *   loses its radio abruptly - screen lock dropping wifi, a wifi->4G handover, a
 *   lift, a tunnel. There is no TCP FIN, so PeerServer never learns the socket
 *   died and keeps `cah-FMURJ6` reserved until its own alive_timeout (~60s by
 *   default). slopnet's first retry lands at reconnectBackoffBase = 1000ms
 *   (slopnet.js:97), i.e. ~59s inside that hold, so the server answers
 *   ID "cah-FMURJ6" is taken -> peerjs `_abort('unavailable-id')`.
 *
 *   The guard at slopnet.js:216 was written for a code collision during the
 *   FIRST `start()`, and `resolve` is its only discriminator - but
 *   `_doReconnect()` passes two freshly-built arrow functions, so `resolve` is
 *   truthy on every reconnect too. slopnet.js:219-221 therefore mint a brand-new
 *   room code and peerId and register under those instead. `_started` cannot
 *   distinguish the two paths either: slopnet.js:184 sets it to true BEFORE
 *   `_createPeer` runs on the initial start.
 *
 *   Nobody ever learns. slopnet.js:207 emits 'ready' with the new code, but
 *   grepping lib/ and all four consumer apps for 'ready' finds only slopnet's own
 *   doc comment (:142) and that emit - zero subscribers. sloplobby.js:199 captured
 *   the code once and each app copied it into a local and painted it once
 *   (texas-holdem:1386/1389, herd-mentality:955/1029, flip-7:1198/1201). So the
 *   code on the host's screen is dead, every already-connected player is dialling
 *   a peer id that no longer exists, anyone typing the displayed code gets
 *   peer-unavailable - and the host sees a green 'reconnected' and no error.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXTENDS THE MOCK (locally - mock-peer.js is NOT modified)
 * ---------------------------------------------------------------------------
 * `unavailable-id` is structurally unreachable on the reconnect path with the
 * stock mock. MockPeer.destroy() (mock-peer.js:256-269) and MockPeer.disconnect()
 * (mock-peer.js:248-254) both `registry.delete(this.id)` SYNCHRONOUSLY, so the
 * `_destroyPeer()` at slopnet.js:529 always frees the id and the re-registration
 * immediately after it always succeeds. The mock can only raise `unavailable-id`
 * from its constructor (mock-peer.js:169-175) - a genuine duplicate at initial
 * start, which is exactly what peer-host.test.js:75 covers.
 *
 * A dead radio cannot do that: `peer.destroy()` has no live socket to tell the
 * server about. So this file adds ONE behaviour, as a local subclass:
 * `RadioLossPeer` re-asserts the server-side reservation that MockPeer's teardown
 * removed, and releases it `_serverHoldMs` later (the server's alive_timeout).
 * The reservation belongs to whoever actually holds it, so a peer that was itself
 * answered ID-TAKEN cannot evict the true holder when slopnet destroys it at
 * :218. Registration, 'open', the ID-TAKEN error and data channels are all stock
 * MockPeer. mock-peer.js is untouched, so the existing tests are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, registry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient } = SlopNet;

/**
 * A MockPeer whose id outlives the peer, the way a PeerServer reservation
 * outlives a websocket that died without a FIN.
 *
 * options._serverHoldMs:
 *   0 / undefined -> the server has not reaped the id at all yet (held for the
 *                    whole test)
 *   N             -> alive_timeout: the id is released N ms after the peer died
 */
class RadioLossPeer extends MockPeer {
    constructor(id, options) {
        super(id, options);
        this._serverHoldMs = (options && options._serverHoldMs) || 0;
    }

    _holdServerSideReservation(teardown) {
        const heldId = this.id;
        const holder = registry.get(heldId);
        teardown(); // MockPeer deletes the reservation...
        if (!holder) return; // ...unless the server had already reaped it.
        registry.set(heldId, holder); // ...but the real server never heard.
        if (holder === this && this._serverHoldMs > 0) {
            setTimeout(() => {
                if (registry.get(heldId) === this) registry.delete(heldId);
            }, this._serverHoldMs);
        }
    }

    disconnect() {
        this._holdServerSideReservation(() => super.disconnect());
    }

    destroy() {
        if (this.destroyed) return;
        this._holdServerSideReservation(() => super.destroy());
    }
}

const BASE_CONFIG = {
    roomPrefix: 'cah-',
    heartbeatInterval: 0,
    reconnectWindowMs: 60000,
    connectionTimeout: 3000,
    reconnectBackoffBase: 50,
    reconnectBackoffMultiplier: 1.5,
    reconnectBackoffMax: 500,
    _PeerClass: RadioLossPeer,
};

function createHost(overrides = {}) {
    const { peerOptions, ...rest } = overrides;
    return new PeerHost({
        ...BASE_CONFIG,
        peerOptions: { debug: 0, ...(peerOptions || {}) },
        ...rest,
    });
}

function createClient(overrides = {}) {
    const { peerOptions, ...rest } = overrides;
    return new PeerClient({
        ...BASE_CONFIG,
        peerOptions: { debug: 0, ...(peerOptions || {}) },
        ...rest,
    });
}

/** Start a host and return the code the app would have painted on screen. */
async function startRoom(host) {
    const started = host.start();
    await vi.advanceTimersByTimeAsync(20);
    return started; // resolves to the room code
}

describe('REPRO: host reconnect silently re-rolls the room code', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sanity: the fake really does hold the id after an unclean radio loss', async () => {
        // Not a bug assertion. This proves the local extension behaves as a real
        // PeerServer does, so the failures below cannot be blamed on the fake.
        const host = new RadioLossPeer('cah-HELD01', { _serverHoldMs: 400 });
        await vi.advanceTimersByTimeAsync(10);
        expect(registry.has('cah-HELD01')).toBe(true);

        host.destroy(); // dead phone: destroy() reaches no server
        expect(registry.has('cah-HELD01')).toBe(true);

        const retry = new RadioLossPeer('cah-HELD01', { _serverHoldMs: 400 });
        const errorTypes = [];
        retry.on('error', (e) => errorTypes.push(e.type));
        await vi.advanceTimersByTimeAsync(10);
        expect(errorTypes).toEqual(['unavailable-id']);

        // The loser of the race must not evict the true reservation...
        retry.destroy();
        expect(registry.has('cah-HELD01')).toBe(true);

        // ...and alive_timeout eventually frees it.
        await vi.advanceTimersByTimeAsync(500);
        expect(registry.has('cah-HELD01')).toBe(false);
    });

    it('BUG: a reconnect that hits ID-TAKEN re-rolls the room code the app is showing', async () => {
        // Server still holding the id when the host retries - the ordinary case:
        // 1000ms retry vs a ~60s alive_timeout.
        const host = createHost({ peerOptions: { _serverHoldMs: 30000 } });

        // The app captures the code exactly once (sloplobby.js:199) and paints it.
        const codeOnScreen = await startRoom(host);
        expect(host.roomCode).toBe(codeOnScreen);

        const readyCodes = [];
        host.on('ready', (code) => readyCodes.push(code));
        const codeWhenDeclaredHealthy = [];
        host.on('reconnected', () => codeWhenDeclaredHealthy.push(host.roomCode));

        // Radio dies. The socket goes without a FIN: the peer notices, the server
        // does not.
        host.peer.disconnect();

        // Let the whole reconnect ladder run.
        await vi.advanceTimersByTimeAsync(5000);

        // The room's identity is what the host printed on its screen and what
        // every player was told. Re-registering is fine; changing identity is not.
        expect(host.roomCode).toBe(codeOnScreen);
        expect(host.peerId).toBe('cah-' + codeOnScreen);

        // Every re-announcement must carry that same code (and today nothing even
        // listens to 'ready', so a changed code cannot reach any UI).
        expect(readyCodes.filter((c) => c !== codeOnScreen)).toEqual([]);

        // The host must never report itself healthy under a code nobody has seen.
        expect(codeWhenDeclaredHealthy.filter((c) => c !== codeOnScreen)).toEqual([]);

        host.destroy();
    });

    it('BUG: both seated players are orphaned - the host is live under a code nobody was told', async () => {
        // alive_timeout (300ms) is far shorter than the clients' retry ladder, so
        // a host that simply retried the SAME id would reclaim the room and both
        // players would walk back in. Instead the host takes a new identity on its
        // very first retry (50ms) and abandons them.
        const host = createHost({ peerOptions: { _serverHoldMs: 300 } });
        const codeOnScreen = await startRoom(host);

        const alice = createClient();
        const bob = createClient();
        const ap = alice.connect(codeOnScreen, 'alice', { name: 'Alice' });
        const bp = bob.connect(codeOnScreen, 'bob', { name: 'Bob' });
        await vi.advanceTimersByTimeAsync(50);
        await ap;
        await bp;
        expect(host.isClientConnected('alice')).toBe(true);
        expect(host.isClientConnected('bob')).toBe(true);

        const hostSawReconnected = vi.fn();
        host.on('reconnected', hostSawReconnected);

        // Host phone goes into a lift.
        host.peer.disconnect();

        // Give every ladder far longer than the 300ms server hold: the host's
        // reconnect, both clients' reconnects, and then some.
        await vi.advanceTimersByTimeAsync(30000);

        // The host believes it is fine.
        expect(hostSawReconnected).toHaveBeenCalled();

        // Both players are dialling the only code they, or the host's screen,
        // have ever been given.
        expect(alice.roomCode).toBe(codeOnScreen);
        expect(bob.roomCode).toBe(codeOnScreen);

        // ...so they must be back at the table.
        expect(alice.isConnected).toBe(true);
        expect(bob.isConnected).toBe(true);
        expect(host.isClientConnected('alice')).toBe(true);
        expect(host.isClientConnected('bob')).toBe(true);

        alice.destroy();
        bob.destroy();
        host.destroy();
    });

    it('BUG: a latecomer typing the code from the host\'s screen cannot join after the host reconnects', async () => {
        const host = createHost({ peerOptions: { _serverHoldMs: 300 } });
        const codeOnScreen = await startRoom(host);

        host.peer.disconnect();
        await vi.advanceTimersByTimeAsync(30000);

        // Someone walks up to the host, reads the code off the phone and types it.
        const carol = createClient();
        const outcome = carol
            .connect(codeOnScreen, 'carol', { name: 'Carol' })
            .then(() => 'joined', (err) => err.type || err.message);
        await vi.advanceTimersByTimeAsync(10000);

        expect(await outcome).toBe('joined');
        expect(host.isClientConnected('carol')).toBe(true);

        carol.destroy();
        host.destroy();
    });

    it('GUARD (passes today, must keep passing after the fix): a collision on the FIRST start still re-rolls', async () => {
        // The fix must not simply delete the regeneration branch, and must not
        // gate on `this._started` - slopnet.js:184 sets that true before
        // _createPeer runs, so it is already true here. Same coverage as
        // peer-host.test.js:75, restated so a naive fix trips this file too.
        const squatter = createHost();
        const takenCode = await startRoom(squatter);

        const newcomer = createHost();
        const started = newcomer.start(takenCode);
        await vi.advanceTimersByTimeAsync(50);
        const gotCode = await started;

        expect(gotCode).not.toBe(takenCode);
        expect(newcomer.roomCode).toBe(gotCode);
        expect(newcomer.peerId).toBe('cah-' + gotCode);

        newcomer.destroy();
        squatter.destroy();
    });
});
