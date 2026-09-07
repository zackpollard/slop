/**
 * REPRODUCING TEST — bug "host-reconnect-silently-changes-room-code"
 * (lib/slopnet/slopnet.js:215-222, reached from :525-539 via :238-242)
 *
 * These tests are EXPECTED TO FAIL against the current slopnet.js. They document
 * the bug; they do not hide it. Do not "fix" the test — fix slopnet.js.
 *
 * THE BUG
 *   `_doReconnect()` (slopnet.js:527-538) calls
 *       this._createPeer(() => this.emit('reconnected'), () => {})
 *   — two freshly-constructed arrow functions, so the closure variable `resolve`
 *   inside `_createPeer` is TRUTHY on every reconnect, exactly as it is during
 *   the initial `start()`. The guard at slopnet.js:216
 *       if (err.type === 'unavailable-id' && resolve)
 *   is therefore satisfied on the reconnect path too, despite the comment on
 *   :217 claiming it means "Room code collision during initial start". Lines
 *   219-221 then generate a NEW room code and a NEW peerId and re-create the
 *   peer. slopnet.js:207 emits a second `ready` with the new code — and nothing
 *   subscribes to `ready`: sloplobby.js:199 captures the code exactly once
 *   (`this.roomCode = await host.start()`), and grepping the four consumer apps
 *   for `on('ready'` returns zero hits. So the host serves a code that neither
 *   its own screen nor any player has ever seen, while emitting `reconnected`.
 *
 * ---------------------------------------------------------------------------
 * WHY mock-peer.js IS TOO FORGIVING (so this file extends it, locally)
 * ---------------------------------------------------------------------------
 * `unavailable-id` is UNREACHABLE on the reconnect path with the stock mock:
 * MockPeer.disconnect() (mock-peer.js:248-254) and MockPeer.destroy()
 * (mock-peer.js:256-269) both do `registry.delete(this.id)` SYNCHRONOUSLY, so
 * `_destroyPeer()` at slopnet.js:529 always frees the id and the immediately
 * following re-registration always succeeds. The mock only ever raises
 * `unavailable-id` from its constructor (mock-peer.js:169-175), i.e. a genuine
 * duplicate at initial `start()` — which is what peer-host.test.js:75 covers.
 *
 * A real phone cannot do that. When the radio drops (lift, tunnel, WiFi->5G
 * handover — the repo's stated target environment) the signalling websocket dies
 * without a FIN. The host's `peer.destroy()` has no live socket to tell the
 * server about, so PeerServer keeps `slop-<prefix><CODE>` reserved until its
 * alive_timeout (~60s), and a brand-new `Peer` with a brand-new token asking for
 * that id is answered ID-TAKEN -> peerjs `_abort('unavailable-id')`. The first
 * retry fires at `reconnectBackoffBase` (1000ms in production, slopnet.js:97) —
 * roughly 60x inside that hold window.
 *
 * So this file adds ONE behaviour on top of mock-peer.js, as a local subclass:
 * `StickyIdPeer` overrides disconnect()/destroy() to put the id BACK into the
 * shared registry after the parent removes it, i.e. the server-side reservation
 * outlives the peer, and releases it after `_idHoldMs` (injected through
 * `config.peerOptions`, which slopnet forwards to the Peer constructor at
 * slopnet.js:200). Everything else — registration, 'open', the ID-collision
 * error, data connections — is stock MockPeer. mock-peer.js itself is NOT
 * modified, so the 101 existing tests are untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, registry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient } = SlopNet;

/**
 * A MockPeer whose id survives its own death, the way a PeerServer reservation
 * survives a websocket that died without a FIN.
 *
 * `options._idHoldMs`:
 *   undefined / 0  -> id is held forever (server has not reaped it yet)
 *   N              -> id is released N ms after the peer died (alive_timeout)
 */
class StickyIdPeer extends MockPeer {
    constructor(id, options) {
        super(id, options);
        this._idHoldMs = (options && options._idHoldMs) || 0;
        this._releaseTimer = null;
    }

    /**
     * Run a MockPeer teardown, then undo its `registry.delete(this.id)` — the
     * real server never learned that this peer died, so the reservation stands.
     * Whatever was registered stays registered (so a peer that LOST the race and
     * was answered ID-TAKEN cannot evict the true holder when it is destroyed),
     * and if the dying peer is the holder, its alive_timeout starts ticking.
     */
    _keepServerSideRegistration(teardown) {
        const heldId = this.id;
        const holder = registry.get(heldId);
        teardown();
        if (!holder) return; // already reaped; nothing to preserve
        registry.set(heldId, holder);
        if (holder === this && this._idHoldMs > 0 && !this._releaseTimer) {
            this._releaseTimer = setTimeout(() => {
                if (registry.get(heldId) === this) registry.delete(heldId);
            }, this._idHoldMs);
        }
    }

    disconnect() {
        this._keepServerSideRegistration(() => super.disconnect());
    }

    destroy() {
        if (this.destroyed) return;
        this._keepServerSideRegistration(() => super.destroy());
    }
}

