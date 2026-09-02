/**
 * REPRO 1 — "retry ladder outlives reconnect window"
 *
 * BUG (slopnet.js:96-99, :106, :132-134, :337-342, :344-367)
 * The client's reconnect ladder and the host's reconnect window are sized from two
 * defaults that were never reconciled:
 *
 *   client: maxReconnectAttempts 20, backoff min(1000 * 1.5^n, 15000)  -> 227,172ms of retrying
 *   host:   reconnectWindowMs 120000                                    -> forgets after 120,000ms
 *
 * Cumulative client wait crosses the host's window on attempt 13 (122,172ms), so attempts
 * 13..20 — 107 seconds, more than a third of the client's whole budget — are all scheduled
 * to land AFTER the host has already deleted the client (slopnet.js:355-361).
 *
 * When such an attempt finally succeeds, _findClientByClientId (:337-342) finds nothing,
 * so _handleData takes the NEW-CLIENT branch (:314-327): the host emits 'client-joined'
 * instead of 'client-rejoined' and acks with `reconnected: false`. Every consumer then runs
 * the returning player through its keep-strangers-out mid-game validation
 * (texas-holdem/index.html:1336-1339, flip-7/index.html:1131-1133,
 * herd-mentality/index.html:886-889) and refuses them their own seat.
 *
 * Real-user sequence, no race required: a phone loses data for ~2.5 minutes (lift, tunnel,
 * basement, tube, rural blackspot) and then comes back. That is the repo's own stated
 * operating condition.
 *
 * WHY THE EXISTING 101 TESTS CANNOT SEE IT
 * Both reconnect-window tests (reconnection.test.js:240 and :298) build the client with
 * `maxReconnectAttempts: 0` and then call `client.destroy()`, so no test has ever had a
 * LIVE, retrying client at the moment 'client-lost' fires. Nothing anywhere asserts which
 * of client-joined / client-rejoined a returning clientId produces after the window closes.
 * These tests therefore run against the REAL DEFAULT_CONFIG (only `_PeerClass` is injected),
 * because the bug is a property of those defaults, not of any override.
 *
 * ON THE MOCK
 * mock-peer.js needed NO changes and has not been modified. The outage is simulated by
 * removing the host's peer id from the mock signaling registry: the client then creates a
 * fresh peer per attempt (slopnet.js:648-656), its `peer.connect()` fails with
 * 'peer-unavailable', and the error lands in the same `peer.on('error')` handler
 * (slopnet.js:703-714) that a real signalling failure would reach. The host object stays
 * alive throughout with its 120s window timer running — which is exactly the real situation
 * (the host's own network is fine; it is the player's phone that is dark).
 *
 * These tests FAIL on purpose. Do not "fix" them by relaxing the assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry, registry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { PeerHost, PeerClient, DEFAULT_CONFIG, _computeBackoff } = SlopNet;

// Production defaults verbatim — only the Peer implementation is injected.
// (sloplobby.js:161 / :246 construct PeerHost/PeerClient with `{ roomPrefix }` only, so
// every one of the four apps runs on exactly these numbers.)
const PROD_CONFIG = { _PeerClass: MockPeer };

const ROOM = 'ROOM1';
const HOST_PEER_ID = DEFAULT_CONFIG.roomPrefix + ROOM;

/** Sum of the client's whole default retry ladder, in ms. */
function ladder() {
    const delays = [];
    for (let i = 0; i < DEFAULT_CONFIG.maxReconnectAttempts; i++) {
        delays.push(_computeBackoff(
            i,
            DEFAULT_CONFIG.reconnectBackoffBase,
            DEFAULT_CONFIG.reconnectBackoffMultiplier,
            DEFAULT_CONFIG.reconnectBackoffMax
        ));
    }
    let cumulative = 0;
    const landsAt = delays.map(d => (cumulative += d));
    return { delays, landsAt, total: cumulative };
}

async function startHost(events) {
    const host = new PeerHost(PROD_CONFIG);
    for (const type of ['client-joined', 'client-rejoined', 'client-left', 'client-lost']) {
        host.on(type, (clientId) => events.push(`${type}:${clientId}`));
    }
    const started = host.start(ROOM);
    await vi.advanceTimersByTimeAsync(20);
    await started;
    return host;
}

