/**
 * REPRODUCING TEST — bug "host-reconnect-self-destruct-loop"
 * (lib/slopnet/slopnet.js:216-221, :487-500, :519-522, :528, :556-561)
 *
 * These tests are EXPECTED TO FAIL against the current slopnet.js. They document
 * the bug; they do not hide it. Do not "fix" the test — fix slopnet.js.
 *
 * ---------------------------------------------------------------------------
 * WHY mock-peer.js IS NOT ADEQUATE HERE (so a local fake lives in this file)
 * ---------------------------------------------------------------------------
 * mock-peer.js cannot express this bug at all, in three independent ways, and
 * every one of them would have to CHANGE existing behaviour that the 101 passing
 * tests depend on. So instead of touching mock-peer.js, this file defines a
 * small local fake (`FakeSignalingServer` + `RealisticPeer`) that mirrors the
 * real peerjs 1.5.5 control flow. mock-peer.js's `SimpleEmitter` is reused.
 *
 *   1. MockPeer.destroy() (mock-peer.js:256-269) emits only 'close'. Real
 *      Peer.destroy() calls disconnect() (peerjs.js:4579-4586), which emits
 *      'disconnected' SYNCHRONOUSLY (peerjs.js:4604-4613) when the peer was not
 *      already disconnected. That synchronous 'disconnected' is what re-enters
 *      slopnet's _startReconnect() (slopnet.js:238-242) from inside
 *      _destroyPeer(). With MockPeer that re-entry is unreachable.
 *
 *   2. MockPeer.destroy() does registry.delete(this.id) (mock-peer.js:260), so
 *      re-registration always succeeds. In reality a phone that drops into a
 *      tunnel never sends a FIN, so PeerServer keeps holding the id until its
 *      alive_timeout (~60s) and the reconnect gets ID-TAKEN -> 'unavailable-id'.
 *      MockPeer only ever produces 'unavailable-id' at construction time
 *      (mock-peer.js:169-175), never from the reconnect path.
 *
 *   3. MockPeer registration is setTimeout(..., 0) (mock-peer.js:178-183), so
 *      'open' always beats any backoff and always clears the competing reconnect
 *      timer at slopnet.js:204. A real cold WS+TLS handshake on a re-acquiring
 *      cellular radio routinely exceeds reconnectBackoffBase (1000ms), which is
 *      what makes the destroy/re-arm loop self-sustaining. The fake below has a
 *      configurable `registrationDelay` so both ratios can be expressed.
 *
 * The fake reproduces exactly these peerjs 1.5.5 behaviours and nothing more:
 *   - _abort() emits the error FIRST and only then destroys/disconnects
 *     (peerjs.js:4564-4568), so slopnet's error handler runs on a LIVE peer.
 *   - a freshly-constructed peer has no _lastServerId, so _abort takes destroy().
 *   - destroy() -> disconnect() -> synchronous emit('disconnected'), then 'close'.
 *   - disconnect() early-returns when already disconnected (peerjs.js:4605), so
 *     destroying an already-dropped peer is silent.
 *   - a socket that died with the radio never frees the id server-side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimpleEmitter } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost } = SlopNet;

// =============================================================================
// Local fake: a PeerServer that holds ids, and a Peer with peerjs 1.5.5 ordering
// =============================================================================

class FakeSignalingServer {
    constructor(registrationDelay = 20) {
        // peerId -> owning RealisticPeer
        this.claims = new Map();
        // How long a full signalling registration takes (WS + TLS + OPEN).
        this.registrationDelay = registrationDelay;
        // Diagnostics
        this.registrationsStarted = 0;
        this.registrationsKilledInFlight = 0;
        this.registrationsCompleted = 0;
    }

    claim(id, peer) {
        this.registrationsStarted++;
        setTimeout(() => {
            if (peer.destroyed || peer.disconnected) {
                // The client vanished before the server could answer.
                this.registrationsKilledInFlight++;
                return;
            }
            const holder = this.claims.get(id);
            if (holder && holder !== peer) {
                peer._onIdTaken(id); // server sends ID-TAKEN
                return;
            }
            this.claims.set(id, peer);
            this.registrationsCompleted++;
            peer._onOpen(id); // server sends OPEN
        }, this.registrationDelay);
    }

    // A close frame only frees the id if it actually reached the server, and
    // only the current holder can free it.
    release(id, peer) {
        if (this.claims.get(id) === peer) this.claims.delete(id);
    }

    // PeerServer's alive_timeout finally reaping an uncleanly-dropped socket.
    reapStaleClaim(id) {
        this.claims.delete(id);
    }

    holderOf(id) {
        return this.claims.get(id) || null;
    }
}

class RealisticPeer extends SimpleEmitter {
    constructor(id, options) {
        super();
        this.options = options || {};
        this._server = this.options.server;
        this._requestedId = id;
        this.id = id;
        this.open = false;
        this.destroyed = false;
        this.disconnected = false;
        this._lastServerId = undefined;
        // When the radio dies, the socket dies with it: close frames never land.
        this._socketDead = false;
        this._server.claim(id, this);
    }

    _onOpen(id) {
        if (this.destroyed || this.disconnected) return;
        this.open = true;
        this.emit('open', id);
    }

    // peerjs.js:4405-4406 ID-TAKEN -> _abort(UnavailableID)
    // peerjs.js:4564-4568 _abort: emitError FIRST, then destroy()/disconnect().
    _onIdTaken(id) {
        const err = new Error(`ID "${id}" is taken`);
        err.type = 'unavailable-id';
        this.emit('error', err); // <-- peer is still ALIVE while this runs
        if (!this._lastServerId) {
            this.destroy();
        } else {
            this.disconnect();
        }
    }

    // peerjs.js:4602-4613
    disconnect() {
        if (this.disconnected) return;
        const currentId = this.id;
        this.disconnected = true;
        this.open = false;
        if (!this._socketDead) this._server.release(this._requestedId, this);
        this._lastServerId = currentId;
        this.id = null;
        this.emit('disconnected', currentId); // SYNCHRONOUS
    }

    // peerjs.js:4578-4586
    destroy() {
        if (this.destroyed) return;
        this.disconnect();
        this.destroyed = true;
        this.emit('close');
    }

    connect() {
        throw new Error('RealisticPeer: outbound connect() is out of scope for this repro');
    }

    // --- test helpers ---

    /**
     * The host's phone drops into a tunnel: the TCP connection dies without a
     * FIN. peerjs's socket 'Disconnected' handler (peerjs.js:4377-4381) does
     * emitError('network') and then disconnect().
     */
    simulateUncleanNetworkLoss() {
        this._socketDead = true;
        const err = new Error('Lost connection to server.');
        err.type = 'network';
        this.emit('error', err);
        this.disconnect();
    }
}