const BASE_CONFIG = {
    roomPrefix: 'sticky-',
    heartbeatInterval: 0,
    reconnectWindowMs: 60000,
    connectionTimeout: 3000,
    reconnectBackoffBase: 50,
    reconnectBackoffMultiplier: 1.5,
    reconnectBackoffMax: 500,
    _PeerClass: StickyIdPeer,
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

describe('REPRO: host reconnect silently changes the room code', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sanity: the sticky-id fake really does hold the id after an unclean loss', async () => {
        // Not a bug assertion — proves the extension behaves as claimed, so that
        // the failures below cannot be dismissed as a broken fake.
        const peer = new StickyIdPeer('sticky-HELD', { _idHoldMs: 300 });
        await vi.advanceTimersByTimeAsync(10);
        expect(registry.has('sticky-HELD')).toBe(true);

        peer.destroy();
        // Dead peer, but the server has not reaped the registration yet.
        expect(registry.has('sticky-HELD')).toBe(true);

        // A new Peer asking for the same id is told ID-TAKEN.
        const taker = new StickyIdPeer('sticky-HELD', {});
        const errors = [];
        taker.on('error', (e) => errors.push(e.type));
        await vi.advanceTimersByTimeAsync(10);
        expect(errors).toEqual(['unavailable-id']);

        // ...and after alive_timeout the id is free again.
        await vi.advanceTimersByTimeAsync(400);
        expect(registry.has('sticky-HELD')).toBe(false);
    });

    it('BUG: keeps serving a different room code than the one the app was handed', async () => {
        const host = createHost({ peerOptions: { _idHoldMs: 30000 } });

        // 1. The app starts the room and captures the code exactly once, the way
        //    sloplobby.js:199 does (`this.roomCode = await host.start()`), then
        //    paints it (texas-holdem:1386+1389, flip-7:1198+1201, herd:955+1029,
        //    cards-against-humanity:543+547).
        const startPromise = host.start();
        await vi.advanceTimersByTimeAsync(20);
        const appCapturedRoomCode = await startPromise;
        const codeOnScreen = appCapturedRoomCode;

        expect(host.roomCode).toBe(codeOnScreen);

        // Record the identity the host is serving at the moment it declares itself
        // healthy again.
        const codesReportedHealthy = [];
        host.on('reconnected', () => codesReportedHealthy.push(host.roomCode));

        // 2. The host's phone loses its radio. The signalling socket dies without
        //    a FIN: the peer sees 'disconnected', the server keeps the id.
        host.peer.disconnect();

        // 3. Let the whole reconnect ladder run.
        await vi.advanceTimersByTimeAsync(1000);

        // The host declares itself healthy ('reconnected') while serving a room
        // code nobody has ever seen. It is legitimate to still be retrying here;
        // it is never legitimate to be live under a different identity.
        expect(codesReportedHealthy.filter((c) => c !== codeOnScreen)).toEqual([]);

        // The screen, the lobby's this.roomCode, and every player's target all
        // still say `codeOnScreen`.
        expect(host.roomCode).toBe(codeOnScreen);
        expect(host.peerId).toBe('sticky-' + codeOnScreen);

        host.destroy();
    });

    it('BUG: announces a DIFFERENT code on the second `ready`, which no consumer subscribes to', async () => {
        const host = createHost({ peerOptions: { _idHoldMs: 30000 } });

        const readyCodes = [];
        host.on('ready', (code) => readyCodes.push(code));

        const startPromise = host.start();
        await vi.advanceTimersByTimeAsync(20);
        const codeOnScreen = await startPromise;

        host.peer.disconnect();
        await vi.advanceTimersByTimeAsync(1000);

        // Re-emitting `ready` after a successful re-registration is fine — what is
        // not fine is re-announcing a DIFFERENT identity, through an event that
        // sloplobby.js and all four apps ignore. Every `ready` must carry the one
        // code the room was created with.
        expect(readyCodes.length).toBeGreaterThan(0);
        expect(readyCodes.filter((c) => c !== codeOnScreen)).toEqual([]);

        host.destroy();
    });

    it('BUG: strands a connected player — the advertised code is dead after the host reconnects', async () => {
        // alive_timeout of 300ms: shorter than the host's own retry ladder, so a
        // host that simply retried the SAME id would reclaim it and the player
        // would come back. Instead the host takes a brand-new id at the first
        // attempt (50ms) and abandons the room.
        const host = createHost({ peerOptions: { _idHoldMs: 300 } });

        const startPromise = host.start();
        await vi.advanceTimersByTimeAsync(20);
        const codeOnScreen = await startPromise;

        const alice = createClient();
        const cp = alice.connect(codeOnScreen, 'alice', { name: 'Alice' });
        await vi.advanceTimersByTimeAsync(50);
        await cp;
        expect(host.isClientConnected('alice')).toBe(true);

        // Host radio drop. Every client is force-marked disconnected at
        // slopnet.js:489-496 and their channels are torn down by _destroyPeer at
        // :529, so Alice starts her own retry ladder against `codeOnScreen`.
        host.peer.disconnect();

        // Give both ladders far longer than the 300ms server hold.
        await vi.advanceTimersByTimeAsync(5000);

        // Alice is dialling the only code she or anyone else has ever been told.
        expect(alice.roomCode).toBe(codeOnScreen);
        // She should be back at the table.
        expect(alice.isConnected).toBe(true);
        expect(host.isClientConnected('alice')).toBe(true);

        alice.destroy();
        host.destroy();
    });
});