describe('REPRO: client retry ladder outlives the host reconnect window', () => {
    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('never schedules a reconnect attempt that lands after the host has forgotten the client', () => {
        const { landsAt, total } = ladder();
        const window = DEFAULT_CONFIG.reconnectWindowMs;

        const lateAttempts = landsAt
            .map((t, i) => ({ attempt: i + 1, landsAtMs: t }))
            .filter(a => a.landsAtMs >= window);

        expect(
            lateAttempts.length,
            `The client's ladder runs for ${total}ms across ${DEFAULT_CONFIG.maxReconnectAttempts} attempts, ` +
            `but the host deletes the client after reconnectWindowMs=${window}ms. ` +
            `Attempts ${lateAttempts.length ? lateAttempts[0].attempt : '-'}..${DEFAULT_CONFIG.maxReconnectAttempts} ` +
            `(landing ${lateAttempts.length ? lateAttempts[0].landsAtMs : '-'}ms..${total}ms) can only ever succeed ` +
            `into a host that no longer has a record of this player.`
        ).toBe(0);
    });

    it('emits client-rejoined (not client-joined) when a still-retrying client returns after the window closed', async () => {
        const events = [];
        const host = await startHost(events);
        const hostPeer = host.peer;

        const client = new PeerClient(PROD_CONFIG);
        const clientEvents = [];
        client.on('connected', () => clientEvents.push('connected'));
        client.on('reconnected', () => clientEvents.push('reconnected'));
        client.on('reconnect-failed', () => clientEvents.push('reconnect-failed'));
        const reconnecting = [];
        client.on('reconnecting', (attempt) => reconnecting.push({ attempt, at: Date.now() }));

        const connected = client.connect(ROOM, 'alice', { name: 'Alice' });
        await vi.advanceTimersByTimeAsync(50);
        await connected;

        expect(host.getConnectedClientIds()).toEqual(['alice']);

        // --- Alice's phone goes dark: the signalling server is unreachable for her, and
        //     the live data connection drops. The host is untouched. ---
        const outageStartedAt = Date.now();
        registry.delete(HOST_PEER_ID);
        client.connection.close();
        await vi.advanceTimersByTimeAsync(100);

        expect(client.isConnected).toBe(false);
        expect(host.getDisconnectedClientIds()).toEqual(['alice']);

        // --- 150 seconds of outage: past the host's 120s window, still inside the
        //     client's 227s ladder. ---
        await vi.advanceTimersByTimeAsync(150000);

        // The host has given up...
        expect(events).toContain('client-lost:alice');
        expect(host.getAllClientIds()).toEqual([]);

        // ...while the client is demonstrably still trying. This is the state no existing
        // test can produce (reconnection.test.js:246 / :307 use maxReconnectAttempts: 0).
        expect(clientEvents).not.toContain('reconnect-failed');
        const attemptsAfterWindow = reconnecting.filter(
            r => r.at - outageStartedAt >= DEFAULT_CONFIG.reconnectWindowMs
        );
        expect(attemptsAfterWindow.length).toBeGreaterThan(0);

        // --- Alice walks out of the lift. Signalling is reachable again. ---
        registry.set(HOST_PEER_ID, hostPeer);
        await vi.advanceTimersByTimeAsync(30000);

        // She is back on the wire...
        expect(client.isConnected).toBe(true);

        // ...but the host greets her as a stranger.
        expect(events).toEqual([
            'client-joined:alice',
            'client-left:alice',
            'client-lost:alice',
            'client-rejoined:alice',
        ]);

        client.destroy();
        host.destroy();
    });

    it('acks a post-window return as a reconnection, so the client emits reconnected not connected', async () => {
        const events = [];
        const host = await startHost(events);
        const hostPeer = host.peer;

        const client = new PeerClient(PROD_CONFIG);
        const clientEvents = [];
        client.on('connected', () => clientEvents.push('connected'));
        client.on('disconnected', () => clientEvents.push('disconnected'));
        client.on('reconnected', () => clientEvents.push('reconnected'));

        const acks = [];
        const connected = client.connect(ROOM, 'alice', { name: 'Alice' });
        await vi.advanceTimersByTimeAsync(50);
        await connected;

        // Observe the raw join_ack the host sends on the return trip.
        const originalHandleData = client._handleData.bind(client);
        client._handleData = (data, ...rest) => {
            if (data && data.type === '__slopnet_join_ack') acks.push(data);
            return originalHandleData(data, ...rest);
        };

        registry.delete(HOST_PEER_ID);
        client.connection.close();
        await vi.advanceTimersByTimeAsync(150000);

        expect(events).toContain('client-lost:alice');

        registry.set(HOST_PEER_ID, hostPeer);
        await vi.advanceTimersByTimeAsync(30000);
        expect(client.isConnected).toBe(true);

        // sloplobby.js's client wiring (:249-269) subscribes to 'reconnected' and never to
        // 'connected', so a returning player whose ack says reconnected:false is silently
        // never told they are back.
        expect(acks.map(a => a.reconnected)).toEqual([true]);
        expect(clientEvents).toEqual(['connected', 'disconnected', 'reconnected']);

        client.destroy();
        host.destroy();
    });
});