function createHost(server, overrides = {}) {
    return new PeerHost({
        roomPrefix: 'recon-',
        heartbeatInterval: 0,
        reconnectWindowMs: 60000,
        maxReconnectAttempts: 20,
        reconnectBackoffBase: 100,
        reconnectBackoffMultiplier: 1.5,
        reconnectBackoffMax: 1000,
        peerOptions: { server },
        _PeerClass: RealisticPeer,
        ...overrides,
    });
}

describe('REPRO: host reconnect self-destruct loop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('must not silently change the room code when the host reconnects after a tunnel dip', async () => {
        // Registration is FASTER than the backoff here, so the destroy/re-arm
        // loop escapes quickly. The permanent damage happens anyway, on the very
        // first reconnect attempt.
        const server = new FakeSignalingServer(20);
        const host = createHost(server, { reconnectBackoffBase: 100 });

        const reconnectFailedFn = vi.fn();
        host.on('reconnect-failed', reconnectFailedFn);
        host.on('error', () => {}); // apps subscribe; keep it from being unhandled

        const startPromise = host.start('ROOM1');
        await vi.advanceTimersByTimeAsync(50);
        // What the app latches once and paints on screen (sloplobby.js:199).
        const roomCodeShownToPlayers = await startPromise;
        expect(roomCodeShownToPlayers).toBe('ROOM1');
        expect(server.holderOf('recon-ROOM1')).toBe(host.peer);

        // Host phone enters a tunnel for five seconds: unclean drop, no FIN, so
        // the signalling server keeps holding recon-ROOM1 (alive_timeout ~60s).
        host.peer.simulateUncleanNetworkLoss();
        await vi.advanceTimersByTimeAsync(5000);

        // The host is alive and thinks everything is fine — no failure surfaced.
        expect(reconnectFailedFn).not.toHaveBeenCalled();

        // The room code on screen must still be the room the host is serving.
        expect(host.roomCode).toBe('ROOM1');
        expect(host.peerId).toBe('recon-ROOM1');
        expect(host.roomCode).toBe(roomCodeShownToPlayers);
    });

    it('must re-register the host once the id is free and the network is healthy', async () => {
        // Registration (400ms) is SLOWER than reconnectBackoffBase (100ms) —
        // an ordinary cold handshake on a radio that is re-acquiring signal.
        const server = new FakeSignalingServer(400);
        const host = createHost(server, { reconnectBackoffBase: 100 });

        const reconnectedFn = vi.fn();
        const reconnectFailedFn = vi.fn();
        host.on('reconnected', reconnectedFn);
        host.on('reconnect-failed', reconnectFailedFn);
        host.on('error', () => {});

        const startPromise = host.start('ROOM1');
        await vi.advanceTimersByTimeAsync(500);
        await startPromise;

        const originalPeer = host.peer;
        host.peer.simulateUncleanNetworkLoss();

        // Five seconds in the tunnel.
        await vi.advanceTimersByTimeAsync(5000);

        const killedDuringOutage = server.registrationsKilledInFlight;

        // Signal is back and the old socket has finally been reaped, so nothing
        // stands in the host's way any more.
        server.reapStaleClaim('recon-ROOM1');
        server.release(host.peerId, originalPeer);

        // Eight more seconds of a perfectly healthy network — 80 backoff periods.
        await vi.advanceTimersByTimeAsync(8000);

        const registeredNow = host.peer && host.peer.open === true &&
            server.holderOf(host.peerId) === host.peer;

        expect(
            {
                registered: registeredNow,
                reconnectedEvents: reconnectedFn.mock.calls.length,
                registrationsKilledInFlightAfterRecovery:
                    server.registrationsKilledInFlight - killedDuringOutage,
            },
            'host destroys its own in-flight registration every backoff period, so it never re-registers'
        ).toEqual({
            registered: true,
            reconnectedEvents: 1,
            registrationsKilledInFlightAfterRecovery: 0,
        });

        expect(reconnectFailedFn).not.toHaveBeenCalled();
    });

    it('must back off and eventually report failure instead of retrying at attempt 1 forever', async () => {
        // slopnet.js:499 resets _reconnectAttempts to 0 on every entry to
        // _startReconnect, and slopnet.js:520 nulls the guard before calling
        // _doReconnect, so _startReconnect is re-entered from inside
        // _destroyPeer. Backoff therefore stays pinned at the base and the cap
        // check at slopnet.js:505 can never trip.
        const server = new FakeSignalingServer(400);
        const host = createHost(server, {
            reconnectBackoffBase: 100,
            maxReconnectAttempts: 5,
        });

        const reconnectingFn = vi.fn();
        const reconnectFailedFn = vi.fn();
        host.on('reconnecting', reconnectingFn);
        host.on('reconnect-failed', reconnectFailedFn);
        host.on('error', () => {});

        const startPromise = host.start('ROOM1');
        await vi.advanceTimersByTimeAsync(500);
        await startPromise;

        host.peer.simulateUncleanNetworkLoss();
        await vi.advanceTimersByTimeAsync(10000);

        const attemptNumbers = reconnectingFn.mock.calls.map(c => c[0]);
        const highestAttemptReported = Math.max(...attemptNumbers);

        expect(
            {
                highestAttemptReported,
                reconnectFailedEmitted: reconnectFailedFn.mock.calls.length > 0,
            },
            `emitted ${attemptNumbers.length} 'reconnecting' events in 10s and every one of them said attempt 1 of 5`
        ).toEqual({
            highestAttemptReported: 5,
            reconnectFailedEmitted: true,
        });
    });
});
